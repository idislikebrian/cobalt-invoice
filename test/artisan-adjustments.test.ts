import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createServer } from 'vite'
import { parseAdjustmentFile, presentedWorklogCells, type ArtisanAdjustmentFile } from '../src/artisan/adjustments.ts'
import { createBillingWeeks } from '../src/artisan/batch.ts'
import { buildWeeklyPreviews } from '../src/artisan/pipeline.ts'
import type { TogglDetailedEntry, WeeklyPreview } from '../src/artisan/types.ts'
import { calculateDiscount, calculateSubtotal, calculateTotal } from '../src/invoice/calculations.ts'
import { sampleInvoice } from '../src/invoice/sample-invoice.ts'
import { canonicalAdjustmentPath, execute, parseCommand, previewRunnerArgs } from '../scripts/artisan/canonical-workflow.ts'
import {
  finalizedAdjustmentIds,
  jsonArtifact,
  sha256,
  validateFinalizationSource,
  type PreviewManifest,
} from '../scripts/artisan/finalization.ts'
import { argumentsFrom, loadAdjustments } from '../scripts/artisan/preview.ts'

const FILE_NAME = '2026-11-01_2026-11-07.json'
const W45 = () => createBillingWeeks('2026-11-01', '2026-11-07', '000729')

// Synthetic W45 entries totaling 26 quarter units; no actual time-entry data.
const entry = (id: string, start: string, stop: string, tag: string): TogglDetailedEntry => ({
  id, start, stop, seconds: (Date.parse(stop) - Date.parse(start)) / 1000,
  project: 'Work/Career', description: 'Cobalt — Production', tags: [tag],
})
const W45_ENTRIES: TogglDetailedEntry[] = [
  entry('w45-1', '2026-11-02T15:00:00Z', '2026-11-02T16:30:00Z', 'AB - Dev'),
  entry('w45-2', '2026-11-02T17:00:00Z', '2026-11-02T18:00:00Z', 'AB - Admin'),
  entry('w45-3', '2026-11-03T15:00:00Z', '2026-11-03T16:00:00Z', 'AB - Admin'),
  entry('w45-4', '2026-11-03T17:00:00Z', '2026-11-03T17:30:00Z', 'AB - Admin'),
  entry('w45-5', '2026-11-04T15:00:00Z', '2026-11-04T16:00:00Z', 'AB - Dev'),
  entry('w45-6', '2026-11-04T17:00:00Z', '2026-11-04T18:00:00Z', 'AB - Dev'),
  entry('w45-7', '2026-11-06T15:00:00Z', '2026-11-06T15:30:00Z', 'AB - Admin'),
]

function adjustmentFile(overrides: Partial<ArtisanAdjustmentFile['adjustments'][number]> = {}): ArtisanAdjustmentFile {
  return {
    version: 1,
    invoiceNumber: '000729',
    billingPeriod: { from: '2026-11-01', through: '2026-11-07' },
    adjustments: [{
      id: 'artisan-2026w45-carousel-supplement',
      kind: 'supplemental-billable-time',
      workDate: '2026-11-07',
      quarterUnits: 4,
      worklogCategory: 'DESIGN',
      internalNote: 'Synthetic design work not timed in Toggl',
      approval: {
        approvedBy: 'Test approver',
        approvedAt: '2026-11-07T13:00:00-05:00',
        source: 'Synthetic approval fixture',
        statement: 'Approved one hour of previously untracked design work for this billing period.',
        references: [{ label: 'Synthetic approval reference', url: 'https://example.test/approval' }],
      },
      ...overrides,
    }],
  }
}

function parse(file: unknown, options: { fileName?: string; weeks?: ReturnType<typeof W45>; now?: Date } = {}) {
  const raw = jsonArtifact(file)
  return parseAdjustmentFile({
    raw,
    fileName: options.fileName ?? FILE_NAME,
    sha256: sha256(raw),
    weeks: options.weeks ?? W45(),
    now: options.now ?? new Date('2026-11-10T12:00:00Z'),
  })
}

// ---------------------------------------------------------------- pipeline

