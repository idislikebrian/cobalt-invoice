import type { ArtisanCategory } from './config'
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

export interface WeeklyAudit {
  invoiceNumber: string
  billingPeriod: { from: string; through: string }
  sourceTogglEntryIds: string[]
  entries: EntryAudit[]
  groupedCells: GroupedCellAudit[]
  weeklyRawDurationSeconds: number
  weeklyBilledDurationSeconds: number
  weeklyBilledQuarterUnits: number
  standardRateSubtotalCents: number
  discountCents: number
  finalTotalCents: number
  blockers: ReviewMessage[]
  warnings: ReviewMessage[]
}

export interface WeeklyPreview {
  invoice: InvoiceData
  audit: WeeklyAudit
}
