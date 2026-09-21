/**
 * MAINTENANCE PLANNER — a contract Phase 6 must satisfy, not an executor
 * ======================================================================
 *
 * Turns a Phase 4 structural diagnosis into an ordered ladder of individually
 * reversible steps. It executes nothing, and after the executor capability
 * spike it knows that most of what it plans cannot be executed yet.
 *
 * ── The distinction this module exists to make ──────────────────────────────
 *
 *   valid + executable            sound diagnosis, real ladder, executor ready
 *   valid + blocked_by_capability sound diagnosis, right ladder, primitive missing
 *   invalid                       the plan should not exist at all
 *
 * Collapsing the middle state into either neighbour is the mistake. Treating it
 * as `invalid` throws away correct engineering because a tool is missing;
 * treating it as `executable` ships a ladder whose middle rung does not exist.
 * Phase 6 needs to tell "waiting for a primitive" apart from "never build this".
 *
 * ── Why a plan can be right and still refuse to run ─────────────────────────
 *
 * When this was written, three of six step kinds had no implementation.
 * Phases 6b and 7 built five; the sixth, `contract`, never will be — it drops
 * the legacy column, and on a platform that hands out connection strings and
 * serves PostgREST clients that pick their own columns, "nobody reads this" is
 * not a fact software can establish. It is `human_only`, it is planned and
 * shown, and it is the one step whose absence does not block the ladder. See
 * `EXECUTOR_CAPABILITY` and `OPTIONAL_TERMINAL_STEPS` in ./step.ts.
 *
 * The middle state still matters and is still reachable: a future step kind
 * arrives unimplemented, and a ladder containing it must not run.
 *
 * The alternative — emitting placeholder verbs so the ladder looks complete —
 * is exactly how `schema_not_registered` shipped pointing at
 * `REGISTER_POSTGREST_SCHEMA`, a verb that never existed, and dead-ended every
 * approval that reached it.
 *
 * ── Deliberately not persisted yet ──────────────────────────────────────────
 *
 * No Prisma model. The roadmap makes the RDS rehearsal a hard gate on new
 * production persistence, and a planner does not need storage to be correct: a
 * plan is a pure function of a diagnosis and a catalog fingerprint. Phase 6
 * introduces the ledger, behind that gate, when there is something to execute.
 */

import { createHash } from 'node:crypto'
import type { StructuralDiagnosis } from '../hypothesis/structural'
import {
  EXECUTOR_CAPABILITY,
  OPTIONAL_TERMINAL_STEPS,
  classifyMaintenanceStep,
  requiresRollbackSpec,
  type MaintenanceStep,
  type MaintenanceStepKind,
} from './step'
import { rollbackRefusal } from './rollback-capability'

export type PlanValidity = 'executable' | 'blocked_by_capability' | 'invalid'

export interface MaintenancePlan {
  findingId: string
  planId: string
  /**
   * Changes whenever the ladder or the catalog it was built against changes.
   *
   * Authorization-sensitive: an approval granted for version N never authorizes
   * N+1. Derived from content rather than a counter so two planners cannot
   * disagree about which version they produced.
   */
  planVersion: string
  diagnosis: {
    hypothesis: string
    verdict: StructuralDiagnosis['kind']
    confidence?: number
    /** Which probe decided it, and what the instruments could see. */
    provenance: string[]
    coverage: StructuralDiagnosis['coverage']
  }
  subsystem: { fingerprint: string; membership: string[] }
  steps: MaintenanceStep[]
  validity: PlanValidity
  /** Why it is not executable. Empty only when validity is 'executable'. */
  blockedReasons: string[]
  /**
   * Steps a person must perform. Reported, never a reason to block.
   *
   * Separate from `blockedReasons` because they are different facts: one is
   * "waiting for a tool to be built", the other is "this will always need a
   * human". Folding them together would make the ladder look perpetually
   * unfinished when it is simply finished at a different boundary.
   */
  humanOnlySteps: string[]
  /** Live-schema identity at planning time. A mismatch means stale. */
  catalogFingerprint: string
  createdAt: string
}

export interface PlanInput {
  findingId: string
  diagnosis: StructuralDiagnosis
  subsystem: { fingerprint: string; membership: string[] }
  /** Derived from the live catalog by the caller. */
  catalogFingerprint: string
}

// ── Ladders ──────────────────────────────────────────────────────────────────

type StepSeed = Omit<MaintenanceStep, 'ordinal' | 'idempotencyKey'>

/**
 * The ladder for each hypothesis this platform can actually confirm.
 *
 * `split_brain_writers` has no entry on purpose: Phase 4 can raise it and never
 * confirm it, so there is no diagnosis strong enough to plan from. A ladder here
 * would be a remedy for a suspicion.
 */
