/**
 * @jest-environment jsdom
 */

/**
 * The console's Realtime page opens its stream with a ticket, not the anon key.
 *
 * It used to open `/realtime?apiKey=<anon key>`: an anonymous stream, which on
 * every table behind row-level security received nothing, while the page said
 * "Connected · Listening for changes" (production QA, 2026-11-09). It now asks
 * the console for a single-use ticket on every connect and opens
 * `/realtime?ticket=…`. Only a project that cannot issue one falls back to the
 * anon key, and the page then says what that view leaves out.
 *
 * Renders the real workbench against stand-in route answers and a recording
 * EventSource.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { RealtimeWorkbench } from '@/components/realtime/RealtimeWorkbench'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/app/projects/p1/realtime',
  useSearchParams: () => new URLSearchParams(),
}))
jest.mock('@/lib/api/auth', () => ({ getAuthToken: () => 'session-token' }))
jest.mock('@/lib/api/projects', () => ({
  getProject: async () => ({ apiBaseUrl: 'https://backenly.test/api/v1/p1' }),
}))

const opened: string[] = []
class RecordingEventSource {
  onmessage: ((msg: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  readyState = 0
  constructor(public url: string) {
    opened.push(url)
  }
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

let ticketStatus = 200
const asked: string[] = []

function answer(url: string, init?: RequestInit): Response {
  asked.push(`${init?.method ?? 'GET'} ${url}`)
  // Plain objects, as jest.setup.js swaps Response for a stand-in.
  const json = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response
  if (url.endsWith('/realtime-status')) {
    return json(200, { triggeredTables: ['orders'], onlineUsers: 0, channel: 'workspace_p1_changes' })
  }
  if (url.endsWith('/realtime-ticket')) {
    return ticketStatus === 200
      ? json(200, { ticket: 'one.time.ticket', expiresIn: 30 })
      : json(ticketStatus, { error: 'no secret', code: 'NO_PROJECT_SECRET' })
  }
  if (url.endsWith('/anon-key')) return json(200, { anonKey: 'proj_live_anon_test_key' })
  return json(404, { error: 'not stubbed' })
}

beforeEach(() => {
  opened.length = 0
  asked.length = 0
  ticketStatus = 200
  ;(globalThis as any).EventSource = RecordingEventSource
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(answer(String(input), init)),
  ) as unknown as typeof fetch
})

describe('the Realtime page', () => {
  it('opens its stream with a ticket from the console, never the anon key', async () => {
    render(<RealtimeWorkbench projectId="p1" />)
    await waitFor(() => expect(opened.length).toBeGreaterThan(0))
    expect(asked).toContain('POST /api/projects/p1/realtime-ticket')
    expect(opened).toEqual(['https://backenly.test/api/v1/p1/realtime?ticket=one.time.ticket'])
    expect(asked.some((a) => a.endsWith('/anon-key'))).toBe(false)
    expect(screen.queryByText(/Showing only changes an anonymous visitor could read/)).toBeNull()
  })

  it('falls back to the anon key only when the project cannot issue a ticket, and says so', async () => {
    ticketStatus = 409
    render(<RealtimeWorkbench projectId="p1" />)
    await waitFor(() => expect(opened.length).toBeGreaterThan(0))
    expect(opened).toEqual(['https://backenly.test/api/v1/p1/realtime?apiKey=proj_live_anon_test_key'])
    expect(screen.getByText(/Showing only changes an anonymous visitor could read/)).toBeInTheDocument()
  })
})
