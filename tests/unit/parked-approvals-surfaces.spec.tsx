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
 *
 * Since the project console rebuild (2026-11-16) the Overview says it in its
 * "Waiting on you" section: the inbox's own count (useWaitingCount), a row per
 * item that opens it on Autonomy, its expiry stated; and its Self-healing row
 * never claims repairs on a deployment that only watches.
 */

import { act, render, screen } from '@testing-library/react'
import { clearAgentConnectionCache } from '@/lib/hooks/useAgentConnection'
import { forgetSharedReads } from '@/lib/client/shared-read'
import { clearWaitingCountCache } from '@/lib/hooks/useWaitingCount'
import { clearProjectRoleCache } from '@/lib/hooks/useProjectRole'
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
let healthFails = false
let approvals: Array<Record<string, unknown>> = []
let report: Record<string, unknown> = {}

const LIVE_EXECUTION = { mode: 'live', reason: 'live', explanation: '', repairsAreApplied: true }
const DROP = {
  id: 'req-1',
  status: 'pending',
  tool: 'drop_column',
  target: 'column `spoilers` on `reviews`',
  requestedBy: 'agent',
  rowCount: 9431,
  createdAt: new Date(Date.now() - 26 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 23 * 3_600_000 + 30 * 60_000).toISOString(),
}

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/** Only the answers these surfaces read; anything else is a quiet 404. */
function answer(url: string): Response {
  const path = url.split('?')[0]
  if (path.endsWith('/health')) return healthFails ? json(500, { success: false }) : json(200, { success: true, data: health })
  if (path.endsWith('/agent-approvals')) return json(200, { success: true, approvals })
  if (path.endsWith('/autonomy')) return json(200, report)
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

const renderOverview = () => render(<WorkspaceHome projectId="p1" />)

beforeEach(() => {
  clearAgentConnectionCache()
  // Reads the page's components share are kept for two seconds; each case
  // answers differently.
  forgetSharedReads()
  clearWaitingCountCache()
  clearProjectRoleCache()
  push.mockReset()
  health = healthWith({})
  healthFails = false
  approvals = []
  report = { level: 'AGGRESSIVE', cap: 'AGGRESSIVE', executionMode: LIVE_EXECUTION, scoreboard: {}, recentActivity: [], pendingApprovals: [], appliedChanges: [] }
  global.fetch = jest.fn((input: RequestInfo | URL) => Promise.resolve(answer(String(input)))) as unknown as typeof fetch
})

describe('the Overview’s “Waiting on you”', () => {
  const section = () => screen.queryByRole('region', { name: /Waiting on you/ }) ?? screen.queryByRole('heading', { name: 'Waiting on you' })?.closest('section')

  it('lists a parked agent call, says when it expires, and opens it on Autonomy', async () => {
    health = healthWith({ agentApprovalsPending: 1 })
    approvals = [DROP]
    renderOverview()
    expect(await screen.findByRole('heading', { name: 'Waiting on you' }, { timeout: 3000 })).toBeInTheDocument()
    expect(await screen.findByText('From your agent', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.getByText('Expires in 23 h')).toBeInTheDocument()
    expect(screen.getByText('9,431 rows')).toBeInTheDocument()
    expect(section()).toHaveTextContent('Drop column spoilers on reviews')
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/app/projects/p1/autonomy#approval-req-1')
  })

  it('counts every queue the way the inbox does: held findings, parked calls and architecture changes', async () => {
    health = healthWith({ agentApprovalsPending: 1, needsAttention: 2, actionableTotal: 2, architectureRequestsPending: 1 })
    approvals = [DROP]
    renderOverview()
    const heading = await screen.findByRole('heading', { name: 'Waiting on you' }, { timeout: 3000 })
    expect(heading.parentElement).toHaveTextContent('Waiting on you4')
  })

  it('never reads a count it could not get as nothing waiting', async () => {
    healthFails = true
    renderOverview()
    expect(await screen.findByText(/Could not load what’s waiting/, {}, { timeout: 3000 })).toBeInTheDocument()
  })

  it('is not there when nothing waits, and the Self-healing row says when it last checked (control)', async () => {
    renderOverview()
    expect(await screen.findByText(/^Checked /, {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Waiting on you' })).toBeNull()
    expect(screen.getByText('Autopilot')).toBeInTheDocument()
  })

  it('says when a check could not run', async () => {
    const now = new Date().toISOString()
    health = healthWith({
      sensors: { at: now, total: 3, ran: 2, errored: [{ id: 'fk', title: 'Foreign keys indexed', error: 'x' }], disabled: [] },
    })
    renderOverview()
    expect(await screen.findByText('1 check could not run', {}, { timeout: 3000 })).toBeInTheDocument()
  })

  it('never says Autopilot on a deployment that only watches', async () => {
    report = { ...report, executionMode: { mode: 'shadow', reason: 'deployment_flag_off', explanation: '', repairsAreApplied: false } }
    renderOverview()
    expect(await screen.findByText('Watching only', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.queryByText('Autopilot')).toBeNull()
    expect(screen.getByText('This deployment doesn’t apply repairs')).toBeInTheDocument()
  })
})

describe('the top bar’s review inbox', () => {
  // Since 2026-11-16 the inbox says "something waits" with one white ◆ and no
  // number; the count is in its tooltip, counted by useWaitingCount, the one
  // count Overview and Autonomy show too.
  const inbox = () => document.querySelector<HTMLElement>('[data-tour="review-inbox"]')
  const diamond = () => inbox()?.querySelector('[data-waiting]')

  it('lights for a parked agent call', async () => {
    health = healthWith({ agentApprovalsPending: 1 })
    render(<TopBar />)
    await settle()
    expect(inbox()?.getAttribute('title')).toBe('1 waiting on your approval')
    expect(inbox()).toHaveAccessibleName('Review queue, 1 waiting on your approval')
    expect(diamond()).not.toBeNull()
  })

  it('counts held findings from the uncapped total, not the truncated preview', async () => {
    health = healthWith({ needsAttention: 60, actionableTotal: 60, findings: [] })
    render(<TopBar />)
    await settle()
    expect(inbox()?.getAttribute('title')).toBe('60 waiting on your approval')
  })

  it('adds every queue: held findings, parked calls and architecture changes', async () => {
    health = healthWith({ needsAttention: 2, agentApprovalsPending: 1, architectureRequestsPending: 1 })
    render(<TopBar />)
    await settle()
    expect(inbox()?.getAttribute('title')).toBe('4 waiting on your approval')
  })

  it('never draws the number on the icon', async () => {
    health = healthWith({ agentApprovalsPending: 3 })
    render(<TopBar />)
    await settle()
    expect(diamond()).not.toBeNull()
    expect(inbox()?.textContent).not.toMatch(/\d/)
  })

  it('stays dark when nothing waits (control)', async () => {
    render(<TopBar />)
    await settle()
    expect(inbox()?.getAttribute('title')).toBe('Review queue')
    expect(diamond()).toBeFalsy()
  })
})