function ladderFor(
  hypothesis: string,
  subsystem: { membership: string[] },
): StepSeed[] | null {
  const table = subsystem.membership[0] ?? 'unknown'

  switch (hypothesis) {
    /**
     * The canonical expand/contract case. The original column is never
     * destructively touched during expand, which is what makes every rung
     * reversible by dropping what it added.
     */
    case 'duplicated_lifecycle_state':
      return [
        {
          kind: 'add_structure',
          action: 'ADD_COLUMN',
          params: { tableName: table, purpose: 'consolidated lifecycle column' },
          preconditions: ['target column does not already exist'],
          expectedPostconditions: ['target column exists and is nullable'],
          rollbackSpec: { strategy: 'drop_column', description: 'Drop the added column.' },
        },
        {
          // Before dual_write, so the catalog never rests with an unconstrained
          // state column. That is not tidiness: the structural diagnosis reads
          // the live catalog, an unconstrained state column raises
          // missing_constraint_permits_invalid_state, and a ladder that halts
          // for a backfill then could not be resumed, because its own expand
          // rung had changed the diagnosis underneath it.
          //
          // It is also when validation is cheapest — the target is entirely
          // NULL until the backfill, and NULL satisfies a CHECK.
          kind: 'carry_constraints',
          action: 'ADD_CONSTRAINT',
          params: { tableName: table, purpose: "the source column's domain under the transform" },
          preconditions: ['target column exists', 'source column declares an enumerable domain'],
          expectedPostconditions: ['target column is constrained to the transformed source domain'],
          rollbackSpec: { strategy: 'drop_constraint', description: 'Drop the added constraint.' },
        },
        {
          kind: 'dual_write',
          action: null,
          params: { tableName: table },
          preconditions: ['target column exists', 'trigger body cannot abort the caller'],
          expectedPostconditions: ['writes to the legacy column also populate the target'],
          rollbackSpec: { strategy: 'drop_trigger', description: 'Drop the dual-write trigger.' },
        },
        {
          kind: 'backfill',
          action: null,
          params: { tableName: table, batched: true, resumable: true },
          preconditions: ['dual-write installed', 'no unreconciled mismatches'],
          expectedPostconditions: ['every pre-existing row has a target value'],
          rollbackSpec: {
            strategy: 'drop_column',
            description:
              'Drop the target column. The source is untouched by expand, so there is nothing ' +
              'to restore and no checkpoint to depend on.',
          },
        },
        {
          kind: 'verify',
          action: null,
          params: { tableName: table },
          preconditions: ['backfill complete'],
          expectedPostconditions: ['source and target agree under the declared transform'],
          rollbackSpec: { strategy: 'none_required', description: 'Read-only.' },
        },
        {
          kind: 'switch_readers',
          action: null,
          params: { tableName: table },
          preconditions: ['reconciliation demonstrated consistency'],
          expectedPostconditions: ['controllable readers use the target column'],
          rollbackSpec: {
            strategy: 'restore_reader_config',
            description: 'Point readers back at the legacy column.',
          },
        },
        {
          kind: 'contract',
          action: null,
          params: { tableName: table },
          preconditions: ['observation window clean', 'no uncontrollable consumer'],
          expectedPostconditions: ['legacy column removed'],
          // Irreversible by definition, which is why it is a separate approval.
          rollbackSpec: null,
        },
      ]

    case 'missing_constraint_permits_invalid_state':
      return [
        {
          kind: 'add_structure',
          action: 'ADD_COLUMN',
          params: { tableName: table, purpose: 'constraint, added NOT VALID' },
          preconditions: ['constraint does not already exist'],
          expectedPostconditions: ['constraint exists, not yet validated'],
          rollbackSpec: { strategy: 'drop_constraint', description: 'Drop the constraint.' },
        },
        {
          kind: 'verify',
          action: null,
          params: { tableName: table },
          preconditions: ['constraint exists'],
          expectedPostconditions: ['existing rows satisfy it, or the violators are named'],
          rollbackSpec: { strategy: 'none_required', description: 'Read-only.' },
        },
      ]

    case 'policy_fragmentation':
      return [
        {
          kind: 'add_structure',
          action: 'SET_PERMISSION',
          params: { tableName: table, purpose: 'single consolidated policy' },
          preconditions: ['consolidated policy does not already exist'],
          expectedPostconditions: ['one policy covers the command'],
          rollbackSpec: {
            strategy: 'restore_policies',
            description:
              'Restore the exact policy set that existed before consolidation. NOT a drop: ' +
              'consolidation replaced the fragments, so removing the result would leave the ' +
              'table with no row security at all.',
          },
        },
        {
          kind: 'verify',
          action: null,
          params: { tableName: table },
          preconditions: ['consolidated policy exists'],
          expectedPostconditions: ['access decisions unchanged for every tested role'],
          rollbackSpec: { strategy: 'none_required', description: 'Read-only.' },
        },
        {
          kind: 'contract',
          action: null,
          params: { tableName: table },
          preconditions: ['verification passed'],
          expectedPostconditions: ['superseded policies removed'],
          rollbackSpec: null,
        },
      ]

    default:
      return null
  }
}

