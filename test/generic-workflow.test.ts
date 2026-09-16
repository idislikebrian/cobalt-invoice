import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createWorkflowContext,
  finalizeInvoice,
  inspectInvoice,
  parseCommand,
  prepareInvoice,
  previewInvoice,
  reportInvoice,
  validateInvoice,
  type Renderer,
  type WorkflowContext,
} from '../scripts/invoice/generic-workflow.ts'

function invoiceData(invoiceNumber: string, status: 'draft' | 'finalized' = 'draft') {
  return {
    invoiceNumber,
    status,
    issueDate: '2026-09-15',
    dueDate: '2026-10-15',
    currency: 'USD',
    sender: { name: 'Test Sender' },
    client: { name: 'Test Client' },
    lineItems: [
      {
        id: 'service',
        description: 'Test service',
        quantity: 1,
        unitPriceCents: 10000,
      },
    ],
  }
}

const fakeRenderer: Renderer = async ({ input, output, mode }) => {
  const invoice = JSON.parse(await readFile(input, 'utf8')) as {
    invoiceNumber: string
    status: string
  }
  await writeFile(output, `PDF:${mode}:${invoice.invoiceNumber}:${invoice.status}`, { flag: 'wx' })
}

async function fixture(context: { after: (callback: () => Promise<void>) => void }): Promise<{
  root: string
  runtimeRoot: string
  workflow: WorkflowContext
  source: (invoiceNumber: string, status?: 'draft' | 'finalized') => Promise<string>
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'generic-invoice-workflow-'))
  const runtimeRoot = path.join(root, 'runtime')
  await Promise.all([
    mkdir(path.join(runtimeRoot, 'input', 'invoices'), { recursive: true }),
    mkdir(path.join(runtimeRoot, 'output', 'previews'), { recursive: true }),
    mkdir(path.join(runtimeRoot, 'output', 'final'), { recursive: true }),
  ])
  context.after(() => rm(root, { recursive: true, force: true }))
  let sourceIndex = 0
  return {
    root,
    runtimeRoot,
    workflow: createWorkflowContext({
      appRoot: process.cwd(),
      runtimeRoot,
      now: () => new Date('2026-09-15T16:00:00.000Z'),
      render: fakeRenderer,
    }),
    source: async (invoiceNumber, status = 'draft') => {
      sourceIndex += 1
      const sourcePath = path.join(root, `source-${sourceIndex}.json`)
      await writeFile(sourcePath, `${JSON.stringify(invoiceData(invoiceNumber, status), null, 2)}\n`)
      return sourcePath
    },
  }
}

test('parses explicit workflow commands and rejects duplicate options', () => {
  const parsed = parseCommand(['finalize', '--preview-id', 'generic-000701-abcdef123456', '--invoice-number', '000701', '--json'])
  assert.equal(parsed.operation, 'finalize')
  assert.equal(parsed.flags.get('--invoice-number'), '000701')
  assert.equal(parsed.json, true)
  assert.throws(
    () => parseCommand(['inspect', '--invoice-number', '000701', '--invoice-number', '000702']),
    /Duplicate option/,
  )
})

test('validate returns safe metadata and refuses secret paths', async (context) => {
  const testFixture = await fixture(context)
  const source = await testFixture.source('000701')
  assert.deepEqual(await validateInvoice(source), {
    ok: true,
    operation: 'validate',
    invoiceNumber: '000701',
    status: 'draft',
    input: source,
  })
  await assert.rejects(
    validateInvoice('/srv/cobalt-invoice/secrets/payment.json'),
    /Secret paths are not valid invoice inputs/,
  )
})

test('prepare creates one canonical draft without overwriting or reusing a number', async (context) => {
  const testFixture = await fixture(context)
  const source = await testFixture.source('000701')
  const prepared = await prepareInvoice(testFixture.workflow, source, 'client-000701')
  assert.equal(prepared.input, path.join(testFixture.runtimeRoot, 'input', 'invoices', 'client-000701.json'))
  assert.equal((await stat(prepared.input)).mode & 0o777, 0o640)
  const state = await inspectInvoice(testFixture.workflow, '000701')
  assert.equal(state.available, false)
  assert.equal(state.occupied, false)
  assert.deepEqual(state.inputFiles, [prepared.input])
  await assert.rejects(
    prepareInvoice(testFixture.workflow, await testFixture.source('000701'), 'other-000701'),
    /already in use or blocked/,
  )
})

test('legacy final PDFs occupy invoice numbers and remain reportable without adoption', async (context) => {
  const testFixture = await fixture(context)
  const legacyPath = path.join(testFixture.runtimeRoot, 'output', 'final', '20260909-000699--legacy.pdf')
  await writeFile(legacyPath, 'legacy-pdf')
  const state = await inspectInvoice(testFixture.workflow, '000699')
  assert.equal(state.occupied, true)
  assert.deepEqual(state.legacyFinalArtifacts, [legacyPath])
  await assert.rejects(
    prepareInvoice(testFixture.workflow, await testFixture.source('000699'), 'legacy-000699'),
    /already in use or blocked/,
  )
  const report = await reportInvoice(testFixture.workflow, '000699')
  assert.equal(report.managed, false)
  assert.equal(report.verifiedAgainstManifest, false)
  assert.equal(report.artifactPath, legacyPath)
  assert.equal(report.sha256, createHash('sha256').update('legacy-pdf').digest('hex'))
})

