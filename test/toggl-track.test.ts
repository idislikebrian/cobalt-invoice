import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fetchTrackEntries, normalizeTrackEntry } from '../scripts/artisan/track.ts'
import { normalizeArtisanDescription } from '../src/artisan/config.ts'

interface Fixture {
  workspace: Record<string, unknown>
  projects: Array<Record<string, unknown>>
  tags: Array<Record<string, unknown>>
  timeEntries: Array<Record<string, unknown>>
}

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/toggl-track-v9.json', import.meta.url), 'utf8'),
) as Fixture

function trackFetch(timeEntries: unknown[] = fixture.timeEntries): {
  fetchImpl: typeof fetch
  requests: Array<{ url: URL; method: string; authorization: string | null }>
} {
  const requests: Array<{ url: URL; method: string; authorization: string | null }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    const requestHeaders = new Headers(init?.headers)
    requests.push({
      url,
      method: init?.method ?? 'GET',
      authorization: requestHeaders.get('authorization'),
    })
    if (url.pathname === '/api/v9/workspaces/12345') return Response.json(fixture.workspace)
    if (url.pathname.endsWith('/projects')) return Response.json({ data: fixture.projects, total_count: fixture.projects.length })
    if (url.pathname.endsWith('/tags')) return Response.json(fixture.tags)
    if (url.pathname === '/api/v9/me/time_entries') return Response.json(timeEntries)
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl, requests }
}

test('normalizes Track entries by resolving project and tag IDs', () => {
  const normalized = normalizeTrackEntry(fixture.timeEntries[0], 12345, {
    projectNames: new Map([[101, 'Work/Career']]),
    tagNames: new Map([[201, 'AB - Dev']]),
  })
  assert.deepEqual(normalized, {
    id: '301',
    start: '2026-07-05T04:00:00.000Z',
    stop: '2026-07-05T04:15:00.000Z',
    seconds: 900,
    project: 'Work/Career',
    description: 'Cobalt -- Production',
    tags: ['AB - Dev'],
  })
})

test('uses read-only v9 endpoints, exact filters, completed entries, and New York range boundaries', async () => {
  const { fetchImpl, requests } = trackFetch()
  const acquisition = await fetchTrackEntries({
    workspaceId: '12345',
    token: 'fixture-token',
    from: '2026-07-05',
    through: '2026-07-11',
    fetchImpl,
  })
  assert.deepEqual(acquisition.entries.map(({ id }) => id), ['301', '302'])
  assert.deepEqual(acquisition.audit.counts, {
    completedEntries: 6,
    projectMatches: 4,
    normalizedDescriptionMatches: 3,
    entriesWithAnyRecognizedTag: 3,
    acceptedEntries: 2,
  })
  assert.equal(JSON.stringify(acquisition.audit).includes('Different description'), true)
  assert.equal(JSON.stringify(acquisition.audit).includes('Another Project'), false)
  assert.ok(requests.every(({ method }) => method === 'GET'))
  assert.ok(requests.every(({ authorization }) => authorization?.startsWith('Basic ')))
  const timeEntryRequest = requests.find(({ url }) => url.pathname.endsWith('/me/time_entries'))!
  assert.equal(timeEntryRequest.url.searchParams.get('start_date'), '2026-07-04T04:00:00.000Z')
  assert.equal(timeEntryRequest.url.searchParams.get('end_date'), '2026-07-12T04:00:00.000Z')
})

test('canonicalizes two hyphens, em dash, and en dash while retaining exact matching', async () => {
  const variants = ['Cobalt -- Production', 'Cobalt — Production', 'Cobalt – Production']
  assert.deepEqual(variants.map(normalizeArtisanDescription), variants.map(() => 'Cobalt -- Production'))
  assert.notEqual(normalizeArtisanDescription('Cobalt Production'), 'Cobalt -- Production')
  assert.notEqual(normalizeArtisanDescription('Cobalt — Production notes'), 'Cobalt -- Production')

  const timeEntries = variants.map((description, index) => ({
    ...fixture.timeEntries[0],
    id: 400 + index,
    description,
    start: `2026-07-0${5 + index}T13:00:00.000Z`,
    stop: `2026-07-0${5 + index}T13:15:00.000Z`,
  }))
  const { fetchImpl } = trackFetch(timeEntries)
  const acquisition = await fetchTrackEntries({
    workspaceId: '12345',
    token: 'fixture-token',
    from: '2026-07-05',
    through: '2026-07-11',
    fetchImpl,
  })
  assert.equal(acquisition.entries.length, 3)
  assert.equal(acquisition.audit.counts.normalizedDescriptionMatches, 3)
  assert.deepEqual(
    acquisition.audit.observedCobaltDescriptions.map(({ value, normalizedValue }) => ({ value, normalizedValue })),
    variants
      .map((value) => ({ value, normalizedValue: 'Cobalt -- Production' }))
      .sort((left, right) => left.value.localeCompare(right.value)),
  )
  assert.ok(
    acquisition.audit.observedCobaltDescriptions
      .find(({ value }) => value.includes('—'))!
      .codePoints.includes('U+2014 "—"'),
  )
  assert.ok(
    acquisition.audit.observedCobaltDescriptions
      .find(({ value }) => value.includes('–'))!
      .codePoints.includes('U+2013 "–"'),
  )
})

test('adds a batch blocker when acquisition accepts zero entries without exposing unrelated descriptions', async () => {
  const unrelated = [{
    ...fixture.timeEntries[0],
    id: 501,
    description: 'Confidential unrelated work',
    tag_ids: [],
    tags: [],
  }]
  const { fetchImpl } = trackFetch(unrelated)
  const acquisition = await fetchTrackEntries({
    workspaceId: '12345',
    token: 'fixture-token',
    from: '2026-07-05',
    through: '2026-07-11',
    fetchImpl,
  })
  assert.equal(acquisition.entries.length, 0)
  assert.equal(acquisition.audit.blockers[0]?.code, 'zero-accepted-entries')
  assert.equal(JSON.stringify(acquisition.audit).includes('Confidential unrelated work'), false)
})

test('fails closed when the Track time-entry result reaches the 1000-entry ceiling', async () => {
  const repeatedEntries = Array.from({ length: 1_000 }, (_, index) => ({
    ...fixture.timeEntries[0],
    id: 10_000 + index,
  }))
  const { fetchImpl } = trackFetch(repeatedEntries)
  await assert.rejects(
    fetchTrackEntries({
      workspaceId: '12345',
      token: 'fixture-token',
      from: '2026-07-05',
      through: '2026-07-11',
      fetchImpl,
    }),
    /reaching its 1000-entry limit; refusing to produce potentially truncated invoices/,
  )
})

test('fails workspace validation when Toggl returns another workspace', async () => {
  const { fetchImpl: baseFetch } = trackFetch()
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/api/v9/workspaces/12345') return Response.json({ id: 54321 })
    return baseFetch(input, init)
  }
  await assert.rejects(
    fetchTrackEntries({
      workspaceId: '12345',
      token: 'fixture-token',
      from: '2026-07-05',
      through: '2026-07-11',
      fetchImpl,
    }),
    /workspace validation returned a different workspace ID/,
  )
})
