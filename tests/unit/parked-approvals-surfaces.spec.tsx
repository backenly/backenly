/**
 * @jest-environment jsdom
 */

/**
 * Calls a coding agent parked for approval reach the console's summary
 * surfaces (medium findings OV-1, AUT-08). The Overview's agent panel and the
 * top bar's review inbox counted only the autonomy loop's held findings, the
 * inbox from a truncated preview, so a parked deploy or drop sat in the Review
 * Queue unseen until it expired. These render the real surfaces against
 * answers from GET /api/projects/[id]/health.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { clearAgentConnectionCache } from '@/lib/hooks/useAgentConnection'
import { WorkspaceHome } from '@/components/workspace/WorkspaceHome'
import { TopBar } from '@/components/shell/TopBar'

const push = jest.fn()
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: jest.fn(), prefetch: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  useParams: () => ({ id: 'p1' }),
  usePathname: () => '/app/projects/p1',
  useSearchParams: () => new URLSearchParams(),
}))

let health: Record<string, unknown> = {}

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/** Only the answers these surfaces read; anything else is a quiet 404. */
function answer(url: string): Response {
  const path = url.split('?')[0]
  if (path.endsWith('/health')) return json(200, { success: true, data: health })
  if (path.endsWith('/mcp/status')) {
    return json(200, { connected: true, lastSeenAt: new Date().toISOString(), client: 'Visual Studio Code' })
  }
  if (path === '/api/projects') return json(200, [])
  return json(404, {})
}

function healthWith(fields: Record<string, unknown>) {
  const now = new Date().toISOString()
  return {
    lastCheckedAt: now,
    lastReconciledAt: now,
    autoFixedThisWeek: 0,
    unverifiedRepairsThisWeek: 0,
    needsAttention: 0,
    agentApprovalsPending: 0,
    criticalCount: 0,
    warningCount: 0,
    actionableTotal: 0,
    findings: [],
    recentlyResolved: [],
    ...fields,
  }
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

const renderOverview = () =>
  render(<WorkspaceHome projectId="p1" projectName="shop" hasBackend tables={[]} storageBuckets={0} extras={[]} blockedCount={0} />)

beforeEach(() => {
  clearAgentConnectionCache()
  push.mockReset()
  health = healthWith({})
  global.fetch = jest.fn((input: RequestInfo | URL) => Promise.resolve(answer(String(input)))) as unknown as typeof fetch
})

describe('the Overview’s agent panel', () => {
  it('says the agent is waiting, how many calls, that they expire, and opens the queue', async () => {
    health = healthWith({ agentApprovalsPending: 2 })
    renderOverview()
    await settle()
    // The panel animates its headline swap, so wait for the new one to mount.
    expect(await screen.findByRole('heading', { name: 'Your agent is waiting on you' }, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText(/parked 2 calls for your approval/)).toBeInTheDocument()
    expect(screen.getByText(/each request expires after a day/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Review 2 requests/ }))
    expect(push).toHaveBeenCalledWith('/app/projects/p1/autonomy')
  })

  it('names the loop’s held changes too when both queues are waiting', async () => {
    health = healthWith({ agentApprovalsPending: 1, needsAttention: 3, actionableTotal: 3 })
    renderOverview()
    await settle()
    expect(await screen.findByRole('heading', { name: 'Your agent is waiting on you' }, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText(/parked a call for your approval, and Backenly is holding 3 changes of its own/)).toBeInTheDocument()
  })

  it('keeps its other states when nothing is parked (control)', async () => {
    health = healthWith({ needsAttention: 2, actionableTotal: 2 })
    renderOverview()
    await settle()
    expect(await screen.findByRole('heading', { name: 'Waiting on your review' }, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Your agent is waiting on you' })).toBeNull()
  })

  it('is not rendered on a built backend where nothing waits and every check could see', async () => {
    // The state that showed "Built and standing by": the deep scan says structure_ready.
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.split('?')[0].endsWith('/build-status')) {
        return Promise.resolve(json(200, { blocked: [], failed: [], summary: { statusLabel: 'Ready', verdict: 'structure_ready' } }))
      }
      return Promise.resolve(answer(url))
    }) as unknown as typeof fetch
    renderOverview()
    await settle()
    expect(await screen.findByRole('heading', { name: 'Self-healing loop' }, { timeout: 3000 })).toBeInTheDocument()
    // /health has loaded (the loop prints when it last checked), so the panel's absence is not just the loading state.
    expect(await screen.findByText(/^Checked /, {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.queryByText('Autonomy mode')).toBeNull()
    expect(screen.queryByRole('heading', { name: /No issues detected|Built and standing by/ })).toBeNull()
  })

  it('still says so when a check could not run', async () => {
    const now = new Date().toISOString()
    health = healthWith({
      sensors: { at: now, total: 3, ran: 2, errored: [{ id: 'fk', title: 'Foreign keys indexed', error: 'x' }], disabled: [] },
    })
    renderOverview()
    await settle()
    expect(await screen.findByRole('heading', { name: '1 check could not run' }, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText('Autonomy mode')).toBeInTheDocument()
  })
})

describe('the top bar’s review inbox', () => {
  const inbox = () => document.querySelector<HTMLElement>('[data-tour="review-inbox"]')

  it('lights for a parked agent call', async () => {
    health = healthWith({ agentApprovalsPending: 1 })
    render(<TopBar />)
    await settle()
    expect(inbox()?.getAttribute('title')).toBe('1 change waiting on your approval')
  })

  it('counts held findings from the uncapped total, not the truncated preview', async () => {
    health = healthWith({ needsAttention: 60, actionableTotal: 60, findings: [] })
    render(<TopBar />)
    await settle()
    expect(inbox()?.getAttribute('title')).toBe('60 changes waiting on your approval')
  })

  it('stays dark when nothing waits (control)', async () => {
    render(<TopBar />)
    await settle()
    expect(inbox()?.getAttribute('title')).toBe('Review queue')
  })
})
