/**
 * Proposal system tests
 * =====================
 * Coverage:
 *   - Apply-intent detection (detectApplyIntent) — pure, no mocks
 *   - Renderer — affordance + apply report (pure)
 *   - Applier — dispatches executeAction, aggregates report (mocked executor + store)
 *
 * Store + generator are not unit-tested here (Prisma + LLM); they are
 * exercised by the integration suite.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// The executor is injected per-call via the `executor` option, so the
// 8k-line minimal-executor module is never loaded here. The store's
// best-effort Prisma writes are neutralised by mocking the Prisma client
// (store.ts imports it via `@/lib/db/prisma`, mapped to this path).
jest.mock('@/lib/db/prisma', () => ({
  __esModule: true,
  prisma: {
    projectPreference: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async () => undefined),
    },
  },
}))

import { applyProposal } from '../../lib/ai/proposals/apply'
import { buildApplyAffordance, renderApplyReport } from '../../lib/ai/proposals/renderer'
import { detectApplyIntent } from '../../app/api/ai/chat/pipeline/proposal-stage'
import type { Proposal, ProposalItem } from '../../lib/ai/proposals/types'

/** Per-test fake executor. Reset in each test's body. */
let execMock: jest.Mock

function buildFixtureProposal(items: Partial<ProposalItem>[]): Proposal {
  return {
    id: 'prop_test',
    projectId: 'proj_test',
    title: 'Test recommendations',
    items: items.map((p, idx) => ({
      id: `it_${idx}`,
      title: p.title ?? `Item ${idx}`,
      description: p.description,
      actionKind: p.actionKind ?? 'informational',
      executable: p.executable ?? false,
      blocker: p.blocker,
      blockerReason: p.blockerReason,
      params: p.params,
      status: p.status ?? 'pending',
    })),
    status: 'open',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    executableCount: items.filter(p => p.executable).length,
  }
}

// ── Detection — pure regex behaviour ────────────────────────────────────────

describe('detectApplyIntent', () => {
  it('classifies bare "apply" / "implement those" as executable_only', () => {
    for (const m of ['apply', 'apply it', 'implement those', 'do it', 'go ahead and apply', 'implement these']) {
      expect(detectApplyIntent(m).kind).toBe('executable_only')
    }
  })

  it('classifies "apply all" / "implement everything" as all', () => {
    for (const m of ['apply all', 'implement everything', 'do all of them', 'run everything']) {
      expect(detectApplyIntent(m).kind).toBe('all')
    }
  })

  it('parses numeric subsets ("apply 1, 3 and 5")', () => {
    const r = detectApplyIntent('apply 1, 3 and 5')
    expect(r.kind).toBe('subset')
    if (r.kind === 'subset') expect(r.indices).toEqual([1, 3, 5])
  })

  it('binds broad referential follow-ups ("start implementing all these updates")', () => {
    expect(detectApplyIntent('start implementing all these updates').kind).toBe('executable_only')
    expect(detectApplyIntent('apply all those fixes').kind).toBe('executable_only')
  })

  it('does NOT match concrete builds or chatter', () => {
    for (const m of ['add a users table', 'create the comments column', 'hi', 'what tables do I have', 'thanks']) {
      expect(detectApplyIntent(m).kind).toBe('none')
    }
  })
})

// ── Renderer — pure ─────────────────────────────────────────────────────────

describe('Renderer — buildApplyAffordance', () => {
  it('mentions the executable count when there are runnable items', () => {
    const proposal = buildFixtureProposal([
      { title: 'Add RLS to posts', actionKind: 'add_rls', executable: true },
      { title: 'Set up Stripe', actionKind: 'enable_integration', executable: false, blocker: 'needs_credential' },
    ])
    const affordance = buildApplyAffordance(proposal)
    expect(affordance).toMatch(/apply\s+\*\*1 item\*\*/i)
    expect(affordance).toMatch(/1 need a key\/credential/i)
  })

  it('shows the "nothing executable" message when blocked-only', () => {
    const proposal = buildFixtureProposal([
      { title: 'Configure CORS', actionKind: 'infra', executable: false, blocker: 'infra_only' },
      { title: 'Configure backups', actionKind: 'infra', executable: false, blocker: 'infra_only' },
    ])
    const affordance = buildApplyAffordance(proposal)
    expect(affordance).toMatch(/no items in this list can be auto-applied/i)
    expect(affordance).toMatch(/2 live outside Backenly/i)
  })

  it('returns empty when proposal has no items', () => {
    expect(buildApplyAffordance(buildFixtureProposal([]))).toBe('')
  })
})

