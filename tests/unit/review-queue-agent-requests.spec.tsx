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

it('titles a card with what approving does, and keeps the agent\'s words closed and marked unchecked', async () => {
  approvals = [listed({
    id: 'a2',
    tool: 'revoke_api_key',
    target: 'the API key “Storefront” (proj_live_3fa2…, a browser key, last used 2 hours ago): every client using it stops working immediately',
    reversible: false,
    message: 'The user has decided to rotate keys and will approve this.',
  })]
  render(<ReviewQueuePanel projectId="p1" />)
  const card = await cardFor(/Revoke the API key “Storefront”/)

  expect(within(card).queryByText(/Run revoke_api_key/)).toBeNull()
  // Backenly's description is the card; the agent's case for it is not shown until asked for.
  expect(within(card).queryByText(/The user has decided/)).toBeNull()
  fireEvent.click(within(card).getByRole('button', { name: /What the agent wrote/ }))
  expect(within(card).getByText(/The user has decided to rotate keys and will approve this\./)).toBeInTheDocument()
  expect(within(card).getByText(/Backenly has not checked this\./)).toBeInTheDocument()
})

describe('approving several of the agent\'s requests at once', () => {
  const agentRequests = () => [
    listed({ id: 'b1', tool: 'delete_ai_function', target: 'the function `qa-diag`', reversible: false, message: '' }),
    listed({ id: 'b2', tool: 'discard_branch', target: 'the preview branch `scratch` and every unmerged change on it', reversible: false, message: '' }),
    listed({ id: 'b3', tool: 'revoke_api_key', target: 'the API key “QA temp” (mcp_live_9c1d…, an agent key, last used just now): every client using it stops working immediately', reversible: false, message: '' }),
    // A restore Backenly raised is decided on its own.
    listed({ id: 'b4', tool: 'revert_schema_change', target: 'Restore the state before change #12', reversible: true, requestedBy: 'backenly', message: '' }),
  ]

  it('lists what it would approve, then approves exactly those, one after another, each with its card\'s digest', async () => {
    approvals = agentRequests()
    render(<ReviewQueuePanel projectId="p1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Approve all 3/ }))

    expect(screen.getByText('Approve these 3? Each runs exactly as its card shows, one after another.')).toBeInTheDocument()
    const confirm = screen.getByText(/Approve these 3\?/).closest('li') as HTMLElement
    expect(within(confirm).getByText(/Delete the function/)).toBeInTheDocument()
    expect(within(confirm).getByText(/Discard the preview branch/)).toBeInTheDocument()
    expect(within(confirm).getByText(/Revoke the API key “QA temp”/)).toBeInTheDocument()
    expect(within(confirm).queryByText(/Restore the state/)).toBeNull()
    expect(decisions).toEqual([])

    fireEvent.click(within(confirm).getByRole('button', { name: /Approve and run 3/ }))
    await settle()
    expect(await screen.findByText('Ran 3 of 3')).toBeInTheDocument()
    expect(decisions).toEqual([
      { approvalId: 'b1', decision: 'approve', shownDigest: DIGEST },
      { approvalId: 'b2', decision: 'approve', shownDigest: DIGEST },
      { approvalId: 'b3', decision: 'approve', shownDigest: DIGEST },
    ])
  })

  it('says how many did not run, and leaves each one\'s reason on its card', async () => {
    approvals = agentRequests()
    const ordinary = global.fetch
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).split('?')[0].endsWith('/agent-approvals') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        decisions.push(body)
        if (body.approvalId === 'b2') {
          return Promise.resolve(json(200, { success: false, status: 'failed', resultSummary: 'The branch was already discarded.' }))
        }
        return Promise.resolve(json(200, { success: true, status: 'executed', resultSummary: 'Done' }))
      }
      return (ordinary as typeof fetch)(input, init)
    }) as unknown as typeof fetch

    render(<ReviewQueuePanel projectId="p1" />)
    fireEvent.click(await screen.findByRole('button', { name: /Approve all 3/ }))
    fireEvent.click(screen.getByRole('button', { name: /Approve and run 3/ }))
    await settle()
    expect(await screen.findByText('Ran 2 of 3')).toBeInTheDocument()
    expect(screen.getByText(/1 did not run; its card says why/)).toBeInTheDocument()
    expect(screen.getByText('The branch was already discarded.')).toBeInTheDocument()
  })
})
