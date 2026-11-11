import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { parseAdjustmentFile, type ValidatedAdjustments } from '../../src/artisan/adjustments.ts'
import { createBillingWeeks, type BillingWeek } from '../../src/artisan/batch.ts'
import { localDateAt } from '../../src/artisan/dates.ts'
import { buildWeeklyPreviews } from '../../src/artisan/pipeline.ts'
import { sampleInvoice } from '../../src/invoice/sample-invoice.ts'
import { invoiceSchema } from '../../src/invoice/schema.ts'
import {
  defaultAdjustmentsRoot,
  finalizedAdjustmentIds,
  jsonArtifact,
  sha256,
  type PreviewManifest,
} from './finalization.ts'
import { fetchTrackEntries } from './track.ts'

const ALLOWED_FLAGS = new Set(['--from', '--through', '--start-number', '--adjustments'])

export function argumentsFrom(argv: string[]): { from: string; through: string; startNumber: string; adjustments?: string } {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) throw new Error('Expected --from, --through, and --start-number')
    if (!ALLOWED_FLAGS.has(key)) throw new Error(`Unexpected option: ${key}`)
    if (values.has(key)) throw new Error(`Duplicate option: ${key}`)
    values.set(key, value)
  }
  const from = values.get('--from')
  const through = values.get('--through')
  const startNumber = values.get('--start-number')
  if (!from || !through || !startNumber) throw new Error('Expected --from, --through, and --start-number')
  const adjustments = values.get('--adjustments')
  return { from, through, startNumber, ...(adjustments && { adjustments }) }
}

/**
 * Load a manually approved adjustment file from the canonical adjustments
 * directory only, freeze its SHA-256, and refuse ids already finalized.
 */
