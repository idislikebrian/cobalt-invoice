import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createBillingWeeks } from '../src/artisan/batch.ts'
import { ARTISAN_TAGS, STANDARD_RATE_CENTS } from '../src/artisan/config.ts'
import { localDateAt, localMidnightInstant, splitAcrossLocalDates, weekStartForDate } from '../src/artisan/dates.ts'
import { buildWeeklyPreviews } from '../src/artisan/pipeline.ts'
import type { TogglDetailedEntry } from '../src/artisan/types.ts'
import { calculateDiscount, calculateSubtotal, calculateTotal } from '../src/invoice/calculations.ts'
import { sampleInvoice } from '../src/invoice/sample-invoice.ts'

const fixturePath = new URL('./fixtures/artisan-toggl.json', import.meta.url)
const valid = (adjustments: Partial<TogglDetailedEntry> = {}): TogglDetailedEntry => ({
  id: 'entry', start: '2026-07-06T13:00:00Z', stop: '2026-07-06T14:00:00Z', seconds: 3600,
  project: 'Work/Career', description: 'Cobalt -- Production', tags: ['AB - Dev'], ...adjustments,
})

test('creates the specified five Sunday–Saturday invoice mappings', () => {
  const weeks = createBillingWeeks('2026-06-28', '2026-08-01', '000702')
  assert.deepEqual(weeks.map(({ invoiceNumber, from, through, issueDate, dueDate }) => ({ invoiceNumber, from, through, issueDate, dueDate })), [
    { invoiceNumber: '000702', from: '2026-06-28', through: '2026-07-04', issueDate: '2026-07-05', dueDate: '2026-07-19' },
    { invoiceNumber: '000703', from: '2026-07-05', through: '2026-07-11', issueDate: '2026-07-12', dueDate: '2026-07-26' },
    { invoiceNumber: '000704', from: '2026-07-12', through: '2026-07-18', issueDate: '2026-07-19', dueDate: '2026-08-02' },
    { invoiceNumber: '000705', from: '2026-07-19', through: '2026-07-25', issueDate: '2026-07-26', dueDate: '2026-08-09' },
    { invoiceNumber: '000706', from: '2026-07-26', through: '2026-08-01', issueDate: '2026-08-02', dueDate: '2026-08-16' },
  ])
})

test('uses America/New_York dates and Sunday week boundaries', () => {
  assert.equal(localDateAt(Date.parse('2026-07-05T03:59:59Z')), '2026-07-04')
  assert.equal(localDateAt(Date.parse('2026-07-05T04:00:00Z')), '2026-07-05')
  assert.equal(weekStartForDate('2026-07-04'), '2026-06-28')
  assert.equal(weekStartForDate('2026-07-05'), '2026-07-05')
})

test('resolves DST-safe local midnights', () => {
  const before = localMidnightInstant('2026-03-08')
  const after = localMidnightInstant('2026-03-09')
  assert.equal((after - before) / 3_600_000, 23)
  assert.equal(localDateAt(after), '2026-03-09')
})

test('splits at local midnight and Sunday boundary', () => {
  const splits = splitAcrossLocalDates('2026-07-12T03:50:00Z', '2026-07-12T04:20:00Z')
  assert.deepEqual(splits.map(({ localDate, rawSeconds }) => ({ localDate, rawSeconds })), [
    { localDate: '2026-07-11', rawSeconds: 600 },
    { localDate: '2026-07-12', rawSeconds: 1200 },
  ])
  assert.deepEqual(splits.map((split) => weekStartForDate(split.localDate)), ['2026-07-05', '2026-07-12'])
})

test('groups before nearest-quarter rounding and displays zero as zero units', async () => {
  const entries = JSON.parse(await readFile(fixturePath, 'utf8')) as TogglDetailedEntry[]
  const weeks = createBillingWeeks('2026-07-05', '2026-07-18', '000703')
  const { previews } = buildWeeklyPreviews(entries, weeks, sampleInvoice.sender)
  const first = previews[0]
  const dev = first.audit.groupedCells.find((cell) => cell.date === '2026-07-06' && cell.category === 'DEV')!
  const admin = first.audit.groupedCells.find((cell) => cell.date === '2026-07-07' && cell.category === 'ADMIN')!
  assert.deepEqual({ raw: dev.rawSeconds, units: dev.roundedQuarterUnits, hours: dev.roundedDecimalHours }, { raw: 480, units: 1, hours: '0.25' })
  assert.deepEqual({ raw: admin.rawSeconds, units: admin.roundedQuarterUnits, hours: admin.roundedDecimalHours }, { raw: 420, units: 0, hours: '0' })
  assert.equal(first.invoice.weeklyTimeWorklog?.cells.find((cell) => cell.date === '2026-07-07' && cell.category === 'ADMIN')?.roundedQuarterUnits, 0)
})

test('maps exact tags and blocks missing/conflicting tags and malformed source fields', () => {
  assert.deepEqual(ARTISAN_TAGS, {
    'AB - Admin': 'ADMIN', 'AB - Design': 'DESIGN', 'AB - Dev': 'DEV', 'AB - Meeting': 'MEETINGS', 'AB - Video': 'VIDEO',
  })
  const entries = [
    valid({ id: 'missing', tags: [] }),
    valid({ id: 'conflict', tags: ['AB - Dev', 'AB - Design'] }),
    valid({ id: 'project', project: 'Wrong' }),
    valid({ id: 'description', description: 'Wrong' }),
    valid({ id: 'running', stop: null, seconds: null }),
  ]
  const { previews } = buildWeeklyPreviews(entries, createBillingWeeks('2026-07-05', '2026-07-11', '000703'), sampleInvoice.sender)
  assert.deepEqual(new Set(previews[0].audit.blockers.map(({ code }) => code)), new Set([
    'missing-artisan-tag', 'conflicting-artisan-tags', 'wrong-project', 'wrong-description', 'running-entry', 'invalid-duration',
  ]))
})

test('calculates each quarter at $30 subtotal and $15 after discount using cents', () => {
  const { previews } = buildWeeklyPreviews([valid({ seconds: 900, stop: '2026-07-06T13:15:00Z' })], createBillingWeeks('2026-07-05', '2026-07-11', '000703'), sampleInvoice.sender)
  const preview = previews[0]
  assert.equal(STANDARD_RATE_CENTS, 12_000)
  assert.equal(preview.audit.standardRateSubtotalCents, 3_000)
  assert.equal(preview.audit.discountCents, 1_500)
  assert.equal(preview.audit.finalTotalCents, 1_500)
  assert.equal(calculateSubtotal(preview.invoice.lineItems), 3_000)
  assert.equal(calculateDiscount(preview.invoice), 1_500)
  assert.equal(calculateTotal(preview.invoice), 1_500)
})

test('leaves the standard invoice data path unchanged', () => {
  assert.equal(sampleInvoice.template, undefined)
  assert.equal(sampleInvoice.weeklyTimeWorklog, undefined)
  assert.equal(calculateTotal(sampleInvoice), 45_000)
})
