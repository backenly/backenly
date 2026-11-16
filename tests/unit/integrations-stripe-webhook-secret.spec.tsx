/**
 * @jest-environment jsdom
 */
/**
 * THE INTEGRATIONS PAGE SAYS WHETHER STRIPE CAN RECEIVE EVENTS (#611)
 * ===================================================================
 * Stripe's webhook signing secret was labelled "Optional, add after
 * deploying", while the receiver (app/api/v1/[projectId]/webhooks/[integration])
 * answers 401 to every Stripe event until it is stored. So a project connected
 * with the secret key alone read "Connected · key confirmed" while every event
 * was refused, and the page:
 *
 *   - counted the card's status from the secret key alone, with the signing
 *     secret's status loaded and never shown;
 *   - showed the receiver URL, which has to be entered in Stripe to get a
 *     signing secret at all, nowhere;
 *   - could add the secret only through the connect dialog, which wanted the
 *     secret key again and something to build before it would store it.
 *
 * The real page, with fetch and the project's API address stood in for.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'

// The connector page is a URL (?connector=stripe); the tests set it here.
let mockSearch = new URLSearchParams()
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({ id: 'p1' }),
  usePathname: () => '/app/projects/p1/integrations',
  useSearchParams: () => mockSearch,
}))
const mockProject = {
  apiBaseUrl: 'https://api.backenly.test/api/v1/p1' as string | null,
  apiUrlProd: null as string | null,
  // The role the page reads (useProjectRole): a developer connects providers.
  role: 'DEVELOPER',
  canWrite: true,
  canAdminister: false,
  organizationId: 'org_1',
}
jest.mock('@/lib/api/projects', () => ({ getProject: jest.fn(async () => mockProject), forgetProjectReads: jest.fn() }))

import { IntegrationsPanel } from '@/components/hub/IntegrationsPanel'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'
const ENDPOINT = 'https://api.backenly.test/api/v1/p1/webhooks/stripe'
const SECRET = `whsec_${'a1b2c3d4'.repeat(4)}`

const STRIPE_KEY = { maskedKey: 'sk_test…1234', connectedAt: '2026-11-11T00:00:00.000Z', verification: 'verified', verificationDetail: 'Stripe accepted this key.' }
const STRIPE_SECRET = {
  maskedKey: 'whsec_a…c3d4',
  connectedAt: '2026-11-11T00:00:00.000Z',
  verification: 'unverifiable',
  verificationDetail: 'Stripe has no endpoint that can confirm a webhook signing secret.',
}

/** What GET /api/projects/p1/integrations answers. */
let state: { integrations: Record<string, { enabled: boolean }>; keyVault: Record<string, unknown> }
/** What POST /api/projects/p1/credentials answers. */
let credentialsAnswer: { status: number; body: Record<string, unknown> }
let posted: Array<Record<string, unknown>>

function stub() {
  posted = []
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]
    if (path === '/api/projects/p1/credentials') {
      const body = JSON.parse(String(init!.body))
      posted.push(body)
      // What the route does with a value it stores: the next load shows it.
      if (credentialsAnswer.status === 200 && body.values.STRIPE_WEBHOOK_SECRET) state.keyVault.stripe_webhook_secret = STRIPE_SECRET
      return Promise.resolve({ ok: credentialsAnswer.status === 200, status: credentialsAnswer.status, json: async () => credentialsAnswer.body } as unknown as Response)
    }
    if (path === '/api/projects/p1/credentials/verify') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, checks: [] }) } as unknown as Response)
    }
    const body =
      path === '/api/projects/p1/integrations' ? state
      : path === '/api/projects/p1' ? { success: true, data: { id: 'p1', name: 'shop', organizationId: 'org_1', role: 'DEVELOPER', canWrite: true, canAdminister: false } }
      : {}
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as unknown as Response)
  }) as unknown as typeof fetch
}

const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })
const input = (name: string) => document.querySelector(`input[name="${name}"]`) as HTMLInputElement | null
/** A connected provider's row in the Connected section, found by its name's link. */
const connectedRow = (name: string) => within(screen.getByRole('region', { name: 'Connected' })).getByRole('link', { name }).closest('li') as HTMLElement

beforeEach(() => {
  mockSearch = new URLSearchParams()
  forgetProjectReads()
  clearProjectRoleCache()
  mockProject.apiBaseUrl = 'https://api.backenly.test/api/v1/p1'
  mockProject.apiUrlProd = null
  credentialsAnswer = { status: 200, body: { success: true, stored: ['STRIPE_WEBHOOK_SECRET'] } }
  // Stripe connected with its secret key alone.
  state = { integrations: { stripe: { enabled: true } }, keyVault: { stripe: STRIPE_KEY } }
  stub()
})

async function openStripe() {
  mockSearch = new URLSearchParams('connector=stripe')
  render(<IntegrationsPanel />)
  await flush()
}