test('unadjusted W45 preview is unchanged: one Toggl line item, 26 quarter units, $390', () => {
  const [preview] = buildWeeklyPreviews(W45_ENTRIES, W45(), sampleInvoice.sender).previews
  assert.equal(preview.invoice.lineItems.length, 1)
  assert.equal(preview.audit.weeklyBilledQuarterUnits, 26)
  assert.equal(preview.audit.weeklyRawDurationSeconds, 23400)
  assert.equal(preview.audit.standardRateSubtotalCents, 78000)
  assert.equal(preview.audit.finalTotalCents, 39000)
  for (const key of ['manualAdjustments', 'adjustmentSource', 'adjustmentQuarterUnits', 'invoiceBilledQuarterUnits']) {
    assert.equal(key in preview.audit, false, `${key} must be absent without adjustments`)
  }
})

test('adjusted W45 preview consolidates into one 7.50 h line while the audit keeps Toggl and untracked time separate', () => {
  const adjustments = parse(adjustmentFile())
  const [preview] = buildWeeklyPreviews(W45_ENTRIES, W45(), sampleInvoice.sender, { adjustments }).previews
  const [plain] = buildWeeklyPreviews(W45_ENTRIES, W45(), sampleInvoice.sender).previews
  // Client-facing: one weekly service line, same id/description/rate as the unadjusted invoice.
  assert.equal(preview.invoice.lineItems.length, 1)
  const [line] = preview.invoice.lineItems
  assert.deepEqual(
    { ...line, quantity: undefined, quantityQuarterUnits: undefined },
    { ...plain.invoice.lineItems[0], quantity: undefined, quantityQuarterUnits: undefined },
  )
  assert.equal(line.quantity, 7.5)
  assert.equal(line.quantityQuarterUnits, 30)
  assert.equal(line.unitPriceCents, 12000)
  assert.equal(line.detail, undefined)
  // Client-facing worklog: Toggl cells unchanged, plus 1.0 h DESIGN on Sat Nov 7; sums to the billed 7.50 h.
  const cells = preview.invoice.weeklyTimeWorklog!.cells
  const isSatDesign = (cell: { date: string; category: string }) => cell.date === '2026-11-07' && cell.category === 'DESIGN'
  assert.deepEqual(cells.filter((cell) => !isSatDesign(cell)), plain.invoice.weeklyTimeWorklog!.cells.filter((cell) => !isSatDesign(cell)))
  assert.equal(plain.invoice.weeklyTimeWorklog!.cells.find(isSatDesign)?.roundedQuarterUnits, 0)
  assert.equal(cells.find(isSatDesign)?.roundedQuarterUnits, 4)
  assert.equal(cells.reduce((sum, cell) => sum + cell.roundedQuarterUnits, 0), 30)
  // Internal: Toggl evidence and rounding untouched, and identical to the unadjusted audit.
  assert.equal(preview.audit.weeklyBilledQuarterUnits, 26)
  assert.equal(preview.audit.weeklyRawDurationSeconds, 23400)
  assert.deepEqual(preview.audit.groupedCells, plain.audit.groupedCells)
  assert.deepEqual(preview.audit.entries, plain.audit.entries)
  assert.deepEqual(preview.audit.sourceTogglEntryIds, plain.audit.sourceTogglEntryIds)
  assert.equal(preview.audit.groupedCells.reduce((sum, cell) => sum + cell.roundedQuarterUnits, 0), 26)
  // Internal: approved untracked hour with provenance.
  assert.equal(preview.audit.adjustmentQuarterUnits, 4)
  assert.equal(preview.audit.invoiceBilledQuarterUnits, 30)
  assert.equal(preview.audit.manualAdjustments?.[0].approval.approvedAt, '2026-11-07T13:00:00-05:00')
  assert.match(preview.audit.manualAdjustments?.[0].approval.statement ?? '', /previously untracked design work/)
  assert.equal(preview.audit.manualAdjustments?.[0].approval.references[0].url, 'https://example.test/approval')
  assert.equal(preview.audit.manualAdjustments?.[0].standardRateAmountCents, 12000)
  assert.equal(preview.audit.adjustmentSource?.file, FILE_NAME)
  // Totals: 7.50 h × $120 = $900, 50% discount, $450.
  assert.equal(calculateSubtotal(preview.invoice.lineItems), 90000)
  assert.equal(calculateDiscount(preview.invoice), 45000)
  assert.equal(calculateTotal(preview.invoice), 45000)
  assert.equal(preview.audit.standardRateSubtotalCents, 90000)
  assert.equal(preview.audit.finalTotalCents, 45000)
})

