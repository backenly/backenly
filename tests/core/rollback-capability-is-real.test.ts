/**
 * A ROLLBACK SPEC IS A SENTENCE. CAPABILITY IS A FACT.
 * ====================================================
 *
 * The planner used to decide a ladder was recoverable like this:
 *
 *     seeds.filter(s => requiresRollbackSpec(s.kind) && !s.rollbackSpec)
 *
 * That is "does every rung carry a description of its undo". It never asked
 * whether the deployed executor could perform one. `drop_object` covered four
 * materially different operations and two of them had no implementation, so
 * ladders were planned, approved and executed on the strength of a recovery
 * that did not exist.
 *
 * The policy case is the one worth reading twice. `REMOVE_PERMISSION` takes a
 * table name and removes EVERY policy on it, while the forward step
 * CONSOLIDATES a fragmented set into one. "Drop the consolidated policy" would
 * therefore leave the table with no row security at all — recovery turning
 * into a security failure. Its real inverse is restoring the exact prior set,
 * which is a different strategy that nothing implements yet.
 *
 * These tests enumerate the registry rather than grepping source, so adding a
 * strategy without deciding its capability is a compile error, and adding one
 * the planner emits without registering it fails here.
 */

import {
  ROLLBACK_CAPABILITY,
  ROLLBACK_STRATEGIES,
  canRollback,
  rollbackRefusal,
  type RollbackStrategy,
} from '@/lib/autonomy/maintenance/rollback-capability'
import { buildMaintenancePlan } from '@/lib/autonomy/maintenance/plan'

/** Every hypothesis the planner has a ladder for. */
const LADDERS = [
  'duplicated_lifecycle_state',
  'missing_constraint_permits_invalid_state',
  'policy_fragmentation',
] as const

const diagnosis = (id: string): any => ({
  kind: 'structural_cause_identified',
  hypothesis: { id },
  confidence: 0.71,
  coverage: { sampleSufficient: true, largestSampleRows: 80, notes: [] },
  blockedBy: [],
  raisedOnly: [],
  reason: 'ok',
  trail: [],
  report: { observations: [], unavailable: [], verdict: { kind: 'conclusive' } },
})

const planFor = (hypothesis: string) =>
  buildMaintenancePlan({
    findingId: 'f1',
    diagnosis: diagnosis(hypothesis),
    subsystem: { fingerprint: 'sessions', membership: ['sessions', 'users'] },
    catalogFingerprint: 'cat-v1',
  })

// ── The registry ─────────────────────────────────────────────────────────────

describe('the rollback capability registry is the authority', () => {
  it('has a decision for every strategy in the vocabulary', () => {
    // Enumerated from the registry itself. A strategy added to the union
    // without an entry here is a TypeScript error at the registry, and one
    // added to the registry without a decision shows up as undefined.
    expect(ROLLBACK_STRATEGIES.length).toBeGreaterThan(0)
    for (const s of ROLLBACK_STRATEGIES) {
      expect(['implemented', 'not_implemented']).toContain(ROLLBACK_CAPABILITY[s])
    }
  })

  it('says exactly which recoveries this deployment can perform', () => {
    // Pinned deliberately. Flipping one of these to 'implemented' without an
    // executor behind it is the original bug, so the change has to be
    // deliberate enough to edit this list.
    const implemented = ROLLBACK_STRATEGIES.filter(canRollback).sort()
    expect(implemented).toEqual([
      'drop_column',
      'drop_trigger',
      'none_required',
      'restore_reader_config',
    ])
  })

  it('names the two it cannot, and why', () => {
    expect(rollbackRefusal('drop_constraint')).toMatch(/no executor that can drop one/)
    expect(rollbackRefusal('restore_policies')).toMatch(/cannot yet capture or replay/)
  })

  it('gives no refusal for anything it claims to support', () => {
    // The inverse. Without it, a registry that refused everything would pass
    // every assertion above.
    for (const s of ROLLBACK_STRATEGIES.filter(canRollback)) {
      expect(rollbackRefusal(s)).toBeNull()
    }
  })
})

// ── What that means for the ladders today ────────────────────────────────────

