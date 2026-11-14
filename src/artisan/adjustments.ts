import { z } from 'zod'
import { ARTISAN_CATEGORIES, STANDARD_RATE_CENTS, type ArtisanCategory } from './config'
import type { BillingWeek } from './batch'

/**
 * Approved, previously untracked work for one Artisan billing week.
 *
 * An adjustment records real work that was performed but not timed in Toggl,
 * together with its approval provenance. It never carries start/stop
 * timestamps, so it cannot be mistaken for Toggl time evidence, and the rate is
 * not configurable: it is billed at STANDARD_RATE_CENTS with the same discount.
 *
 * Internally the adjustment stays separate (audit, manifest, exactly-once).
 * On the client-facing invoice it is presented as part of the single weekly
 * service line, and in the worklog cell for its work date and category.
 */

const ADJUSTMENT_ID = /^[a-z0-9][a-z0-9-]{2,79}$/
export const ADJUSTMENT_FILE_NAME = /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.json$/
const MAX_QUARTER_UNITS_PER_ADJUSTMENT = 40

const approvalReferenceSchema = z.object({
  label: z.string().trim().min(1).max(160),
  url: z.url(),
}).strict()

const approvalSchema = z.object({
  approvedBy: z.string().trim().min(1).max(120),
  approvedAt: z.iso.datetime({ offset: true }),
  source: z.string().trim().min(1).max(200),
  statement: z.string().trim().min(1).max(2000),
  references: z.array(approvalReferenceSchema).min(1).max(5),
}).strict()

export const artisanAdjustmentSchema = z.object({
  id: z.string().regex(ADJUSTMENT_ID, 'Adjustment id must be 3–80 lowercase letters, digits, or hyphens'),
  kind: z.literal('supplemental-billable-time'),
  workDate: z.iso.date(),
  quarterUnits: z.number().int().positive().max(MAX_QUARTER_UNITS_PER_ADJUSTMENT),
  /** Worklog category the untracked work belongs to (client-facing breakdown). */
  worklogCategory: z.enum(ARTISAN_CATEGORIES as [ArtisanCategory, ...ArtisanCategory[]]),
  /** Internal bookkeeping note; never rendered on the invoice. */
  internalNote: z.string().trim().min(1).max(240),
  approval: approvalSchema,
}).strict()

export const artisanAdjustmentFileSchema = z.object({
  version: z.literal(1),
  invoiceNumber: z.string().regex(/^\d{6}$/),
  billingPeriod: z.object({ from: z.iso.date(), through: z.iso.date() }).strict(),
  adjustments: z.array(artisanAdjustmentSchema).min(1).max(10),
}).strict()

export type ArtisanAdjustment = z.infer<typeof artisanAdjustmentSchema>
export type ArtisanAdjustmentFile = z.infer<typeof artisanAdjustmentFileSchema>

export interface AdjustmentSource {
  file: string
  sha256: string
}

export interface ValidatedAdjustments {
  source: AdjustmentSource
  billingPeriod: { from: string; through: string }
  adjustments: ArtisanAdjustment[]
}

/** Audit record for one adjustment, frozen into the weekly audit artifact. */
export interface AdjustmentAudit extends ArtisanAdjustment {
  unitPriceCents: number
  standardRateAmountCents: number
}

export interface WorklogCell {
  date: string
  category: ArtisanCategory
  roundedQuarterUnits: number
}

/**
 * Parse and validate a raw adjustment file against the exact billing weeks of
 * a preview batch. Fails closed on any schema, period, date, or uniqueness error.
 */
export function parseAdjustmentFile(options: {
  raw: string
  fileName: string
  sha256: string
  weeks: BillingWeek[]
  now?: Date
}): ValidatedAdjustments {
  if (!ADJUSTMENT_FILE_NAME.test(options.fileName)) {
    throw new Error('Adjustment file name must be <from>_<through>.json')
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(options.raw)
  } catch {
    throw new Error('Adjustment file is not valid JSON')
  }
  const result = artisanAdjustmentFileSchema.safeParse(parsedJson)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(`Adjustment file is invalid at ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'schema error'}`)
  }
  const file = result.data
  const { from, through } = file.billingPeriod
  if (options.fileName !== `${from}_${through}.json`) {
    throw new Error('Adjustment file name must match its billing period')
  }
  if (options.weeks.length !== 1 || options.weeks[0].from !== from || options.weeks[0].through !== through) {
    throw new Error('Adjustments require a single-week preview whose range exactly matches the adjustment billing period')
  }
  if (options.weeks[0].invoiceNumber !== file.invoiceNumber) {
    throw new Error('Adjustment invoice number must match the preview invoice number')
  }
  const ids = new Set<string>()
  const now = (options.now ?? new Date()).getTime()
  for (const adjustment of file.adjustments) {
    if (ids.has(adjustment.id)) throw new Error(`Duplicate adjustment id: ${adjustment.id}`)
    ids.add(adjustment.id)
    if (adjustment.workDate < from || adjustment.workDate > through) {
      throw new Error(`Adjustment ${adjustment.id} work date is outside the billing period`)
    }
    if (Date.parse(adjustment.approval.approvedAt) > now) {
      throw new Error(`Adjustment ${adjustment.id} approval timestamp is in the future`)
    }
  }
  return {
    source: { file: options.fileName, sha256: options.sha256 },
    billingPeriod: file.billingPeriod,
    adjustments: file.adjustments,
  }
}

/**
 * Client-facing worklog cells: the Toggl-derived cells, plus each approved
 * adjustment added to the cell for its work date and category. Toggl cells are
 * copied, never mutated, so the audit's Toggl evidence is unchanged; existing
 * cell order is kept and any new cell is appended in adjustment order.
 */
export function presentedWorklogCells(togglCells: readonly WorklogCell[], adjustments: readonly ArtisanAdjustment[]): WorklogCell[] {
  const cells = togglCells.map(({ date, category, roundedQuarterUnits }) => ({ date, category, roundedQuarterUnits }))
  for (const adjustment of adjustments) {
    const cell = cells.find(({ date, category }) => date === adjustment.workDate && category === adjustment.worklogCategory)
    if (cell) cell.roundedQuarterUnits += adjustment.quarterUnits
    else cells.push({ date: adjustment.workDate, category: adjustment.worklogCategory, roundedQuarterUnits: adjustment.quarterUnits })
  }
  return cells
}

export function adjustmentAudits(adjustments: ArtisanAdjustment[]): AdjustmentAudit[] {
  return adjustments.map((adjustment) => ({
    ...adjustment,
    unitPriceCents: STANDARD_RATE_CENTS,
    standardRateAmountCents: (adjustment.quarterUnits * STANDARD_RATE_CENTS) / 4,
  }))
}