test('presented worklog adds untracked time into an existing cell without mutating Toggl evidence', () => {
  const toggl = [
    { date: '2026-11-07', category: 'DESIGN' as const, roundedQuarterUnits: 3 },
    { date: '2026-11-02', category: 'DEV' as const, roundedQuarterUnits: 5 },
  ]
  const frozen = structuredClone(toggl)
  const [adjustment] = adjustmentFile().adjustments
  assert.deepEqual(presentedWorklogCells(toggl, [adjustment]), [
    { date: '2026-11-07', category: 'DESIGN', roundedQuarterUnits: 7 },
    { date: '2026-11-02', category: 'DEV', roundedQuarterUnits: 5 },
  ])
  assert.deepEqual(toggl, frozen)
  assert.deepEqual(presentedWorklogCells(toggl, []), toggl)
})

test('pipeline refuses adjustments for multi-week or mismatched batches', () => {
  const adjustments = parse(adjustmentFile())
  assert.throws(
    () => buildWeeklyPreviews([], createBillingWeeks('2026-10-25', '2026-11-07', '000728'), sampleInvoice.sender, { adjustments }),
    /single-week batch/,
  )
  assert.throws(
    () => buildWeeklyPreviews([], createBillingWeeks('2026-11-08', '2026-11-14', '000730'), sampleInvoice.sender, { adjustments }),
    /single-week batch/,
  )
})

// --------------------------------------------------------- adjustment schema

test('adjustment schema fails closed on malformed, ambiguous, or out-of-period input', () => {
  const base = adjustmentFile()
  const cases: Array<[unknown, RegExp, { fileName?: string; weeks?: ReturnType<typeof W45>; now?: Date }?]> = [
    [{ ...base, adjustments: [...base.adjustments, base.adjustments[0]] }, /Duplicate adjustment id/],
    [adjustmentFile({ workDate: '2026-11-08' }), /outside the billing period/],
    [adjustmentFile({ quarterUnits: 0 }), /quarterUnits/],
    [adjustmentFile({ quarterUnits: 1.5 }), /quarterUnits/],
    [adjustmentFile({ id: 'Bad Id' }), /\bid\b/],
    [{ ...base, adjustments: [{ ...base.adjustments[0], start: '2026-11-07T12:00:00Z' }] }, /invalid/],
    [{ ...base, adjustments: [{ ...base.adjustments[0], unitPriceCents: 1 }] }, /invalid/],
    [{ ...base, adjustments: [{ ...base.adjustments[0], worklogCategory: 'SOCIAL' }] }, /worklogCategory/],
    [{ ...base, adjustments: [{ ...base.adjustments[0], worklogCategory: undefined }] }, /worklogCategory/],
    [{ ...base, adjustments: [{ ...base.adjustments[0], description: 'Client-facing label' }] }, /invalid/],
    [{ ...base, adjustments: [{ ...base.adjustments[0], detail: 'Client-facing note' }] }, /invalid/],
    [{ ...base, adjustments: [{ ...base.adjustments[0], approval: { ...base.adjustments[0].approval, statement: ' ' } }] }, /approval\.statement/],
    [{ ...base, adjustments: [{ ...base.adjustments[0], approval: { ...base.adjustments[0].approval, references: [] } }] }, /approval\.references/],
    [{ ...base, adjustments: [{ ...base.adjustments[0], approval: { ...base.adjustments[0].approval, approvedAt: '2026-11-07' } }] }, /approval\.approvedAt/],
    [{ ...base, version: 2 }, /version/],
    [{ ...base, invoiceNumber: '000730' }, /invoice number must match/],
    [{ ...base, invoiceNumber: '729' }, /invoiceNumber/],
    [base, /approval timestamp is in the future/, { now: new Date('2026-11-07T17:00:00Z') }],
    [base, /must match its billing period/, { fileName: '2026-11-08_2026-11-14.json' }],
    [base, /<from>_<through>\.json/, { fileName: 'w45.json' }],
    [base, /single-week preview/, { weeks: createBillingWeeks('2026-10-25', '2026-11-07', '000728') }],
  ]
  for (const [file, pattern, options] of cases) {
    assert.throws(() => parse(file, options), pattern)
  }
  assert.throws(
    () => parseAdjustmentFile({ raw: '{not json', fileName: FILE_NAME, sha256: 'x', weeks: W45() }),
    /not valid JSON/,
  )
})

// ------------------------------------------------------------ document dates

