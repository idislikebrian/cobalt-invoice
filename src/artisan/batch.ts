import { addDays, enumerateDates } from './dates'

export interface BillingWeek {
  invoiceNumber: string
  from: string
  through: string
  issueDate: string
  dueDate: string
  dates: string[]
}

export function createBillingWeeks(from: string, through: string, startNumber: string): BillingWeek[] {
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
    const issueDate = addDays(weekThrough, 1)
    weeks.push({
      invoiceNumber: String(start + weeks.length).padStart(width, '0'),
      from: weekFrom,
      through: weekThrough,
      issueDate,
      dueDate: addDays(issueDate, 14),
      dates: dates.slice(offset, offset + 7),
    })
  }
  return weeks
}
