/**
 * @jest-environment jsdom
 */

/**
 * "Connect agent" is offered until the user's coding agent is connected,
 * and not after. A customer whose VS Code agent was already connected over MCP
 * was still sent to Connect from every section, because the top bar's primary
 * action and each empty state asked unconditionally. These render the real
 * surfaces against both answers from GET /api/projects/[id]/mcp/status.
 *
 * Since the project console rebuild (2026-11-16, decision 1) the top bar
 * offers one SECONDARY "Connect agent", only until the agent first connects,
 * never on Overview or Connect (both carry the setup themselves) and never to
 * someone who cannot create keys. The agent's state lives on the sidebar's
 * Connect item: live (●, mid grey) only while it is at work, hollow and dim
 * when quiet, the words "Not connected" when there is none.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { clearAgentConnectionCache } from '@/lib/hooks/useAgentConnection'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'
import { forgetProjectReads } from '@/lib/api/projects'
import { BUTTON_VARIANTS } from '@/components/inspector/kit'
import { FunctionsWorkbench } from '@/components/functions/FunctionsWorkbench'
import { MainWorkspace } from '@/components/workspace/MainWorkspace'
import { AuthWorkbench } from '@/components/auth/AuthWorkbench'
import { TopBar } from '@/components/shell/TopBar'
import { ProjectSidebar } from '@/components/shell/ProjectSidebar'
import ProjectConnectPage from '@/app/app/projects/[id]/connect/page'

const push = jest.fn()
let pathname = '/app/projects/p1'
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({ id: 'p1' }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams('tab=users'),
}))

const CONNECTED = { connected: true, active: true, lastSeenAt: new Date().toISOString(), client: 'Visual Studio Code' }
const NOT_CONNECTED = { connected: false, active: false, lastSeenAt: null, client: null }
/** Set up, last called six days ago: the server answers not active. */
const IDLE = { ...CONNECTED, active: false, lastSeenAt: new Date(Date.now() - 6 * 24 * 3_600_000).toISOString() }

let agentAnswer: unknown = NOT_CONNECTED

/** GET /api/projects/[id]'s role fields: an owner may create keys, a developer may not. */
const OWNER = { role: 'OWNER', canWrite: true, canAdminister: true }
const DEVELOPER = { role: 'DEVELOPER', canWrite: true, canAdminister: false }
let roleAnswer: Record<string, unknown> = OWNER

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/** Only the answers these surfaces read; anything else is a quiet 404. */
function answer(url: string): Response {
  const path = url.split('?')[0]
  if (path.endsWith('/mcp/status')) return json(200, agentAnswer)
  if (path === '/api/projects/p1') {
    return json(200, { success: true, data: { id: 'p1', name: 'shop', projectStatus: 'LIVE', organizationId: 'org_1', ...roleAnswer } })
  }
  if (path.endsWith('/ai-functions')) return json(200, { functions: [] })
  if (path === '/api/auth/users') return json(200, { users: [] })
  if (path.endsWith('/state')) return json(200, { entities: [], apis: [], capabilities: [], hasContent: false, isLive: false })
  if (path.endsWith('/build-status')) return json(200, { blocked: [] })
  if (path === '/api/projects') return json(200, [])
  if (path.endsWith('/mcp/keys')) return json(200, { rawKey: 'mcp_live_0123456-89abcdef', key: { id: 'k1', label: 'Claude Code' } })
  if (path === '/api/mcp/health') return json(200, { ok: true, projectId: 'p1', project: { id: 'p1', name: 'shop' }, toolCount: 23 })
  return json(404, {})
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  clearAgentConnectionCache()
  clearProjectRoleCache()
  forgetProjectReads()
  push.mockReset()
  pathname = '/app/projects/p1'
  agentAnswer = NOT_CONNECTED
  roleAnswer = OWNER
  global.fetch = jest.fn((input: RequestInfo | URL) => Promise.resolve(answer(String(input)))) as unknown as typeof fetch
})