test('unadjusted invoices keep the original document date and gain no date audit', () => {
  // preview.ts passes no generation date for unadjusted batches; this is the result.
  const [week] = createBillingWeeks('2026-11-01', '2026-11-07', '000729')
  assert.equal(week.issueDate, '2026-11-08')
  assert.equal(week.dueDate, '2026-11-22')
  const [preview] = buildWeeklyPreviews(W45_ENTRIES, [week], sampleInvoice.sender).previews
  assert.equal(preview.invoice.issueDate, '2026-11-08')
  assert.equal(preview.invoice.dueDate, '2026-11-22')
  assert.equal('documentDates' in preview.audit, false)
})

test('adjusted invoice document date is never back-dated before the preview generation date', () => {
  const late = createBillingWeeks('2026-11-01', '2026-11-07', '000729', '2026-11-11')[0]
  assert.equal(late.issueDate, '2026-11-11')
  assert.equal(late.dueDate, '2026-11-25')
  const onTime = createBillingWeeks('2026-11-01', '2026-11-07', '000729', '2026-11-05')[0]
  assert.equal(onTime.issueDate, '2026-11-08')
  assert.equal(onTime.dueDate, '2026-11-22')
  const legacy = createBillingWeeks('2026-11-01', '2026-11-07', '000729')[0]
  assert.equal(legacy.issueDate, '2026-11-08')
  assert.equal(legacy.generatedOn, null)
  assert.throws(() => createBillingWeeks('2026-11-01', '2026-11-07', '000729', '11/11/2026'), /generatedOn/)

  const adjustments = parse(adjustmentFile())
  const [preview] = buildWeeklyPreviews(W45_ENTRIES, [late], sampleInvoice.sender, { adjustments }).previews
  assert.equal(preview.invoice.issueDate, '2026-11-11')
  assert.deepEqual(preview.audit.documentDates, {
    billingPeriod: { from: '2026-11-01', through: '2026-11-07' },
    documentDate: '2026-11-11',
    dueDate: '2026-11-25',
    documentDateBasis: preview.audit.documentDates?.documentDateBasis,
    previewGeneratedOn: '2026-11-11',
    notIssuanceEvidence: true,
  })
  assert.match(preview.audit.documentDates?.documentDateBasis ?? '', /not evidence of finalization or sending/)
})

// --------------------------------------------------------- finalization gate

interface Fixture {
  root: string
  previewDirectory: string
  finalRoot: string
  adjustmentsRoot: string
  adjustmentPath: string
}

async function writePreview(directory: string, preview: WeeklyPreview, manifestExtra: Partial<PreviewManifest> = {}) {
  const invoiceRaw = jsonArtifact(preview.invoice)
  const auditRaw = jsonArtifact(preview.audit)
  const invoiceNumber = preview.invoice.invoiceNumber
  await writeFile(path.join(directory, `${invoiceNumber}.invoice.json`), invoiceRaw)
  await writeFile(path.join(directory, `${invoiceNumber}.audit.json`), auditRaw)
  const manifest: PreviewManifest = {
    version: 1,
    previewId: 'fixture-preview',
    createdAt: '2026-11-11T12:00:00.000Z',
    invoiceNumbers: [invoiceNumber],
    sources: [{
      invoiceNumber,
      invoiceFile: `${invoiceNumber}.invoice.json`,
      invoiceSha256: sha256(invoiceRaw),
      auditFile: `${invoiceNumber}.audit.json`,
      auditSha256: sha256(auditRaw),
      totalCents: preview.audit.finalTotalCents,
    }],
    ...manifestExtra,
  }
  await writeFile(path.join(directory, 'preview-manifest.json'), jsonArtifact(manifest))
}

async function adjustedFixture(): Promise<Fixture & { preview: WeeklyPreview }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'artisan-adjustments-'))
  const previewDirectory = path.join(root, 'preview')
  const finalRoot = path.join(root, 'final')
  const adjustmentsRoot = path.join(root, 'artisan-adjustments')
  await Promise.all([mkdir(previewDirectory), mkdir(finalRoot), mkdir(adjustmentsRoot)])
  const adjustmentPath = path.join(adjustmentsRoot, FILE_NAME)
  await writeFile(adjustmentPath, jsonArtifact(adjustmentFile()))
  const weeks = createBillingWeeks('2026-11-01', '2026-11-07', '000729', '2026-11-11')
  const adjustments = await loadAdjustments({
    requestedPath: adjustmentPath, adjustmentsRoot, finalRoot, weeks, now: new Date('2026-11-11T12:00:00Z'),
  })
  const [preview] = buildWeeklyPreviews(W45_ENTRIES, weeks, sampleInvoice.sender, { adjustments }).previews
  await writePreview(previewDirectory, preview, {
    adjustments: { invoiceNumber: '000729', file: adjustments.source.file, sha256: adjustments.source.sha256 },
  })
  return { root, previewDirectory, finalRoot, adjustmentsRoot, adjustmentPath, preview }
}

