import {
  ARTISAN_DESCRIPTION,
  ARTISAN_PROJECT,
  ARTISAN_TAGS,
  normalizeArtisanDescription,
} from '../../src/artisan/config.ts'
import { addDays, localMidnightInstant } from '../../src/artisan/dates.ts'
import type { TogglDetailedEntry } from '../../src/artisan/types.ts'
import type { ReviewMessage } from '../../src/artisan/types.ts'
import {
  assertTogglResponseOk,
  togglAuthorization,
} from './toggl.ts'

const TRACK_API_BASE = 'https://api.track.toggl.com/api/v9'
const TRACK_TIME_ENTRY_LIMIT = 1_000
const METADATA_PAGE_SIZE = 200

interface TrackMetadata {
  projectNames: Map<number, string>
  tagNames: Map<number, string>
}

interface DescriptionDiagnostic {
  value: string
  normalizedValue: string
  count: number
  codePoints: string[]
}

export interface TrackAcquisitionAudit {
  requestedRange: { from: string; through: string }
  counts: {
    completedEntries: number
    projectMatches: number
    normalizedDescriptionMatches: number
    entriesWithAnyRecognizedTag: number
    acceptedEntries: number
  }
  configuredDescription: DescriptionDiagnostic
  observedCobaltDescriptions: DescriptionDiagnostic[]
  relevantDescriptionCounts: Array<{ value: string; count: number }>
  relevantTagCounts: Array<{ value: string; count: number }>
  blockers: ReviewMessage[]
}

export interface TrackAcquisitionResult {
  entries: TogglDetailedEntry[]
  audit: TrackAcquisitionAudit
}

