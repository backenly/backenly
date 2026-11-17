/**
 * @jest-environment jsdom
 */

/**
 * A hypothesis that failed the investigator's own checks (it cites evidence
 * that never ran, or names a column that does not exist) is not shown on the
 * card: the card says what it says without one. One that passed is shown, as
 * an AI hypothesis. Production QA (2026-11-16).
 */

import { act, render, screen } from '@testing-library/react'
import { ReviewQueuePanel } from '@/components/ReviewQueuePanel'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
}))

const now = new Date().toISOString()
let diagnosis: Record<string, unknown> = {}

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    if (path.endsWith('/autonomy')) {
      return Promise.resolve(json(200, {
        pendingApprovals: [{
          id: 'f1',
          type: 'missing_fk',
          severity: 'warning',
          detectedAt: now,
          reason: '`orders` has a relation with no foreign key constraint',
          details: { tableName: 'orders', columnName: 'user_id', referencedTable: 'users', diagnosis },
        }],
      }))
    }
    if (path.endsWith('/agent-approvals')) return Promise.resolve(json(200, { success: true, approvals: [] }))
    return Promise.resolve(json(404, {}))
  }) as unknown as typeof fetch
})

async function shown() {
  render(<ReviewQueuePanel projectId="p1" />)
  await screen.findByText(/has a relation with no foreign key constraint/)
  await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() })
}

it('shows a hypothesis that passed its checks, as one', async () => {
  diagnosis = {
    rootCause: 'orders.user_id holds only ids that exist in users.',
    recommendation: 'Add the constraint.',
    model: 'claude',
    verdict: 'explained',
    validation: { ok: true, problems: [] },
  }
  await shown()
  expect(screen.getByText('AI hypothesis, not verified')).toBeInTheDocument()
  expect(screen.getByText('orders.user_id holds only ids that exist in users.')).toBeInTheDocument()
})

it('does not show one that failed them', async () => {
  diagnosis = {
    rootCause: 'orders.customer_ref points at users, which nothing enforces.',
    recommendation: 'Add the constraint.',
    model: 'claude',
    verdict: 'uncertain',
    validation: { ok: false, problems: ['names column "orders.customer_ref", which does not exist'] },
  }
  await shown()
  expect(screen.queryByText('AI hypothesis, not verified')).toBeNull()
  expect(screen.queryByText(/customer_ref/)).toBeNull()
})
