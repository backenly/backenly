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
const app = (origin: string, isActive = true) => ({
  id: origin,
  origin,
  isActive,
  connectedBy: 'u1',
  backendVersion: 1,
  connectedAt: new Date().toISOString(),
  disconnectedAt: null,
})
const BLOCKED = 'Browsers on other sites are blocked. Servers and mobile apps are not affected.'
const OPEN = /^Any website can still call the API: only development addresses are listed, and those never limit it\. Add your app’s real address to block browsers on other sites\.$/
let origins: Array<ReturnType<typeof app>>

beforeEach(() => {
  origins = [app('https://shop.example')]
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    const body = path.endsWith('/connection-health') ? HEALTH : path.endsWith('/connected-apps') ? { apps: origins } : {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
})

async function renderCards() {
  render(<FrontendRuntimeCards projectId="p1" />)
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
}

it('says a request without an Origin failed its key check, in a sentence that agrees with its number', async () => {
  await renderCards()
  expect(screen.getByText(/^1 request without an Origin header failed the API key check, the last 33 min ago\. Usually/)).toBeInTheDocument()
  expect(screen.queryByText(/were rejected/)).toBeNull()
})

it('says the allowlist binds browsers, not every caller', async () => {
  await renderCards()
  expect(screen.getByText(BLOCKED)).toBeInTheDocument()
  expect(screen.queryByText(/Only these origins can call/)).toBeNull()
})

// Production QA, 2026-11-27: with http://localhost:5173 the only allowed
// origin the page said other sites are blocked, and a call from
// https://evil.example was answered with its own origin allowed. Development
// origins never make the list exclusive (lib/security/development-origin.ts),
// and the page now says what the API does.
it.each([
  ['a dev server on localhost', ['http://localhost:5173']],
  ['a dev server and a LAN address', ['http://localhost:5173', 'http://192.168.1.20:3000']],
  ['a development origin beside a removed real one', ['http://localhost:5173']],
])('says any website can still call the API while the list holds only %s', async (_name, listed) => {
  origins = [...listed.map((o) => app(o)), app('https://old.example', false)]
  await renderCards()
  expect(screen.getByText(OPEN)).toBeInTheDocument()
  expect(screen.queryByText(BLOCKED)).toBeNull()
})

it('says other sites are blocked once a real address is on the list beside the development ones', async () => {
  origins = [app('http://localhost:5173'), app('https://shop.example')]
  await renderCards()
  expect(screen.getByText(BLOCKED)).toBeInTheDocument()
  expect(screen.queryByText(OPEN)).toBeNull()
})
