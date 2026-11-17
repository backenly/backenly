/**
 * @jest-environment jsdom
 */
/**
 * Connect → API keys shows each key's rate as the runtime counts it: a browser
 * key per address, any other key against itself. The console worked that out
 * from the list's `keyType`, a storage value that read "public" for every
 * project key (production QA re-test 2026-11-16, report #106). The list no
 * longer carries it; it says the window that decides each key's requests
 * (`clientWindow`), and the console shows that.
 */
import { act, render, screen } from '@testing-library/react'
import { ClientKeysPanel } from '@/components/hub/ClientKeysPanel'

jest.mock('next/navigation', () => ({ useParams: () => ({ id: 'p1' }) }))

const key = (
  id: string,
  name: string,
  kind: string,
  serviceRole: boolean,
  clientWindow: { limit: number; windowSeconds: number; perAddress: boolean },
) => ({
  id, name, key: `${kind === 'service' ? 'svc' : 'proj'}_live_••••••••`, keyPrefix: kind === 'service' ? 'svc_live_' : 'proj_live_',
  kind, role: kind === 'service' ? 'admin' : 'client', permissions: ['read', 'write'], capabilities: [], serviceRole,
  branchId: null, branch: null, projectId: 'p1', lastUsed: null, createdAt: '2026-11-16T10:00:00.000Z', expiresAt: null,
  rateLimit: 1000, rateLimitWindow: 3600, clientWindow, requestCount: 0, resetAt: null,
})

beforeEach(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        apiKeys: [
          key('k1', 'web app', 'publishable', false, { limit: 300, windowSeconds: 10, perAddress: true }),
          key('k2', 'nightly job', 'service', true, { limit: 1000, windowSeconds: 3600, perAddress: false }),
        ],
      }),
    } as Response),
  ) as unknown as typeof fetch
})

it("shows the window the server says decides each key's requests", async () => {
  render(<ClientKeysPanel />)
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
  const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement
  expect(row('web app')).toHaveTextContent('300 / 10 s per address')
  expect(row('nightly job')).toHaveTextContent('1,000 / 1 h')
  expect(row('nightly job')).not.toHaveTextContent('per address')
})
