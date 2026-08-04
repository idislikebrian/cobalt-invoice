import {
  ARTISAN_CATEGORIES,
  ARTISAN_DESCRIPTION,
  ARTISAN_PROJECT,
  ARTISAN_SERVICE_DESCRIPTION,
  ARTISAN_TAGS,
  ARTISAN_TIMEZONE,
  DISCOUNT_BASIS_POINTS,
  QUARTER_SECONDS,
  STANDARD_RATE_CENTS,
  normalizeArtisanDescription,
  type ArtisanCategory,
} from './config'
import { localDateAt, splitAcrossLocalDates, weekStartForDate } from './dates'
import type { BillingWeek } from './batch'
import type {
  BoundarySplitAudit,
  EntryAudit,
  GroupedCellAudit,
  ReviewMessage,
  TogglDetailedEntry,
  WeeklyPreview,
} from './types'
import { invoiceSchema, type InvoiceData } from '../invoice/schema'

const recognizedTags = new Set<string>(Object.keys(ARTISAN_TAGS))

function decimalQuarterHours(units: number): string {
  const whole = Math.floor(units / 4)
  return `${whole}${['', '.25', '.5', '.75'][units % 4]}`
}

function formattedPeriod(from: string, through: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  return `${formatter.format(new Date(`${from}T00:00:00Z`))} – ${formatter.format(new Date(`${through}T00:00:00Z`))}`
}

function blocker(entryId: string, code: string, message: string): ReviewMessage {
  return { code, entryId, message }
}

