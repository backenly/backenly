/**
 * @jest-environment jsdom
 */
/**
 * The Integrations page offers every provider the registry serves. Production
 * QA (2026-11-09, report 52): the page offered 5 providers (Stripe, Resend,
 * OpenAI, Anthropic, PostHog) while the MCP integrations tool and the functions
 * runtime served 11, so SendGrid, Twilio, OneSignal, Replicate, Runway and
 * Stability could be connected by an agent and used by a function but not
 * connected from the console.
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
import { connectableProviders } from '@/lib/services/ai-functions/integration-registry'

/** How each registry provider is named on its card. */
const CARD_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  onesignal: 'OneSignal',
  openai: 'OpenAI',
  posthog: 'PostHog',
  replicate: 'Replicate',
  resend: 'Resend',
  runway: 'Runway',
  sendgrid: 'SendGrid',
  stability: 'Stability AI',
  stripe: 'Stripe',
  twilio: 'Twilio',
}

function stub() {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    if (path === '/api/projects/p1/credentials/verify') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, checks: [] }) } as unknown as Response)
    }
    const body = path === '/api/projects/p1/integrations' ? { integrations: {}, keyVault: {} } : {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as unknown as Response)
  }) as unknown as typeof fetch
}

const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
const input = (name: string) => document.querySelector(`input[name="${name}"]`) as HTMLInputElement

it('offers a card for every provider the registry serves, and counts them all', async () => {
  stub()
  render(<IntegrationsPanel />)
  await flush()
  const ids = connectableProviders().map((p) => p.id)
  // This test names the registry's providers; a new one must be named here too.
  expect([...ids].sort()).toEqual(Object.keys(CARD_NAMES).sort())
  for (const id of ids) {
    expect(screen.getByRole('button', { name: new RegExp(`^${CARD_NAMES[id]}`) })).toBeInTheDocument()
  }
  expect(screen.getByText(`0 of ${ids.length} connected`)).toBeInTheDocument()
})

it('groups the providers by the registry’s categories', async () => {
  stub()
  render(<IntegrationsPanel />)
  await flush()
  for (const title of ['Payments', 'Email', 'SMS', 'Push notifications', 'AI / LLM', 'Image & video generation']) {
    // A filter's accessible name is its title followed by its count ("SMS1").
    expect(screen.getByRole('radio', { name: (name) => name.startsWith(title) })).toBeInTheDocument()
  }
  fireEvent.click(screen.getByRole('radio', { name: /^SMS/ }))
  await flush()
  expect(screen.getByRole('button', { name: /^Twilio/ })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^Stripe/ })).toBeNull()
})

it('connects OneSignal with its REST API key and its App ID, each in its own field', async () => {
  stub()
  render(<IntegrationsPanel />)
  await flush()
  fireEvent.click(screen.getByRole('button', { name: /^OneSignal/ }))
  await flush()
  fireEvent.click(screen.getAllByRole('button', { name: 'Connect OneSignal' })[0])
  await flush()
  fireEvent.change(input('ONESIGNAL_REST_API_KEY'), { target: { value: 'os_v2_app_restkeyvalue0123456789' } })
  fireEvent.change(input('ONESIGNAL_APP_ID'), { target: { value: '8f0e2a1c-3b4d-4e5f-a6b7-c8d9e0f1a2b3' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await flush()
  const verify = (global.fetch as jest.Mock).mock.calls.find(([url]) => String(url) === '/api/projects/p1/credentials/verify')
  expect(JSON.parse(verify![1].body)).toEqual({
    integrationId: 'onesignal',
    values: {
      ONESIGNAL_REST_API_KEY: 'os_v2_app_restkeyvalue0123456789',
      ONESIGNAL_APP_ID: '8f0e2a1c-3b4d-4e5f-a6b7-c8d9e0f1a2b3',
    },
  })
})
