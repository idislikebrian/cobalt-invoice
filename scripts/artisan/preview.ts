import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import { createBillingWeeks } from '../../src/artisan/batch.ts'
import { buildWeeklyPreviews } from '../../src/artisan/pipeline.ts'
import { sampleInvoice } from '../../src/invoice/sample-invoice.ts'
import { fetchTrackEntries } from './track.ts'

function argumentsFrom(argv: string[]): { from: string; through: string; startNumber: string } {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) throw new Error('Expected --from, --through, and --start-number')
    values.set(key, value)
  }
  const from = values.get('--from')
  const through = values.get('--through')
  const startNumber = values.get('--start-number')
  if (!from || !through || !startNumber) throw new Error('Expected --from, --through, and --start-number')
  return { from, through, startNumber }
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2))
  const token = process.env.TOGGL_API_TOKEN
  const workspaceId = process.env.TOGGL_WORKSPACE_ID
  if (!token || !workspaceId) throw new Error('Set server-only TOGGL_API_TOKEN and TOGGL_WORKSPACE_ID in .env.local')
  const weeks = createBillingWeeks(args.from, args.through, args.startNumber)
  const acquisition = await fetchTrackEntries({
    token,
    workspaceId,
    from: args.from,
    through: args.through,
  })
  const result = buildWeeklyPreviews(acquisition.entries, weeks, sampleInvoice.sender)
  for (const preview of result.previews) {
    preview.audit.blockers.push(...acquisition.audit.blockers)
  }

  const previewId = new Date().toISOString().replace(/[:.]/g, '-')
  const outputDirectory = path.resolve('output', 'previews', previewId)
  await mkdir(outputDirectory, { recursive: true })
  await writeFile(
    path.join(outputDirectory, 'acquisition-audit.json'),
    `${JSON.stringify(acquisition.audit, null, 2)}\n`,
  )
  console.log('Safe acquisition audit:')
  console.log(JSON.stringify(acquisition.audit, null, 2))

  for (const preview of result.previews) {
    await writeFile(path.join(outputDirectory, `${preview.invoice.invoiceNumber}.audit.json`), `${JSON.stringify(preview.audit, null, 2)}\n`)
  }

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
    billedHours: (audit.weeklyBilledQuarterUnits / 4).toFixed(2),
    subtotal: money(audit.standardRateSubtotalCents),
    discount: money(audit.discountCents),
    total: money(audit.finalTotalCents),
    blockerCount: audit.blockers.length,
  }))
  await writeFile(path.join(outputDirectory, 'batch-summary.json'), `${JSON.stringify({ previewId, summaries: summary }, null, 2)}\n`)
  console.table(summary)
  console.log(`Preview artifacts: ${outputDirectory}`)
  if (result.unassignedBlockers.length > 0) {
    throw new Error(`Batch has ${result.unassignedBlockers.length} unassigned blocker(s); no PDFs were generated`)
  }
  if (acquisition.audit.blockers.length > 0) {
    throw new Error(acquisition.audit.blockers.map(({ message }) => message).join('; '))
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
