/**
 * @jest-environment jsdom
 */
/**
 * When rows already in the table refuse a fix, the Autonomy page shows why at
 * once. Both panels retried every 409 three times, 2.5 s apart, because a 409
 * used to mean only that a scan held the project; an approval refused by the
 * rows (code EXISTING_ROWS) would only be refused again, each time running the
 * fix, before the reason reached the person.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { DetectedFindingsPanel } from '@/components/DetectedFindingsPanel'
import { ReviewQueuePanel } from '@/components/ReviewQueuePanel'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
}))

const REFUSAL = 'Some rows in reviews have a user_id that matches no row in users, so the foreign key was not added and nothing changed.'
const FINDING = {
  id: 'f1',
  type: 'missing_fk',
  severity: 'warning',
  status: 'open',
  detectedAt: new Date().toISOString(),
  reason: 'reviews has a relation with no foreign key constraint',
  details: { tableName: 'reviews', columnName: 'user_id' },
}

let approvals = 0
function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  approvals = 0
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const path = String(input).split('?')[0]
    if (path.endsWith('/health/approve')) {
      approvals += 1
      return Promise.resolve(json(409, { success: false, error: REFUSAL, code: 'EXISTING_ROWS' }))
    }
    if (path.endsWith('/autonomy')) return Promise.resolve(json(200, { pendingApprovals: [FINDING] }))
    if (path.endsWith('/agent-approvals')) return Promise.resolve(json(200, { success: true, approvals: [] }))
    if (path.endsWith('/health')) return Promise.resolve(json(200, { data: { findings: [FINDING], actionableTotal: 1, needsAttention: 0 } }))
    return Promise.resolve(json(404, {}))
  }) as unknown as typeof fetch
})

const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() })

it('the findings panel shows the reason at once and asks once', async () => {
  render(<DetectedFindingsPanel projectId="p1" level="BALANCED" />)
  await settle()
  fireEvent.click(screen.getByRole('button', { name: /Fix now/ }))
  await settle()
  expect(screen.getByText(REFUSAL)).toBeInTheDocument()
  expect(approvals).toBe(1)
})

it('the review queue shows the reason at once and asks once', async () => {
  render(<ReviewQueuePanel projectId="p1" />)
  await settle()
  fireEvent.click(await screen.findByRole('button', { name: /Approve & fix/ }))
  await settle()
  expect(screen.getByText(REFUSAL)).toBeInTheDocument()
  expect(approvals).toBe(1)
})