interface TrackEntryFacts {
  value: unknown
  workspaceId: number | null
  project: string | null
  description: string | null
  tags: string[]
  startMs: number
  stopMs: number
  completed: boolean
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function numericId(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function arrayResponse(value: unknown, context: string): unknown[] {
  if (Array.isArray(value)) return value
  const record = objectRecord(value)
  if (Array.isArray(record.data)) return record.data
  throw new Error(`${context} returned an unexpected response shape`)
}

function codePoints(value: string): string[] {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!
    return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(character)}`
  })
}

function groupedCounts(values: string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => left.value.localeCompare(right.value))
}

function descriptionDiagnostics(values: string[]): DescriptionDiagnostic[] {
  return groupedCounts(values).map(({ value, count }) => ({
    value,
    normalizedValue: normalizeArtisanDescription(value),
    count,
    codePoints: codePoints(value),
  }))
}

async function getJson(
  url: URL,
  context: string,
  token: string,
  authorization: string,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
  })
  await assertTogglResponseOk(response, context, token, authorization)
  return response.json()
}

async function getAllMetadata(
  path: string,
  context: string,
  token: string,
  authorization: string,
  fetchImpl: typeof fetch,
): Promise<unknown[]> {
  const items: unknown[] = []
  for (let page = 1; ; page += 1) {
    const url = new URL(`${TRACK_API_BASE}${path}`)
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', String(METADATA_PAGE_SIZE))
    if (path.endsWith('/projects')) {
      url.searchParams.set('sort_field', 'name')
      url.searchParams.set('sort_order', 'asc')
    }
    const response = arrayResponse(
      await getJson(url, context, token, authorization, fetchImpl),
      context,
    )
    items.push(...response)
    if (response.length < METADATA_PAGE_SIZE) return items
    if (page >= 1_000) throw new Error(`${context} pagination exceeded the safety limit`)
  }
}

export function normalizeTrackEntry(
  value: unknown,
  workspaceId: number,
  metadata: TrackMetadata,
): TogglDetailedEntry | null {
  const entry = objectRecord(value)
  const entryWorkspaceId = numericId(entry.workspace_id ?? entry.wid)
  const projectId = numericId(entry.project_id ?? entry.pid)
  const id = entry.id
  const start = typeof entry.start === 'string' ? entry.start : null
  const stop = typeof entry.stop === 'string' ? entry.stop : null
  const duration = typeof entry.duration === 'number' ? entry.duration : null
  if (entryWorkspaceId !== workspaceId || !stop || !start || !duration || duration <= 0) return null

  const project = projectId === null ? null : metadata.projectNames.get(projectId) ?? null
  const directTags = Array.isArray(entry.tags)
    ? entry.tags.filter((tag): tag is string => typeof tag === 'string')
    : []
  const resolvedTags = Array.isArray(entry.tag_ids)
    ? entry.tag_ids
      .map((tagId) => numericId(tagId))
      .filter((tagId): tagId is number => tagId !== null)
      .map((tagId) => metadata.tagNames.get(tagId))
      .filter((tag): tag is string => tag !== undefined)
    : []
  const tags = [...new Set([...directTags, ...resolvedTags])]
  const recognizedTags = tags.filter((tag) => Object.hasOwn(ARTISAN_TAGS, tag))
  if (
    project !== ARTISAN_PROJECT ||
    typeof entry.description !== 'string' ||
    normalizeArtisanDescription(entry.description) !== normalizeArtisanDescription(ARTISAN_DESCRIPTION) ||
    recognizedTags.length !== 1
  ) return null

  return {
    id: typeof id === 'number' || typeof id === 'string' ? String(id) : 'missing-id',
    start,
    stop,
    seconds: duration,
    project,
    description: ARTISAN_DESCRIPTION,
    tags,
  }
}

function trackEntryFacts(value: unknown, metadata: TrackMetadata): TrackEntryFacts {
  const entry = objectRecord(value)
  const projectId = numericId(entry.project_id ?? entry.pid)
  const directTags = Array.isArray(entry.tags)
    ? entry.tags.filter((tag): tag is string => typeof tag === 'string')
    : []
  const resolvedTags = Array.isArray(entry.tag_ids)
    ? entry.tag_ids
      .map((tagId) => numericId(tagId))
      .filter((tagId): tagId is number => tagId !== null)
      .map((tagId) => metadata.tagNames.get(tagId))
      .filter((tag): tag is string => tag !== undefined)
    : []
  const startMs = typeof entry.start === 'string' ? Date.parse(entry.start) : Number.NaN
  const stopMs = typeof entry.stop === 'string' ? Date.parse(entry.stop) : Number.NaN
  const duration = typeof entry.duration === 'number' ? entry.duration : null
  return {
    value,
    workspaceId: numericId(entry.workspace_id ?? entry.wid),
    project: projectId === null ? null : metadata.projectNames.get(projectId) ?? null,
    description: typeof entry.description === 'string' ? entry.description : null,
    tags: [...new Set([...directTags, ...resolvedTags])],
    startMs,
    stopMs,
    completed: Number.isFinite(startMs) && Number.isFinite(stopMs) && stopMs > startMs && typeof duration === 'number' && duration > 0,
  }
}

export async function fetchTrackEntries(options: {
  workspaceId: string
  token: string
  from: string
  through: string
  fetchImpl?: typeof fetch
}): Promise<TrackAcquisitionResult> {
  const parsedWorkspaceId = Number(options.workspaceId)
  if (!Number.isSafeInteger(parsedWorkspaceId) || parsedWorkspaceId <= 0) {
    throw new Error('TOGGL_WORKSPACE_ID must be a positive integer')
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const authorization = togglAuthorization(options.token)

  const workspaceUrl = new URL(`${TRACK_API_BASE}/workspaces/${parsedWorkspaceId}`)
  const workspace = objectRecord(await getJson(
    workspaceUrl,
    'Toggl workspace validation',
    options.token,
    authorization,
    fetchImpl,
  ))
  if (numericId(workspace.id ?? workspace.workspace_id) !== parsedWorkspaceId) {
    throw new Error('Toggl workspace validation returned a different workspace ID')
  }

  const [projects, tags] = await Promise.all([
    getAllMetadata(`/workspaces/${parsedWorkspaceId}/projects`, 'Toggl project metadata', options.token, authorization, fetchImpl),
    getAllMetadata(`/workspaces/${parsedWorkspaceId}/tags`, 'Toggl tag metadata', options.token, authorization, fetchImpl),
  ])
  const metadata: TrackMetadata = {
    projectNames: new Map<number, string>(),
    tagNames: new Map<number, string>(),
  }
  for (const project of projects) {
    const record = objectRecord(project)
    const id = numericId(record.id)
    if (id !== null && typeof record.name === 'string' && record.name.length > 0) {
      metadata.projectNames.set(id, record.name)
    }
  }
  for (const tag of tags) {
    const record = objectRecord(tag)
    const id = numericId(record.id)
    if (id !== null && typeof record.name === 'string' && record.name.length > 0) {
      metadata.tagNames.set(id, record.name)
    }
  }
  if (![...metadata.projectNames.values()].includes(ARTISAN_PROJECT)) {
    throw new Error(`Toggl project metadata does not contain “${ARTISAN_PROJECT}”`)
  }
  const missingTags = Object.keys(ARTISAN_TAGS).filter(
    (requiredTag) => ![...metadata.tagNames.values()].includes(requiredTag),
  )
  if (missingTags.length > 0) throw new Error(`Toggl tag metadata is missing: ${missingTags.join(', ')}`)

  const rangeStart = localMidnightInstant(options.from)
  const rangeEnd = localMidnightInstant(addDays(options.through, 1))
  const queryStart = localMidnightInstant(addDays(options.from, -1))
  const entriesUrl = new URL(`${TRACK_API_BASE}/me/time_entries`)
  entriesUrl.searchParams.set('start_date', new Date(queryStart).toISOString())
  entriesUrl.searchParams.set('end_date', new Date(rangeEnd).toISOString())
  const rawEntries = arrayResponse(
    await getJson(entriesUrl, 'Toggl Track time entries', options.token, authorization, fetchImpl),
    'Toggl Track time entries',
  )
  if (rawEntries.length >= TRACK_TIME_ENTRY_LIMIT) {
    throw new Error(`Toggl Track returned ${rawEntries.length} time entries, reaching its ${TRACK_TIME_ENTRY_LIMIT}-entry limit; refusing to produce potentially truncated invoices`)
  }

  const completedEntries = rawEntries
    .map((entry) => trackEntryFacts(entry, metadata))
    .filter((entry) => entry.completed && entry.stopMs > rangeStart && entry.startMs < rangeEnd)
  const workspaceEntries = completedEntries.filter((entry) => entry.workspaceId === parsedWorkspaceId)
  const projectEntries = workspaceEntries.filter((entry) => entry.project === ARTISAN_PROJECT)
  const descriptionEntries = projectEntries.filter(
    (entry) => entry.description !== null &&
      normalizeArtisanDescription(entry.description) === normalizeArtisanDescription(ARTISAN_DESCRIPTION),
  )
  const entriesWithRecognizedTag = descriptionEntries.filter(
    (entry) => entry.tags.some((tag) => Object.hasOwn(ARTISAN_TAGS, tag)),
  )
  const entries = entriesWithRecognizedTag
    .map((entry) => normalizeTrackEntry(entry.value, parsedWorkspaceId, metadata))
    .filter((entry): entry is TogglDetailedEntry => entry !== null)
  const relevantEntries = workspaceEntries.filter(
    (entry) => entry.description?.includes('Cobalt') || entry.tags.some((tag) => tag.startsWith('AB -')),
  )
  const blockers: ReviewMessage[] = entries.length === 0
    ? [{
        code: 'zero-accepted-entries',
        entryId: null,
        message: 'The entire requested batch contains zero accepted Artisan entries; refusing to generate zero-dollar PDFs',
      }]
    : []
  const configuredDescription = {
    value: ARTISAN_DESCRIPTION,
    normalizedValue: normalizeArtisanDescription(ARTISAN_DESCRIPTION),
    count: 1,
    codePoints: codePoints(ARTISAN_DESCRIPTION),
  }
  return {
    entries,
    audit: {
      requestedRange: { from: options.from, through: options.through },
      counts: {
        completedEntries: completedEntries.length,
        projectMatches: projectEntries.length,
        normalizedDescriptionMatches: descriptionEntries.length,
        entriesWithAnyRecognizedTag: entriesWithRecognizedTag.length,
        acceptedEntries: entries.length,
      },
      configuredDescription,
      observedCobaltDescriptions: descriptionDiagnostics(
        workspaceEntries
          .map((entry) => entry.description)
          .filter((description): description is string => description?.includes('Cobalt') ?? false),
      ),
      relevantDescriptionCounts: groupedCounts(
        relevantEntries
          .map((entry) => entry.description)
          .filter((description): description is string => description !== null),
      ),
      relevantTagCounts: groupedCounts(
        relevantEntries.flatMap((entry) => entry.tags.filter((tag) => tag.startsWith('AB -'))),
      ),
      blockers,
    },
  }
}
