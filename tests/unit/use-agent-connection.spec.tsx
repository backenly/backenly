/**
 * @jest-environment jsdom
 */

/**
 * The console's one answer to "is this user's coding agent connected?"
 * (lib/hooks/useAgentConnection.ts). Every "Connect your agent" step reads it,
 * so it is asked once and shared, it changes when the agent connects in another
 * window and the user comes back, and one failed request never puts the step
 * back in front of a user whose agent is connected.
 */

import { act, render, screen } from '@testing-library/react'
import {
  clearAgentConnectionCache,
  readAgentConnection,
  refreshAgentConnection,
  useAgentConnection,
} from '@/lib/hooks/useAgentConnection'

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

const CONNECTED = { connected: true, lastSeenAt: '2026-10-11T09:30:00.000Z', client: 'Visual Studio Code' }
const NOT_CONNECTED = { connected: false, lastSeenAt: null, client: null }

function Probe({ id, projectId = 'p1' }: { id: string; projectId?: string | null }) {
  const a = useAgentConnection(projectId)
  return <p data-testid={id}>{`${a.status} connected=${a.connected} needsConnect=${a.needsConnect} client=${a.client ?? '-'}`}</p>
}

const statusCalls = () =>
  (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url).endsWith('/mcp/status'))

/** Let pending fetches and the renders they cause finish. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}

async function comeBack(event: 'focus' | 'visibilitychange') {
  await act(async () => {
    if (event === 'focus') window.dispatchEvent(new Event('focus'))
    else document.dispatchEvent(new Event('visibilitychange'))
  })
  await settle()
}

beforeEach(() => {
  clearAgentConnectionCache()
})

describe('useAgentConnection', () => {
  it('asks once for every surface on the page and hands them all the answer', async () => {
    global.fetch = jest.fn().mockResolvedValue(json(200, CONNECTED))
    render(
      <>
        <Probe id="top-bar" />
        <Probe id="page" />
      </>,
    )
    // Before the answer neither state is offered.
    expect(screen.getByTestId('top-bar')).toHaveTextContent('loading connected=false needsConnect=false')
    await settle()

    expect(statusCalls()).toHaveLength(1)
    expect(statusCalls()[0][0]).toBe('/api/projects/p1/mcp/status')
    for (const id of ['top-bar', 'page']) {
      expect(screen.getByTestId(id)).toHaveTextContent('connected connected=true needsConnect=false client=Visual Studio Code')
    }
  })

  it('offers the Connect step while the agent is not connected', async () => {
    global.fetch = jest.fn().mockResolvedValue(json(200, NOT_CONNECTED))
    render(<Probe id="p" />)
    await settle()
    expect(screen.getByTestId('p')).toHaveTextContent('disconnected connected=false needsConnect=true')
  })

  it('offers it when the first answer never comes, as every surface did before', async () => {
    global.fetch = jest.fn().mockResolvedValue(json(500, { error: 'Could not load the agent connection' }))
    render(<Probe id="server-error" />)
    await settle()
    expect(screen.getByTestId('server-error')).toHaveTextContent('disconnected connected=false needsConnect=true')

    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    render(<Probe id="offline" projectId="p2" />)
    await settle()
    expect(screen.getByTestId('offline')).toHaveTextContent('disconnected connected=false needsConnect=true')
  })

  it('flips once the agent connects in another window and the user comes back', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(json(200, NOT_CONNECTED))
      .mockResolvedValueOnce(json(200, CONNECTED))
      .mockResolvedValueOnce(json(200, NOT_CONNECTED))
    render(<Probe id="p" />)
    await settle()
    expect(screen.getByTestId('p')).toHaveTextContent('disconnected')

    await comeBack('focus')
    expect(screen.getByTestId('p')).toHaveTextContent('connected connected=true needsConnect=false')

    // And back, when the key is revoked: the tab becoming visible asks again.
    await comeBack('visibilitychange')
    expect(screen.getByTestId('p')).toHaveTextContent('disconnected connected=false needsConnect=true')
    expect(statusCalls()).toHaveLength(3)
  })

  it('keeps a connected answer when a later request fails', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(json(200, CONNECTED))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(502, { error: 'Bad gateway' }))
    render(<Probe id="p" />)
    await settle()
    await comeBack('focus')
    await comeBack('focus')
    expect(statusCalls()).toHaveLength(3)
    expect(screen.getByTestId('p')).toHaveTextContent('connected connected=true needsConnect=false')
  })

  it('re-renders nothing when a refresh brings back the same answer', async () => {
    global.fetch = jest.fn().mockResolvedValue(json(200, CONNECTED))
    let renders = 0
    function Counter() {
      useAgentConnection('p1')
      renders++
      return null
    }
    render(<Counter />)
    await settle()
    const settled = renders
    await comeBack('focus')
    expect(statusCalls()).toHaveLength(2)
    expect(renders).toBe(settled)
  })

  it('reuses a fresh answer when another section mounts, instead of asking again', async () => {
    global.fetch = jest.fn().mockResolvedValue(json(200, CONNECTED))
    const { unmount } = render(<Probe id="first" />)
    await settle()
    unmount()
    render(<Probe id="next-section" />)
    expect(screen.getByTestId('next-section')).toHaveTextContent('connected connected=true')
    await settle()
    expect(statusCalls()).toHaveLength(1)
  })

  it('has nothing to ask without a project, and offers the step as before', async () => {
    global.fetch = jest.fn()
    render(<Probe id="p" projectId={null} />)
    await settle()
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.getByTestId('p')).toHaveTextContent('disconnected connected=false needsConnect=true')
  })
})

describe('refreshAgentConnection and readAgentConnection', () => {
  it('reads the answer as it stands without asking for one', async () => {
    global.fetch = jest.fn().mockResolvedValue(json(200, CONNECTED))
    expect(readAgentConnection('p1').status).toBe('loading')
    expect(global.fetch).not.toHaveBeenCalled()

    await refreshAgentConnection('p1')
    expect(readAgentConnection('p1')).toEqual({
      status: 'connected',
      // Connected, but its last call was long ago: not calling now.
      active: false,
      lastSeenAt: CONNECTED.lastSeenAt,
      client: 'Visual Studio Code',
    })
  })

  it('joins a request already in flight rather than starting another', async () => {
    let answer: (r: Response) => void = () => {}
    global.fetch = jest.fn().mockReturnValue(new Promise<Response>((r) => { answer = r }))
    const a = refreshAgentConnection('p1')
    const b = refreshAgentConnection('p1')
    expect(a).toBe(b)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    answer(json(200, NOT_CONNECTED))
    await a
    expect(readAgentConnection('p1').status).toBe('disconnected')
  })

  it('settles even when fetch throws before it returns a promise', async () => {
    global.fetch = jest.fn(() => {
      throw new TypeError('fetch is not available')
    })
    await refreshAgentConnection('p1')
    expect(readAgentConnection('p1').status).toBe('disconnected')

    // Not stuck on a settled request: the next refresh really asks again.
    global.fetch = jest.fn().mockResolvedValue(json(200, CONNECTED))
    await refreshAgentConnection('p1')
    expect(global.fetch).toHaveBeenCalledTimes(1)
    expect(readAgentConnection('p1').status).toBe('connected')
  })
})