describe('the Stripe row', () => {
  it('does not count Stripe as connected without its signing secret, and says which credential is missing', async () => {
    render(<IntegrationsPanel />)
    await flush()

    expect(screen.getByText('None connected')).toBeInTheDocument()
    expect(within(connectedRow('Stripe')).getByText('Add the webhook secret')).toBeInTheDocument()
    // Its state is the missing secret, never the healthy "Connected" (its date fact aside).
    expect(within(connectedRow('Stripe')).queryByText('Connected')).toBeNull()
  })

  it('counts Stripe as connected once both are stored', async () => {
    state.keyVault.stripe_webhook_secret = STRIPE_SECRET
    render(<IntegrationsPanel />)
    await flush()

    expect(screen.getByText('1 connected')).toBeInTheDocument()
    expect(within(connectedRow('Stripe')).queryByText('Add the webhook secret')).toBeNull()
  })

  it('says the same of OneSignal without its App ID, which push needs', async () => {
    state = {
      integrations: { onesignal: { enabled: true } },
      keyVault: { onesignal: { ...STRIPE_KEY, maskedKey: 'os_v2_a…wxyz', verification: 'unverifiable' } },
    }
    render(<IntegrationsPanel />)
    await flush()

    expect(screen.getByText('None connected')).toBeInTheDocument()
    expect(within(connectedRow('OneSignal')).getByText('Add the App ID')).toBeInTheDocument()
  })
})

describe("Stripe's page", () => {
  it('shows the endpoint URL to add in Stripe, from the project’s own API address', async () => {
    await openStripe()

    expect(screen.getByRole('heading', { name: 'Stripe sends events to' })).toBeInTheDocument()
    expect(screen.getByText(ENDPOINT)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Copy endpoint URL' }).length).toBeGreaterThan(0)
  })

  it('uses an operator’s API address for the project when one is set, as the Connect page does', async () => {
    mockProject.apiUrlProd = 'https://api.example.test/api/v1/p1/'
    await openStripe()

    expect(screen.getByText('https://api.example.test/api/v1/p1/webhooks/stripe')).toBeInTheDocument()
    expect(screen.queryByText(ENDPOINT)).toBeNull()
  })

  it('says when this server has no address for the project’s region, rather than show another one', async () => {
    mockProject.apiBaseUrl = null
    await openStripe()

    expect(screen.getByText('This server has no API address for the project’s region, so its endpoint URL can’t be shown.')).toBeInTheDocument()
    expect(screen.queryByText(/\/webhooks\/stripe$/)).toBeNull()
  })

  it('says the signing secret is not stored and what that stops', async () => {
    await openStripe()

    expect(screen.getByText('STRIPE_WEBHOOK_SECRET')).toBeInTheDocument()
    expect(screen.getAllByText('Not stored').length).toBeGreaterThan(0)
    expect(screen.getByText('Stripe events are refused until it’s stored.')).toBeInTheDocument()
  })

  it('adds the signing secret on its own: no secret key again, nothing to pick', async () => {
    await openStripe()
    fireEvent.click(screen.getByRole('button', { name: 'Add webhook secret' }))
    await flush()

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Add the Stripe webhook secret')).toBeInTheDocument()
    expect(within(dialog).getByText(ENDPOINT)).toBeInTheDocument()
    expect(input('STRIPE_SECRET_KEY')).toBeNull()
    expect(within(dialog).queryByText(/What should Stripe do/)).toBeNull()

    fireEvent.change(input('STRIPE_WEBHOOK_SECRET')!, { target: { value: SECRET } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await flush()

    expect(posted).toEqual([{ integrationId: 'stripe', values: { STRIPE_WEBHOOK_SECRET: SECRET } }])
    expect(screen.queryByRole('dialog')).toBeNull()
    // Read again: both stored, the secret shown like the key, and it can be replaced.
    expect(screen.getByText(/whsec_a/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument()
  })

  it('says why a secret was refused, and keeps the dialog open', async () => {
    // What the route answers (storeIntegrationKey's format check).
    const refusal =
      'Stripe webhook signing secrets must start with whsec_. Find yours in the Stripe Dashboard → Webhooks → your endpoint → Signing secret.'
    credentialsAnswer = { status: 422, body: { error: refusal } }
    await openStripe()
    fireEvent.click(screen.getByRole('button', { name: 'Add webhook secret' }))
    await flush()
    fireEvent.change(input('STRIPE_WEBHOOK_SECRET')!, { target: { value: 'not-a-signing-secret' } })
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }))
    await flush()

    expect(screen.getByRole('alert')).toHaveTextContent(refusal)
    expect(input('STRIPE_WEBHOOK_SECRET')).not.toBeNull()
  })
})

describe('the connect dialog', () => {
  it('no longer calls the signing secret optional: it says what it is for, beside the endpoint URL', async () => {
    state = { integrations: {}, keyVault: {} }
    await openStripe()
    fireEvent.click(screen.getAllByRole('button', { name: /^Connect/ })[0])
    await flush()

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByText('Optional, add after deploying')).toBeNull()
    expect(within(dialog).getByText(/Stripe events are refused until it’s stored\./)).toBeInTheDocument()
    expect(within(dialog).getByText(ENDPOINT)).toBeInTheDocument()
    expect(input('STRIPE_SECRET_KEY')).not.toBeNull()
    expect(input('STRIPE_WEBHOOK_SECRET')).not.toBeNull()
  })
})
