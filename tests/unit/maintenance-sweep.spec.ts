/**
 * THE SWEEP REFUSES MORE THAN IT RUNS
 * ===================================
 *
 * Removing the operator removes the person who was standing there when a
 * ladder halted. Run by hand, halting at an unapproved Tier-2 rung is fine —
 * the operator sees it and decides. Unattended it leaves a table with a new
 * column nothing fills and a dual-write that was never installed, created by
 * the scheduler and left until somebody notices.
 *
 * So the property under test is not "it runs the ladder". It is that it does
 * not START one it cannot finish, and that every gate proven against the
 * manual path still refuses here.
 */

const mockFindFinding = jest.fn()
const mockFindApproval = jest.fn()
/**
 * This file tests the EXECUTOR's gates - tier, consent, staleness, the
 * deployment flag - and those gates need a ladder that can actually run.
 *
 * `drop_constraint` is unsupported in this deployment, which blocks every
 * ladder the planner currently emits at plan time. That is correct in
 * production and it would leave every test below with nothing to execute, so
 * recovery is treated as available here. The real registry's behaviour is
 * owned by tests/core/rollback-capability-is-real.test.ts, which asserts the
 * opposite and would fail if this mock leaked into it.
 */
jest.mock('@/lib/autonomy/maintenance/rollback-capability', () => ({
  ...jest.requireActual('@/lib/autonomy/maintenance/rollback-capability'),
  rollbackRefusal: () => null,
  canRollback: () => true,
}))

jest.mock('@/lib/db', () => ({
  prisma: {
    healthFinding: { findFirst: (...a: any[]) => mockFindFinding(...(a as [])) },
    maintenanceApproval: { findFirst: (...a: any[]) => mockFindApproval(...(a as [])) },
  },
}))

const mockResolve = jest.fn()
jest.mock('@/lib/autonomy/maintenance/resolve', () => ({
  resolveMaintenancePlan: (...a: any[]) => mockResolve(...(a as [])),
  isRefusal: (r: any) => r?.refusal !== undefined,
}))

const mockExecute = jest.fn()
jest.mock('@/lib/autonomy/maintenance/execute', () => ({
  executeMaintenancePlan: (...a: any[]) => mockExecute(...(a as [])),
}))

const mockLevel = jest.fn(async () => 'AGGRESSIVE')
jest.mock('@/lib/autonomy/autonomy-level', () => ({
  ...jest.requireActual('@/lib/autonomy/autonomy-level'),
  getProjectAutonomyLevel: (...a: any[]) => mockLevel(...(a as [])),
}))

import { sweepProjectMaintenance } from '@/lib/autonomy/maintenance/sweep'
import { buildMaintenancePlan } from '@/lib/autonomy/maintenance/plan'
import type { StepBinding } from '@/lib/autonomy/maintenance/execute'

const diagnosis = (): any => ({
  kind: 'structural_cause_identified',
  hypothesis: { id: 'duplicated_lifecycle_state' },
  confidence: 0.71,
  coverage: { sampleSufficient: true, largestSampleRows: 80, notes: [] },
  blockedBy: [],
  raisedOnly: [],
  reason: 'ok',
  trail: [],
  report: { observations: [], unavailable: [], verdict: { kind: 'conclusive' } },
})

const plan = () =>
  buildMaintenancePlan({
    findingId: 'f1',
    diagnosis: diagnosis(),
    subsystem: { fingerprint: 'sub-1', membership: ['sessions'] },
    catalogFingerprint: 'cat-v1',
  })

