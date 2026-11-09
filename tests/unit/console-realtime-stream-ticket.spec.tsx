/**
 * @jest-environment jsdom
 */

/**
 * THE CONSOLE'S REALTIME PAGE STREAMS AS THE SIGNED-IN MEMBER (#617)
 * =================================================================
 * The page opened its stream with the project's anon key in the URL, so on a
 * table whose rows only their owners may read it showed the deletes alone. It
 * now asks the console for a ticket issued to the signed-in member
 * (POST /api/projects/:id/realtime-ticket) and opens the stream with that, a
 * fresh one for every connection, because a ticket is good for one.
 *
 * Renders the real page with the browser's fetch and EventSource stood in for.
 * What the stream receives with the ticket is pinned against a real database
 * in tests/integration/console-realtime-operator-feed.spec.ts.
 */

import { act, render, screen } from '@testing-library/react'
import { RealtimeWorkbench } from '@/components/realtime/RealtimeWorkbench'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({ id: 'p1' }),
  usePathname: () => '/app/projects/p1/realtime',
  useSearchParams: () => new URLSearchParams(),
}))
jest.mock('@/lib/api/auth', () => ({ ...jest.requireActual('@/lib/api/auth'), getAuthToken: () => 'console-session' }))
jest.mock('@/lib/api/projects', () => ({
  ...jest.requireActual('@/lib/api/projects'),
  getProject: jest.fn(async () => ({ id: 'p1', apiBaseUrl: 'https://eu.api.backenly.test/api/v1/p1' })),
}))

class FakeEventSource {
  static opened: FakeEventSource[] = []
  onmessage: ((msg: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(readonly url: string) {
    FakeEventSource.opened.push(this)
  }
  close() {
    this.closed = true
  }
}

interface Call {
  path: string
  method: string
  headers: Record<string, string>
  credentials?: string
}

const calls: Call[] = []
/** What the ticket route answers, in turn. */
let ticketAnswers: Array<{ status: number; body: unknown }> = []

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

const ticketCalls = () => calls.filter((c) => c.path === '/api/projects/p1/realtime-ticket')
const streamUrls = () => FakeEventSource.opened.map((es) => es.url)

/** Lets the page's awaited fetches and state updates run. */
async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  FakeEventSource.opened = []
  calls.length = 0
  ticketAnswers = []
  ;(global as any).EventSource = FakeEventSource
  global.fetch = jest.fn(async (url: any, init?: any) => {
    const path = String(url).split('?')[0]
    calls.push({ path, method: init?.method ?? 'GET', headers: init?.headers ?? {}, credentials: init?.credentials })
    if (path === '/api/projects/p1/realtime-ticket') {
      const answer = ticketAnswers.shift() ?? { status: 500, body: { error: 'Internal error' } }
      return json(answer.status, answer.body)
    }
    if (path === '/api/projects/p1/realtime-status') {
      return json(200, { triggeredTables: ['notes'], onlineUsers: 0, channel: 'workspace_p1_changes' })
    }
    return json(404, {})
  }) as any
})

afterEach(() => {
  jest.useRealTimers()
})

it('opens the stream with a ticket issued to the signed-in member, never with the anon key', async () => {
  ticketAnswers = [{ status: 200, body: { ticket: 'ticket-1', expiresIn: 30 } }]

  render(<RealtimeWorkbench projectId="p1" />)
  await settle()

  expect(ticketCalls()).toEqual([
    { path: '/api/projects/p1/realtime-ticket', method: 'POST', headers: { Authorization: 'Bearer console-session' }, credentials: 'include' },
  ])
  expect(calls.some((c) => c.path.endsWith('/anon-key'))).toBe(false)
  expect(streamUrls()).toEqual(['https://eu.api.backenly.test/api/v1/p1/realtime?ticket=ticket-1'])
})

it('asks for a fresh ticket for every connection, a reconnect included', async () => {
  jest.useFakeTimers()
  ticketAnswers = [
    { status: 200, body: { ticket: 'ticket-1', expiresIn: 30 } },
    { status: 200, body: { ticket: 'ticket-2', expiresIn: 30 } },
  ]

  render(<RealtimeWorkbench projectId="p1" />)
  await settle()
  act(() => FakeEventSource.opened[0].onerror?.())
  // The first retry waits a second, give or take a quarter.
  await act(async () => { jest.advanceTimersByTime(1_500) })
  await settle()

  expect(FakeEventSource.opened[0].closed).toBe(true)
  expect(ticketCalls()).toHaveLength(2)
  expect(streamUrls()).toEqual([
    'https://eu.api.backenly.test/api/v1/p1/realtime?ticket=ticket-1',
    'https://eu.api.backenly.test/api/v1/p1/realtime?ticket=ticket-2',
  ])
})

it('retries a ticket the console could not issue, without opening a stream meanwhile', async () => {
  jest.useFakeTimers()
  ticketAnswers = [
    { status: 503, body: { code: 'TICKET_LEDGER_UNAVAILABLE' } },
    { status: 200, body: { ticket: 'ticket-2', expiresIn: 30 } },
  ]

  render(<RealtimeWorkbench projectId="p1" />)
  await settle()
  expect(streamUrls()).toEqual([])
  await act(async () => { jest.advanceTimersByTime(1_500) })
  await settle()

  expect(streamUrls()).toEqual(['https://eu.api.backenly.test/api/v1/p1/realtime?ticket=ticket-2'])
})

it.each([
  [401, /dashboard session expired/],
  [404, /no longer have access to it/],
])('stops and says why when the ticket route answers %d', async (status, reason) => {
  jest.useFakeTimers()
  ticketAnswers = [{ status, body: { error: 'refused' } }]

  render(<RealtimeWorkbench projectId="p1" />)
  await settle()
  await act(async () => { jest.advanceTimersByTime(60_000) })
  await settle()

  expect(screen.getAllByText(reason).length).toBeGreaterThan(0)
  expect(ticketCalls()).toHaveLength(1)
  expect(streamUrls()).toEqual([])
})
