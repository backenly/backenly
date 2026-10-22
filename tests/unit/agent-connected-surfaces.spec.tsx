/**
 * @jest-environment jsdom
 */

/**
 * "Connect agent" is offered until the user's coding agent is connected,
 * and not after. A customer whose VS Code agent was already connected over MCP
 * was still sent to Connect from every section, because the top bar's primary
 * action and each empty state asked unconditionally. These render the real
 * surfaces against both answers from GET /api/projects/[id]/mcp/status.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { clearAgentConnectionCache } from '@/lib/hooks/useAgentConnection'
import { FunctionsWorkbench } from '@/components/functions/FunctionsWorkbench'
import { MainWorkspace } from '@/components/workspace/MainWorkspace'
import { AuthWorkbench } from '@/components/auth/AuthWorkbench'
import { TopBar } from '@/components/shell/TopBar'

const push = jest.fn()
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({ id: 'p1' }),
  usePathname: () => '/app/projects/p1',
  useSearchParams: () => new URLSearchParams('tab=users'),
}))

const CONNECTED = { connected: true, lastSeenAt: new Date().toISOString(), client: 'Visual Studio Code' }
const NOT_CONNECTED = { connected: false, lastSeenAt: null, client: null }

let agentAnswer: unknown = NOT_CONNECTED

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/** Only the answers these surfaces read; anything else is a quiet 404. */
function answer(url: string): Response {
  const path = url.split('?')[0]
  if (path.endsWith('/mcp/status')) return json(200, agentAnswer)
  if (path.endsWith('/ai-functions')) return json(200, { functions: [] })
  if (path === '/api/auth/users') return json(200, { users: [] })
  if (path.endsWith('/state')) return json(200, { entities: [], apis: [], capabilities: [], hasContent: false, isLive: false })
  if (path.endsWith('/build-status')) return json(200, { blocked: [] })
  if (path === '/api/projects') return json(200, [])
  return json(404, {})
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  clearAgentConnectionCache()
  push.mockReset()
  agentAnswer = NOT_CONNECTED
  global.fetch = jest.fn((input: RequestInfo | URL) => Promise.resolve(answer(String(input)))) as unknown as typeof fetch
})

describe('Functions (the reported surface)', () => {
  async function openNewFunction() {
    fireEvent.click(screen.getByRole('button', { name: /New function/ }))
    return screen.getByRole('dialog', { name: 'New function' })
  }

  it('sends a user without a connected agent to Connect', async () => {
    render(<FunctionsWorkbench projectId="p1" />)
    await settle()
    expect(screen.getByRole('link', { name: /Connect agent/ })).toHaveAttribute('href', '/app/projects/p1/connect')
    expect(screen.getByRole('link', { name: /View docs/ })).toHaveAttribute('href', '/docs/functions')

    const dialog = await openNewFunction()
    expect(within(dialog).getByRole('link', { name: /Connect agent/ })).toHaveAttribute('href', '/app/projects/p1/connect')
  })

  it('does not ask a user whose agent is connected, and still hands over the asks', async () => {
    agentAnswer = CONNECTED
    render(<FunctionsWorkbench projectId="p1" />)
    await settle()
    expect(screen.queryByRole('link', { name: /Connect agent/ })).toBeNull()
    expect(screen.getByText('When a user signs up, send them a welcome email.')).toBeInTheDocument()

    const dialog = await openNewFunction()
    expect(within(dialog).queryByRole('link', { name: /Connect agent/ })).toBeNull()
    expect(within(dialog).getAllByRole('button', { name: 'Copy prompt' }).length).toBeGreaterThan(0)
    expect(within(dialog).getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0)
  })
})

describe('Overview of an empty project', () => {
  it('asks a user without a connected agent to connect it', async () => {
    render(<MainWorkspace projectId="p1" projectName="shop" />)
    await settle()
    expect(screen.getByRole('heading', { name: 'shop' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Your backend is ready to build' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Connect agent/ })).toHaveAttribute('href', '/app/projects/p1/connect')
    // Step 1 is done on any project; step 2 is not until the agent connects.
    expect(screen.getByRole('heading', { name: 'Done: Create a project' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Step 2: Connect your coding agent' })).toBeInTheDocument()
  })

  it('tells a connected user so, and hands over the first ask instead', async () => {
    agentAnswer = CONNECTED
    render(<MainWorkspace projectId="p1" projectName="shop" />)
    await settle()
    expect(screen.getByRole('heading', { name: 'Your agent is connected' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Connect agent/ })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Done: Connect your coding agent' })).toBeInTheDocument()
    expect(screen.getByText(/Connected through Visual Studio Code, last call just now/)).toBeInTheDocument()
    expect(screen.getByText(/Build the backend for a task tracker/)).toBeInTheDocument()
  })
})

describe('Auth & Users with no users yet', () => {
  it('offers Connect only until the agent is connected', async () => {
    const { unmount } = render(<AuthWorkbench projectId="p1" />)
    await settle()
    expect(screen.getByRole('link', { name: 'Connect agent' })).toHaveAttribute('href', '/app/projects/p1/connect')
    unmount()

    clearAgentConnectionCache()
    agentAnswer = CONNECTED
    render(<AuthWorkbench projectId="p1" />)
    await settle()
    expect(screen.queryByRole('link', { name: 'Connect agent' })).toBeNull()
    expect(screen.getByText(/Add email and password sign-up/)).toBeInTheDocument()
  })
})

describe('Top bar', () => {
  const slot = () => document.querySelector<HTMLElement>('[data-tour="connect-agent"]')

  it('makes Connect agent the primary action while no agent is connected', async () => {
    render(<TopBar />)
    // Hidden, not absent, until the answer is in: no flash of the wrong state,
    // and the tour's target is always there.
    expect(slot()).not.toBeNull()
    expect(slot()).toHaveClass('invisible')
    await settle()
    expect(slot()).not.toHaveClass('invisible')
    expect(screen.getByRole('link', { name: 'Connect agent' })).toHaveAttribute('href', '/app/projects/p1/connect')
    expect(screen.queryByRole('link', { name: 'Agent connected' })).toBeNull()
  })

  it('reports a connected agent instead of asking again, and still opens Connect', async () => {
    agentAnswer = CONNECTED
    render(<TopBar />)
    await settle()
    const status = screen.getByRole('link', { name: 'Agent connected' })
    expect(status).toHaveAttribute('href', '/app/projects/p1/connect')
    expect(status).toHaveAttribute('data-tour', 'connect-agent')
    expect(status.getAttribute('title')).toMatch(/through Visual Studio Code, last call just now/)
    expect(screen.queryByRole('link', { name: 'Connect agent' })).toBeNull()
  })
})
