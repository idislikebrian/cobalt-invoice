import { addDays, enumerateDates } from './dates'

export interface BillingWeek {
  invoiceNumber: string
  from: string
  through: string
  issueDate: string
  dueDate: string
  dates: string[]
  /** Local (America/New_York) date the preview was generated, when known. */
  generatedOn: string | null
}

export const DOCUMENT_DATE_BASIS_WITH_GENERATION =
  'Later of the day after the billing period and the preview generation date (America/New_York). Document date only; not evidence of finalization or sending.'
export const DOCUMENT_DATE_BASIS_PERIOD_ONLY =
  'Day after the billing period. Document date only; not evidence of finalization or sending.'

/**
 * Creates Sunday–Saturday billing weeks.
 *
 * `generatedOn` is the local date the preview is being produced. When given,
 * the document (issue) date is never earlier than that date, so a late
 * preview does not back-date the invoice to the day after the billing period.
 * The due date stays NET 14 from the document date.
 */
export function createBillingWeeks(from: string, through: string, startNumber: string, generatedOn?: string): BillingWeek[] {
  if (generatedOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(generatedOn)) throw new Error('generatedOn must use YYYY-MM-DD')
  if (!/^\d+$/.test(startNumber)) throw new Error('start-number must contain digits only')
  const dates = enumerateDates(from, through)
  if (dates.length === 0 || dates.length % 7 !== 0) throw new Error('Billing range must contain complete Sunday–Saturday weeks')
  const start = Number(startNumber)
  const width = startNumber.length
  const weeks: BillingWeek[] = []
  for (let offset = 0; offset < dates.length; offset += 7) {
    const weekFrom = dates[offset]
    const weekThrough = dates[offset + 6]
    if (new Date(`${weekFrom}T00:00:00Z`).getUTCDay() !== 0 || new Date(`${weekThrough}T00:00:00Z`).getUTCDay() !== 6) {
      throw new Error('Billing range must align to Sunday–Saturday weeks')
    }
    const dayAfterPeriod = addDays(weekThrough, 1)
    const issueDate = generatedOn && generatedOn > dayAfterPeriod ? generatedOn : dayAfterPeriod
    weeks.push({
      invoiceNumber: String(start + weeks.length).padStart(width, '0'),
      from: weekFrom,
      through: weekThrough,
      issueDate,
      dueDate: addDays(issueDate, 14),
      dates: dates.slice(offset, offset + 7),
      generatedOn: generatedOn ?? null,
    })
  }
  return weeks
}
