/**
 * CONSENT IS HARDER TO GIVE THAN TO RECORD
 * ========================================
 *
 * A writer for `maintenance_approvals` is easy. A writer that cannot be used
 * to authorise the wrong thing is the actual requirement, because the row it
 * produces is the only reason an unattended process is allowed to rewrite a
 * customer's schema.
 *
 * So these tests are almost entirely about refusal. The one acceptance test
 * exists so the refusals cannot be passing vacuously on a path that would have
 * refused anyway.
 */

/**
 * Most of this file is about the CONSENT rules - version binding, bindings,
 * the tier ceiling, revocation - and those need a ladder somebody could
 * actually approve.
 *
 * Since the capability gate landed, every ladder the planner emits is
 * `blocked_by_capability` because `drop_constraint` has no executor, and
 * `grantMaintenanceApproval` correctly refuses to record consent for a plan
 * that cannot be safely undone. That is asserted explicitly at the bottom of
 * this file with the real registry; everywhere else recovery is treated as
 * available so the consent rules themselves are exercised.
 */
let recoveryIsAvailable = true

jest.mock('@/lib/autonomy/maintenance/rollback-capability', () => {
  const actual = jest.requireActual('@/lib/autonomy/maintenance/rollback-capability')
  return {
    ...actual,
    rollbackRefusal: (st: string) => (recoveryIsAvailable ? null : actual.rollbackRefusal(st)),
    canRollback: (st: string) => (recoveryIsAvailable ? true : actual.canRollback(st)),
  }
})

const mockFindFinding = jest.fn()
const mockFindApproval = jest.fn()
const mockUpsertApproval = jest.fn()
const mockFindUniqueApproval = jest.fn()
const mockUpdateApproval = jest.fn()

jest.mock('@/lib/db', () => ({
  prisma: {
    healthFinding: { findFirst: (...a: any[]) => mockFindFinding(...(a as [])) },
    maintenanceApproval: {
      findFirst: (...a: any[]) => mockFindApproval(...(a as [])),
      findUnique: (...a: any[]) => mockFindUniqueApproval(...(a as [])),
      upsert: (...a: any[]) => mockUpsertApproval(...(a as [])),
      update: (...a: any[]) => mockUpdateApproval(...(a as [])),
    },
  },
}))

const mockResolve = jest.fn()
jest.mock('@/lib/autonomy/maintenance/resolve', () => ({
  resolveMaintenancePlan: (...a: any[]) => mockResolve(...(a as [])),
  isRefusal: (r: any) => r?.refusal !== undefined,
}))

import {
  grantMaintenanceApproval,
  revokeMaintenanceApproval,
  composeBindings,
  describePendingLadder,
  isLadderRefusal,
  isGrantRefusal,
  MAX_APPROVABLE_TIER,
  type LadderAnswers,
} from '@/lib/autonomy/maintenance/approval'
import { buildMaintenancePlan } from '@/lib/autonomy/maintenance/plan'

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
    subsystem: { fingerprint: 'sessions', membership: ['sessions', 'users'] },
    catalogFingerprint: 'cat-v1',
  })

const ANSWERS: LadderAnswers = {
  sourceColumn: 'status',
  targetColumn: 'state',
  targetType: 'text',
  transform: { kind: 'identity' },
  allowedValues: ['active', 'expired'],
}

beforeEach(() => {
  recoveryIsAvailable = true
  jest.clearAllMocks()
  mockFindFinding.mockResolvedValue({ id: 'f1' })
  mockFindApproval.mockResolvedValue(null)
  mockResolve.mockResolvedValue({
    plan: plan(),
    subsystem: { fingerprint: 'sessions', membership: ['sessions', 'users'] },
    catalogFingerprint: 'cat-v1',
    table: 'sessions',
  })
  mockUpsertApproval.mockImplementation(async ({ create, update }: any) => ({
    id: 'ap-1',
    planId: create?.planId ?? 'plan-1',
    planVersion: create?.planVersion ?? 'v1',
    maxTier: (create ?? update)?.maxTier ?? 2,
    bindings: (create ?? update)?.bindings ?? {},
    approvedBy: (create ?? update)?.approvedBy ?? 'u1',
    reason: (create ?? update)?.reason ?? null,
    createdAt: new Date(),
  }))
})

// ── What the owner is shown ──────────────────────────────────────────────────

describe('describing the ladder awaiting a decision', () => {
  it('reports no ladder rather than an error on a healthy project', async () => {
    // The common case. Treating "nothing is wrong" as a failure would teach
    // every caller to read a healthy backend as a broken one.
    mockFindFinding.mockResolvedValue(null)
    const r = await describePendingLadder({ projectId: 'p1' })
    expect(isLadderRefusal(r)).toBe(true)
  })

  it('separates the rungs a robot may run from the one only a person may', async () => {
    const r = await describePendingLadder({ projectId: 'p1' })
    if (isLadderRefusal(r)) throw new Error(r.refusal)
    expect(r.needsBinding.map(s => s.kind)).not.toContain('contract')
    expect(r.humanOnly.map(s => s.kind)).toEqual(['contract'])
  })

  it('says of every rung whether it can be undone', async () => {
    const r = await describePendingLadder({ projectId: 'p1' })
    if (isLadderRefusal(r)) throw new Error(r.refusal)
    // `contract` drops the legacy column. Nothing undoes that, and the owner
    // is told so before consenting rather than after.
    expect(r.humanOnly[0].rollback).toBeNull()
    expect(r.needsBinding.every(s => s.rollback !== null)).toBe(true)
  })
})