describe('Renderer — renderApplyReport', () => {
  it('shows checkmarks for done items and X for failures', () => {
    const md = renderApplyReport({
      proposalId: 'p', attempted: 3, succeeded: 2, failed: 1, skipped: 0,
      items: [
        { id: '1', title: 'Add RLS to posts', status: 'done', proof: 'policy created on posts' },
        { id: '2', title: 'Add index to comments.target_id', status: 'done' },
        { id: '3', title: 'Generate notifications API', status: 'failed', error: 'Table not found' },
      ],
      markdown: '',
    })
    expect(md).toMatch(/Applied \*\*2\/3\*\* items/)
    expect(md).toMatch(/✓ Add RLS to posts — policy created on posts/)
    expect(md).toMatch(/✗ Generate notifications API — Table not found/)
  })

  it('reports nothing-applied truthfully', () => {
    const md = renderApplyReport({
      proposalId: 'p', attempted: 0, succeeded: 0, failed: 0, skipped: 2, items: [], markdown: '',
    })
    expect(md).toMatch(/nothing applied/i)
  })
})

// ── Applier — mocked executor + store ───────────────────────────────────────

describe('Applier — applyProposal', () => {
  beforeEach(() => {
    execMock = jest.fn()
  })

  it('dispatches each executable item through the executor and aggregates the report', async () => {
    execMock
      .mockResolvedValueOnce({ success: true, message: 'RLS policy created on posts' })
      .mockResolvedValueOnce({ success: true, message: 'Index created on comments(target_id)' })

    const proposal = buildFixtureProposal([
      { title: 'Add RLS to posts', actionKind: 'add_rls', executable: true, params: { tableName: 'posts', policy: 'owner_read_write' } },
      { title: 'Add index to comments', actionKind: 'add_index', executable: true, params: { tableName: 'comments', columns: ['target_id'] } },
    ])

    const report = await applyProposal({ proposal, projectId: 'proj_test', executor: execMock as any })

    expect(execMock).toHaveBeenCalledTimes(2)
    expect(report.attempted).toBe(2)
    expect(report.succeeded).toBe(2)
    expect(report.failed).toBe(0)
    expect(report.items[0]).toMatchObject({ status: 'done', proof: expect.stringMatching(/RLS policy/) })
    expect(report.markdown).toMatch(/Applied \*\*2\/2\*\*/)
  })

  it('marks non-executable items as skipped, never calling the executor', async () => {
    const proposal = buildFixtureProposal([
      { title: 'Rate limiting', actionKind: 'infra', executable: false, blocker: 'infra_only', blockerReason: 'Server-level concern' },
    ])
    const report = await applyProposal({ proposal, projectId: 'proj_test', executor: execMock as any })

    expect(execMock).not.toHaveBeenCalled()
    expect(report.attempted).toBe(0)
    expect(report.skipped).toBe(1)
    expect(report.items[0].status).toBe('skipped')
  })

  it('respects subset scope — only runs the requested item ids', async () => {
    execMock.mockResolvedValue({ success: true, message: 'done' })
    const proposal = buildFixtureProposal([
      { title: 'A', actionKind: 'add_rls', executable: true },
      { title: 'B', actionKind: 'add_index', executable: true },
      { title: 'C', actionKind: 'add_index', executable: true },
    ])
    const report = await applyProposal({
      proposal, projectId: 'proj_test', executor: execMock as any,
      scope: { itemIds: [proposal.items[0].id, proposal.items[2].id] },
    })
    expect(execMock).toHaveBeenCalledTimes(2)
    expect(report.attempted).toBe(2)
    expect(report.items.map(i => i.title)).toEqual(['A', 'C'])
  })

  it('captures executor errors as failed items without throwing', async () => {
    execMock.mockResolvedValueOnce({ success: false, error: 'table missing' })
    const proposal = buildFixtureProposal([
      { title: 'Generate API for notifications', actionKind: 'generate_api', executable: true, params: { tableName: 'notifications' } },
    ])
    const report = await applyProposal({ proposal, projectId: 'proj_test', executor: execMock as any })
    expect(report.failed).toBe(1)
    expect(report.items[0]).toMatchObject({ status: 'failed', error: 'table missing' })
  })

  it('emits ordered progress events via onProgress', async () => {
    execMock.mockResolvedValue({ success: true, message: 'done' })
    const events: string[] = []
    const proposal = buildFixtureProposal([{ title: 'A', actionKind: 'add_rls', executable: true }])
    await applyProposal({
      proposal, projectId: 'proj_test', executor: execMock as any,
      onProgress: ev => { events.push(`${ev.type}:${ev.item.title}`) },
    })
    expect(events).toEqual(['start:A', 'done:A'])
  })
})