const validate = (fixture: Fixture) => validateFinalizationSource({
  previewDirectory: fixture.previewDirectory,
  invoiceNumbers: ['000729'],
  finalRoot: fixture.finalRoot,
  adjustmentsRoot: fixture.adjustmentsRoot,
})

test('finalization accepts an intact adjusted preview and reports the adjustment id', async (context) => {
  const fixture = await adjustedFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const validated = await validate(fixture)
  assert.deepEqual(validated.sources[0].manualAdjustmentIds, ['artisan-2026w45-carousel-supplement'])
  assert.equal(validated.sources[0].totalCents, 45000)
})

test('finalization fails closed when the adjustment source changes or disappears after preview', async (context) => {
  const fixture = await adjustedFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const changed = adjustmentFile({ quarterUnits: 8 })
  await writeFile(fixture.adjustmentPath, jsonArtifact(changed))
  await assert.rejects(validate(fixture), /Adjustment source changed after preview/)
  await rm(fixture.adjustmentPath)
  await assert.rejects(validate(fixture), /Adjustment source for invoice 000729 is missing/)
})

test('finalization requires an adjustments root for adjusted previews', async (context) => {
  const fixture = await adjustedFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  await assert.rejects(
    validateFinalizationSource({ previewDirectory: fixture.previewDirectory, invoiceNumbers: ['000729'], finalRoot: fixture.finalRoot }),
    /adjustments root is required/,
  )
})

test('finalization rejects re-hashed snapshots whose client presentation no longer matches Toggl evidence plus the frozen source', async (context) => {
  const fixture = await adjustedFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const tampered = structuredClone(fixture.preview)
  // Move the untracked hour to a different day in the client-facing worklog only.
  const cellOf = (preview: WeeklyPreview, date: string, category: string) =>
    preview.invoice.weeklyTimeWorklog!.cells.find((cell) => cell.date === date && cell.category === category)!
  cellOf(tampered, '2026-11-07', 'DESIGN').roundedQuarterUnits = 0
  cellOf(tampered, '2026-11-06', 'DESIGN').roundedQuarterUnits = 4
  const manifest = JSON.parse(await readFile(path.join(fixture.previewDirectory, 'preview-manifest.json'), 'utf8')) as PreviewManifest
  await writePreview(fixture.previewDirectory, tampered, { adjustments: manifest.adjustments })
  await assert.rejects(validate(fixture), /differs from its frozen adjustment source/)
  // Inflate the worklog without touching the billed line.
  const inflated = structuredClone(fixture.preview)
  cellOf(inflated, '2026-11-07', 'DESIGN').roundedQuarterUnits = 8
  await writePreview(fixture.previewDirectory, inflated, { adjustments: manifest.adjustments })
  await assert.rejects(validate(fixture), /differs from its frozen adjustment source/)
  // Shift hours from the Toggl evidence into the untracked hour while keeping totals.
  const shifted = structuredClone(fixture.preview)
  // (Toggl evidence claims 25 qu, the untracked hour is presented as 5 qu.)
  shifted.audit.groupedCells.find((cell) => cell.roundedQuarterUnits > 0)!.roundedQuarterUnits -= 1
  shifted.audit.weeklyBilledQuarterUnits -= 1
  shifted.audit.adjustmentQuarterUnits = 5
  await writePreview(fixture.previewDirectory, shifted, { adjustments: manifest.adjustments })
  await assert.rejects(validate(fixture), /differs from its (frozen adjustment source|audit)/)
  // Re-introduce a separate client-facing adjustment line.
  const split = structuredClone(fixture.preview)
  split.invoice.lineItems = [
    { ...split.invoice.lineItems[0], quantity: 6.5, quantityQuarterUnits: 26 },
    { ...split.invoice.lineItems[0], id: 'extra', quantity: 1, quantityQuarterUnits: 4 },
  ]
  await writePreview(fixture.previewDirectory, split, { adjustments: manifest.adjustments })
  await assert.rejects(validate(fixture), /differs from its audit/)
})

