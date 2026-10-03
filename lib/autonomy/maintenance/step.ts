/**
 * MAINTENANCE STEP — one decision function, called twice
 * ======================================================
 *
 * `classifyMaintenanceStep` is the ONLY place that decides a maintenance step's
 * tier and whether the executor can run it. Phase 5 calls it while planning;
 * Phase 6 will call the same function immediately before mutating. Two copies
 * would drift, and the drift is invisible until a planner promises Tier 1 and an
 * executor performs something else.
 *
 * ── Why `classifyFix` is not reused ─────────────────────────────────────────
 *
 * `lib/core/fix-classifier.ts` classifies FINDINGS by type. Maintenance steps
 * are not findings, none of their verbs are registered there, and the spike
 * (docs/structural-probe-inventory.md's sibling work) found that `ADD_COLUMN`,
 * `RUN_DATA_MIGRATION` and `SYNC_COLUMN` have no entry in it at all. Forcing
 * them through it would mean inventing finding types to carry migration steps.
 *
 * ── Capability is a fact about the executor, not a wish ─────────────────────
 *
 * The executor capability spike found that three of the six step kinds had no
 * implementation at all:
 *
 *   ADD_COLUMN               real verb, real handler
 *   CREATE_TRIGGER           writes an AppTrigger row — event automation, NOT
 *                            a database trigger. Unusable for dual-write.
 *   RUN_DATA_MIGRATION       has a `backfill` op, but it is explicitly atomic:
 *                            one transaction, no batching, no BackgroundJob
 *                            integration. Wrong shape for a large live table.
 *   reconciliation           did not exist in any form.
 *
 * Recording that as `not_implemented` was the honest alternative to pointing at
 * a placeholder verb — which is precisely how `schema_not_registered` shipped
 * referencing `REGISTER_POSTGREST_SCHEMA`, a verb that never existed.
 *
 * Phase 6b built the missing three, under `./primitives/`, none of them by
 * reusing the verbs above. Two consequences follow, and both are enforced
 * rather than documented: the capability table is part of `planVersion`, so a
 * plan approved while blocked does not become executable by this file changing;
 * and the tiers below did not move, so the primitives existing is not the same
 * event as them being permitted to run.
 */

import type { RollbackStrategy } from './rollback-capability'
import type { AutonomyTier } from '../desired-state'

export type MaintenanceStepKind =
  | 'add_structure'
  | 'carry_constraints'
  | 'dual_write'
  | 'backfill'
  | 'verify'
  | 'switch_readers'
  | 'contract'

export type ExecutorCapability =
  /** A real executor verb with a real handler, usable as-is. */
  | 'implemented'
  /** No primitive exists. Phase 6 must build one. */
  | 'not_implemented'
  /** A primitive exists but its semantics are wrong for maintenance. */
  | 'not_implemented_for_maintenance'
  /** Deliberately deferred — a later phase owns it. */
  | 'future_phase_7'
  /**
   * Built as far as software can take it, and finished by a person.
   *
   * Not a missing primitive: `contract` drops the legacy column, and doing that
   * safely requires knowing nobody reads it. On a platform that hands out
   * connection strings and serves PostgREST clients that pick their own columns,
   * that is not a fact software can establish — see ../readers.ts. So the step
   * exists, is planned, and is never executed by the executor.
   */
  | 'human_only'

/**
 * What the executor can actually do today, per step kind.
 *
 * This table is the spike's output, not an aspiration. When Phase 6 lands a
 * bounded dual-write primitive, a resumable backfill and an independent
 * reconciliation, entries flip to `implemented` — and plans generated before
 * that must NOT silently become executable. They are re-planned into a new
 * `planVersion`, because an approval granted against a plan that could not run
 * is not consent for one that can.
 */
export const EXECUTOR_CAPABILITY: Readonly<Record<MaintenanceStepKind, ExecutorCapability>> = {
  // ADD_COLUMN / ADD CONSTRAINT / CREATE POLICY all route through executeAction.
  add_structure: 'implemented',
  // `primitives/carry-constraints.ts`. Derives the target's domain by applying
  // the transform to the source's declared domain and refuses unless the
  // binding says the same thing. Without it `contract` drops a constrained
  // column and leaves an unconstrained one.
  carry_constraints: 'implemented',
  // Phase 6b. `primitives/dual-write.ts` installs a real BEFORE trigger with a
  // generated body over the closed transform vocabulary, replacing the
  // AppTrigger surface that was never a database trigger at all.
  dual_write: 'implemented',
  // Phase 6b. `primitives/backfill.ts` is batched and resumable, with a
  // transaction-local lock timeout, and leaves retries to BackgroundJob —
  // the three properties RUN_DATA_MIGRATION's atomic backfill does not have.
  backfill: 'implemented',
  // Phase 6b. `primitives/verify.ts` over reconcile.ts, which does compare a
  // source column against a target one under a transform. lib/verification/*
  // still cannot, and is still not what this uses.
  verify: 'implemented',
  // Phase 7. `primitives/switch-readers.ts` moves the readers Backenly wrote and
  // refuses to guess at the rest; ../readers.ts names the consumer classes that
  // cannot be enumerated at all, which is why a switch is never "complete".
  switch_readers: 'implemented',
  // Not deferred — finished by a person, permanently. See `human_only`.
  contract: 'human_only',
}

