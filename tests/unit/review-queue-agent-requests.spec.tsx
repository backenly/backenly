/**
 * @jest-environment jsdom
 */

/**
 * The Review Queue's card for a call an agent parked. A regional project's
 * request is read from its region (lib/mcp/approval-request-bodies.ts): a card
 * that could show only stand-ins says so and cannot be approved, and an
 * approval sends back the digest of what its card showed, so the server runs
 * only what the human read. Rendered against answers from the approvals route.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { ReviewQueuePanel } from '@/components/ReviewQueuePanel'

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
}))

const now = new Date().toISOString()
const DIGEST = 'e'.repeat(64)

/** A request as GET /api/projects/[id]/agent-approvals lists it. */
const listed = (fields: Record<string, unknown>) => ({
  id: 'a1',
  status: 'pending',
  tool: 'block_end_user',
  target: 'the end-user alice@example.com (they lose access immediately)',
  rowCount: null,
  reversible: true,
  message: 'Block alice@example.com',
  createdAt: now,
  expiresAt: now,
  decidedAt: null,
  executedAt: null,
  resultSummary: null,
  readable: true,
  shownDigest: DIGEST,
  ...fields,
})

let approvals: Array<Record<string, unknown>> = []
const decisions: unknown[] = []

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

beforeEach(() => {
  decisions.length = 0
  global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split('?')[0]
    if (path.endsWith('/autonomy')) return Promise.resolve(json(200, { pendingApprovals: [] }))
    if (path.endsWith('/agent-approvals') && init?.method === 'POST') {
      decisions.push(JSON.parse(String(init.body)))
      return Promise.resolve(json(200, { success: true, status: 'executed', resultSummary: 'Blocked' }))
    }
    if (path.endsWith('/agent-approvals')) return Promise.resolve(json(200, { success: true, approvals }))
    return Promise.resolve(json(404, {}))
  }) as unknown as typeof fetch
})

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

/** The card whose headline names `target`. */
async function cardFor(target: RegExp): Promise<HTMLElement> {
  return (await screen.findByText(target)).closest('li') as HTMLElement
}

it('says a card shows only stand-ins, and offers no approval of it, when the region could not be read', async () => {
  approvals = [listed({ target: 'block_end_user target t_abc', readable: false, shownDigest: null })]
  render(<ReviewQueuePanel projectId="p1" />)
  const card = await cardFor(/block_end_user target t_abc/)

  expect(within(card).getByText(/The exact call is kept in the project’s region and could not be read just now\. Refresh to try again\./)).toBeInTheDocument()
  const approve = within(card).getByRole('button', { name: /Approve & run/ })
  expect(approve).toBeDisabled()
  expect(within(card).getByRole('button', { name: /Reject/ })).not.toBeDisabled()

  fireEvent.click(approve)
  await settle()
  expect(decisions).toEqual([])
})

it('sends back the digest of what the card showed with an approval', async () => {
  approvals = [listed({ id: 'a2' })]
  render(<ReviewQueuePanel projectId="p1" />)
  const card = await cardFor(/the end-user alice@example\.com/)
  expect(within(card).queryByText(/could not be read just now/)).toBeNull()

  fireEvent.click(within(card).getByRole('button', { name: /Approve & run/ }))
  await settle()
  expect(decisions).toEqual([{ approvalId: 'a2', decision: 'approve', shownDigest: DIGEST }])
})

it('sends no digest with a rejection, which needs none', async () => {
  approvals = [listed({ id: 'a3' })]
  render(<ReviewQueuePanel projectId="p1" />)
  const card = await cardFor(/the end-user alice@example\.com/)

  fireEvent.click(within(card).getByRole('button', { name: /Reject/ }))
  await settle()
  expect(decisions).toEqual([{ approvalId: 'a3', decision: 'reject' }])
})