// ── Refusals ─────────────────────────────────────────────────────────────────

describe('granting consent refuses more than it records', () => {
  it('refuses a version that is not the one the ladder currently builds to', async () => {
    // The stale-tab case, and the replayed-agent-tool-call case. Without the
    // rebuild, this authorises a ladder nobody has seen.
    const r = await grantMaintenanceApproval({
      projectId: 'p1',
      planVersion: 'a-version-from-an-old-screen',
      approvedBy: 'u1',
      answers: ANSWERS,
    })
    expect(isGrantRefusal(r)).toBe(true)
    if (!isGrantRefusal(r)) return
    expect(r.refusal).toMatch(/is now version/)
    expect(r.currentPlanVersion).toBe(plan().planVersion)
    expect(mockUpsertApproval).not.toHaveBeenCalled()
  })

  it('refuses when a rung has no binding', async () => {
    const r = await grantMaintenanceApproval({
      projectId: 'p1',
      planVersion: plan().planVersion,
      approvedBy: 'u1',
      bindings: {},
    })
    expect(isGrantRefusal(r)).toBe(true)
    if (!isGrantRefusal(r)) return
    expect(r.refusal).toMatch(/has no binding describing what it operates on/)
    expect(mockUpsertApproval).not.toHaveBeenCalled()
  })

  it('refuses a binding that describes a different kind of rung', async () => {
    const p = plan()
    const good = composeBindings(
      p.steps
        .filter(s => s.kind !== 'contract')
        .map(s => ({ ordinal: s.ordinal, kind: s.kind, tier: 0, executable: true, rollback: null, params: {} })),
      'sessions',
      ANSWERS,
    )
    // Ordinal 0 is add_structure. Hand it a verify binding.
    const wrong: any = { ...good, 0: { kind: 'verify', table: 'sessions', sourceColumn: 'status', targetColumn: 'state', transform: { kind: 'identity' } } }
    const r = await grantMaintenanceApproval({
      projectId: 'p1',
      planVersion: p.planVersion,
      approvedBy: 'u1',
      bindings: wrong,
    })
    expect(isGrantRefusal(r)).toBe(true)
    if (!isGrantRefusal(r)) return
    expect(r.refusal).toMatch(/but its binding describes a verify/)
  })

  it('refuses an approval that does not name who gave it', async () => {
    const r = await grantMaintenanceApproval({
      projectId: 'p1',
      planVersion: plan().planVersion,
      approvedBy: '   ',
      answers: ANSWERS,
    })
    expect(isGrantRefusal(r)).toBe(true)
  })

  it('refuses when the ladder needs a higher tier than the consent covers', async () => {
    // Partial consent would halt the ladder half-expanded, which is the state
    // the whole-ladder eligibility check exists to prevent.
    const r = await grantMaintenanceApproval({
      projectId: 'p1',
      planVersion: plan().planVersion,
      approvedBy: 'u1',
      answers: ANSWERS,
      maxTier: 1,
    })
    expect(isGrantRefusal(r)).toBe(true)
    if (!isGrantRefusal(r)) return
    expect(r.refusal).toMatch(/only covers up to tier 1/)
  })

  it('clamps a request for tier 3 down to the approvable ceiling', async () => {
    // `contract` is irreversible and is performed by a person. No request body
    // may widen the band, so this is clamped rather than refused.
    await grantMaintenanceApproval({
      projectId: 'p1',
      planVersion: plan().planVersion,
      approvedBy: 'u1',
      answers: ANSWERS,
      maxTier: 3,
    })
    expect(mockUpsertApproval).toHaveBeenCalled()
    const arg = mockUpsertApproval.mock.calls[0][0] as any
    expect(arg.create.maxTier).toBe(MAX_APPROVABLE_TIER)
    expect(arg.create.maxTier).toBeLessThan(3)
  })
})

// ── The one acceptance ───────────────────────────────────────────────────────

describe('granting consent that is actually valid', () => {
  it('records it, bound to the exact version, with the bindings attached', async () => {
    const p = plan()
    const r = await grantMaintenanceApproval({
      projectId: 'p1',
      planVersion: p.planVersion,
      approvedBy: 'user-42',
      answers: ANSWERS,
      reason: 'reviewed the diff',
    })
    expect(isGrantRefusal(r)).toBe(false)
    const arg = mockUpsertApproval.mock.calls[0][0] as any

    // Bound to the pair that must be unique, never to planId alone.
    expect(arg.where.planId_planVersion).toEqual({
      planId: p.planId,
      planVersion: p.planVersion,
    })
    expect(arg.create.approvedBy).toBe('user-42')
    // Bindings travel WITH consent: they are part of what was consented to.
    expect(arg.create.bindings[0]).toMatchObject({ kind: 'add_structure', column: 'state' })
  })

  it('re-approving the same version lifts a prior revocation rather than stacking a row', async () => {
    await grantMaintenanceApproval({
      projectId: 'p1',
      planVersion: plan().planVersion,
      approvedBy: 'u1',
      answers: ANSWERS,
    })
    const arg = mockUpsertApproval.mock.calls[0][0] as any
    expect(arg.update.revokedAt).toBeNull()
    expect(arg.update.revokedBy).toBeNull()
  })
})

