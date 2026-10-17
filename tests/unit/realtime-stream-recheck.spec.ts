/**
 * An open realtime stream re-checks its project every 25 seconds, as the
 * runtime's stream does (server/routes/realtime.ts): the serving gate only runs
 * when a stream connects, so a stream opened before a lock or a pause must end
 * on its own. A state that cannot be read keeps the stream (a lookup blip is not
 * a pause).
 *
 * Database-free: the listener hub, the ticket and the project's state are the
 * test's; the request wrapper is identity (the gate it adds is pinned in
 * tests/integration/next-routes-serving-gate.spec.ts).
 */

import '@/tests/helpers/real-web-standard'

const mockStates: Array<{ kind: string; reason?: string | null; pausedAt?: Date }> = []
const mockUnsubscribe = jest.fn()

jest.mock('@/lib/traffic/recorded-v1', () => ({ recordedV1: (handler: any) => handler }))
jest.mock('@/lib/api/v1/middleware', () => ({ v1ApiMiddleware: jest.fn() }))
jest.mock('@/lib/realtime/ticket-auth', () => ({ redeemRealtimeTicketParam: jest.fn(async () => ({ ok: true })) }))
jest.mock('@/lib/realtime/listener-hub', () => ({
  listenerHub: { subscribe: jest.fn(async () => ({ ok: true, channel: 'workspace_test_changes', unsubscribe: mockUnsubscribe })) },
}))
jest.mock('@/lib/projects/serving-state', () => {
  const actual = jest.requireActual('@/lib/projects/serving-state')
  return { ...actual, getProjectServingState: jest.fn(async () => mockStates.shift() ?? { kind: 'serving' }) }
})

import { NextRequest } from 'next/server'
import { GET } from '@/app/api/v1/[projectId]/realtime/route'

const PROJECT = '11111111-2222-4333-8444-555555555555'
const decoder = new TextDecoder()

async function open() {
  const res: Response = await (GET as any)(
    new NextRequest(`http://localhost:3000/api/v1/${PROJECT}/realtime?ticket=t`),
    { params: Promise.resolve({ projectId: PROJECT }) },
  )
  return collector(res.body!.getReader())
}

/**
 * Reads what the stream has sent so far. One read stays pending across calls,
 * so a read that outlived a timeout is not lost with the chunk it receives.
 */
function collector(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
  const drain = async (timeoutMs = 50): Promise<{ text: string; done: boolean }> => {
    let text = ''
    for (;;) {
      pending ??= reader.read()
      const next = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))])
      if (next === null) return { text, done: false }
      pending = null
      if (next.done) return { text, done: true }
      text += decoder.decode(next.value)
    }
  }
  return { drain, cancel: () => reader.cancel() }
}

beforeEach(() => {
  mockStates.length = 0
  mockUnsubscribe.mockClear()
  jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] })
})

afterEach(() => {
  jest.useRealTimers()
})

it('ends a stream whose project is locked after it opened, with the lock code', async () => {
  const stream = await open()
  expect((await stream.drain()).text).toContain('"type":"connected"')

  mockStates.push({ kind: 'locked', reason: null })
  jest.advanceTimersByTime(25_000)
  const after = await stream.drain()
  expect(after.text).toContain('"code":"PROJECT_LOCKED"')
  expect(after.done).toBe(true)
  expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
})

it('ends a stream whose project is paused after it opened, with the paused code', async () => {
  const stream = await open()
  await stream.drain()

  mockStates.push({ kind: 'paused', reason: null, pausedAt: new Date() })
  jest.advanceTimersByTime(25_000)
  const after = await stream.drain()
  expect(after.text).toContain('"code":"PROJECT_PAUSED"')
  expect(after.done).toBe(true)
})

it('keeps a stream whose project still serves, or whose state cannot be read', async () => {
  const stream = await open()
  await stream.drain()

  mockStates.push({ kind: 'serving' }, { kind: 'unavailable' })
  jest.advanceTimersByTime(25_000)
  const first = await stream.drain()
  jest.advanceTimersByTime(25_000)
  const second = await stream.drain()
  expect(first.text).toContain(': keepalive')
  expect(second.text).toContain(': keepalive')
  expect(first.done || second.done).toBe(false)
  expect(mockUnsubscribe).not.toHaveBeenCalled()
  await stream.cancel()
})