const bindingsFor = (p: ReturnType<typeof plan>): Record<number, StepBinding> => {
  const out: Record<number, StepBinding> = {}
  const cols = {
    table: 'sessions', sourceColumn: 'status', targetColumn: 'state',
    transform: { kind: 'identity' as const },
  }
  for (const s of p.steps) {
    if (s.kind === 'add_structure') {
      out[s.ordinal] = { kind: 'add_structure', verb: 'ADD_COLUMN', table: 'sessions', column: 'state', columnType: 'text' }
    } else if (s.kind === 'carry_constraints') out[s.ordinal] = { kind: 'carry_constraints', ...cols, allowedValues: ['a'] }
    else if (s.kind === 'dual_write') out[s.ordinal] = { kind: 'dual_write', ...cols }
    else if (s.kind === 'backfill') out[s.ordinal] = { kind: 'backfill', ...cols }
    else if (s.kind === 'verify') out[s.ordinal] = { kind: 'verify', ...cols }
    else if (s.kind === 'switch_readers') {
      out[s.ordinal] = { kind: 'switch_readers', table: 'sessions', sourceColumn: 'status', targetColumn: 'state' }
    }
  }
  return out
}

const sweep = () => sweepProjectMaintenance({ projectId: 'p1' })

const approvalFor = (p: ReturnType<typeof plan>, over: Record<string, unknown> = {}) => ({
  id: 'ap-1', planVersion: p.planVersion, maxTier: 2, bindings: bindingsFor(p), ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  process.env.ENABLE_MAINTENANCE_SCHEDULER = 'true'
  process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS = 'true'
  mockLevel.mockResolvedValue('AGGRESSIVE')
  mockFindFinding.mockResolvedValue({ id: 'f1' })
  mockFindApproval.mockResolvedValue(null)
  mockExecute.mockResolvedValue({ status: 'completed', haltReason: null, steps: [] })
  const p = plan()
  mockResolve.mockResolvedValue({ plan: p, catalogFingerprint: 'cat-v1', table: 'sessions' })
})

afterEach(() => {
  delete process.env.ENABLE_MAINTENANCE_SCHEDULER
  delete process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS
})

