/**
 * @jest-environment jsdom
 */

/**
 * READ-ONLY IS CHOSEN AT ISSUANCE, IN THE CONSOLE
 * ================================================
 * The docs promise it everywhere — "Choose read-only or read-write when you
 * create it, because an agent cannot change its own key", "A human chooses
 * read-only when the key is issued" — and the keys route has supported
 * `readOnly: true` all along. But the console panel never sent the field and
 * never showed it: the only key it could mint was read-write (permissions
 * ['read','write','admin']), and keys minted read-only by hand were listed
 * with no marker. The only read-only path was the Cloud OAuth consent screen,
 * which a self-hosted install cannot even reach.
 *
 * Renders the real panel: the toggle sends readOnly, and a read-only key is
 * labelled in the list.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { AgentKeysPanel } from '@/components/connect/AgentKeysPanel'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({ id: 'p1' }),
  usePathname: () => '/app/projects/p1/connect',
  useSearchParams: () => new URLSearchParams(),
}))

const posted: Array<Record<string, unknown>> = []
let listedKeys: Array<Record<string, unknown>> = []

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response
}

beforeEach(() => {
  posted.length = 0
  listedKeys = []
  global.fetch = jest.fn(async (url: any, init?: any) => {
    const path = String(url).split('?')[0]
    if (path.endsWith('/mcp/keys') && init?.method === 'POST') {
      const body = JSON.parse(init.body)
      posted.push(body)
      return json(200, { rawKey: 'mcp_live_testkey', key: { id: 'k9', label: body.label, readOnly: body.readOnly === true } })
    }
    if (path.endsWith('/mcp/keys')) return json(200, { keys: listedKeys })
    if (path.endsWith('/mcp/usage')) return json(200, { calls24h: 0, calls7d: 0, errorRate: 0, byKey: [], recent: [] })
    if (path.endsWith('/mcp/status')) return json(200, { connected: false, lastSeenAt: null, client: null })
    return json(404, {})
  }) as any
})

it('the Read-only toggle issues a read-only key', async () => {
  render(<AgentKeysPanel projectId="p1" />)
  await act(async () => {})
  fireEvent.click(screen.getByLabelText(/read-only/i))
  fireEvent.change(screen.getByPlaceholderText(/Label, e.g./), { target: { value: 'contractor agent' } })
  fireEvent.click(screen.getByText('New key'))
  await act(async () => {})
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({ label: 'contractor agent', readOnly: true })
})

it('left off, the key is read-write as before', async () => {
  render(<AgentKeysPanel projectId="p1" />)
  await act(async () => {})
  fireEvent.change(screen.getByPlaceholderText(/Label, e.g./), { target: { value: 'ci server' } })
  fireEvent.click(screen.getByText('New key'))
  await act(async () => {})
  expect(posted[0]).toMatchObject({ readOnly: false })
})

it('a read-only key is labelled in the list, a read-write one is not', async () => {
  listedKeys = [
    { id: 'k1', name: 'MCP key', label: 'inspector', readOnly: true, masked: 'mcp_live_aaaa…', createdAt: new Date().toISOString(), lastUsed: null, expiresAt: null },
    { id: 'k2', name: 'MCP key', label: 'builder', readOnly: false, masked: 'mcp_live_bbbb…', createdAt: new Date().toISOString(), lastUsed: null, expiresAt: null },
  ]
  render(<AgentKeysPanel projectId="p1" />)
  await act(async () => {})
  expect(screen.getAllByText('Read-only')).toHaveLength(2) // the toggle + the one badge
  expect(screen.getByText('inspector')).toBeTruthy()
  expect(screen.getByText('builder')).toBeTruthy()
})