// ── Planning ─────────────────────────────────────────────────────────────────

function stableHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)
}

/**
 * Build a plan, or explain why there is none.
 *
 * Always returns a plan object. A refusal carries its reasons rather than being
 * a null, because "we looked and declined" and "nothing ran" are different
 * facts and the second is not worth recording.
 */
export function buildMaintenancePlan(input: PlanInput): MaintenancePlan {
  const { findingId, diagnosis, subsystem, catalogFingerprint } = input
  const blockedReasons: string[] = []

  const provenance: string[] = [
    `verdict=${diagnosis.kind}`,
    ...diagnosis.report.observations.map(o => `${o.testId}=${o.outcome}`),
    ...diagnosis.blockedBy.map(b => `${b.test}=unavailable(${b.reason})`),
    // Raised, never concluded on, and no longer able to veto a confirmed
    // leader — so it has to travel with the plan as a standing caveat. A
    // possibility the platform cannot settle is still a possibility, and the
    // person reading this plan is the one who can settle it.
    ...diagnosis.raisedOnly.map(id => `${id}=raised-but-unconfirmable`),
  ]

  const hypothesis = diagnosis.hypothesis?.id ?? '(none)'

  const base = {
    findingId,
    planId: stableHash([findingId, subsystem.membership]),
    diagnosis: {
      hypothesis,
      verdict: diagnosis.kind,
      confidence: diagnosis.confidence,
      provenance,
      coverage: diagnosis.coverage,
    },
    subsystem,
    catalogFingerprint,
    createdAt: new Date().toISOString(),
  }

  const invalid = (reasons: string[]): MaintenancePlan => ({
    ...base,
    planVersion: stableHash([base.planId, 'invalid', reasons]),
    steps: [],
    validity: 'invalid',
    blockedReasons: reasons,
    humanOnlySteps: [],
  })

  /**
   * The ladder is sound and this deployment cannot safely run it.
   *
   * `blocked_by_capability`, not `invalid`: nothing is wrong with the plan,
   * and nothing a human approves can make a missing executor exist. Steps are
   * carried so the surface can show WHAT it would have done, which is the
   * difference between "Backenly cannot do this yet" and a blank refusal.
   */
  const blockedByCapability = (reasons: string[]): MaintenancePlan => ({
    ...base,
    planVersion: stableHash([base.planId, 'blocked_by_capability', reasons]),
    steps: [],
    validity: 'blocked_by_capability',
    blockedReasons: reasons,
    humanOnlySteps: [],
  })

  // ── 1. The diagnosis must be decision-quality ──────────────────────────────
  //
  // Planning is NOT evidence. A ladder existing must never raise confidence in
  // the diagnosis that produced it, so the gate is applied before any ladder is
  // constructed rather than as a property of one.
  if (diagnosis.kind !== 'structural_cause_identified') {
    // The diagnosis's own reason travels with the verdict. Without it the
    // refusal names the gate but not the cause, and the only way to learn why
    // a plan will not build is to rebuild the runner image and ask again.
    return invalid([
      `diagnosis is ${diagnosis.kind}; only a confirmed structural cause may be planned from`,
      `diagnosis reason: ${diagnosis.reason}`,
      ...(diagnosis.blockedBy.length > 0
        ? [`deciding probes unavailable: ${diagnosis.blockedBy.map(b => `${b.test}(${b.reason})`).join('; ')}`]
        : []),
    ])
  }

  // A hypothesis whose deciding probe never ran was neither supported nor
  // refuted, whatever the engine concluded.
  if (diagnosis.blockedBy.some(b => b.hypothesis === hypothesis)) {
    const b = diagnosis.blockedBy.find(x => x.hypothesis === hypothesis)!
    return invalid([`the probe that decides "${hypothesis}" did not run: ${b.test} (${b.reason})`])
  }

  // Raised-only hypotheses have no ladder at all — see ladderFor.
  const seeds = ladderFor(hypothesis, subsystem)
  if (!seeds || seeds.length === 0) {
    return invalid([`no maintenance ladder is defined for "${hypothesis}"`])
  }

  // ── 2. Every non-contract step must describe a real rollback ───────────────
  //
  // Rejected outright, not routed to approval. "Approve this irreversible
  // change" is a question the owner has no good way to answer, and asking it
  // hands back a risk the planner existed to remove.
  const missingRollback = seeds.filter(s => requiresRollbackSpec(s.kind) && !s.rollbackSpec)
  if (missingRollback.length > 0) {
    return invalid([
      `steps without a rollback: ${missingRollback.map(s => s.kind).join(', ')}`,
    ])
  }

  // And a description is not a capability.
  //
  // This check used to end one line above, which treated the presence of a
  // sentence as proof of an ability. Two of the four operations the old
  // `drop_object` strategy covered had no executor at all, so ladders were
  // planned, approved and executed on the strength of a recovery that did not
  // exist. The registry is the authority now: a rung is recoverable when the
  // deployed executor can perform its exact rollback kind, and not before.
  const unrecoverable = seeds
    .filter(s => requiresRollbackSpec(s.kind) && s.rollbackSpec)
    .map(s => ({ kind: s.kind, refusal: rollbackRefusal(s.rollbackSpec!.strategy) }))
    .filter(x => x.refusal !== null)
  if (unrecoverable.length > 0) {
    // `blocked_by_capability`, deliberately NOT something a human can approve.
    // Nobody's consent makes a missing executor exist, so this must never
    // surface as work waiting on the owner.
    return blockedByCapability(
      unrecoverable.map(x => `${x.kind} cannot be scheduled because ${x.refusal}`),
    )
  }

  const steps: MaintenanceStep[] = seeds.map((s, i) => ({
    ...s,
    ordinal: i,
    idempotencyKey: stableHash([base.planId, i, s.kind, s.params]),
  }))

  // ── 3. Capability — a plan may be right and still not runnable ─────────────
  //
  // `contract` is the one step whose absence does not block: the ladder is
  // complete and safe once readers have moved and held, and the legacy column
  // simply stays. It is still planned, still shown, and still requires a person
  // — it just does not make everything before it unrunnable. See
  // OPTIONAL_TERMINAL_STEPS in ./step.ts for why that exception is exactly one
  // step wide.
  const humanOnly: string[] = []
  for (const step of steps) {
    const c = classifyMaintenanceStep(step)
    if (c.executable) continue
    const line = `${step.kind}: ${EXECUTOR_CAPABILITY[step.kind]} — ${c.reason}`
    if (OPTIONAL_TERMINAL_STEPS.includes(step.kind)) humanOnly.push(line)
    else blockedReasons.push(line)
  }

  const planVersion = stableHash([
    base.planId,
    catalogFingerprint,
    steps.map(s => [s.kind, s.action, s.params, s.idempotencyKey]),
    // What the executor could do when this plan was built.
    //
    // Without this, a plan built while `dual_write` was `not_implemented` keeps
    // its version when the primitive lands, and an approval granted against a
    // ladder that could not run silently becomes consent for one that can.
    // Including it re-versions every plan the moment the capability table moves,
    // which is what "they are re-planned into a new planVersion" means in
    // ./step.ts — enforced here rather than left as an instruction.
    //
    // Steps whose kind does not appear in the plan are included too: the table
    // is a property of the executor, not of this ladder.
    Object.entries(EXECUTOR_CAPABILITY).sort(([a], [b]) => a.localeCompare(b)),
  ])

  return {
    ...base,
    planVersion,
    steps,
    validity: blockedReasons.length > 0 ? 'blocked_by_capability' : 'executable',
    blockedReasons,
    humanOnlySteps: humanOnly,
  }
}