/**
 * Steps a ladder may end without, and still be worth running.
 *
 * Only `contract`. Expand/contract is complete and safe the moment readers have
 * moved and held: the legacy column simply stays. Dropping it is an
 * optimisation, and one whose precondition ("nobody reads this") this platform
 * cannot establish.
 *
 * Which makes it the single exception to all-or-nothing. Without it the ladder
 * would be permanently `blocked_by_capability` and Phase 6b could never run end
 * to end — the capability table would be describing a plan nobody can execute
 * rather than one waiting on a tool.
 */
export const OPTIONAL_TERMINAL_STEPS: readonly MaintenanceStepKind[] = ['contract']

export interface MaintenanceStep {
  ordinal: number
  kind: MaintenanceStepKind
  /** Executor verb, when one exists. Null when capability is not implemented. */
  action: string | null
  params: Record<string, unknown>
  /**
   * Stable across re-planning of the same logical step, so an executor that
   * crashed mid-ladder cannot apply it twice.
   */
  idempotencyKey: string
  /** Must hold before the step runs. Re-checked at execution time, not trusted. */
  preconditions: string[]
  /** Must hold after. The named check a verify step will assert. */
  expectedPostconditions: string[]
  /**
   * How to undo this step. Null is permitted ONLY for `contract`, which is
   * irreversible by definition and is why it is a separate approval.
   */
  rollbackSpec: RollbackSpec | null
}

export interface RollbackSpec {
  /**
   * What undoing this rung actually means, named precisely enough that the
   * capability registry can answer whether it is executable.
   *
   * `drop_object` used to stand here and covered four different operations —
   * dropping a column, a trigger, a constraint or a policy. Two of those have
   * no executor, and one of them (policy) has a verb that removes EVERY policy
   * on the table rather than the one that was added. The shared name is what
   * let the planner treat all four as equally recoverable.
   *
   * Note that dropping the column a backfill filled is `drop_column` like any
   * other. That is the expand/contract insight: expand never destructively
   * mutates the source, so undoing a backfill means dropping the structure it
   * filled rather than reconstructing anything from a checkpoint — which
   * matters because `rollbackDataMigration`'s checkpoint is `CREATE TABLE AS`
   * and restores rows and types but NOT constraints, indexes or defaults.
   *
   * Whether any of these can actually run is `ROLLBACK_CAPABILITY`'s question,
   * never this type's. A spec is a description; capability is a fact about the
   * deployed executor.
   */
  strategy: RollbackStrategy
  description: string
}

export interface StepClassification {
  tier: AutonomyTier
  /** Whether the executor can run this step AT ALL, today. */
  executable: boolean
  capability: ExecutorCapability
  reason: string
}

/**
 * The single decision point for a maintenance step.
 *
 * Tier here is about blast radius, and it is deliberately NOT derived from
 * whether a step is additive to the SCHEMA. `dual_write` adds no column and is
 * the most dangerous step in the ladder: a trigger that raises aborts the
 * caller's write, and one that succeeds with a wrong value diverges the two
 * structures silently.
 */
export function classifyMaintenanceStep(step: {
  kind: MaintenanceStepKind
  rollbackSpec?: RollbackSpec | null
}): StepClassification {
  const capability = EXECUTOR_CAPABILITY[step.kind]
  const executable = capability === 'implemented'

  switch (step.kind) {
    case 'add_structure':
      return {
        tier: 1,
        executable,
        capability,
        reason:
          'Adds a column, constraint or policy. Additive, snapshotted, and reversible by ' +
          'dropping what was added.',
      }

    case 'carry_constraints':
      return {
        // Tier 2, for dual_write's reason rather than add_structure's. A CHECK
        // is additive to the SCHEMA and restrictive to BEHAVIOUR: once it
        // exists, a write the customer's application used to make is rejected.
        // Adding it also takes ACCESS EXCLUSIVE and validates the table.
        tier: 2,
        executable,
        capability,
        reason:
          'Constrains a column to the source domain under the declared transform. ' +
          'Schema-additive and behaviour-restricting, and only the second one decides this tier.',
      }

    case 'verify':
      return {
        tier: 0,
        executable,
        capability,
        reason: 'Reads and compares. Changes nothing.',
      }

    case 'backfill':
      return {
        tier: 2,
        executable,
        capability,
        reason:
          'Writes to every row of a live table. Additive in schema terms and emphatically not ' +
          'additive in cost: it must be batched, resumable, and abort on lock wait.',
      }

    case 'dual_write':
      return {
        // Tier 2 regardless of capability. A trigger is not additive to
        // BEHAVIOUR: it runs inside the caller's transaction, and a failure
        // there aborts a write the customer's application made.
        tier: 2,
        executable,
        capability,
        reason:
          'Installs a trigger that runs inside the caller\'s transaction. Schema-additive and ' +
          'behaviour-changing, which are different properties, and only the second one decides ' +
          'this tier.',
      }

    case 'switch_readers':
      return {
        tier: 2,
        executable,
        capability,
        reason: 'Moves readers to the new structure. One approval, and never bundled with contract.',
      }

    case 'contract':
      return {
        // Irreversible. No dial may auto-apply it at any level.
        tier: 3,
        executable,
        capability,
        reason:
          'Drops the legacy structure. Irreversible, always a separate approval, and permanently ' +
          'human-gated when any consumer is outside Backenly\'s control.',
      }
  }
}

/**
 * Every step except `contract` must describe a real rollback.
 *
 * A ladder that cannot be undone is rejected outright rather than routed to
 * approval. "Approve this irreversible change" is a question the owner has no
 * good way to answer, and asking it transfers a risk the planner was supposed
 * to eliminate.
 */
export function requiresRollbackSpec(kind: MaintenanceStepKind): boolean {
  return kind !== 'contract'
}
