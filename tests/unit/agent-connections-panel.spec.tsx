/**
 * @jest-environment jsdom
 */

/**
 * An agent the user signed in from the browser can be seen and disconnected
 * on Connect, Agents (medium findings T4, CON-09). The keys route always
 * returned these OAuth connections, but the panel read only `keys`, so it
 * said "No agent keys yet" while the top bar said an agent was connected.
 * Settings, API keys was the only listing and labelled them "Client".
 *
 * Since 2026-11-16 keys and browser sign-ins are one list on Connect → Agents,
 * each with its own ⋯ (Revoke key, or Disconnect), and API keys sit beside it
 * on Connect → API, so the old pointer from Settings is gone.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { AgentKeysPanel } from '@/components/connect/AgentKeysPanel'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'
import { clearAgentConnectionCache } from '@/lib/hooks/useAgentConnection'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({ id: 'p1' }),
  usePathname: () => '/app/projects/p1/connect',
  useSearchParams: () => new URLSearchParams(),
}))

const CONNECTION = {
  id: 'conn-1',
  client: 'Claude Code',
  readOnly: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  lastUsed: new Date(Date.now() - 5 * 60_000).toISOString(),
}

const calls: Array<{ url: string; method: string }> = []

function json(status: number, body: unknown) {
  const text = JSON.stringify(body)
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => text } as Response
}

function answer(url: string, init?: RequestInit): Response {
  const path = url.split('?')[0]
  calls.push({ url: path, method: init?.method ?? 'GET' })
  if (path === '/api/projects/p1/mcp/keys') return json(200, { keys: [], connections: [CONNECTION] })
  if (path === '/api/projects/p1/mcp/keys/conn-1' && init?.method === 'DELETE') return json(200, { ok: true, revoked: 'conn-1' })
  if (path === '/api/projects/p1') return json(200, { success: true, data: { id: 'p1', name: 'shop', role: 'OWNER', canWrite: true, canAdminister: true } })
  if (path.endsWith('/mcp/status')) return json(200, { connected: true, lastSeenAt: CONNECTION.lastUsed, client: 'Claude Code' })
  return json(404, {})
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

beforeEach(() => {
  forgetProjectReads()
  clearProjectRoleCache()
  clearAgentConnectionCache()
  calls.length = 0
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(answer(String(input), init)),
  ) as unknown as typeof fetch
})

describe('Connect, Agents', () => {
  const row = () => screen.getByText('Claude Code').closest('li') as HTMLElement

  it('lists an agent signed in from the browser in the one list, with no key to show', async () => {
    render(<AgentKeysPanel projectId="p1" />)
    await settle()
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument()
    expect(within(row()).getByText('Read-only')).toBeInTheDocument()
    expect(within(row()).getByText('Signed in from the browser')).toBeInTheDocument()
    expect(within(row()).queryByText(/mcp_oauth_/)).toBeNull()
    expect(within(row()).getByRole('button', { name: 'Actions for Claude Code' })).toBeInTheDocument()
  })

  it('disconnects it, after saying what that does, through the connection’s own revoke', async () => {
    render(<AgentKeysPanel projectId="p1" />)
    await settle()
    fireEvent.click(within(row()).getByRole('button', { name: 'Actions for Claude Code' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Disconnect' }))
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect Claude Code?' })
    expect(within(dialog).getByText(/stops working immediately/)).toBeInTheDocument()
    expect(within(dialog).getByText(/You can’t undo this|You can't undo this/)).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }))
    })
    await settle()
    expect(calls).toContainEqual({ url: '/api/projects/p1/mcp/keys/conn-1', method: 'DELETE' })
  })
})