function validateEntry(entry: TogglDetailedEntry): { blockers: ReviewMessage[]; category: ArtisanCategory | null } {
  const blockers: ReviewMessage[] = []
  if (entry.project !== ARTISAN_PROJECT) blockers.push(blocker(entry.id, 'wrong-project', `Expected project “${ARTISAN_PROJECT}”; received ${JSON.stringify(entry.project)}`))
  if (
    !entry.description ||
    normalizeArtisanDescription(entry.description) !== normalizeArtisanDescription(ARTISAN_DESCRIPTION)
  ) blockers.push(blocker(entry.id, 'wrong-description', `Expected description “${ARTISAN_DESCRIPTION}”; received ${JSON.stringify(entry.description)}`))
  const matches = entry.tags.filter((tag) => recognizedTags.has(tag))
  if (matches.length === 0) blockers.push(blocker(entry.id, 'missing-artisan-tag', 'Entry has no recognized Artisan tag'))
  if (matches.length > 1) blockers.push(blocker(entry.id, 'conflicting-artisan-tags', `Entry has multiple recognized Artisan tags: ${matches.join(', ')}`))
  if (!entry.stop) blockers.push(blocker(entry.id, 'running-entry', 'Entry has no stop timestamp'))
  const startMs = entry.start ? Date.parse(entry.start) : Number.NaN
  const stopMs = entry.stop ? Date.parse(entry.stop) : Number.NaN
  const timestampSeconds = (stopMs - startMs) / 1000
  const durationSeconds = entry.seconds
  if (
    typeof durationSeconds !== 'number' ||
    !Number.isFinite(durationSeconds) ||
    !Number.isInteger(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(stopMs) ||
    stopMs <= startMs ||
    timestampSeconds !== durationSeconds
  ) {
    blockers.push(blocker(entry.id, 'invalid-duration', 'Entry requires valid start/stop timestamps and a matching positive integer duration in seconds'))
  }
  return {
    blockers,
    category: matches.length === 1 ? ARTISAN_TAGS[matches[0] as keyof typeof ARTISAN_TAGS] : null,
  }
}

function baseInvoice(week: BillingWeek, quarterUnits: number, cells: GroupedCellAudit[], sender: InvoiceData['sender']): InvoiceData {
  return invoiceSchema.parse({
    invoiceNumber: week.invoiceNumber,
    template: 'weekly-time',
    status: 'draft',
    issueDate: week.issueDate,
    dueDate: week.dueDate,
    currency: 'USD',
    sender,
    client: {
      name: 'Charlie McCoy',
      businessName: 'Artisan Barber',
      email: 'info@artisanbarber.com',
      billingNote: 'Terms: NET 14',
      address: { line1: '331 E 81st St', city: 'New York', region: 'NY', postalCode: '10028' },
    },
    lineItems: [{
      id: `artisan-services-${week.from}`,
      description: `${ARTISAN_SERVICE_DESCRIPTION} — ${formattedPeriod(week.from, week.through)}`,
      quantity: quarterUnits / 4,
      quantityQuarterUnits: quarterUnits,
      unitPriceCents: STANDARD_RATE_CENTS,
    }],
    discount: { type: 'percentage', rateBasisPoints: DISCOUNT_BASIS_POINTS, label: 'Friends & Family — 50%' },
    weeklyTimeWorklog: {
      timezone: ARTISAN_TIMEZONE,
      periodStart: week.from,
      periodEnd: week.through,
      dates: week.dates,
      project: ARTISAN_PROJECT,
      description: ARTISAN_DESCRIPTION,
      cells: cells.map(({ date, category, roundedQuarterUnits }) => ({ date, category, roundedQuarterUnits })),
    },
  })
}

export interface PipelineResult {
  previews: WeeklyPreview[]
  unassignedBlockers: ReviewMessage[]
}

export function buildWeeklyPreviews(entries: TogglDetailedEntry[], weeks: BillingWeek[], sender: InvoiceData['sender']): PipelineResult {
  const weekByStart = new Map(weeks.map((week) => [week.from, week]))
  const states = new Map(weeks.map((week) => [week.from, {
    entryIds: new Set<string>(),
    entries: new Map<string, EntryAudit>(),
    grouped: new Map<string, number>(),
    blockers: [] as ReviewMessage[],
    warnings: [] as ReviewMessage[],
  }]))
  const unassignedBlockers: ReviewMessage[] = []

  for (const entry of entries) {
    const validation = validateEntry(entry)
    const splits = entry.start && entry.stop ? splitAcrossLocalDates(entry.start, entry.stop) : []
    const possibleWeekStarts = new Set<string>()
    for (const split of splits) possibleWeekStarts.add(weekStartForDate(split.localDate))
    if (possibleWeekStarts.size === 0 && entry.start && Number.isFinite(Date.parse(entry.start))) {
      possibleWeekStarts.add(weekStartForDate(localDateAt(Date.parse(entry.start))))
    }
    const inBatchWeeks = [...possibleWeekStarts].filter((weekStart) => weekByStart.has(weekStart))
    if (inBatchWeeks.length === 0) {
      if (possibleWeekStarts.size === 0 && validation.blockers.length > 0) {
        unassignedBlockers.push(...validation.blockers, blocker(entry.id, 'unassigned-week', 'Entry cannot be assigned deterministically to a requested billing week'))
      }
      continue
    }

    for (const weekStart of inBatchWeeks) {
      const state = states.get(weekStart)!
      const weekSplits: BoundarySplitAudit[] = splits
        .filter((split) => weekStartForDate(split.localDate) === weekStart)
        .map((split) => ({ ...split, weekStart }))
      state.entryIds.add(entry.id)
      state.entries.set(entry.id, {
        id: entry.id,
        originalStart: entry.start,
        originalStop: entry.stop,
        localDates: [...new Set(weekSplits.map((split) => split.localDate))],
        project: entry.project,
        description: entry.description,
        tags: entry.tags,
        rawSeconds: entry.seconds,
        boundarySplits: weekSplits,
      })
      state.blockers.push(...validation.blockers)
      if (validation.blockers.length === 0 && validation.category) {
        for (const split of weekSplits) {
          const key = `${split.localDate}:${validation.category}`
          state.grouped.set(key, (state.grouped.get(key) ?? 0) + split.rawSeconds)
        }
      }
    }
  }

  const previews = weeks.map((week) => {
    const state = states.get(week.from)!
    const groupedCells: GroupedCellAudit[] = []
    for (const date of week.dates) {
      for (const category of ARTISAN_CATEGORIES) {
        const rawSeconds = state.grouped.get(`${date}:${category}`) ?? 0
        const roundedQuarterUnits = Math.round(rawSeconds / QUARTER_SECONDS)
        groupedCells.push({ date, category, rawSeconds, roundedQuarterUnits, roundedDecimalHours: decimalQuarterHours(roundedQuarterUnits) })
      }
    }
    const rawSeconds = groupedCells.reduce((sum, cell) => sum + cell.rawSeconds, 0)
    const quarterUnits = groupedCells.reduce((sum, cell) => sum + cell.roundedQuarterUnits, 0)
    const subtotalCents = (quarterUnits * STANDARD_RATE_CENTS) / 4
    const discountCents = (subtotalCents * DISCOUNT_BASIS_POINTS) / 10_000
    return {
      invoice: baseInvoice(week, quarterUnits, groupedCells, sender),
      audit: {
        invoiceNumber: week.invoiceNumber,
        billingPeriod: { from: week.from, through: week.through },
        sourceTogglEntryIds: [...state.entryIds],
        entries: [...state.entries.values()],
        groupedCells,
        weeklyRawDurationSeconds: rawSeconds,
        weeklyBilledDurationSeconds: quarterUnits * QUARTER_SECONDS,
        weeklyBilledQuarterUnits: quarterUnits,
        standardRateSubtotalCents: subtotalCents,
        discountCents,
        finalTotalCents: subtotalCents - discountCents,
        blockers: state.blockers,
        warnings: state.warnings,
      },
    }
  })
  return { previews, unassignedBlockers }
}