describe('Functions (the reported surface)', () => {
  async function openNewFunction() {
    fireEvent.click(screen.getByRole('button', { name: /New function/ }))
    return screen.getByRole('dialog', { name: 'New function' })
  }

  it('asks a user without a connected agent to connect it, in the panel, with no button of its own', async () => {
    render(<FunctionsWorkbench projectId="p1" />)
    await settle()
    // Decision 1: the top bar carries Connect agent; the empty panel says it in its sentence.
    expect(screen.getByText(/Connect your agent, then send it one of these\./)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Connect agent/ })).toBeNull()
    // Relative on Backenly Cloud, absolute (backenly.com) on a self-hosted build: the page is the same.
    expect(screen.getByRole('link', { name: /Functions docs/ }).getAttribute('href')).toMatch(/^(https:\/\/backenly\.com)?\/docs\/functions$/)

    const dialog = await openNewFunction()
    expect(within(dialog).getByText(/Connect your agent, then send it one of these\./)).toBeInTheDocument()
    expect(within(dialog).queryByRole('link', { name: /Connect agent/ })).toBeNull()
  })

  it('does not ask a user whose agent is connected, and still hands over the asks', async () => {
    agentAnswer = CONNECTED
    render(<FunctionsWorkbench projectId="p1" />)
    await settle()
    expect(screen.queryByText(/Connect your agent/)).toBeNull()
    expect(screen.getByText(/one of these to start\./)).toBeInTheDocument()
    expect(screen.getByText('When a user signs up, send them a welcome email.')).toBeInTheDocument()

    const dialog = await openNewFunction()
    expect(within(dialog).queryByText(/Connect your agent/)).toBeNull()
    expect(within(dialog).getAllByRole('button', { name: 'Copy request' }).length).toBeGreaterThan(0)
    expect(within(dialog).getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0)
  })
})