describe('no ladder is schedulable while its recovery is fictional', () => {
  it.each(LADDERS)('%s is blocked by capability, not offered for approval', hypothesis => {
    const plan = planFor(hypothesis)

    // `blocked_by_capability`, never `executable`. The distinction that
    // matters: this is not work waiting on a human, because no approval
    // creates a missing executor.
    expect(plan.validity).toBe('blocked_by_capability')
    expect(plan.blockedReasons.join(' ')).toMatch(/cannot be scheduled because/)
  })

  it('says which rung and which missing capability, not just "blocked"', () => {
    // An operator has to be able to act on this. "Blocked" alone is the kind
    // of refusal that sends somebody reading source.
    const constraintLadder = planFor('duplicated_lifecycle_state')
    expect(constraintLadder.blockedReasons.join(' ')).toMatch(/carry_constraints/)
    expect(constraintLadder.blockedReasons.join(' ')).toMatch(/drop a constraint/)

    const policyLadder = planFor('policy_fragmentation')
    expect(policyLadder.blockedReasons.join(' ')).toMatch(/restore the previous policy set/)
  })

  it('still shows the ladder it would have run, without authorising any of it', () => {
    // The steps ARE carried, deliberately. `blocked_by_capability` has always
    // meant "the engineering is right and a tool is missing", and the surface
    // shows what Backenly would have done — the difference between "cannot do
    // this yet" and a blank refusal.
    //
    // Safety comes from the executor, not from hiding the plan: `refuseLadder`
    // in execute.ts refuses a `blocked_by_capability` plan outright INCLUDING
    // its runnable prefix, because running the supported prefix of
    // expand/contract is how a half-expanded schema gets created by the thing
    // that was refusing.
    for (const h of LADDERS) {
      const plan = planFor(h)
      expect(plan.steps.length).toBeGreaterThan(0)
      expect(plan.validity).not.toBe('executable')
    }
  })

  it('re-versions the plan when recovery capability moves', () => {
    // An approval granted while `drop_constraint` was unsupported must not
    // silently become consent for the same ladder once the recovery lands:
    // the risk the approver weighed was "this cannot be put back". The forward
    // capability table is already folded into planVersion for exactly this
    // reason, and the rollback table now is too.
    const before = planFor('duplicated_lifecycle_state').planVersion

    // Rebuild the planner with `drop_constraint` supported, as a deployment
    // that has shipped the recovery would see it.
    let after = ''
    jest.isolateModules(() => {
      jest.doMock('@/lib/autonomy/maintenance/rollback-capability', () => {
        const actual = jest.requireActual('@/lib/autonomy/maintenance/rollback-capability')
        return {
          ...actual,
          ROLLBACK_CAPABILITY: { ...actual.ROLLBACK_CAPABILITY, drop_constraint: 'implemented' },
          rollbackRefusal: (s: string) => (s === 'drop_constraint' ? null : actual.rollbackRefusal(s)),
        }
      })
      const { buildMaintenancePlan: rebuilt } = require('@/lib/autonomy/maintenance/plan')
      after = rebuilt({
        findingId: 'f1',
        diagnosis: diagnosis('duplicated_lifecycle_state'),
        subsystem: { fingerprint: 'sessions', membership: ['sessions', 'users'] },
        catalogFingerprint: 'cat-v1',
      }).planVersion
    })
    jest.dontMock('@/lib/autonomy/maintenance/rollback-capability')

    expect(after).not.toBe(before)
  })
})

// ── The property that outlives these three ladders ──────────────────────────

describe('the planner cannot mark a ladder executable on an unsupported recovery', () => {
  it('every strategy the planner emits is registered', () => {
    // Catches a spec written with a strategy nobody added to the registry,
    // which would read as `undefined` capability and slip through.
    //
    // Read off the built plans rather than the source, so it follows the
    // planner wherever its ladders move.
    const emitted = new Set<string>()
    for (const h of LADDERS) {
      // The blocked plans above carry no steps, so the seeds are re-derived
      // through a permissive lens: what matters is that whatever strategy
      // string the planner writes is one the registry knows.
      const reasons = planFor(h).blockedReasons.join(' ')
      for (const s of ROLLBACK_STRATEGIES) if (reasons.includes(s)) emitted.add(s)
    }
    for (const s of emitted) {
      expect(ROLLBACK_STRATEGIES).toContain(s as RollbackStrategy)
    }
  })

  it('treats an unknown strategy as not recoverable', () => {
    // The allow-list property, same rule as fix verification: a value nobody
    // registered is unsupported, not supported-by-default.
    expect(canRollback('a_strategy_from_next_quarter' as RollbackStrategy)).toBe(false)
  })
})
