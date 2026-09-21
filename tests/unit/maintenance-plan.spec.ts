/**
 * PHASE 5 — the maintenance planner is a safety contract
 * ======================================================
 *
 * Phase 5 plans and refuses. It executes nothing, and after the executor
 * capability spike it knows most of what it plans cannot be executed yet.
 *
 * The distinction these tests protect:
 *
 *     valid + executable             sound diagnosis, real ladder, executor ready
 *     valid + blocked_by_capability  sound diagnosis, right ladder, primitive missing
 *     invalid                        the plan should not exist at all
 *
 * Collapsing the middle state is the mistake. Treating it as invalid discards
 * correct engineering because a tool is missing; treating it as executable ships
 * a ladder whose middle rung does not exist.
 *
 * Pure: no database. Every input is a constructed diagnosis, which is what makes
 * the refusal paths cheap enough to enumerate exhaustively.
 */

import {
  buildMaintenancePlan,
  isPlanStale,
  approvalStillValid,
  executablePrefix,
} from '@/lib/autonomy/maintenance/plan'
import {
  classifyMaintenanceStep,
  EXECUTOR_CAPABILITY,
  requiresRollbackSpec,
} from '@/lib/autonomy/maintenance/step'
import { OPTIONAL_TERMINAL_STEPS } from '@/lib/autonomy/maintenance/step'
import { canRollback } from '@/lib/autonomy/maintenance/rollback-capability'
import type { StructuralDiagnosis } from '@/lib/autonomy/hypothesis/structural'

const COVERAGE = {
  policiesReadable: true,
  constraintCatalogReadable: true,
  statementTelemetryAvailable: true,
  largestSampleRows: 120,
  sampleSufficient: true,
  notes: [],
}

/** A confirmed diagnosis, which callers narrow per test. */
function diagnosis(over: Partial<StructuralDiagnosis> = {}): StructuralDiagnosis {
  return {
    kind: 'structural_cause_identified',
    hypothesis: {
      id: 'duplicated_lifecycle_state',
      statement: 'the same state is recorded twice',
      prior: 0.25,
      predicts: { column_covariation: 'co_varying' },
      remedy: { summary: 'consolidate', autoApplicable: false },
    },
    confidence: 0.92,
    coverage: COVERAGE,
    blockedBy: [],
    raisedOnly: [],
    reason: 'confirmed',
    trail: ['…'],
    report: {
      symptomId: 'subsystem_repeat_failure',
      verdict: { kind: 'no_symptom' },
      observations: [{ testId: 'column_covariation', outcome: 'co_varying' }],
      unavailable: [],
      trail: [],
    },
    ...over,
  } as StructuralDiagnosis
}

const SUBSYSTEM = { fingerprint: 'sessions', membership: ['sessions', 'users'] }

const plan = (d: StructuralDiagnosis, fingerprint = 'cat-v1') =>
  buildMaintenancePlan({
    findingId: 'f1',
    diagnosis: d,
    subsystem: SUBSYSTEM,
    catalogFingerprint: fingerprint,
  })

// ── The capability table is the spike's output ───────────────────────────────

describe('executor capability', () => {
  it('records what the executor can actually do, not what the ladder wants', () => {
    expect(EXECUTOR_CAPABILITY.add_structure).toBe('implemented')
    // Phase 6b built these three under lib/autonomy/maintenance/primitives,
    // none of them by reusing a verb that was the wrong shape: CREATE_TRIGGER
    // wrote an AppTrigger row rather than a database trigger, and
    // RUN_DATA_MIGRATION's backfill is atomic where maintenance needs resumable.
    expect(EXECUTOR_CAPABILITY.dual_write).toBe('implemented')
    expect(EXECUTOR_CAPABILITY.backfill).toBe('implemented')
    expect(EXECUTOR_CAPABILITY.verify).toBe('implemented')
    // Phase 7 built the reader switch, for the readers Backenly wrote.
    expect(EXECUTOR_CAPABILITY.switch_readers).toBe('implemented')
    // NOT deferred: contract drops the legacy column, which needs "nobody reads
    // this" to be established, and this platform cannot establish it. A person
    // does it. See lib/autonomy/maintenance/readers.ts.
    expect(EXECUTOR_CAPABILITY.contract).toBe('human_only')
  })

  it('never emits a placeholder verb for an unimplemented step', () => {
    const p = plan(diagnosis())
    for (const s of p.steps) {
      if (EXECUTOR_CAPABILITY[s.kind] !== 'implemented') {
        // A fabricated verb here is how schema_not_registered shipped pointing
        // at REGISTER_POSTGREST_SCHEMA and dead-ended every approval.
        expect(s.action).toBeNull()
      }
    }
  })
})