describe('Overview of an empty project', () => {
  // Since the project console rebuild (2026-11-16) the setup is on the page:
  // the command with a key one click away, then the first request to send.
  // No stepper, no second "Connect agent" link.
  it('puts the setup on the page for a user without a connected agent', async () => {
    render(<MainWorkspace projectId="p1" />)
    await settle()
    expect(screen.getByRole('heading', { name: 'shop' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Connect your coding agent' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate key' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Then ask it to build' })).toBeInTheDocument()
    expect(screen.getByText(/Build the backend for a task tracker/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Connect agent/ })).toBeNull()
    expect(screen.queryByText(/Step 2/)).toBeNull()
  })

  it('tells a connected user so, and hands over the first ask instead', async () => {
    agentAnswer = CONNECTED
    render(<MainWorkspace projectId="p1" />)
    await settle()
    expect(screen.getByRole('heading', { name: 'Your agent' })).toBeInTheDocument()
    expect(screen.getByText('Visual Studio Code')).toBeInTheDocument()
    expect(screen.getByText(/^Last call just now/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Ask it to build' })).toBeInTheDocument()
    expect(screen.getByText(/Build the backend for a task tracker/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Generate key' })).toBeNull()
    expect(screen.queryByRole('link', { name: /Connect agent/ })).toBeNull()
  })

  it('keeps the command on screen after Test connection, whose key is not shown again', async () => {
    render(<MainWorkspace projectId="p1" />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Generate key' }))
    await settle()
    // The test authenticates with the key, which the server then counts as connected.
    agentAnswer = CONNECTED
    fireEvent.click(await screen.findByRole('button', { name: /Test connection/ }))
    expect(await screen.findByText('Connected. 23 tools on shop.')).toBeInTheDocument()
    await settle()
    // The command still carries the key, with its Copy.
    expect(screen.getByText('mcp_live_0123456…')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2)
    expect(screen.getByRole('heading', { name: 'Ask it to build' })).toBeInTheDocument()
  })

  it('tells someone who cannot create keys who can, and still hands over the ask', async () => {
    roleAnswer = DEVELOPER
    render(<MainWorkspace projectId="p1" />)
    await settle()
    expect(screen.getByText('Only an owner or admin can connect an agent to this project.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Generate key' })).toBeNull()
    expect(screen.getByText(/Build the backend for a task tracker/)).toBeInTheDocument()
  })
})

describe('Auth & Users with no users yet', () => {
  // Decision 1: the empty panel carries no Connect button of its own (the top
  // bar offers the one); its sentence asks for the agent until it is connected.
  it('asks for the agent only until it is connected, then names it', async () => {
    const { unmount } = render(<AuthWorkbench projectId="p1" />)
    await settle()
    expect(screen.getByText(/Connect your agent, then send it this\./)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Connect agent' })).toBeNull()
    unmount()

    clearAgentConnectionCache()
    agentAnswer = CONNECTED
    render(<AuthWorkbench projectId="p1" />)
    await settle()
    expect(screen.queryByText(/Connect your agent/)).toBeNull()
    expect(screen.getByText(/Send Visual Studio Code this to start\./)).toBeInTheDocument()
    expect(screen.getByText(/Add email and password sign-up/)).toBeInTheDocument()
  })
})

describe('Top bar', () => {
  const connectAgent = () => screen.queryByRole('link', { name: 'Connect agent' })

  it('offers one secondary Connect agent on a section page while no agent has connected', async () => {
    pathname = '/app/projects/p1/database'
    render(<TopBar />)
    // Nothing until both answers are in (the agent, the role): no flash of the wrong state.
    expect(connectAgent()).toBeNull()
    await settle()
    const link = connectAgent()
    expect(link).toHaveAttribute('href', '/app/projects/p1/connect')
    // Secondary, never the white primary: the page owns its one main button.
    expect(link?.className).toContain(BUTTON_VARIANTS.secondary)
    expect(link?.className).not.toContain(BUTTON_VARIANTS.primary)
  })

  it.each([
    ['Overview', '/app/projects/p1'],
    ['Connect', '/app/projects/p1/connect'],
  ])('leaves it to %s, which carries the setup itself', async (_page, path) => {
    pathname = path
    render(<TopBar />)
    await settle()
    expect(connectAgent()).toBeNull()
  })

  it('does not ask again once the agent has connected, busy or quiet', async () => {
    pathname = '/app/projects/p1/database'
    for (const connected of [CONNECTED, IDLE]) {
      clearAgentConnectionCache()
      agentAnswer = connected
      const { unmount } = render(<TopBar />)
      await settle()
      expect(connectAgent()).toBeNull()
      unmount()
    }
  })

  it('is not offered to someone who cannot create keys', async () => {
    pathname = '/app/projects/p1/database'
    roleAnswer = DEVELOPER
    render(<TopBar />)
    await settle()
    expect(connectAgent()).toBeNull()
  })

  it('carries no agent slot and no Production chip', async () => {
    pathname = '/app/projects/p1/database'
    agentAnswer = IDLE
    render(<TopBar />)
    await settle()
    expect(screen.queryByText(/Last call|Agent connected/)).toBeNull()
    expect(screen.queryByText('Production')).toBeNull()
  })
})

describe("the sidebar's Connect item", () => {
  const item = () => document.querySelector<HTMLElement>('[data-tour="nav-connect"]')

  it('says nothing about the agent until the answer is in', () => {
    render(<ProjectSidebar />)
    expect(item()).toHaveAttribute('href', '/app/projects/p1/connect')
    expect(item()?.textContent).toBe('Connect')
  })

  it('says "Not connected" in words while no agent is connected', async () => {
    render(<ProjectSidebar />)
    await settle()
    expect(item()).toHaveTextContent('Not connected')
    expect(item()).toHaveAccessibleName('Connect, not connected')
  })

  it('is live only while the agent is at work, and names it with its last call', async () => {
    agentAnswer = CONNECTED
    render(<ProjectSidebar />)
    await settle()
    // Monochrome status (2026-11-16): live is the filled glyph in mid grey, never a hue.
    expect(item()?.querySelector('[data-agent-state="active"] svg.text-zinc-300 circle[fill="currentColor"]')).not.toBeNull()
    expect(item()?.getAttribute('title')).toBe('Visual Studio Code, last call just now')
    expect(item()).toHaveAccessibleName('Connect, Visual Studio Code, last call just now')
    expect(item()).not.toHaveTextContent('Not connected')
  })

  it('shows a quiet agent hollow, never live, with when it last called', async () => {
    // Production QA (2026-11-09): "Agent connected", green, six days after the
    // last call. MCP over HTTP holds no connection to see; a call is the sign.
    agentAnswer = IDLE
    render(<ProjectSidebar />)
    await settle()
    expect(item()?.querySelector('[data-agent-state="active"]')).toBeNull()
    // Hollow and dim: the idle glyph, never the filled live one.
    expect(item()?.querySelector('[data-agent-state="quiet"] svg.text-zinc-500')).not.toBeNull()
    expect(item()?.querySelector('[data-agent-state] circle[fill="currentColor"]')).toBeNull()
    expect(item()?.getAttribute('title')).toBe('Visual Studio Code, last call 6 d ago')
    expect(item()).not.toHaveTextContent('Not connected')
  })
})

describe('Connect', () => {
  // The header's one fact is the agent's: live only while it is at work,
  // hollow and with its last call when it is quiet (decision 1, 2026-11-16).
  it('is live only while the agent is at work, and otherwise says when it last called', async () => {
    agentAnswer = CONNECTED
    const { unmount } = render(<ProjectConnectPage />)
    await settle()
    expect(screen.getByText(/^Last call just now/)).toBeInTheDocument()
    expect(screen.getByText('Agent at work')).toBeInTheDocument()
    unmount()

    clearAgentConnectionCache()
    agentAnswer = IDLE
    render(<ProjectConnectPage />)
    await settle()
    expect(screen.queryByText('Agent at work')).toBeNull()
    expect(screen.getByText('Agent connected, quiet')).toBeInTheDocument()
    expect(screen.getByText(/^Last call 6 d ago/)).toBeInTheDocument()
  })

  it('says no agent is connected when none is', async () => {
    render(<ProjectConnectPage />)
    await settle()
    expect(screen.getByText('No agent connected')).toBeInTheDocument()
  })
})
