import type { TogglDetailedEntry } from '../../src/artisan/types.ts'

const REPORTS_BASE = 'https://api.track.toggl.com/reports/api/v3/workspace'

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

export function normalizeDetailedEntry(value: unknown): TogglDetailedEntry {
  const entry = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rawId = entry.time_entry_id ?? entry.id
  return {
    id: typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : 'missing-id',
    start: stringOrNull(entry.start),
    stop: stringOrNull(entry.stop ?? entry.end),
    seconds: numberOrNull(entry.seconds ?? entry.duration),
    project: stringOrNull(entry.project ?? entry.project_name),
    description: stringOrNull(entry.description),
    tags: stringArray(entry.tags ?? entry.tag_names),
  }
}

function responseRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (Array.isArray(object.data)) return object.data
    if (Array.isArray(object.time_entries)) return object.time_entries
  }
  throw new Error('Toggl detailed report returned an unexpected response shape')
}

export function normalizeDetailedResponse(value: unknown): TogglDetailedEntry[] {
  return responseRows(value).flatMap((value) => {
    const row = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    if (!Array.isArray(row.time_entries)) return [normalizeDetailedEntry(row)]
    return row.time_entries.map((nested) => normalizeDetailedEntry({
      ...row,
      ...(nested && typeof nested === 'object' ? nested as Record<string, unknown> : {}),
      time_entry_id: nested && typeof nested === 'object'
        ? (nested as Record<string, unknown>).id ?? row.time_entry_id
        : row.time_entry_id,
    }))
  })
}

export async function fetchDetailedEntries(options: {
  workspaceId: string
  token: string
  from: string
  through: string
  fetchImpl?: typeof fetch
}): Promise<TogglDetailedEntry[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const authorization = `Basic ${Buffer.from(`${options.token}:api_token`).toString('base64')}`
  const entries: TogglDetailedEntry[] = []
  let firstId: number | undefined
  let firstRowNumber: number | undefined
  const cursors = new Set<string>()

  for (;;) {
    const body: Record<string, unknown> = {
      start_date: options.from,
      end_date: options.through,
      description: 'Cobalt -- Production',
      enrich_response: true,
      grouped: false,
      rounding: 0,
      rounding_minutes: 0,
      page_size: 100,
      order_by: 'date',
      order_dir: 'ASC',
    }
    if (firstId !== undefined) body.first_id = firstId
    if (firstRowNumber !== undefined) body.first_row_number = firstRowNumber

    const response = await fetchImpl(`${REPORTS_BASE}/${encodeURIComponent(options.workspaceId)}/search/time_entries`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Toggl detailed report failed with HTTP ${response.status}`)
    entries.push(...normalizeDetailedResponse(await response.json()))

    const nextIdHeader = response.headers.get('x-next-id')
    const nextRowHeader = response.headers.get('x-next-row-number')
    if (!nextIdHeader && !nextRowHeader) break
    const cursor = `${nextIdHeader ?? ''}:${nextRowHeader ?? ''}`
    if (cursors.has(cursor)) throw new Error('Toggl pagination cursor repeated')
    cursors.add(cursor)
    firstId = nextIdHeader ? Number(nextIdHeader) : undefined
    firstRowNumber = nextRowHeader ? Number(nextRowHeader) : undefined
    if ((firstId !== undefined && !Number.isInteger(firstId)) || (firstRowNumber !== undefined && !Number.isInteger(firstRowNumber))) {
      throw new Error('Toggl returned an invalid pagination cursor')
    }
  }
  return entries
}
