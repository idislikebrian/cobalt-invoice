import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createBillingWeeks } from '../src/artisan/batch.ts'
import { buildWeeklyPreviews } from '../src/artisan/pipeline.ts'
import { sampleInvoice } from '../src/invoice/sample-invoice.ts'
import {
  jsonArtifact,
  sha256,
  validateFinalizationSource,
  type PreviewManifest,
} from '../scripts/artisan/finalization.ts'

const DEFAULT_INVOICE_NUMBERS = [
  '000702',
  '000703',
  '000704',
  '000705',
  '000706',
] as const

async function makePreviewFixture(options: { blocker?: boolean } = {}): Promise<{
  root: string
  previewDirectory: string
  finalRoot: string
  invoiceNumbers: string[]
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artisan-finalization-'))
  const previewDirectory = path.join(root, 'preview')
  const finalRoot = path.join(root, 'final')
  await mkdir(previewDirectory)
  const previews = buildWeeklyPreviews(
    [],
    createBillingWeeks('2026-06-28', '2026-08-01', '000702'),
    sampleInvoice.sender,
  ).previews
  if (options.blocker) {
    previews[0].audit.blockers.push({ code: 'test-blocker', entryId: null, message: 'Blocked for test' })
  }
  const sources: PreviewManifest['sources'] = []
  for (const preview of previews) {
    const invoiceNumber = preview.invoice.invoiceNumber
    const invoiceFile = `${invoiceNumber}.invoice.json`
    const auditFile = `${invoiceNumber}.audit.json`
    const invoiceRaw = jsonArtifact(preview.invoice)
    const auditRaw = jsonArtifact(preview.audit)
    await Promise.all([
      writeFile(path.join(previewDirectory, invoiceFile), invoiceRaw),
      writeFile(path.join(previewDirectory, auditFile), auditRaw),
    ])
    sources.push({
      invoiceNumber,
      invoiceFile,
      invoiceSha256: sha256(invoiceRaw),
      auditFile,
      auditSha256: sha256(auditRaw),
      totalCents: preview.audit.finalTotalCents,
    })
  }
  const manifest: PreviewManifest = {
    version: 1,
    previewId: 'fixture-preview',
    createdAt: '2026-08-04T12:00:00.000Z',
    invoiceNumbers: previews.map(({ invoice }) => invoice.invoiceNumber),
    sources,
  }
  await writeFile(path.join(previewDirectory, 'preview-manifest.json'), jsonArtifact(manifest))
  return {
    root,
    previewDirectory,
    finalRoot,
    invoiceNumbers: previews.map(({ invoice }) => invoice.invoiceNumber),
  }
}

test('validates a complete frozen preview batch for successful finalization', async (context) => {
  const fixture = await makePreviewFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const validated = await validateFinalizationSource({
    previewDirectory: fixture.previewDirectory,
    invoiceNumbers: fixture.invoiceNumbers,
    finalRoot: fixture.finalRoot,
  })
  assert.deepEqual(validated.sources.map(({ invoiceNumber }) => invoiceNumber), DEFAULT_INVOICE_NUMBERS)
})