describe('classifyMaintenanceStep is the one decision point', () => {
  it('rates dual_write Tier 2 on BEHAVIOUR, not schema additivity', () => {
    const c = classifyMaintenanceStep({ kind: 'dual_write' })
    expect(c.tier).toBe(2)
    expect(c.reason).toMatch(/caller/)
  })

  it('rates contract Tier 3', () => {
    expect(classifyMaintenanceStep({ kind: 'contract' }).tier).toBe(3)
  })

  it('rates verify Tier 0', () => {
    expect(classifyMaintenanceStep({ kind: 'verify' }).tier).toBe(0)
  })

  it('reports executable only for implemented capabilities', () => {
    expect(classifyMaintenanceStep({ kind: 'add_structure' }).executable).toBe(true)
    expect(classifyMaintenanceStep({ kind: 'dual_write' }).executable).toBe(true)
    expect(classifyMaintenanceStep({ kind: 'backfill' }).executable).toBe(true)
    expect(classifyMaintenanceStep({ kind: 'switch_readers' }).executable).toBe(true)
    // human_only is not executable, and never becomes so.
    expect(classifyMaintenanceStep({ kind: 'contract' }).executable).toBe(false)
  })

  it('did not lower a tier when the primitive arrived', () => {
    // A primitive existing and a primitive being permitted to run are different
    // events. Tier is blast radius, and dual_write installs a trigger inside the
    // caller's transaction whether or not this repository can now write one.
    expect(classifyMaintenanceStep({ kind: 'dual_write' }).tier).toBe(2)
    expect(classifyMaintenanceStep({ kind: 'backfill' }).tier).toBe(2)
    expect(classifyMaintenanceStep({ kind: 'verify' }).tier).toBe(0)
    expect(classifyMaintenanceStep({ kind: 'add_structure' }).tier).toBe(1)
    expect(classifyMaintenanceStep({ kind: 'contract' }).tier).toBe(3)
  })

  it('requires a rollback for everything except contract', () => {
    expect(requiresRollbackSpec('contract')).toBe(false)
    for (const k of ['add_structure', 'dual_write', 'backfill', 'verify', 'switch_readers'] as const) {
      expect(requiresRollbackSpec(k)).toBe(true)
    }
  })
})

// ── Refusals ─────────────────────────────────────────────────────────────────

describe('a plan requires a decision-quality diagnosis', () => {
  it('refuses an inconclusive diagnosis', () => {
    const p = plan(diagnosis({ kind: 'inconclusive', hypothesis: undefined }))
    expect(p.validity).toBe('invalid')
    expect(p.steps).toEqual([])
    expect(p.blockedReasons[0]).toMatch(/inconclusive/)
  })

  it('refuses no_structural_cause', () => {
    const p = plan(diagnosis({ kind: 'no_structural_cause', hypothesis: undefined }))
    expect(p.validity).toBe('invalid')
  })

  /**
   * `split_brain_writers` can be raised and never confirmed, so there is no
   * ladder for it at all. A remedy for a suspicion is exactly what Phase 4's
   * inventory refused to manufacture.
   */
  it('refuses a raised-only hypothesis', () => {
    const p = plan(
      diagnosis({
        hypothesis: {
          id: 'split_brain_writers',
          statement: 'two writers',
          prior: 0.1,
          predicts: { write_statement_shapes: 'multiple_writers' },
          remedy: { summary: 'find them', autoApplicable: false },
        },
      } as Partial<StructuralDiagnosis>),
    )
    expect(p.validity).toBe('invalid')
    expect(p.blockedReasons[0]).toMatch(/no maintenance ladder/)
  })

  it('refuses when the deciding probe for the leading hypothesis never ran', () => {
    const p = plan(
      diagnosis({
        blockedBy: [
          {
            hypothesis: 'duplicated_lifecycle_state',
            test: 'column_covariation',
            reason: 'insufficient sample',
          },
        ],
      }),
    )
    expect(p.validity).toBe('invalid')
    expect(p.blockedReasons[0]).toMatch(/did not run/)
  })

  it('still plans when an UNRELATED hypothesis had a blocked probe', () => {
    // Guards the check above from being "any blockedBy entry refuses", which
    // would make the planner refuse far more than intended.
    const p = plan(
      diagnosis({
        blockedBy: [
          { hypothesis: 'policy_fragmentation', test: 'policy_overlap', reason: 'unreadable' },
        ],
      }),
    )
    expect(p.validity).not.toBe('invalid')
  })
})

