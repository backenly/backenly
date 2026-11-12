/**
 * @jest-environment jsdom
 */
/**
 * The frontend cards say what actually happens to a request. Production QA
 * (2026-11-09): "1 request without an Origin header (last 33m ago) were
 * rejected" read as if the missing Origin were the reason, though a request
 * without one and with a valid key is served; and "Only these origins can call
 * the SDK" overclaimed, since the list binds browsers (CORS), not servers.
 */
import { act, render, screen } from '@testing-library/react'
import { FrontendRuntimeCards } from '@/components/connect/FrontendRuntimePanel'

const HEALTH = {
  failures: [],
  successes: [],
  probes: { count: 1, lastSeen: new Date(Date.now() - 33 * 60_000).toISOString() },
  totals: { failures24h: 0, failures1h: 0, bootstraps24h: 0, distinctOriginsFailing: 0, distinctOriginsConnected: 0 },
  summaryText: '',
}
const APPS = {
  apps: [{ id: 'a1', origin: 'https://shop.example', isActive: true, connectedBy: 'u1', backendVersion: 1, connectedAt: new Date().toISOString(), disconnectedAt: null }],
}

beforeEach(() => {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    const body = path.endsWith('/connection-health') ? HEALTH : path.endsWith('/connected-apps') ? APPS : {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
})

async function renderCards() {
  render(<FrontendRuntimeCards projectId="p1" />)
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
}

it('says a request without an Origin failed its key check, in a sentence that agrees with its number', async () => {
  await renderCards()
  expect(screen.getByText(/^1 request without an Origin header\s+failed the API key check \(last .+\)\. Usually/)).toBeInTheDocument()
  expect(screen.queryByText(/were rejected/)).toBeNull()
})

it('says the allowlist binds browsers, not every caller', async () => {
  await renderCards()
  expect(screen.getByText('1 active. Browsers block calls from other sites; servers and mobile apps are not affected.')).toBeInTheDocument()
  expect(screen.queryByText(/Only these origins can call/)).toBeNull()
})
