import type { ArtisanCategory } from './config'
import type { AdjustmentAudit, AdjustmentSource } from './adjustments'
import type { InvoiceData } from '../invoice/schema'

export interface TogglDetailedEntry {
  id: string
  start: string | null
  stop: string | null
  seconds: number | null
  project: string | null
  description: string | null
  tags: string[]
}

export interface ReviewMessage {
  code: string
  entryId: string | null
  message: string
}

export interface BoundarySplitAudit {
  localDate: string
  weekStart: string
  start: string
  stop: string
  rawSeconds: number
}

export interface EntryAudit {
  id: string
  originalStart: string | null
  originalStop: string | null
  localDates: string[]
  project: string | null
  description: string | null
  tags: string[]
  rawSeconds: number | null
  boundarySplits: BoundarySplitAudit[]
}

export interface GroupedCellAudit {
  date: string
  category: ArtisanCategory
  rawSeconds: number
  roundedQuarterUnits: number
  roundedDecimalHours: string
}

/**
 * Explicit date semantics for a weekly invoice. The document date is the date
 * printed on the invoice; it is not evidence of finalization or sending.
 * Finalization time is recorded in the finalization manifest, and sending is
 * recorded outside Invoice Studio.
 */
export interface DocumentDatesAudit {
  billingPeriod: { from: string; through: string }
  documentDate: string
  dueDate: string
  documentDateBasis: string
  previewGeneratedOn: string | null
  notIssuanceEvidence: true
}

export interface WeeklyAudit {
  invoiceNumber: string
  billingPeriod: { from: string; through: string }
  sourceTogglEntryIds: string[]
  entries: EntryAudit[]
  groupedCells: GroupedCellAudit[]
  weeklyRawDurationSeconds: number
  weeklyBilledDurationSeconds: number
  /** Toggl-derived billed quarter units only (line item 1). */
  weeklyBilledQuarterUnits: number
  /** Invoice subtotal across every line item, including any manual adjustments. */
  standardRateSubtotalCents: number
  discountCents: number
  finalTotalCents: number
  blockers: ReviewMessage[]
  warnings: ReviewMessage[]
  /** Present only on manually adjusted invoices (see manualAdjustments). */
  documentDates?: DocumentDatesAudit
  /** Present only when manually approved, non-Toggl adjustments were applied. */
  manualAdjustments?: AdjustmentAudit[]
  adjustmentSource?: AdjustmentSource
  adjustmentQuarterUnits?: number
  invoiceBilledQuarterUnits?: number
}

export interface WeeklyPreview {
  invoice: InvoiceData
  audit: WeeklyAudit
}
