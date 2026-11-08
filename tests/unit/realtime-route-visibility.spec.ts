/**
 * The realtime route streams a change only to a subscriber who could read the
 * row: a stream opened with alice's ticket receives her row and not bob's. A
 * burst on many streams costs one query per identity, not one per stream per
 * change, and a check the database cannot answer reaches the stream as a
 * report, not as silence (#622).
 *
 * Database-free: the listener hub hands the route changes, the catalog answers
 * the table's primary key, and the visibility query answers as an own-rows
 * policy would (only alice's rows for alice). The decision logic, the batching
 * and the query are the real ones (lib/realtime/visibility.ts); the policy
 * itself is pinned against PostgreSQL in
 * __tests__/database/realtime-row-visibility.test.ts.
 */

import '@/tests/helpers/real-web-standard'

const mockHub: { handlers: Array<(payload: unknown) => void> } = { handlers: [] }
const ALICE = 'alice-user-id'
const ALICE_NOTE = '0aa00000-0000-4000-8000-000000000001'
const BOB_NOTE = '0bb00000-0000-4000-8000-000000000002'
/** What the visibility query sees: how often it ran, how many at once, and whether it can start. */
const mockDb = { calls: 0, inFlight: 0, maxInFlight: 0, fail: false }

jest.mock('@/lib/traffic/recorded-v1', () => ({ recordedV1: (handler: any) => handler }))
jest.mock('@/lib/api/v1/middleware', () => ({ v1ApiMiddleware: jest.fn() }))
jest.mock('@/lib/realtime/ticket-auth', () => ({
  redeemRealtimeTicketParam: jest.fn(async () => ({ ok: true, claims: { projectId: 'p', endUserId: 'alice-user-id', endUserRole: 'user', serviceRole: false } })),
}))
jest.mock('@/lib/realtime/listener-hub', () => ({
  listenerHub: {
    subscribe: jest.fn(async (_projectId: string, onPayload: (p: unknown) => void) => {
      mockHub.handlers.push(onPayload)
      return { ok: true, channel: 'workspace_changes', unsubscribe: jest.fn() }
    }),
  },
}))
jest.mock('@/lib/data-plane/regional', () => ({
  ...jest.requireActual('@/lib/data-plane/regional'),
  workspaceRawClient: jest.fn(async () => ({ $queryRaw: async () => [{ name: 'id', type: 'uuid' }] })),
}))
jest.mock('@/lib/services/workspace-rls', () => ({
  // Answers as an own-rows policy: alice may read rows whose id starts 0aa.
  // Each key column's values arrive as one array, and the answer is the
  // 1-based positions alice may read; a single value is answered as one row.
  executeWithUserContext: jest.fn(async (_projectId: string, userId: string, _svc: boolean, _sql: string, values: unknown[]) => {
    mockDb.calls++
    mockDb.inFlight++
    mockDb.maxInFlight = Math.max(mockDb.maxInFlight, mockDb.inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (mockDb.fail) throw new Error('Transaction API error: Unable to start a transaction in the given time.')
      const ids = (Array.isArray(values[0]) ? values[0] : [values[0]]) as string[]
      return ids.flatMap((id, i) => (userId === 'alice-user-id' && id.startsWith('0aa') ? [{ i: i + 1 }] : []))
    } finally {
      mockDb.inFlight--
    }
  }),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/v1/[projectId]/realtime/route'

const PROJECT = '11111111-2222-4333-8444-555555555555'

const emit = (payload: unknown) => mockHub.handlers.forEach((handler) => handler(payload))
const insert = (id: string, body: string) => ({ type: 'insert', table: 'notes', data: { id, owner_id: id.startsWith('0aa') ? ALICE : 'bob', body }, old: null })
const noteId = (owner: '0aa' | '0bb', n: number) => `${owner}00000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** A stream opened with alice's ticket, and what it has received so far. */
async function openStream() {
  const res: Response = await (GET as any)(
    new NextRequest(`http://localhost:3000/api/v1/${PROJECT}/realtime?ticket=t`),
    { params: Promise.resolve({ projectId: PROJECT }) },
  )
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const stream = { text: '' }
  // One read stays pending across calls, so a read that outlived its window is
  // not lost with the chunk it later receives.
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
  const readFor = async (ms: number) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      pending ??= reader.read()
      const next = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 20))])
      if (next === null) continue
      pending = null
      if (next.done) return
      stream.text += decoder.decode(next.value)
    }
  }
  return { stream, readFor, close: () => reader.cancel() }
}

beforeEach(() => {
  mockHub.handlers.length = 0
  Object.assign(mockDb, { calls: 0, inFlight: 0, maxInFlight: 0, fail: false })
})

it("streams alice's row to alice's stream and not bob's", async () => {
  const s = await openStream()
  await s.readFor(100)
  expect(s.stream.text).toContain('"type":"connected"')
  emit(insert(BOB_NOTE, 'bob private'))
  emit(insert(ALICE_NOTE, 'alice private'))
  await s.readFor(200)
  await s.close()

  expect(s.stream.text).toContain('alice private')
  expect(s.stream.text).not.toContain('bob private')
})

it('checks a burst on ten streams opened as one user with one query, not one per stream per change', async () => {
  const streams = await Promise.all(Array.from({ length: 10 }, () => openStream()))
  await Promise.all(streams.map((s) => s.readFor(100)))
  for (let n = 0; n < 10; n++) {
    emit(insert(noteId('0aa', n), `alice note ${n}`))
    emit(insert(noteId('0bb', n), `bob note ${n}`))
  }
  await Promise.all(streams.map((s) => s.readFor(300)))
  await Promise.all(streams.map((s) => s.close()))

  for (const s of streams) {
    for (let n = 0; n < 10; n++) expect(s.stream.text).toContain(`alice note ${n}"`)
    expect(s.stream.text).not.toContain('bob note')
  }
  expect(mockDb.calls).toBe(1)
  expect(mockDb.maxInFlight).toBeLessThanOrEqual(2)
})

it('reports a change whose check the database could not start, instead of dropping it in silence', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {})
  try {
    mockDb.fail = true
    const s = await openStream()
    await s.readFor(100)
    emit(insert(ALICE_NOTE, 'alice private'))
    await s.readFor(2_000)
    await s.close()

    expect(s.stream.text).toContain('"code":"CHANGES_NOT_DELIVERED"')
    expect(s.stream.text).toContain('"table":"notes"')
    expect(s.stream.text).toContain('Read that table again to catch up')
    expect(s.stream.text).not.toContain('alice private')
    // Tried three times before it was reported.
    expect(mockDb.calls).toBe(3)
  } finally {
    error.mockRestore()
  }
})
