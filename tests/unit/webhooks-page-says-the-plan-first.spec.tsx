/**
 * @jest-environment jsdom
 */
/**
 * On a plan without webhooks, the Webhooks page says so and offers no form.
 * Production QA (2026-11-09): on Free it showed "Webhooks require the Pro plan"
 * as an error, and "Add endpoint" still opened the form whose save was refused.
 */
import { act, render, screen } from '@testing-library/react'

jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
import { WebhooksPanel } from '@/components/integrations/WebhooksPanel'

const MADE_ON_PRO = {
  id: 'w1', eventType: 'row.inserted', targetUrl: 'https://hooks.example.test/in', active: true,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', logCount: 0,
}

function stub(plan: { allowed: boolean; currentPlan?: string }, webhooks: unknown[] = []) {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    const body = path.endsWith('/trigger-webhooks')
      ? { triggers: [], deliveries: [] }
      : path.endsWith('/logs')
      ? { logs: [] }
      : { webhooks, capture: { tables: ['orders'], required: webhooks.length > 0, healthy: true, readable: true }, plan }
    return Promise.resolve({ ok: true, status: 200, json: async () => body } as Response)
  }) as unknown as typeof fetch
}

async function renderPanel() {
  render(<WebhooksPanel projectId="p1" />)
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
}

it('on Free, says webhooks are on Pro, links to plans, and offers no form', async () => {
  stub({ allowed: false, currentPlan: 'SANDBOX' })
  await renderPanel()
  expect(screen.getByText('Webhooks are part of the Pro plan')).toBeInTheDocument()
  expect(screen.getByText(/This project is on Free\./)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/app/billing')
  expect(screen.queryByRole('button', { name: /Add endpoint/ })).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
})

it('on Free with an endpoint made on Pro, says it still receives events and offers no form', async () => {
  stub({ allowed: false, currentPlan: 'SANDBOX' }, [MADE_ON_PRO])
  await renderPanel()
  expect(screen.getByText(/this project is on Free\. The endpoints below still receive events/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'See plans' })).toHaveAttribute('href', '/app/billing')
  expect(screen.queryByRole('button', { name: /Add endpoint/ })).toBeNull()
  // Every row action is refused on this plan, so none is offered.
  expect(screen.queryByRole('button', { name: /Send test|^Test$/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /More actions for/ })).toBeNull()
  expect(screen.getByText('https://hooks.example.test/in')).toBeInTheDocument()
})

it('CONTROL: on Pro, the empty page offers to add an endpoint', async () => {
  stub({ allowed: true })
  await renderPanel()
  expect(screen.getByRole('button', { name: /Add endpoint/ })).toBeInTheDocument()
  expect(screen.queryByText('Webhooks are part of the Pro plan')).toBeNull()
})

it('CONTROL: on Pro, an endpoint offers its actions', async () => {
  stub({ allowed: true }, [MADE_ON_PRO])
  await renderPanel()
  expect(screen.getByRole('button', { name: /Send test/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /More actions for/ })).toBeInTheDocument()
})
