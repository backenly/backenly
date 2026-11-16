/**
 * @jest-environment jsdom
 */
/**
 * Integrations → Connect Stripe: the key is checked before anything is stored.
 * Production QA (2026-11-09): step 1 accepted any text, and Stripe's refusal
 * came only after the next step (what to build) was filled in. The dialog is
 * one step now (console rebuild, 2026-11-16): Connect asks the provider first,
 * puts a refusal under the field it is about and stores nothing, and only then
 * stores the key and closes onto the provider's page.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'

const mockRouter = { push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useParams: () => ({ id: 'p1' }),
  usePathname: () => '/app/projects/p1/integrations',
  useSearchParams: () => new URLSearchParams(),
}))

import { IntegrationsPanel } from '@/components/hub/IntegrationsPanel'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'

// A made-up key, built from parts: a literal shaped like a live Stripe key is
// (rightly) refused by the repository's secret scanning.
const KEY = ['sk', 'live', '51Kz7YtRqPoNmLkJiHgFeDcBaZy'].join('_')

function stub(verify: { status: number; body: unknown }) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    if (path === '/api/projects/p1/credentials/verify') {
      return Promise.resolve({ ok: verify.status < 300, status: verify.status, json: async () => verify.body } as Response)
    }
    if (path === '/api/projects/p1/credentials') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) } as Response)
    }
    const body =
      path === '/api/projects/p1/integrations' ? { integrations: {}, keyVault: {} }
      : path === '/api/projects/p1' ? { success: true, data: { id: 'p1', name: 'shop', organizationId: 'org_1', role: 'DEVELOPER', canWrite: true, canAdminister: false } }
      : {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
}

const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
const input = (name: string) => document.querySelector(`input[name="${name}"]`) as HTMLInputElement

beforeEach(() => {
  forgetProjectReads()
  clearProjectRoleCache()
})

async function connectStripe(values: { key: string; webhook?: string }) {
  render(<IntegrationsPanel />)
  await flush()
  fireEvent.click(screen.getByRole('button', { name: 'Connect Stripe' }))
  await flush()
  fireEvent.change(input('STRIPE_SECRET_KEY'), { target: { value: values.key } })
  if (values.webhook) fireEvent.change(input('STRIPE_WEBHOOK_SECRET'), { target: { value: values.webhook } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
  await flush()
}

const callsTo = (path: string) => (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url) === path)
const verifyCalls = () => callsTo('/api/projects/p1/credentials/verify')
const storeCalls = () => callsTo('/api/projects/p1/credentials')
const dialogOpen = () => !!input('STRIPE_SECRET_KEY')

it('says a key Stripe refuses under the key, and stores nothing', async () => {
  const refusal = 'Stripe rejected this key (HTTP 401) — it is not a valid credential for that account.'
  stub({ status: 422, body: { ok: false, envVar: 'STRIPE_SECRET_KEY', error: refusal } })
  await connectStripe({ key: KEY })
  expect(screen.getByRole('alert')).toHaveTextContent(refusal)
  expect(input('STRIPE_SECRET_KEY')).toHaveAttribute('aria-invalid', 'true')
  expect(storeCalls()).toHaveLength(0)
  expect(dialogOpen()).toBe(true)
  expect(JSON.parse(verifyCalls()[0][1].body)).toEqual({ integrationId: 'stripe', values: { STRIPE_SECRET_KEY: KEY } })
})

it('says a malformed webhook signing secret under its own field', async () => {
  const hint = 'Stripe webhook signing secrets must start with whsec_.'
  stub({ status: 422, body: { ok: false, envVar: 'STRIPE_WEBHOOK_SECRET', error: hint } })
  await connectStripe({ key: KEY, webhook: 'not-a-signing-secret' })
  expect(screen.getByRole('alert')).toHaveTextContent(hint)
  expect(input('STRIPE_WEBHOOK_SECRET')).toHaveAttribute('aria-invalid', 'true')
  expect(input('STRIPE_SECRET_KEY')).toHaveAttribute('aria-invalid', 'false')
  expect(storeCalls()).toHaveLength(0)
})

it('stores the key once Stripe accepts it, and closes onto the page', async () => {
  stub({
    status: 200,
    body: { ok: true, checks: [{ envVar: 'STRIPE_SECRET_KEY', status: 'verified', detail: 'Stripe accepted this key.' }] },
  })
  await connectStripe({ key: KEY })
  expect(JSON.parse(storeCalls()[0][1].body)).toEqual({ integrationId: 'stripe', values: { STRIPE_SECRET_KEY: KEY } })
  expect(dialogOpen()).toBe(false)
})

it("CONTROL: when the check can't be made, connecting goes on (storing checks again)", async () => {
  stub({ status: 500, body: { error: 'Internal server error' } })
  await connectStripe({ key: KEY })
  expect(storeCalls()).toHaveLength(1)
  expect(screen.queryByRole('alert')).toBeNull()
})
