/**
 * @jest-environment jsdom
 */
/**
 * Settings → API keys: a preview key whose branch was merged or discarded never
 * answers again, so it shows that it ended with its branch, not the far-off
 * expiry it was minted with. Production QA (2026-11-09) found five such keys
 * listed as live, "expiring" in February 2027.
 */
import { act, render, screen } from '@testing-library/react'
import { ClientKeysPanel } from '@/components/hub/ClientKeysPanel'

jest.mock('next/navigation', () => ({ useParams: () => ({ id: 'p1' }) }))

const key = (id: string, name: string, branch: { id: string; name: string; status: string } | null) => ({
  id, name, key: 'proj_live_ab12…', keyPrefix: 'proj_live_ab12', keyType: 'public', role: 'client',
  permissions: ['read', 'write'], capabilities: [], serviceRole: false, branchId: branch?.id ?? null, branch,
  projectId: 'p1', lastUsed: null, createdAt: '2026-11-09T10:00:00.000Z', expiresAt: '2027-02-07T10:00:00.000Z',
  rateLimit: 1000, rateLimitWindow: 3600, requestCount: 0, resetAt: null,
})

beforeEach(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        apiKeys: [
          key('k1', 'scratch key', { id: 'b1', name: 'scratch', status: 'discarded' }),
          key('k2', 'staging key', { id: 'b2', name: 'live', status: 'active' }),
        ],
      }),
    } as Response),
  ) as unknown as typeof fetch
})

it('says a closed branch’s key ended with it, and keeps a live one’s date', async () => {
  render(<ClientKeysPanel />)
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
  const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement
  expect(row('scratch key')).toHaveTextContent('Ended with branch')
  expect(row('scratch key')).not.toHaveTextContent('2027')
  expect(row('staging key')).not.toHaveTextContent('Ended with branch')
  expect(row('staging key')).toHaveTextContent('2027')
})