// ── Composition ──────────────────────────────────────────────────────────────

describe('one answer fans out across the rungs', () => {
  const steps = () =>
    plan()
      .steps.filter(s => s.kind !== 'contract')
      .map(s => ({ ordinal: s.ordinal, kind: s.kind, tier: 0, executable: true, rollback: null, params: {} }))

  it('gives every runnable rung a binding of its own kind', () => {
    const out = composeBindings(steps() as any, 'sessions', ANSWERS)
    for (const s of steps()) {
      expect(out[s.ordinal]).toBeDefined()
      expect(out[s.ordinal].kind).toBe(s.kind)
    }
  })

  it('never invents a binding for a rung it does not understand', () => {
    // A new step kind must surface as "no binding describes what it operates
    // on" rather than be quietly approved.
    const out = composeBindings(
      [{ ordinal: 99, kind: 'contract' as any, tier: 3, executable: false, rollback: null, params: {} }],
      'sessions',
      ANSWERS,
    )
    expect(out[99]).toBeUndefined()
  })

  it('carries the stated domain onto the constraint rung', () => {
    const out = composeBindings(steps() as any, 'sessions', ANSWERS)
    const cc = Object.values(out).find(b => b.kind === 'carry_constraints') as any
    expect(cc.allowedValues).toEqual(['active', 'expired'])
  })
})

// ── Withdrawal ───────────────────────────────────────────────────────────────

describe('withdrawing consent', () => {
  it('refuses an approval belonging to another project', async () => {
    // An id learned elsewhere must not be revocable across a tenancy boundary,
    // and the refusal must not confirm the row exists.
    mockFindUniqueApproval.mockResolvedValue({ id: 'ap-1', projectId: 'someone-else', revokedAt: null })
    const r = await revokeMaintenanceApproval({ projectId: 'p1', approvalId: 'ap-1', revokedBy: 'u1' })
    expect(r).toEqual({ ok: false, refusal: 'no such approval' })
    expect(mockUpdateApproval).not.toHaveBeenCalled()
  })

  it('is idempotent on an approval already withdrawn', async () => {
    mockFindUniqueApproval.mockResolvedValue({ id: 'ap-1', projectId: 'p1', revokedAt: new Date() })
    const r = await revokeMaintenanceApproval({ projectId: 'p1', approvalId: 'ap-1', revokedBy: 'u1' })
    expect(r).toEqual({ ok: true, id: 'ap-1' })
    expect(mockUpdateApproval).not.toHaveBeenCalled()
  })

  it('stamps who withdrew it', async () => {
    mockFindUniqueApproval.mockResolvedValue({ id: 'ap-1', projectId: 'p1', revokedAt: null })
    await revokeMaintenanceApproval({ projectId: 'p1', approvalId: 'ap-1', revokedBy: 'user-42' })
    const arg = mockUpdateApproval.mock.calls[0][0] as any
    expect(arg.data.revokedBy).toBe('user-42')
    expect(arg.data.revokedAt).toBeInstanceOf(Date)
  })
})

// ── The gate, with the real registry ────────────────────────────────────────

describe('consent cannot be recorded for a ladder Backenly cannot undo', () => {
  it('refuses, and says the plan is blocked rather than asking for bindings', async () => {
    // The property that keeps an unrecoverable ladder out of the approval
    // queue entirely. Without it the owner is handed a decision they cannot
    // make meaningfully: approving a change whose recovery does not exist.
    recoveryIsAvailable = false
    // Rebuilt AFTER the flip. `beforeEach` primes the resolve mock with a plan
    // built while recovery was available, so reusing it would be approving a
    // plan the planner would no longer produce.
    const blocked = plan()
    expect(blocked.validity).toBe('blocked_by_capability')
    mockResolve.mockResolvedValue({
      plan: blocked,
      subsystem: { fingerprint: 'sessions', membership: ['sessions', 'users'] },
      catalogFingerprint: 'cat-v1',
      table: 'sessions',
    })

    const r = await grantMaintenanceApproval({
      projectId: 'p1',
      planVersion: blocked.planVersion,
      approvedBy: 'u1',
      answers: ANSWERS,
    })

    expect(isGrantRefusal(r)).toBe(true)
    if (!isGrantRefusal(r)) return
    expect(r.refusal).toMatch(/blocked_by_capability/)
    expect(r.refusal).toMatch(/drop a constraint/)
    expect(mockUpsertApproval).not.toHaveBeenCalled()
  })
})
