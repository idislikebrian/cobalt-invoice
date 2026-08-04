import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchDetailedEntries, normalizeDetailedResponse } from '../scripts/artisan/toggl.ts'

test('flattens current detailed-report rows with nested time entries', () => {
  const entries = normalizeDetailedResponse([{
    project_name: 'Work/Career', description: 'Cobalt -- Production', tag_names: ['AB - Video'],
    time_entries: [{ id: 44, start: '2026-07-07T13:00:00Z', stop: '2026-07-07T13:15:00Z', seconds: 900 }],
  }])
  assert.deepEqual(entries, [{
    id: '44', start: '2026-07-07T13:00:00Z', stop: '2026-07-07T13:15:00Z', seconds: 900,
    project: 'Work/Career', description: 'Cobalt -- Production', tags: ['AB - Video'],
  }])
})

test('paginates detailed reports with both Toggl cursors and never serializes the token', async () => {
  const bodies: Array<Record<string, unknown>> = []
  const headers: Array<HeadersInit | undefined> = []
  const pages = [
    new Response(JSON.stringify([{ time_entry_id: 1, start: '2026-07-06T13:00:00Z', stop: '2026-07-06T14:00:00Z', seconds: 3600, project: 'Work/Career', description: 'Cobalt -- Production', tags: ['AB - Dev'] }]), { headers: { 'x-next-id': '8', 'x-next-row-number': '101' } }),
    new Response(JSON.stringify([{ time_entry_id: 2, start: '2026-07-06T14:00:00Z', stop: '2026-07-06T15:00:00Z', seconds: 3600, project: 'Work/Career', description: 'Cobalt -- Production', tags: ['AB - Design'] }]))
  ]
  const fetchImpl: typeof fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    headers.push(init?.headers)
    return pages.shift()!
  }
  const entries = await fetchDetailedEntries({ workspaceId: 'fixture-workspace', token: 'fixture-secret-token', from: '2026-07-05', through: '2026-07-11', fetchImpl })
  assert.equal(entries.length, 2)
  assert.deepEqual({ first_id: bodies[1].first_id, first_row_number: bodies[1].first_row_number }, { first_id: 8, first_row_number: 101 })
  assert.equal(JSON.stringify(bodies).includes('fixture-secret-token'), false)
  assert.match(String((headers[0] as Record<string, string>).Authorization), /^Basic /)
})

test('reports bounded, useful 402 diagnostics without exposing credentials', async () => {
  const token = 'fixture-secret-token'
  const authorization = `Basic ${Buffer.from(`${token}:api_token`).toString('base64')}`
  const responseBody = JSON.stringify({
    error: 'Payment required for detailed reports',
    api_token: token,
    authorization,
    detail: 'x'.repeat(4_000),
  })
  const fetchImpl: typeof fetch = async () => new Response(responseBody, {
    status: 402,
    headers: {
      'X-Toggl-Quota-Remaining': '17',
      'X-Toggl-Quota-Resets-In': '42',
    },
  })

  await assert.rejects(
    fetchDetailedEntries({
      workspaceId: 'fixture-workspace',
      token,
      from: '2026-07-05',
      through: '2026-07-11',
      fetchImpl,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /HTTP 402/)
      assert.match(error.message, /Payment required for detailed reports/)
      assert.match(error.message, /X-Toggl-Quota-Remaining: 17/)
      assert.match(error.message, /X-Toggl-Quota-Resets-In: 42/)
      assert.match(error.message, /\[truncated\]/)
      assert.equal(error.message.includes(token), false)
      assert.equal(error.message.includes(authorization), false)
      assert.ok(error.message.length < 2_500)
      return true
    },
  )
})
