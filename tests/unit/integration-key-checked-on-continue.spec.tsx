/**
 * @jest-environment jsdom
 */
/**
 * Integrations → Connect Stripe: the key is checked on Continue, on its own
 * step. Production QA (2026-11-09): step 1 accepted any text, and Stripe's
 * refusal came only after the next step (what to build) was filled in.
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

// A made-up key, built from parts: a literal shaped like a live Stripe key is
// (rightly) refused by the repository's secret scanning.
const KEY = ['sk', 'live', '51Kz7YtRqPoNmLkJiHgFeDcBaZy'].join('_')
const NEXT_STEP = 'What should Stripe do in this backend?'

function stub(verify: { status: number; body: unknown }) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    if (path === '/api/projects/p1/credentials/verify') {
      return Promise.resolve({ ok: verify.status < 300, status: verify.status, json: async () => verify.body } as Response)
    }
    const body = path === '/api/projects/p1/integrations' ? { integrations: {}, keyVault: {} } : {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
}

const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
const input = (name: string) => document.querySelector(`input[name="${name}"]`) as HTMLInputElement

async function openStripeAndContinue(values: { key: string; webhook?: string }) {
  render(<IntegrationsPanel />)
  await flush()
  fireEvent.click(screen.getByRole('button', { name: /^Stripe/ }))
  await flush()
  fireEvent.click(screen.getAllByRole('button', { name: 'Connect Stripe' })[0])
  await flush()
  fireEvent.change(input('STRIPE_SECRET_KEY'), { target: { value: values.key } })
  if (values.webhook) fireEvent.change(input('STRIPE_WEBHOOK_SECRET'), { target: { value: values.webhook } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await flush()
}

const verifyCalls = () =>
  (global.fetch as jest.Mock).mock.calls.filter(([url]) => String(url) === '/api/projects/p1/credentials/verify')

it('says a key Stripe refuses on the key step, and the next step does not open', async () => {
  const refusal = 'Stripe rejected this key (HTTP 401) — it is not a valid credential for that account.'
  stub({ status: 422, body: { ok: false, envVar: 'STRIPE_SECRET_KEY', error: refusal } })
  await openStripeAndContinue({ key: KEY })
  expect(screen.getByRole('alert')).toHaveTextContent(refusal)
  expect(input('STRIPE_SECRET_KEY')).toHaveAttribute('aria-invalid', 'true')
  expect(screen.queryByText(NEXT_STEP)).toBeNull()
  expect(JSON.parse(verifyCalls()[0][1].body)).toEqual({ integrationId: 'stripe', values: { STRIPE_SECRET_KEY: KEY } })
})

it('says a malformed webhook signing secret under its own field', async () => {
  const hint = 'Stripe webhook signing secrets must start with whsec_.'
  stub({ status: 422, body: { ok: false, envVar: 'STRIPE_WEBHOOK_SECRET', error: hint } })
  await openStripeAndContinue({ key: KEY, webhook: 'not-a-signing-secret' })
  expect(screen.getByRole('alert')).toHaveTextContent(hint)
  expect(input('STRIPE_WEBHOOK_SECRET')).toHaveAttribute('aria-invalid', 'true')
  expect(input('STRIPE_SECRET_KEY')).toHaveAttribute('aria-invalid', 'false')
  expect(screen.queryByText(NEXT_STEP)).toBeNull()
})

it("opens the next step with Stripe's answer when Stripe accepts the key", async () => {
  stub({
    status: 200,
    body: { ok: true, checks: [{ envVar: 'STRIPE_SECRET_KEY', status: 'verified', detail: 'Stripe accepted this key.' }] },
  })
  await openStripeAndContinue({ key: KEY })
  expect(screen.getByText(NEXT_STEP)).toBeInTheDocument()
  expect(screen.getByText('Stripe accepted this key.')).toBeInTheDocument()
})

it("CONTROL: when the check can't be made, the next step still opens (connecting checks again)", async () => {
  stub({ status: 500, body: { error: 'Internal server error' } })
  await openStripeAndContinue({ key: KEY })
  expect(screen.getByText(NEXT_STEP)).toBeInTheDocument()
  expect(screen.queryByRole('alert')).toBeNull()
})