describe('two switches, and neither alone is enough', () => {
  it('does nothing when the scheduler is off', async () => {
    delete process.env.ENABLE_MAINTENANCE_SCHEDULER
    const r = await sweep()
    expect(r.disposition).toBe('disabled')
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('does nothing when the deployment may not write', async () => {
    // "May this deployment write at all" and "may it decide when to" are
    // different questions. Turning the first on for a hand-run plan must not
    // start a sweep.
    delete process.env.ENABLE_PHASE_6B_MAINTENANCE_MUTATIONS
    const r = await sweep()
    expect(r.disposition).toBe('disabled')
    expect(mockExecute).not.toHaveBeenCalled()
  })
})

describe('it does not start what it cannot finish', () => {
  it('runs nothing at all when a tier-2 rung has no approval', async () => {
    // The whole point. add_structure is Tier 1 and WOULD be permitted, so a
    // rung-by-rung executor would add the column and halt at dual_write,
    // leaving a half-expanded schema nobody asked for.
    const r = await sweep()
    expect(r.disposition).toBe('awaiting_approval')
    expect(r.reason).toMatch(/tier 2 needs an approval/)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('runs the ladder once consent covers it', async () => {
    const p = plan()
    mockFindApproval.mockResolvedValue(approvalFor(p))
    const r = await sweep()
    expect(r.disposition).toBe('executed')
    expect(mockExecute).toHaveBeenCalledTimes(1)
  })

  it('does not run when consent carries no bindings, and never invents them', async () => {
    // A scheduler that guesses which column a ladder means is a scheduler that
    // migrates the wrong column unattended.
    const p = plan()
    mockFindApproval.mockResolvedValue(approvalFor(p, { bindings: {} }))
    const r = await sweep()
    expect(r.disposition).toBe('awaiting_approval')
    expect(r.reason).toMatch(/no binding/)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('does not run when consent describes only part of the ladder', async () => {
    const p = plan()
    const partial = bindingsFor(p)
    delete partial[p.steps.find(s => s.kind === 'backfill')!.ordinal]
    mockFindApproval.mockResolvedValue(approvalFor(p, { bindings: partial }))
    const r = await sweep()
    expect(r.disposition).toBe('awaiting_approval')
    expect(r.reason).toMatch(/no binding/)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('ignores bindings attached to a stale consent', async () => {
    // An old mapping applied to a new ladder is how the wrong column gets
    // migrated. The bindings are only read when the version matches.
    const p = plan()
    mockFindApproval.mockResolvedValue(
      approvalFor(p, { planVersion: 'an-older-version', bindings: bindingsFor(p) }),
    )
    const r = await sweep()
    expect(r.disposition).toBe('approval_stale')
    expect(mockExecute).not.toHaveBeenCalled()
  })
})

describe('consent is bound to a version, not to a plan', () => {
  it('refuses an approval granted for an earlier version, and says which', async () => {
    mockFindApproval.mockResolvedValue({ id: 'ap-1', planVersion: 'an-older-version', maxTier: 2 })
    const r = await sweep()
    expect(r.disposition).toBe('approval_stale')
    expect(r.reason).toMatch(/an-older-version/)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('ignores a revoked approval', async () => {
    // The query filters revokedAt: null, so a withdrawn consent reads as no
    // consent rather than as a weaker one.
    const r = await sweep()
    expect(mockFindApproval).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ revokedAt: null }) }),
    )
    expect(r.disposition).toBe('awaiting_approval')
  })
})

describe('the dial still governs the low tiers', () => {
  it('refuses when the level does not permit tier 1', async () => {
    const p = plan()
    mockFindApproval.mockResolvedValue(approvalFor(p))
    mockLevel.mockResolvedValue('OFF')
    const r = await sweep()
    expect(r.disposition).toBe('awaiting_approval')
    expect(r.reason).toMatch(/does not permit tier/)
    expect(mockExecute).not.toHaveBeenCalled()
  })
})

describe('contract never blocks and is never run', () => {
  it('executes the ladder even though its last rung is human-only', async () => {
    // contract is Tier 3 and human_only. It is the ONE step whose absence
    // leaves the ladder complete rather than half-done, so it must not make
    // everything before it ineligible.
    const p = plan()
    expect(p.steps.at(-1)!.kind).toBe('contract')
    mockFindApproval.mockResolvedValue(approvalFor(p))

    const r = await sweep()
    expect(r.disposition).toBe('executed')
  })
})

describe('the plan is rebuilt, never remembered', () => {
  it('resolves from the live catalog on every pass', async () => {
    const p = plan()
    mockFindApproval.mockResolvedValue(approvalFor(p))
    await sweep()
    expect(mockResolve).toHaveBeenCalledWith({ projectId: 'p1', findingId: 'f1' })
  })

  it('reports a plan that will not build rather than forcing one', async () => {
    mockResolve.mockResolvedValue({ refusal: 'diagnosis is inconclusive' })
    const r = await sweep()
    expect(r.disposition).toBe('not_planable')
    expect(r.reason).toMatch(/inconclusive/)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('does nothing when the project has no open structural finding', async () => {
    mockFindFinding.mockResolvedValue(null)
    const r = await sweep()
    expect(r.disposition).toBe('no_finding')
    expect(mockResolve).not.toHaveBeenCalled()
  })

  it('looks only at unresolved findings, never fixed or dismissed ones', async () => {
    // Re-planning from a dismissed finding overrides a human, and a fixed one
    // is done. `pending_approval` IS unresolved: it is the status the observer
    // writes this finding with, and reading `open` alone meant the sweep never
    // found a real one (tests/probes/restructuring-is-reachable.spec.ts).
    await sweep()
    const where = mockFindFinding.mock.calls[0][0].where
    expect(where.status).toEqual({ in: ['open', 'pending_approval'] })
    expect(where.status.in).not.toContain('dismissed')
    expect(where.status.in).not.toContain('auto_fixed')
  })
})
