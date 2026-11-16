/**
 * @jest-environment jsdom
 */

/**
 * The Webhooks page teaches the timestamped signature.
 *
 * Production QA re-test, 2026-11-16, #101: its "Verify deliveries" section
 * taught X-Webhook-Signature, an HMAC of the body alone, which a captured
 * delivery passes forever. It now teaches X-Webhook-Signature-V2 over
 * "<timestamp>.<delivery id>.<raw body>" and a 5-minute limit on the
 * timestamp, and its verify.js does exactly that
 * (tests/unit/webhook-verify-snippet.spec.ts).
 */

import { act, fireEvent, render, screen } from '@testing-library/react'

jest.mock('@cloud/control-plane', () => ({ CLOUD_CONTROL_PLANE: true }))
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), prefetch: jest.fn(), refresh: jest.fn(), forward: jest.fn() }
const mockSearch = new URLSearchParams()
jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => mockSearch,
  usePathname: () => '/app/projects/p1/webhooks',
  useParams: () => ({ id: 'p1' }),
}))

import { WebhooksPanel } from '@/components/integrations/WebhooksPanel'
import { VERIFY_SNIPPET } from '@/components/integrations/webhooks-present'
import { forgetProjectReads } from '@/lib/api/projects'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'

const ENDPOINT = {
  id: 'w1', eventType: 'row.inserted', targetUrl: 'https://hooks.example.test/in', active: true,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', logCount: 0,
}

beforeEach(() => {
  forgetProjectReads()
  clearProjectRoleCache()
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    const body = path === '/api/projects/p1'
      ? { success: true, data: { id: 'p1', name: 'shop', organizationId: 'org_1', role: 'OWNER', canWrite: true, canAdminister: true } }
      : path.endsWith('/trigger-webhooks')
      ? { triggers: [], deliveries: [] }
      : path.endsWith('/logs')
      ? { logs: [] }
      : { webhooks: [ENDPOINT], capture: { tables: ['orders'], required: true, healthy: true, readable: true }, plan: { allowed: true } }
    return Promise.resolve({ ok: true, status: 200, json: async () => body })
  }) as unknown as typeof fetch
})

it('names the timestamped signature, what it covers, and how old a delivery may be', async () => {
  render(<WebhooksPanel projectId="p1" />)
  await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve() })

  const section = (document.body.textContent ?? '').replace(/\s+/g, ' ')
  expect(section).toContain(
    'Each delivery is signed with X-Webhook-Signature-V2, an HMAC-SHA256 of <timestamp>.<delivery id>.<raw body> under the endpoint’s secret, with the time in X-Webhook-Timestamp. Refuse a delivery more than 5 minutes old, so a captured one can’t be sent again.',
  )
  expect(section).toContain('Retries repeat X-Webhook-Delivery, so drop the ones you’ve handled.')

  fireEvent.click(screen.getByRole('button', { name: 'Show code' }))
  expect(document.body.textContent).toContain("const signature = get('x-webhook-signature-v2')")
  expect(VERIFY_SNIPPET).toContain('crypto.timingSafeEqual(a, b)')
})