/**
 * Has the live schema moved since this plan was built?
 *
 * A structurally stale ladder must never execute. Its preconditions were
 * computed against a schema that no longer exists, and on this platform that is
 * not a rare case: READ_WRITE connection strings mean DDL arrives from psql with
 * no Backenly event at all.
 */
export function isPlanStale(plan: MaintenancePlan, currentCatalogFingerprint: string): boolean {
  return plan.catalogFingerprint !== currentCatalogFingerprint
}

/**
 * Does an approval still authorize this plan?
 *
 * Bound to `planVersion`, so any re-plan invalidates prior consent. An owner who
 * approved a six-step ladder did not approve a different six-step ladder that
 * happens to share a finding.
 */
export function approvalStillValid(plan: MaintenancePlan, approvedVersion: string): boolean {
  return plan.planVersion === approvedVersion
}

/**
 * The prefix of a ladder whose steps the executor could run today.
 *
 * Exported for REPORTING only. Phase 6 must never execute it: a ladder is
 * all-or-nothing, and running the supported prefix of an expand/contract
 * sequence leaves a half-migrated schema with a new column nothing fills and a
 * dual-write that was never installed. `executablePrefix().length` is a
 * diagnostic, never a permission.
 */
export function executablePrefix(plan: MaintenancePlan): MaintenanceStep[] {
  const out: MaintenanceStep[] = []
  for (const s of plan.steps) {
    if (!classifyMaintenanceStep(s).executable) break
    out.push(s)
  }
  return out
}