test('finalization rejects adjustment data that the preview manifest does not declare', async (context) => {
  const fixture = await adjustedFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  await writePreview(fixture.previewDirectory, fixture.preview) // manifest written without `adjustments`
  await assert.rejects(validate(fixture), /does not declare/)
})

test('an adjustment id can be finalized exactly once', async (context) => {
  const fixture = await adjustedFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const priorFinal = path.join(fixture.finalRoot, '2026-11-12T00-00-00-000Z')
  await mkdir(priorFinal)
  await writeFile(path.join(priorFinal, 'finalization-manifest.json'), jsonArtifact({
    version: 1,
    manualAdjustments: [{ invoiceNumber: '000731', ids: ['artisan-2026w45-carousel-supplement'], sourceFile: FILE_NAME, sourceSha256: 'a'.repeat(64) }],
  }))
  assert.equal((await finalizedAdjustmentIds(fixture.finalRoot)).get('artisan-2026w45-carousel-supplement'), '2026-11-12T00-00-00-000Z')
  await assert.rejects(validate(fixture), /already finalized in 2026-11-12T00-00-00-000Z/)
  await assert.rejects(
    loadAdjustments({
      requestedPath: fixture.adjustmentPath,
      adjustmentsRoot: fixture.adjustmentsRoot,
      finalRoot: fixture.finalRoot,
      weeks: W45(),
      now: new Date('2026-11-11T12:00:00Z'),
    }),
    /already finalized/,
  )
})

test('unadjusted previews still finalize and gain no adjustment ids', async (context) => {
  const fixture = await adjustedFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const [plain] = buildWeeklyPreviews(W45_ENTRIES, W45(), sampleInvoice.sender).previews
  await writePreview(fixture.previewDirectory, plain)
  const validated = await validate(fixture)
  assert.deepEqual(validated.sources[0].manualAdjustmentIds, [])
  assert.equal(validated.sources[0].totalCents, 39000)
})

test('unadjusted previews may not carry adjustment-only document-date data', async (context) => {
  const fixture = await adjustedFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const [plain] = buildWeeklyPreviews(W45_ENTRIES, W45(), sampleInvoice.sender).previews
  const smuggled = structuredClone(plain)
  smuggled.audit.documentDates = structuredClone(fixture.preview.audit.documentDates)
  await writePreview(fixture.previewDirectory, smuggled)
  await assert.rejects(validate(fixture), /does not declare/)
})

test('adjusted previews must keep their document-date audit consistent with the invoice', async (context) => {
  const fixture = await adjustedFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const manifest = JSON.parse(await readFile(path.join(fixture.previewDirectory, 'preview-manifest.json'), 'utf8')) as PreviewManifest
  const shifted = structuredClone(fixture.preview)
  shifted.invoice.issueDate = '2026-11-08'
  await writePreview(fixture.previewDirectory, shifted, { adjustments: manifest.adjustments })
  await assert.rejects(validate(fixture), /differs from its frozen adjustment source/)
  const missing = structuredClone(fixture.preview)
  delete missing.audit.documentDates
  await writePreview(fixture.previewDirectory, missing, { adjustments: manifest.adjustments })
  await assert.rejects(validate(fixture), /differs from its frozen adjustment source/)
})

// ------------------------------------------------- exactly-once fails closed

async function finalRootWith(setup: (finalRoot: string) => Promise<void>) {
  const finalRoot = await mkdtemp(path.join(os.tmpdir(), 'artisan-final-'))
  await setup(finalRoot)
  return finalRoot
}

const legacyManifest = { version: 1, finalizedAt: '2026-10-01T19:47:18.639Z', invoiceNumbers: ['000700'] }

test('exactly-once scan skips legacy loose PDFs and accepts legacy manifests without adjustments', async (context) => {
  const finalRoot = await finalRootWith(async (root) => {
    await writeFile(path.join(root, '20260909-000699--alesage.pdf'), '%PDF-1.4 legacy')
    await mkdir(path.join(root, '2026-10-01T19-47-18-639Z'))
    await writeFile(path.join(root, '2026-10-01T19-47-18-639Z', 'finalization-manifest.json'), jsonArtifact(legacyManifest))
  })
  context.after(() => rm(finalRoot, { recursive: true, force: true }))
  assert.equal((await finalizedAdjustmentIds(finalRoot)).size, 0)
  assert.equal((await finalizedAdjustmentIds(path.join(finalRoot, 'does-not-exist'))).size, 0)
})