// ── The middle state ─────────────────────────────────────────────────────────

describe('valid but blocked by capability', () => {
  /**
   * Phases 6b and 7 implemented every step kind the planner emits, so no real
   * ladder is blocked any more. The state must still be reachable: the next
   * step kind to be invented arrives unimplemented, and a ladder containing it
   * must not run.
   *
   * So the capability table is mocked rather than a real gap being relied on.
   * Deleting these tests because nothing is blocked today would remove the
   * guard exactly when it stops being self-testing.
   */
  const withCapability = (over: Record<string, string>, fn: (built: any) => void) => {
    jest.isolateModules(() => {
      jest.doMock('@/lib/autonomy/maintenance/step', () => {
        const real = jest.requireActual('@/lib/autonomy/maintenance/step')
        const table = { ...real.EXECUTOR_CAPABILITY, ...over }
        return {
          ...real,
          EXECUTOR_CAPABILITY: table,
          // The real classifier reads the real table from its own module scope,
          // so overriding the exported constant alone changes nothing it
          // returns. Capability is re-derived here from the overridden table;
          // tier still comes from the real classifier, because tier is a
          // property of the step and must not move when capability does.
          classifyMaintenanceStep: (s: any) => {
            const c = real.classifyMaintenanceStep(s)
            return { ...c, capability: table[s.kind], executable: table[s.kind] === 'implemented' }
          },
        }
      })
      const { buildMaintenancePlan: build } = require('@/lib/autonomy/maintenance/plan')
      fn(
        build({
          findingId: 'f1',
          diagnosis: diagnosis(),
          subsystem: SUBSYSTEM,
          catalogFingerprint: 'cat-v1',
        }),
      )
    })
    jest.dontMock('@/lib/autonomy/maintenance/step')
  }

  it('produces the full ladder and marks it non-executable', () => {
    withCapability({ dual_write: 'not_implemented' }, p => {
      expect(p.validity).toBe('blocked_by_capability')
      expect(p.steps.map((s: any) => s.kind)).toEqual([
        // carry_constraints sits between add_structure and dual_write so the
        // catalog never rests with an unconstrained state column, which would
        // change the diagnosis and stop the ladder resuming after a backfill.
        'add_structure', 'carry_constraints', 'dual_write', 'backfill', 'verify',
        'switch_readers', 'contract',
      ])
      expect(p.blockedReasons.join(' ')).toMatch(/dual_write/)
    })
  })

  it('is NOT the same as invalid', () => {
    const bad = plan(diagnosis({ kind: 'inconclusive', hypothesis: undefined }))
    withCapability({ dual_write: 'not_implemented' }, blocked => {
      expect(blocked.validity).toBe('blocked_by_capability')
      expect(bad.validity).toBe('invalid')
      // The blocked plan is real engineering waiting on a tool; the invalid one
      // should never have existed. The executor must tell them apart.
      expect(blocked.steps.length).toBeGreaterThan(0)
      expect(bad.steps).toEqual([])
    })
  })

  /**
   * The rule that keeps a half-migrated schema from ever existing.
   *
   * With `dual_write` unavailable a prefix IS runnable. Running it would leave a
   * new column nothing fills and a dual-write that was never installed.
   */
  it('exposes an executable prefix as a diagnostic, never as permission', () => {
    withCapability({ dual_write: 'not_implemented' }, p => {
      const prefix = executablePrefix(p)
      expect(prefix.length).toBeGreaterThan(0)
      expect(prefix.length).toBeLessThan(p.steps.length)
      expect(p.validity).toBe('blocked_by_capability')
    })
  })

  it('does not let the human-only contract step block the ladder', () => {
    // The single exception to all-or-nothing, and the reason the six-rung
    // ladder can run at all. `contract` drops the legacy column, which requires
    // knowing nobody reads it — not a fact this platform can establish. The
    // ladder is complete and safe without it; the old column simply stays.
    const p = plan(diagnosis())
    // Only `contract` may appear here. The rollback-capability gate adds its
    // own reasons for this ladder (carry_constraints cannot be undone in this
    // deployment), and those are owned by
    // tests/core/rollback-capability-is-real.test.ts - what THIS test claims
    // is narrower: the human-only rung is not one of them.
    expect(p.steps.map(s => s.kind)).toContain('contract')
    expect(p.blockedReasons.join(' ')).not.toMatch(/contract/)
    // Reported, not hidden: a person still has to do it.
    expect(p.humanOnlySteps.join(' ')).toMatch(/contract: human_only/)
  })

  it('a ladder whose every step is implemented is executable', () => {
    // Proves `blocked_by_capability` is not simply what this planner always
    // returns. The constraint ladder is add_structure + verify; with verify
    // implemented it would be executable, so this asserts the mechanism rather
    // than today's table.
    const p = plan(
      diagnosis({
        hypothesis: {
          id: 'missing_constraint_permits_invalid_state',
          statement: 'unconstrained',
          prior: 0.25,
          predicts: { constraint_coverage: 'state_columns_unconstrained' },
          remedy: { summary: 'constrain', autoApplicable: false },
        },
      } as Partial<StructuralDiagnosis>),
    )
    // Executable requires BOTH gates, and this test exists to prove neither is
    // a constant. A rung can be perfectly runnable and still unrecoverable -
    // which is the whole point of the second registry - so asserting only the
    // forward table would now be asserting something that is never true.
    const runnable = p.steps.every(s => EXECUTOR_CAPABILITY[s.kind] === 'implemented')
    const recoverable = p.steps.every(
      s =>
        OPTIONAL_TERMINAL_STEPS.includes(s.kind) ||
        !s.rollbackSpec ||
        canRollback(s.rollbackSpec.strategy),
    )
    expect(p.validity).toBe(runnable && recoverable ? 'executable' : 'blocked_by_capability')
    // And the two gates disagree for this ladder today, which is the fact that
    // makes the assertion above non-trivial rather than a tautology.
    expect(runnable).toBe(true)
    expect(recoverable).toBe(false)
  })
})

