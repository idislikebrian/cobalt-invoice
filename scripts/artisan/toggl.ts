import type { TogglDetailedEntry } from '../../src/artisan/types.ts'

const REPORTS_BASE = 'https://api.track.toggl.com/reports/api/v3/workspace'
const MAX_ERROR_BODY_CHARACTERS = 2_000

function redactSecrets(body: string, secrets: string[]): string {
  let redacted = body
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, '[REDACTED]')
  }
  return redacted
    .replace(/Basic\s+[A-Za-z0-9+/=_-]+/gi, 'Basic [REDACTED]')
    .replace(
      /(["']?(?:authorization|api[_-]?token|access[_-]?token|password|secret)["']?\s*[:=]\s*)(["'])[^"']*\2/gi,
      '$1$2[REDACTED]$2',
    )
}

async function boundedErrorBody(response: Response, secrets: string[]): Promise<string> {
  let body: string
  try {
    body = await response.text()
  } catch {
    return '<unavailable>'
  }
  if (body.length === 0) return '<empty>'
  const redacted = redactSecrets(body, secrets)
  if (redacted.length <= MAX_ERROR_BODY_CHARACTERS) return redacted
  return `${redacted.slice(0, MAX_ERROR_BODY_CHARACTERS)}… [truncated]`
}

export function togglAuthorization(token: string): string {
  return `Basic ${Buffer.from(`${token}:api_token`).toString('base64')}`
}

export async function assertTogglResponseOk(
  response: Response,
  context: string,
  token: string,
  authorization: string,
): Promise<void> {
  if (response.ok) return
  const responseBody = await boundedErrorBody(response, [token, authorization])
  const quotaRemaining = response.headers.get('x-toggl-quota-remaining') ?? '<unavailable>'
  const quotaResetsIn = response.headers.get('x-toggl-quota-resets-in') ?? '<unavailable>'
  throw new Error([
    `${context} failed with HTTP ${response.status}`,
    `response body: ${responseBody}`,
    `X-Toggl-Quota-Remaining: ${quotaRemaining}`,
    `X-Toggl-Quota-Resets-In: ${quotaResetsIn}`,
  ].join('; '))
}

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
  const authorization = togglAuthorization(options.token)
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
    await assertTogglResponseOk(response, 'Toggl detailed report', options.token, authorization)
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