test('exactly-once scan fails closed on any unreadable or malformed finalization record', async (context) => {
  const record = (name: string) => async (root: string) => {
    await mkdir(path.join(root, name))
  }
  const cases: Array<[string, (root: string) => Promise<void>, RegExp]> = [
    ['directory without manifest', record('2026-11-12T00-00-00-000Z'), /has no finalization manifest/],
    ['manifest is unreadable (a directory)', async (root) => {
      await mkdir(path.join(root, 'r', 'finalization-manifest.json'), { recursive: true })
    }, /is unreadable/],
    ['manifest is not JSON', async (root) => {
      await mkdir(path.join(root, 'r'))
      await writeFile(path.join(root, 'r', 'finalization-manifest.json'), '{"version": 1, "manualAdj')
    }, /is not valid JSON/],
    ['manifest is not an object', async (root) => {
      await mkdir(path.join(root, 'r'))
      await writeFile(path.join(root, 'r', 'finalization-manifest.json'), 'null')
    }, /Malformed finalization manifest in r/],
    ['manifest has an unknown version', async (root) => {
      await mkdir(path.join(root, 'r'))
      await writeFile(path.join(root, 'r', 'finalization-manifest.json'), jsonArtifact({ ...legacyManifest, version: 2 }))
    }, /Malformed finalization manifest/],
    ['manualAdjustments is not an array', async (root) => {
      await mkdir(path.join(root, 'r'))
      await writeFile(path.join(root, 'r', 'finalization-manifest.json'), jsonArtifact({ ...legacyManifest, manualAdjustments: { ids: ['x'] } }))
    }, /Malformed finalization manifest/],
    ['adjustment ids are not strings', async (root) => {
      await mkdir(path.join(root, 'r'))
      await writeFile(path.join(root, 'r', 'finalization-manifest.json'), jsonArtifact({ ...legacyManifest, manualAdjustments: [{ ids: [42] }] }))
    }, /Malformed finalization manifest/],
    ['adjustment record has no ids', async (root) => {
      await mkdir(path.join(root, 'r'))
      await writeFile(path.join(root, 'r', 'finalization-manifest.json'), jsonArtifact({ ...legacyManifest, manualAdjustments: [{ ids: [] }] }))
    }, /Malformed finalization manifest/],
    ['symlinked entry in final root', async (root) => {
      const elsewhere = await mkdtemp(path.join(os.tmpdir(), 'artisan-elsewhere-'))
      await symlink(elsewhere, path.join(root, 'linked'))
    }, /Unexpected non-directory entry linked/],
  ]
  for (const [label, setup, pattern] of cases) {
    const finalRoot = await finalRootWith(setup)
    context.after(() => rm(finalRoot, { recursive: true, force: true }))
    await assert.rejects(finalizedAdjustmentIds(finalRoot), pattern, label)
  }
})

test('a corrupt finalization record blocks adjusted preview and finalization, but not unadjusted finalization', async (context) => {
  const fixture = await adjustedFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  await mkdir(path.join(fixture.finalRoot, '2026-11-12T00-00-00-000Z'))
  await writeFile(path.join(fixture.finalRoot, '2026-11-12T00-00-00-000Z', 'finalization-manifest.json'), 'not json')
  await writeFile(path.join(fixture.finalRoot, '20260909-000699--alesage.pdf'), '%PDF-1.4 legacy')
  await assert.rejects(validate(fixture), /not valid JSON; cannot verify adjustment usage/)
  await assert.rejects(
    loadAdjustments({
      requestedPath: fixture.adjustmentPath,
      adjustmentsRoot: fixture.adjustmentsRoot,
      finalRoot: fixture.finalRoot,
      weeks: W45(),
      now: new Date('2026-11-11T12:00:00Z'),
    }),
    /not valid JSON; cannot verify adjustment usage/,
  )
  const [plain] = buildWeeklyPreviews(W45_ENTRIES, W45(), sampleInvoice.sender).previews
  await writePreview(fixture.previewDirectory, plain)
  assert.equal((await validate(fixture)).sources[0].totalCents, 39000)
})

// ------------------------------------------------------ launcher & arguments