test('preview is immutable, content-addressed, and idempotent', async (context) => {
  const testFixture = await fixture(context)
  const prepared = await prepareInvoice(
    testFixture.workflow,
    await testFixture.source('000702'),
    'client-000702',
  )
  const first = await previewInvoice(testFixture.workflow, prepared.input)
  const second = await previewInvoice(testFixture.workflow, prepared.input)
  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.equal(second.previewId, first.previewId)
  assert.equal(second.sha256, first.sha256)
  const previewDirectory = path.dirname(first.artifactPath)
  assert.equal((await stat(previewDirectory)).mode & 0o777, 0o550)
  assert.equal((await stat(first.artifactPath)).mode & 0o777, 0o440)
  assert.equal((await stat(path.join(previewDirectory, 'preview-manifest.json'))).mode & 0o777, 0o440)
})

test('finalization verifies the reviewed source and exact invoice number', async (context) => {
  const testFixture = await fixture(context)
  const prepared = await prepareInvoice(
    testFixture.workflow,
    await testFixture.source('000703'),
    'client-000703',
  )
  const preview = await previewInvoice(testFixture.workflow, prepared.input)
  await assert.rejects(
    finalizeInvoice(testFixture.workflow, preview.previewId, '000704'),
    /does not match the preview manifest/,
  )
  await writeFile(prepared.input, `${JSON.stringify(invoiceData('000703'), null, 2)} \n`)
  await assert.rejects(
    finalizeInvoice(testFixture.workflow, preview.previewId, '000703'),
    /source changed after preview/,
  )
})

test('finalization promotes only the frozen snapshot and reports a verified hash', async (context) => {
  const testFixture = await fixture(context)
  const prepared = await prepareInvoice(
    testFixture.workflow,
    await testFixture.source('000704'),
    'client-000704',
  )
  const preview = await previewInvoice(testFixture.workflow, prepared.input)
  const first = await finalizeInvoice(testFixture.workflow, preview.previewId, '000704')
  const second = await finalizeInvoice(testFixture.workflow, preview.previewId, '000704')
  assert.equal(first.replayed, false)
  assert.equal(second.replayed, true)
  assert.equal(second.sha256, first.sha256)

  const finalDirectory = path.dirname(first.artifactPath)
  const finalizedSnapshot = JSON.parse(
    await readFile(path.join(finalDirectory, '000704.invoice.json'), 'utf8'),
  ) as { status: string }
  const sourceDraft = JSON.parse(await readFile(prepared.input, 'utf8')) as { status: string }
  assert.equal(finalizedSnapshot.status, 'finalized')
  assert.equal(sourceDraft.status, 'draft')
  assert.equal((await stat(finalDirectory)).mode & 0o777, 0o550)
  assert.equal((await stat(first.artifactPath)).mode & 0o777, 0o440)

  const report = await reportInvoice(testFixture.workflow, '000704')
  assert.equal(report.managed, true)
  assert.equal(report.verifiedAgainstManifest, true)
  assert.equal(report.sha256, first.sha256)
})

test('legacy occupancy blocks finalization after preview', async (context) => {
  const testFixture = await fixture(context)
  const prepared = await prepareInvoice(
    testFixture.workflow,
    await testFixture.source('000705'),
    'client-000705',
  )
  const preview = await previewInvoice(testFixture.workflow, prepared.input)
  await writeFile(
    path.join(testFixture.runtimeRoot, 'output', 'final', 'manual-000705.pdf'),
    'existing',
  )
  await assert.rejects(
    finalizeInvoice(testFixture.workflow, preview.previewId, '000705'),
    /already finalized or blocked/,
  )
})

test('renderer failure leaves no committed preview or active lock', async (context) => {
  const testFixture = await fixture(context)
  const prepared = await prepareInvoice(
    testFixture.workflow,
    await testFixture.source('000706'),
    'client-000706',
  )
  const failingWorkflow = createWorkflowContext({
    appRoot: process.cwd(),
    runtimeRoot: testFixture.runtimeRoot,
    render: async () => {
      throw new Error('fixture renderer failure')
    },
  })
  await assert.rejects(previewInvoice(failingWorkflow, prepared.input), /fixture renderer failure/)
  assert.deepEqual(await readdir(path.join(testFixture.runtimeRoot, 'output', 'previews')), [])
  assert.deepEqual(
    await readdir(path.join(testFixture.runtimeRoot, 'state', 'invoice-studio', 'locks')),
    [],
  )
})
