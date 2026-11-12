/**
 * @jest-environment jsdom
 */
/**
 * The Webhooks page's endpoint form picks tables (report 102): a row event can
 * go to every table, as before, or only to the tables ticked; a sign-up event
 * has no table field. The list says which tables an endpoint receives.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'

jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
import { WebhooksPanel } from '@/components/integrations/WebhooksPanel'

const ROW = (over: Record<string, unknown> = {}) => ({
  id: 'w1', eventType: 'row.inserted', targetUrl: 'https://hooks.example.test/in', active: true, tables: [],
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', logCount: 0, ...over,
})

function stub(webhooks: unknown[] = []) {
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]
    if (init?.method === 'POST' && path === '/api/projects/p1/webhooks') {
      return Promise.resolve({ ok: true, status: 201, json: async () => ({ webhook: { ...ROW(), secret: 's' }, captureError: null }) } as Response)
    }
    const body = path.endsWith('/trigger-webhooks')
      ? { triggers: [], deliveries: [] }
      : { webhooks, availableTables: ['orders', 'product_views'], capture: { tables: [], required: false, healthy: true, readable: true }, plan: { allowed: true } }
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
}

const flush = () => act(async () => { for (let i = 0; i < 15; i++) await Promise.resolve() })

async function openForm() {
  render(<WebhooksPanel projectId="p1" />)
  await flush()
  fireEvent.click(screen.getAllByRole('button', { name: /Add endpoint/ })[0])
  await flush()
  fireEvent.change(document.querySelector('input[name="webhook-url"]')!, { target: { value: 'https://hooks.example.test/orders' } })
}

const posted = () => {
  const call = (global.fetch as jest.Mock).mock.calls.find(([, init]) => init?.method === 'POST')
  return JSON.parse(call![1].body)
}

it('sends a row event for every table unless tables are picked', async () => {
  stub()
  await openForm()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' })) })
  await flush()
  expect(posted()).toEqual({ eventType: 'row.inserted', targetUrl: 'https://hooks.example.test/orders', tables: [] })
})

it('sends only the tables ticked, and will not save with none ticked', async () => {
  stub()
  await openForm()
  fireEvent.click(screen.getByRole('radio', { name: 'Only the tables I pick' }))
  expect(screen.getByRole('button', { name: 'Save endpoint' })).toBeDisabled()
  fireEvent.click(screen.getByRole('checkbox', { name: 'orders' }))
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save endpoint' })) })
  await flush()
  expect(posted()).toMatchObject({ tables: ['orders'] })
})

it('has no table field for a sign-up event', async () => {
  stub()
  await openForm()
  fireEvent.click(screen.getByRole('radio', { name: /auth\.user\.created/ }))
  expect(screen.queryByRole('radio', { name: 'Only the tables I pick' })).toBeNull()
})

it('says which tables each endpoint receives', async () => {
  stub([ROW({ tables: ['orders'] }), ROW({ id: 'w2', targetUrl: 'https://hooks.example.test/all' })])
  render(<WebhooksPanel projectId="p1" />)
  await flush()
  expect(screen.getByText('orders')).toBeInTheDocument()
  expect(screen.getByText('Every table')).toBeInTheDocument()
})