test('adjustment files are accepted only inside the canonical adjustments directory', async (context) => {
  const fixture = await adjustedFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  assert.equal(await canonicalAdjustmentPath(fixture.adjustmentPath, fixture.adjustmentsRoot), fixture.adjustmentPath)
  const outside = path.join(fixture.root, FILE_NAME)
  await writeFile(outside, jsonArtifact(adjustmentFile()))
  await assert.rejects(canonicalAdjustmentPath(outside, fixture.adjustmentsRoot), /canonical artisan-adjustments directory/)
  const linked = path.join(fixture.adjustmentsRoot, '2026-11-08_2026-11-14.json')
  await symlink(outside, linked)
  await assert.rejects(canonicalAdjustmentPath(linked, fixture.adjustmentsRoot), /canonical artisan-adjustments directory/)
  const misnamed = path.join(fixture.adjustmentsRoot, 'w45.json')
  await writeFile(misnamed, '{}')
  await assert.rejects(canonicalAdjustmentPath(misnamed, fixture.adjustmentsRoot), /<from>_<through>\.json/)
  await assert.rejects(
    loadAdjustments({ requestedPath: outside, adjustmentsRoot: fixture.adjustmentsRoot, finalRoot: fixture.finalRoot, weeks: W45() }),
    /canonical artisan-adjustments directory/,
  )
})

test('launcher forwards --adjustments only when supplied and still rejects unknown options', async () => {
  assert.deepEqual(previewRunnerArgs('2026-11-01', '2026-11-07', '000729'), [
    'run', '--silent', 'invoice:artisan:preview', '--', '--from', '2026-11-01', '--through', '2026-11-07', '--start-number', '000729',
  ])
  assert.deepEqual(previewRunnerArgs('2026-11-01', '2026-11-07', '000729', '/x/2026-11-01_2026-11-07.json').slice(-2), [
    '--adjustments', '/x/2026-11-01_2026-11-07.json',
  ])
  await assert.rejects(
    execute(parseCommand(['artisan-preview', '--from', '2026-11-01', '--through', '2026-11-07', '--start-number', '000729', '--hours', '1'])),
    /Unexpected option for artisan-preview/,
  )
  await assert.rejects(
    execute(parseCommand(['artisan-validate', '--preview-id', 'x', '--preview-path', '/x', '--invoice-numbers', '000729', '--adjustments', '/x'])),
    /Unexpected option for artisan-validate/,
  )
  assert.throws(() => argumentsFrom(['--from', 'a', '--through', 'b', '--start-number', 'c', '--rate', '1']), /Unexpected option/)
  assert.throws(() => argumentsFrom(['--from', 'a', '--from', 'a', '--through', 'b', '--start-number', 'c']), /Duplicate option/)
  assert.deepEqual(argumentsFrom(['--from', 'a', '--through', 'b', '--start-number', 'c']), { from: 'a', through: 'b', startNumber: 'c' })
})

// ---------------------------------------------------------------- rendering

test('adjusted preview PDF shows one consolidated 7.50 h line and no internal bookkeeping labels', async (context) => {
  const fixture = await adjustedFixture()
  context.after(() => rm(fixture.root, { recursive: true, force: true }))
  const vite = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  await vite.listen()
  const address = vite.httpServer?.address()
  assert.ok(address && typeof address !== 'string')
  const browser = await chromium.launch()
  const pdfPath = path.join(fixture.root, 'adjusted.pdf')
  try {
    const encoded = Buffer.from(JSON.stringify(fixture.preview.invoice)).toString('base64url')
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/?invoice=${encoded}&render=preview`, { waitUntil: 'networkidle' })
    await page.pdf({ path: pdfPath, format: 'Letter', printBackground: true })
    await page.close()
  } finally {
    await browser.close()
    await vite.close()
  }
  const document = await getDocument({ data: new Uint8Array(await readFile(pdfPath)) }).promise
  let text = ''
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const content = await (await document.getPage(pageNumber)).getTextContent()
    text += ` ${content.items.map((item) => 'str' in item ? item.str : '').join(' ')}`
  }
  const flat = text.replace(/\s+/g, ' ')
  assert.match(flat, /Creative Direction — November 1, 2026 – November 7, 2026/)
  assert.match(flat, /\b7\.5\b/)
  assert.match(flat, /\$120\.00/)
  assert.match(flat, /\$900\.00/)
  assert.match(flat, /−\$450\.00/)
  assert.match(flat, /Total \$450\.00/)
  for (const internal of [/adjust/i, /toggl/i, /supplement/i, /untracked/i, /manual/i, /carousel/i, /approv/i]) {
    assert.doesNotMatch(flat, internal)
  }
  assert.match(flat, /November 11, 2026|Nov(ember)? 11, 2026/)
})
