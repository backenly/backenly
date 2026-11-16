/**
 * @jest-environment jsdom
 */
/**
 * On a plan without webhooks, the Webhooks page says so and offers no form.
 * Production QA (2026-11-09): on Free it showed "Webhooks require the Pro plan"
 * as an error, and "Add endpoint" still opened the form whose save was refused.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'

jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
// The endpoint page is a URL (?endpoint=); the tests set it here.
let search = new URLSearchParams()
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  usePathname: () => '/app/projects/p1/webhooks',
  useSearchParams: () => search,
  useParams: () => ({ id: 'p1' }),
}))
import { WebhooksPanel } from '@/components/integrations/WebhooksPanel'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'

const MADE_ON_PRO = {
  id: 'w1', eventType: 'row.inserted', targetUrl: 'https://hooks.example.test/in', active: true,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', logCount: 0,
}

function stub(plan: { allowed: boolean; currentPlan?: string }, webhooks: unknown[] = []) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    const body = path === '/api/projects/p1'
      ? { success: true, data: { id: 'p1', name: 'shop', organizationId: 'org_1', role: 'OWNER', canWrite: true, canAdminister: true } }
      : path.endsWith('/trigger-webhooks')
      ? { triggers: [], deliveries: [] }
      : path.endsWith('/logs')
      ? { logs: [] }
      : { webhooks, capture: { tables: ['orders'], required: webhooks.length > 0, healthy: true, readable: true }, plan }
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
}

beforeEach(() => {
  search = new URLSearchParams()
  forgetProjectReads()
  clearProjectRoleCache()
})

async function renderPanel() {
  render(<WebhooksPanel projectId="p1" />)
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() })
}

it('on Free, says webhooks come with Pro, offers the upgrade, and no form', async () => {
  stub({ allowed: false, currentPlan: 'SANDBOX' })
  await renderPanel()
  expect(screen.getByText('Webhooks come with Pro')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Upgrade to Pro' })).toHaveAttribute('href', '/app/org/org_1/billing')
  expect(screen.queryByRole('button', { name: /Add endpoint/ })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

const menuItems = (name: RegExp = /Actions for/) => {
  fireEvent.click(screen.getAllByRole('button', { name })[0])
  return screen.getAllByRole('menuitem').map((item) => item.textContent)
}

it('on Free with an endpoint made on Pro, says it still receives events and offers no form', async () => {
  stub({ allowed: false, currentPlan: 'SANDBOX' }, [MADE_ON_PRO])
  await renderPanel()
  expect(screen.getByText(/This project is on Free\. Endpoints keep receiving; you can turn them off or delete them\./)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Upgrade to Pro' })).toHaveAttribute('href', '/app/org/org_1/billing')
  expect(screen.queryByRole('button', { name: /Add endpoint/ })).toBeNull()
  // The endpoint is still listed, by its host and path.
  expect(screen.getByRole('link', { name: /hooks\.example\.test/ })).toBeInTheDocument()
})

it('on Free, the endpoint page sends no test', async () => {
  search = new URLSearchParams('endpoint=w1')
  stub({ allowed: false, currentPlan: 'SANDBOX' }, [MADE_ON_PRO])
  await renderPanel()
  expect(screen.getByText(/This project is on Free\. It keeps receiving; you can turn it off or delete it\./)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Send test/ })).toBeNull()
})

it('on Free, an endpoint can only be turned off or deleted, and Turn off waits for the server', async () => {
  stub({ allowed: false, currentPlan: 'SANDBOX' }, [MADE_ON_PRO])
  await renderPanel()
  expect(menuItems().filter(Boolean)).toEqual(['Turn off', 'Delete endpoint…'])
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Turn off' }))
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
  const patch = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'PATCH')
  expect(patch?.[0]).toBe('/api/projects/p1/webhooks/w1')
  expect(JSON.parse(patch?.[1].body)).toEqual({ active: false })
})

it('on Free, an endpoint that is off can only be deleted', async () => {
  stub({ allowed: false, currentPlan: 'SANDBOX' }, [{ ...MADE_ON_PRO, active: false }])
  await renderPanel()
  expect(menuItems().filter(Boolean)).toEqual(['Delete endpoint…'])
})

it('CONTROL: on Pro, the empty page offers to add an endpoint', async () => {
  stub({ allowed: true })
  await renderPanel()
  expect(screen.getByRole('button', { name: /Add endpoint/ })).toBeInTheDocument()
  expect(screen.queryByText('Webhooks come with Pro')).toBeNull()
})

it('CONTROL: on Pro, an endpoint offers its actions, and its page sends a test', async () => {
  stub({ allowed: true }, [MADE_ON_PRO])
  await renderPanel()
  expect(menuItems().filter(Boolean)).toEqual(['Send test', 'Edit endpoint…', 'Turn off', 'Rotate secret…', 'Delete endpoint…'])
})

it('CONTROL: on Pro, the endpoint page offers Send test', async () => {
  search = new URLSearchParams('endpoint=w1')
  stub({ allowed: true }, [MADE_ON_PRO])
  await renderPanel()
  expect(screen.getByRole('button', { name: /Send test/ })).toBeInTheDocument()
})
