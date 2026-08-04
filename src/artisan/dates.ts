import { ARTISAN_TIMEZONE } from './config'

const localPartsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ARTISAN_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

export function localDateAt(epochMilliseconds: number): string {
  const parts = Object.fromEntries(
    localPartsFormatter.formatToParts(epochMilliseconds).map(({ type, value }) => [type, value]),
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function weekday(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay()
}

export function weekStartForDate(isoDate: string): string {
  return addDays(isoDate, -weekday(isoDate))
}

export function localMidnightInstant(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number)
  const desiredAsUtc = Date.UTC(year, month - 1, day)
  let candidate = desiredAsUtc

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = Object.fromEntries(
      localPartsFormatter.formatToParts(candidate).map(({ type, value }) => [type, value]),
    )
    const representedAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    )
    candidate -= representedAsUtc - desiredAsUtc
  }

  if (localDateAt(candidate) !== isoDate) {
    throw new Error(`Could not resolve local midnight for ${isoDate}`)
  }

  return candidate
}

export interface DateSplit {
  localDate: string
  start: string
  stop: string
  rawSeconds: number
}

export function splitAcrossLocalDates(startIso: string, stopIso: string): DateSplit[] {
  const start = Date.parse(startIso)
  const stop = Date.parse(stopIso)
  if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start) return []

  const splits: DateSplit[] = []
  let cursor = start
  while (cursor < stop) {
    const localDate = localDateAt(cursor)
    const nextMidnight = localMidnightInstant(addDays(localDate, 1))
    const end = Math.min(stop, nextMidnight)
    splits.push({
      localDate,
      start: new Date(cursor).toISOString(),
      stop: new Date(end).toISOString(),
      rawSeconds: Math.round((end - cursor) / 1000),
    })
    cursor = end
  }
  return splits
}

export function enumerateDates(start: string, end: string): string[] {
  const dates: string[] = []
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date)
  return dates
}