test('accepts explicit invoice numbers from the frozen preview manifest', async (context) => {
  const fixture = await makePreviewFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const manifestPath = path.join(fixture.previewDirectory, 'preview-manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PreviewManifest
  const invoiceNumbers = ['000812', '000813', '000814', '000815', '000816']
  manifest.invoiceNumbers = invoiceNumbers
  for (const [index, source] of manifest.sources.entries()) {
    const invoiceRaw = await readFile(path.join(fixture.previewDirectory, source.invoiceFile), 'utf8')
    const auditRaw = await readFile(path.join(fixture.previewDirectory, source.auditFile), 'utf8')
    const invoice = JSON.parse(invoiceRaw) as Record<string, unknown>
    const audit = JSON.parse(auditRaw) as Record<string, unknown>
    invoice.invoiceNumber = invoiceNumbers[index]
    audit.invoiceNumber = invoiceNumbers[index]
    const newInvoiceFile = `${invoiceNumbers[index]}.invoice.json`
    const newAuditFile = `${invoiceNumbers[index]}.audit.json`
    const newInvoiceRaw = jsonArtifact(invoice)
    const newAuditRaw = jsonArtifact(audit)
    await Promise.all([
      writeFile(path.join(fixture.previewDirectory, newInvoiceFile), newInvoiceRaw),
      writeFile(path.join(fixture.previewDirectory, newAuditFile), newAuditRaw),
    ])
    source.invoiceNumber = invoiceNumbers[index]
    source.invoiceFile = newInvoiceFile
    source.auditFile = newAuditFile
    source.invoiceSha256 = sha256(newInvoiceRaw)
    source.auditSha256 = sha256(newAuditRaw)
  }
  await writeFile(manifestPath, jsonArtifact(manifest))
  const validated = await validateFinalizationSource({
    previewDirectory: fixture.previewDirectory,
    invoiceNumbers,
    finalRoot: fixture.finalRoot,
  })
  assert.deepEqual(validated.sources.map(({ invoiceNumber }) => invoiceNumber), invoiceNumbers)
})

test('fails closed for a missing preview directory or artifact', async (context) => {
  const fixture = await makePreviewFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  await assert.rejects(
    validateFinalizationSource({
      previewDirectory: path.join(fixture.root, 'missing'),
      invoiceNumbers: fixture.invoiceNumbers,
      finalRoot: fixture.finalRoot,
    }),
    /Preview directory is missing/,
  )
  await rm(path.join(fixture.previewDirectory, '000704.audit.json'))
  await assert.rejects(
    validateFinalizationSource({
      previewDirectory: fixture.previewDirectory,
      invoiceNumbers: fixture.invoiceNumbers,
      finalRoot: fixture.finalRoot,
    }),
    /artifact is missing/,
  )
})

test('fails closed when an audit contains blockers', async (context) => {
  const fixture = await makePreviewFixture({ blocker: true })
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  await assert.rejects(
    validateFinalizationSource({
      previewDirectory: fixture.previewDirectory,
      invoiceNumbers: fixture.invoiceNumbers,
      finalRoot: fixture.finalRoot,
    }),
    /has 1 blocker/,
  )
})

test('fails closed when a frozen invoice snapshot is tampered', async (context) => {
  const fixture = await makePreviewFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const snapshot = path.join(fixture.previewDirectory, '000702.invoice.json')
  await writeFile(snapshot, `${await readFile(snapshot, 'utf8')} `)
  await assert.rejects(
    validateFinalizationSource({
      previewDirectory: fixture.previewDirectory,
      invoiceNumbers: fixture.invoiceNumbers,
      finalRoot: fixture.finalRoot,
    }),
    /differs from its recorded preview snapshot/,
  )
})

test('fails closed when any requested invoice already has a final PDF', async (context) => {
  const fixture = await makePreviewFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  await mkdir(path.join(fixture.finalRoot, 'prior'), { recursive: true })
  await writeFile(path.join(fixture.finalRoot, 'prior', '000705.pdf'), 'existing')
  await assert.rejects(
    validateFinalizationSource({
      previewDirectory: fixture.previewDirectory,
      invoiceNumbers: fixture.invoiceNumbers,
      finalRoot: fixture.finalRoot,
    }),
    /already exists for invoice 000705/,
  )
})

test('requires explicit confirmation of all invoice numbers in the frozen preview manifest', async (context) => {
  const fixture = await makePreviewFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  await assert.rejects(
    validateFinalizationSource({
      previewDirectory: fixture.previewDirectory,
      invoiceNumbers: ['000702'],
      finalRoot: fixture.finalRoot,
    }),
    /Explicitly confirm invoice numbers/,
  )
})

test('PDF extraction keeps Draft indicators in previews and removes both from finals', async (context) => {
  const fixture = await makePreviewFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const validated = await validateFinalizationSource({
    previewDirectory: fixture.previewDirectory,
    invoiceNumbers: fixture.invoiceNumbers,
    finalRoot: fixture.finalRoot,
  })
  const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  await vite.listen()
  const address = vite.httpServer?.address()
  assert.ok(address && typeof address !== 'string')
  const browser = await chromium.launch()
  const finalPdfPath = path.join(fixture.root, 'final.pdf')
  const previewPdfPath = path.join(fixture.root, 'preview.pdf')
  try {
    const encoded = Buffer.from(JSON.stringify(validated.sources[0].invoice)).toString('base64url')
    for (const [renderMode, pdfPath] of [['preview', previewPdfPath], ['final', finalPdfPath]] as const) {
      const page = await browser.newPage()
      await page.goto(`http://127.0.0.1:${address.port}/?invoice=${encoded}&render=${renderMode}`, { waitUntil: 'networkidle' })
      await page.pdf({ path: pdfPath, format: 'Letter', printBackground: true })
      await page.close()
    }
  } finally {
    await browser.close()
    await vite.close()
  }
  async function extractedText(pdfPath: string): Promise<string> {
    const document = await getDocument({ data: new Uint8Array(await readFile(pdfPath)) }).promise
    const page = await document.getPage(1)
    const content = await page.getTextContent()
    return content.items.map((item) => 'str' in item ? item.str : '').join(' ')
  }
  const previewText = await extractedText(previewPdfPath)
  const finalText = await extractedText(finalPdfPath)
  assert.match(previewText.replace(/\s+/g, ''), /DRAFT·PREVIEW/)
  assert.match(previewText, /\bDraft\b/)
  assert.doesNotMatch(finalText.replace(/\s+/g, ''), /DRAFT|PREVIEW/)
  assert.doesNotMatch(finalText, /\bDraft\b/)
  assert.match(finalText, /Invoice/)
})