export async function loadAdjustments(options: {
  requestedPath: string
  adjustmentsRoot: string
  finalRoot: string
  weeks: BillingWeek[]
  now?: Date
}): Promise<ValidatedAdjustments> {
  let canonicalRoot: string
  let canonicalPath: string
  try {
    canonicalRoot = await realpath(options.adjustmentsRoot)
    canonicalPath = await realpath(options.requestedPath)
  } catch {
    throw new Error('Adjustment file or canonical adjustments directory is missing')
  }
  if (path.dirname(canonicalPath) !== canonicalRoot) {
    throw new Error('Adjustment file must be inside the canonical artisan-adjustments directory')
  }
  const raw = await readFile(canonicalPath, 'utf8')
  const validated = parseAdjustmentFile({
    raw,
    fileName: path.basename(canonicalPath),
    sha256: sha256(raw),
    weeks: options.weeks,
    now: options.now,
  })
  const consumed = await finalizedAdjustmentIds(options.finalRoot)
  for (const { id } of validated.adjustments) {
    const consumedBy = consumed.get(id)
    if (consumedBy) throw new Error(`Adjustment ${id} was already finalized in ${consumedBy}`)
  }
  return validated
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function frozenPaymentDetails(): Record<string, string> | undefined {
  const values = {
    bankName: process.env.VITE_PAYMENT_BANK_NAME,
    routingNumber: process.env.VITE_PAYMENT_ROUTING_NUMBER,
    accountNumber: process.env.VITE_PAYMENT_ACCOUNT_NUMBER,
    ethereumNetwork: process.env.VITE_PAYMENT_ETHEREUM_NETWORK,
    ethereumAddress: process.env.VITE_PAYMENT_ETHEREUM_ADDRESS,
    zellePhone: process.env.VITE_PAYMENT_ZELLE_PHONE,
  }
  const populated = Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1])),
  )
  return Object.keys(populated).length > 0 ? populated : undefined
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2))
  const token = process.env.TOGGL_API_TOKEN
  const workspaceId = process.env.TOGGL_WORKSPACE_ID
  if (!token || !workspaceId) throw new Error('Set server-only TOGGL_API_TOKEN and TOGGL_WORKSPACE_ID in .env.local')
  // Unadjusted batches keep the original document date (day after the period).
  // Only the manual-adjustment workflow dates the document no earlier than generation.
  const weeks = createBillingWeeks(
    args.from,
    args.through,
    args.startNumber,
    args.adjustments ? localDateAt(Date.now()) : undefined,
  )
  const adjustments = args.adjustments
    ? await loadAdjustments({
        requestedPath: args.adjustments,
        adjustmentsRoot: defaultAdjustmentsRoot(),
        finalRoot: path.resolve('output', 'final'),
        weeks,
      })
    : undefined
  const acquisition = await fetchTrackEntries({
    token,
    workspaceId,
    from: args.from,
    through: args.through,
  })
  const result = buildWeeklyPreviews(acquisition.entries, weeks, sampleInvoice.sender, { adjustments })
  const paymentDetails = frozenPaymentDetails()
  for (const preview of result.previews) {
    preview.invoice = invoiceSchema.parse({
      ...preview.invoice,
      ...(paymentDetails && { paymentDetails }),
    })
  }
  for (const preview of result.previews) {
    preview.audit.blockers.push(...acquisition.audit.blockers)
  }

  const createdAt = new Date().toISOString()
  const previewId = createdAt.replace(/[:.]/g, '-')
  const outputDirectory = path.resolve('output', 'previews', previewId)
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(
    path.join(outputDirectory, 'acquisition-audit.json'),
    jsonArtifact(acquisition.audit),
  )
  console.log('Safe acquisition audit:')
  console.log(JSON.stringify(acquisition.audit, null, 2))

  const sourceRecords: PreviewManifest['sources'] = []
  for (const preview of result.previews) {
    const invoiceNumber = preview.invoice.invoiceNumber
    const invoiceFile = `${invoiceNumber}.invoice.json`
    const auditFile = `${invoiceNumber}.audit.json`
    const invoiceArtifact = jsonArtifact(preview.invoice)
    const auditArtifact = jsonArtifact(preview.audit)
    await Promise.all([
      writeFile(path.join(outputDirectory, invoiceFile), invoiceArtifact),
      writeFile(path.join(outputDirectory, auditFile), auditArtifact),
    ])
    sourceRecords.push({
      invoiceNumber,
      invoiceFile,
      invoiceSha256: sha256(invoiceArtifact),
      auditFile,
      auditSha256: sha256(auditArtifact),
      totalCents: preview.audit.finalTotalCents,
    })
  }
  const previewManifest: PreviewManifest = {
    version: 1,
    previewId,
    createdAt,
    invoiceNumbers: result.previews.map(({ invoice }) => invoice.invoiceNumber),
    sources: sourceRecords,
    ...(adjustments && {
      adjustments: {
        invoiceNumber: result.previews[0].invoice.invoiceNumber,
        file: adjustments.source.file,
        sha256: adjustments.source.sha256,
      },
    }),
  }
  await writeFile(path.join(outputDirectory, 'preview-manifest.json'), jsonArtifact(previewManifest))

  const renderablePreviews = result.previews.filter(
    (preview) => preview.audit.blockers.length === 0,
  )
  if (renderablePreviews.length > 0 && result.unassignedBlockers.length === 0) {
    const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('Could not determine preview server port')
    const browser = await chromium.launch()

    try {
      for (const preview of renderablePreviews) {
        const encoded = Buffer.from(JSON.stringify(preview.invoice)).toString('base64url')
        const page = await browser.newPage()
        await page.goto(`http://127.0.0.1:${address.port}/?invoice=${encoded}`, { waitUntil: 'networkidle' })
        await page.pdf({ path: path.join(outputDirectory, `${preview.invoice.invoiceNumber}.preview.pdf`), format: 'Letter', printBackground: true })
        await page.close()
      }
    } finally {
      await browser.close()
      await vite.close()
    }
  }

  const summary = result.previews.map(({ audit }) => ({
    invoiceNumber: audit.invoiceNumber,
    billingPeriod: `${audit.billingPeriod.from} through ${audit.billingPeriod.through}`,
    rawHours: (audit.weeklyRawDurationSeconds / 3600).toFixed(4),
    ...(audit.manualAdjustments && {
      togglBilledHours: (audit.weeklyBilledQuarterUnits / 4).toFixed(2),
      adjustmentHours: ((audit.adjustmentQuarterUnits ?? 0) / 4).toFixed(2),
      adjustmentIds: audit.manualAdjustments.map(({ id }) => id).join(','),
      documentDate: audit.documentDates?.documentDate,
      dueDate: audit.documentDates?.dueDate,
    }),
    billedHours: ((audit.invoiceBilledQuarterUnits ?? audit.weeklyBilledQuarterUnits) / 4).toFixed(2),
    subtotal: money(audit.standardRateSubtotalCents),
    discount: money(audit.discountCents),
    total: money(audit.finalTotalCents),
    blockerCount: audit.blockers.length,
  }))
  await writeFile(path.join(outputDirectory, 'batch-summary.json'), jsonArtifact({ previewId, summaries: summary }))
  console.table(summary)
  console.log(`Preview artifacts: ${outputDirectory}`)
  if (result.unassignedBlockers.length > 0) {
    throw new Error(`Batch has ${result.unassignedBlockers.length} unassigned blocker(s); no PDFs were generated`)
  }
  if (acquisition.audit.blockers.length > 0) {
    throw new Error(acquisition.audit.blockers.map(({ message }) => message).join('; '))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
