/**
 * @jest-environment jsdom
 */

/**
 * THE CONSOLE'S ADMIN KEY IS A SERVICE KEY
 * ========================================
 * Settings → API keys offered "Admin — Full access. Server-side only, never in
 * a browser." and then sent `serviceRole: false`. The runtime's elevation
 * switch is serviceRole, not the role string, so the minted proj_live_ key was
 * neither full-access (RLS still applied; the data plane demanded an end-user
 * token for writes) nor browser-refused (the refusal only fires for
 * serviceRole keys) — the exact opposite of the copy on the option.
 *
 * Renders the real panel and asserts the request body the console actually
 * sends: Admin → serviceRole true; Client → serviceRole false.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { ClientKeysPanel } from '@/components/hub/ClientKeysPanel'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({ id: 'p1' }),
  usePathname: () => '/app/projects/p1/settings',
  useSearchParams: () => new URLSearchParams(),
}))

const posted: Array<Record<string, unknown>> = []

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  posted.length = 0
  global.fetch = jest.fn(async (url: any, init?: any) => {
    const path = String(url).split('?')[0]
    if (path === '/api/api-keys' && init?.method === 'POST') {
      posted.push(JSON.parse(init.body))
      return json(200, { apiKey: { key: 'svc_live_test', id: 'k1', name: 'x' } })
    }
    if (path === '/api/api-keys') return json(200, { apiKeys: [] })
    return json(404, {})
  }) as any
})

async function createKeyAs(roleLabel: string) {
  render(<ClientKeysPanel />)
  await act(async () => {})
  fireEvent.click(screen.getAllByText('New key')[0])
  fireEvent.change(screen.getByPlaceholderText('Production mobile app…'), { target: { value: 'server cron' } })
  fireEvent.click(screen.getByDisplayValue(roleLabel.toLowerCase() === 'admin' ? 'admin' : 'client'))
  fireEvent.click(screen.getByText('Create key'))
  await act(async () => {})
}

it('the Admin option mints a service-role key', async () => {
  await createKeyAs('admin')
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({ role: 'admin', serviceRole: true, keyType: 'public' })
})

it('the Client option stays publishable', async () => {
  await createKeyAs('client')
  expect(posted).toHaveLength(1)
  expect(posted[0]).toMatchObject({ role: 'client', serviceRole: false })
})

it('the option copy says what the key actually is', async () => {
  render(<ClientKeysPanel />)
  await act(async () => {})
  fireEvent.click(screen.getAllByText('New key')[0])
  expect(screen.getByText(/bypasses row security/i)).toBeTruthy()
  expect(screen.getByText(/refuses it from a browser/i)).toBeTruthy()
})