// ── Rollback, staleness, versioning ──────────────────────────────────────────

describe('reversibility is a precondition, not a warning', () => {
  it('every non-contract step carries a rollback spec', () => {
    const p = plan(diagnosis())
    for (const s of p.steps) {
      if (s.kind === 'contract') expect(s.rollbackSpec).toBeNull()
      else expect(s.rollbackSpec).not.toBeNull()
    }
  })

  /**
   * The expand/contract insight: the source column is never destructively
   * touched during expand, so undoing a backfill means dropping the structure it
   * filled — not reconstructing the original from `rollbackDataMigration`'s
   * CREATE TABLE AS checkpoint, which documents that it restores rows and types
   * but NOT constraints, indexes or defaults.
   */
  it('backfill reverts the new structure rather than restoring a checkpoint', () => {
    const p = plan(diagnosis())
    const backfill = p.steps.find(s => s.kind === 'backfill')!
    // `revert_new_structure` until the strategies were typed one per
    // operation. Undoing a backfill has always MEANT dropping the column it
    // filled - expand never destructively touches the source - so this is the
    // same property under the name the capability registry knows it by.
    expect(backfill.rollbackSpec?.strategy).toBe('drop_column')
    expect(backfill.rollbackSpec?.description).toMatch(/nothing to restore|no checkpoint/i)
  })

  it('contract is the only step allowed no rollback, and is Tier 3', () => {
    const p = plan(diagnosis())
    const contract = p.steps.find(s => s.kind === 'contract')!
    expect(contract.rollbackSpec).toBeNull()
    expect(classifyMaintenanceStep(contract).tier).toBe(3)
  })
})

