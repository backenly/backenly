/**
 * The realtime route streams a change only to a subscriber who could read the
 * row: a stream opened with alice's ticket receives her row and not bob's.
 *
 * Database-free: the listener hub hands the route two changes, the catalog
 * answers the table's primary key, and the visibility query answers as an
 * own-rows policy would (only alice's row for alice). The decision logic and
 * the query are the real ones (lib/realtime/visibility.ts); the policy itself
 * is pinned against PostgreSQL in __tests__/database/realtime-row-visibility.test.ts.
 */

import '@/tests/helpers/real-web-standard'

const mockHub: { emit?: (payload: unknown) => void } = {}
const ALICE = 'alice-user-id'
const ALICE_NOTE = '0aa00000-0000-4000-8000-000000000001'
const BOB_NOTE = '0bb00000-0000-4000-8000-000000000002'

jest.mock('@/lib/traffic/recorded-v1', () => ({ recordedV1: (handler: any) => handler }))
jest.mock('@/lib/api/v1/middleware', () => ({ v1ApiMiddleware: jest.fn() }))
jest.mock('@/lib/realtime/ticket-auth', () => ({
  redeemRealtimeTicketParam: jest.fn(async () => ({ ok: true, claims: { projectId: 'p', endUserId: 'alice-user-id', endUserRole: 'user', serviceRole: false } })),
}))
jest.mock('@/lib/realtime/listener-hub', () => ({
  listenerHub: {
    subscribe: jest.fn(async (_projectId: string, onPayload: (p: unknown) => void) => {
      mockHub.emit = onPayload
      return { ok: true, channel: 'workspace_changes', unsubscribe: jest.fn() }
    }),
  },
}))
jest.mock('@/lib/data-plane/regional', () => ({
  ...jest.requireActual('@/lib/data-plane/regional'),
  workspaceRawClient: jest.fn(async () => ({ $queryRaw: async () => [{ name: 'id', type: 'uuid' }] })),
}))
jest.mock('@/lib/services/workspace-rls', () => ({
  executeWithUserContext: jest.fn(async (_projectId: string, userId: string, _svc: boolean, _sql: string, values: unknown[]) =>
    userId === 'alice-user-id' && values[0] === '0aa00000-0000-4000-8000-000000000001' ? [{ '?column?': 1 }] : []),
}))

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/v1/[projectId]/realtime/route'

const PROJECT = '11111111-2222-4333-8444-555555555555'

it("streams alice's row to alice's stream and not bob's", async () => {
  const res: Response = await (GET as any)(
    new NextRequest(`http://localhost:3000/api/v1/${PROJECT}/realtime?ticket=t`),
    { params: Promise.resolve({ projectId: PROJECT }) },
  )
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
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
      text += decoder.decode(next.value)
    }
  }

  await readFor(100)
  expect(text).toContain('"type":"connected"')
  mockHub.emit!({ type: 'insert', table: 'notes', data: { id: BOB_NOTE, owner_id: 'bob', body: 'bob private' }, old: null })
  mockHub.emit!({ type: 'insert', table: 'notes', data: { id: ALICE_NOTE, owner_id: ALICE, body: 'alice private' }, old: null })
  await readFor(200)
  await reader.cancel()

  expect(text).toContain("alice private")
  expect(text).not.toContain('bob private')
})