describe('staleness and authorization', () => {
  it('a plan built against one catalog is stale against another', () => {
    const p = plan(diagnosis(), 'cat-v1')
    expect(isPlanStale(p, 'cat-v1')).toBe(false)
    expect(isPlanStale(p, 'cat-v2')).toBe(true)
  })

  it('planVersion changes when the catalog changes', () => {
    const a = plan(diagnosis(), 'cat-v1')
    const b = plan(diagnosis(), 'cat-v2')
    expect(a.planVersion).not.toBe(b.planVersion)
  })

  it('planVersion is stable for identical inputs', () => {
    // Otherwise every tick would invalidate the previous approval.
    expect(plan(diagnosis(), 'cat-v1').planVersion).toBe(plan(diagnosis(), 'cat-v1').planVersion)
  })

  it('an approval for one version does not authorize another', () => {
    const v1 = plan(diagnosis(), 'cat-v1')
    const v2 = plan(diagnosis(), 'cat-v2')
    expect(approvalStillValid(v1, v1.planVersion)).toBe(true)
    expect(approvalStillValid(v2, v1.planVersion)).toBe(false)
  })

  it('an approval does not survive the executor gaining a capability', () => {
    // The hazard this closes: a plan built while dual_write was unimplemented
    // was `blocked_by_capability`, and an owner could approve it. When Phase 6b
    // landed the primitive, an unchanged planVersion would have turned consent
    // for a ladder that could not run into consent for one that can.
    //
    // The capability table is part of the version, so the approval lapses on its
    // own. Re-planning is the only way back, which is the intended cost.
    const current = plan(diagnosis(), 'cat-v1')

    let previous: string = ''
    jest.isolateModules(() => {
      jest.doMock('@/lib/autonomy/maintenance/step', () => {
        const real = jest.requireActual('@/lib/autonomy/maintenance/step')
        return {
          ...real,
          EXECUTOR_CAPABILITY: { ...real.EXECUTOR_CAPABILITY, dual_write: 'not_implemented' },
        }
      })
      const { buildMaintenancePlan: build } = require('@/lib/autonomy/maintenance/plan')
      previous = build({
        findingId: 'f1',
        diagnosis: diagnosis(),
        subsystem: SUBSYSTEM,
        catalogFingerprint: 'cat-v1',
      }).planVersion
    })
    jest.dontMock('@/lib/autonomy/maintenance/step')

    // Non-vacuity: the mock really did produce a different plan version, so this
    // is measuring the capability table and not a constant.
    expect(previous).not.toBe('')
    expect(previous).not.toBe(current.planVersion)
    expect(approvalStillValid(current, previous)).toBe(false)
  })

  it('idempotency keys are stable and distinct per step', () => {
    const a = plan(diagnosis(), 'cat-v1')
    const b = plan(diagnosis(), 'cat-v1')
    const keys = a.steps.map(s => s.idempotencyKey)
    expect(keys).toEqual(b.steps.map(s => s.idempotencyKey))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('planning is not evidence', () => {
  /**
   * A generated ladder must never raise confidence in the diagnosis that
   * produced it. The plan reports the diagnosis it was handed, unchanged.
   */
  it('reports the diagnosis confidence unchanged', () => {
    const d = diagnosis({ confidence: 0.91 })
    expect(plan(d).diagnosis.confidence).toBe(0.91)
  })

  it('carries provenance and coverage separately from the verdict', () => {
    const p = plan(diagnosis())
    expect(p.diagnosis.coverage).toEqual(COVERAGE)
    expect(p.diagnosis.provenance.join(' ')).toMatch(/column_covariation=co_varying/)
  })

  it('records coverage even when it is poor', () => {
    const p = plan(
      diagnosis({
        coverage: { ...COVERAGE, statementTelemetryAvailable: false, notes: ['pg_stat_statements absent'] },
      }),
    )
    expect(p.diagnosis.coverage.statementTelemetryAvailable).toBe(false)
    expect(p.diagnosis.coverage.notes).toContain('pg_stat_statements absent')
  })
})
