/**
 * CAN THIS BE UNDONE? — the registry, not the description
 * ========================================================
 *
 * A `rollbackSpec` is a sentence. It says what undoing a rung WOULD mean. The
 * planner was treating the presence of that sentence as proof the system could
 * perform it:
 *
 *     const missingRollback = seeds.filter(s => requiresRollbackSpec(s.kind) && !s.rollbackSpec)
 *
 * So a plan was "rollbackable" when every rung carried a description. Nothing
 * asked whether the deployed executor could actually execute any of them, and
 * the answer for two of them was no.
 *
 * ── What `drop_object` was hiding ──────────────────────────────────────────
 *
 * One strategy name covered four materially different operations, which is
 * exactly what let the overclaim through unnoticed:
 *
 *     drop_object(column)      DROP_COLUMN exists                  executable
 *     drop_object(trigger)     removeDualWrite exists              executable
 *     drop_object(constraint)  NO verb exists at all               not
 *     drop_object(policy)      REMOVE_PERMISSION exists, and is
 *                              not the inverse of anything         not
 *
 * The policy case is the one worth reading twice. `REMOVE_PERMISSION` takes a
 * table name and removes EVERY policy on it. The forward step consolidates a
 * fragmented policy set into one, so "drop the consolidated policy" would
 * leave the table with no row security at all. That is not an imperfect
 * recovery, it is a security incident wearing a recovery's name. The real
 * inverse is restoring the exact previous set, which needs the pre-mutation
 * policies captured before the forward step runs — so it is its own strategy,
 * `restore_policies`, and it is honestly unsupported today.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * Capability is what the system can prove and execute today, not what its
 * types suggest it ought to be able to do. A ladder whose recovery is
 * fictional is more dangerous than no ladder, because the fiction is what the
 * tier system, the approval flow and the operator are all relying on.
 *
 * Consequence, accepted deliberately: every ladder the planner currently emits
 * has at least one rung whose rollback is unsupported, so none of them is
 * schedulable until the executors below are real. Less autonomy with truthful
 * guarantees beats broader autonomy backed by recovery that does not exist.
 */

export type RollbackStrategy =
  /** Drop a column this ladder added. `DROP_COLUMN` on the governed executor. */
  | 'drop_column'
  /** Drop the dual-write trigger this ladder installed. `removeDualWrite`. */
  | 'drop_trigger'
  /** Drop a CHECK constraint this ladder added. No verb exists yet. */
  | 'drop_constraint'
  /** Point rewritten readers back at the legacy column. `revertReaders`. */
  | 'restore_reader_config'
  /**
   * Put back the exact policy set that existed before consolidation.
   *
   * NOT "remove the policy that was added". Consolidation replaces the
   * fragments, so removing the result leaves nothing behind.
   */
  | 'restore_policies'
  /** The rung mutated nothing. A read-only step needs no undo. */
  | 'none_required'

export type RollbackCapability = 'implemented' | 'not_implemented'

/**
 * The single source of truth for what recovery this deployment can perform.
 *
 * Mirrors `EXECUTOR_CAPABILITY` in `step.ts`, which answers the same question
 * for the forward direction. Two registries rather than one because a rung can
 * be perfectly executable and not undoable, and conflating them is how the
 * ladder came to promise a recovery it did not have.
 */
export const ROLLBACK_CAPABILITY: Readonly<Record<RollbackStrategy, RollbackCapability>> = {
  // Read-only rungs. Nothing to undo, so nothing to implement.
  none_required: 'implemented',

  // `DROP_COLUMN` on the governed executor. The expand/contract insight makes
  // this sufficient: expand never destructively mutates the source column, so
  // undoing a backfill means dropping the structure it filled rather than
  // reconstructing anything from a checkpoint.
  drop_column: 'implemented',

  // `primitives/dual-write.ts removeDualWrite`, which drops the trigger and
  // leaves the fault table for inspection.
  drop_trigger: 'implemented',

  // `primitives/switch-readers.ts revertReaders`, which restores each
  // function's exact previous source.
  restore_reader_config: 'implemented',

  // ── Not implemented, and the ladders that need them are refused ──────────

  // There is no DROP_CONSTRAINT action. `ADD_CONSTRAINT` exists, its inverse
  // does not, and `DROP_INDEX` explicitly refuses constraint-backed indexes.
  //
  // When this is built it should be a recovery-only primitive bound to the
  // exact constraint created by one step execution, with the stale-state
  // fingerprint still required, rather than a general destructive verb any
  // caller can reach. A broadly available DROP_CONSTRAINT deserves its own
  // tier and approval review; it should not arrive as a side effect of
  // building a recovery path.
  drop_constraint: 'not_implemented',

  // Needs the pre-mutation policy set captured BEFORE the forward step, which
  // nothing in the maintenance path does today. `capturePreFixState` already
  // does exactly this for the auto-fix path (`PreFixMetadata.prePolicies`), so
  // the shape is known; it is the capture and the restore that are missing.
  restore_policies: 'not_implemented',
}

export function canRollback(strategy: RollbackStrategy): boolean {
  return ROLLBACK_CAPABILITY[strategy] === 'implemented'
}

/** Every strategy the vocabulary defines. Enumerated, never regexed. */
export const ROLLBACK_STRATEGIES = Object.keys(ROLLBACK_CAPABILITY) as RollbackStrategy[]

/**
 * Why this rung cannot be undone, in words an operator can act on, or null
 * when it can.
 *
 * Returned rather than thrown: an unsupported recovery is a legitimate answer
 * the planner has to be able to print, not an error condition.
 */
export function rollbackRefusal(strategy: RollbackStrategy): string | null {
  if (canRollback(strategy)) return null
  switch (strategy) {
    case 'drop_constraint':
      return 'its rollback would drop a constraint, and this deployment has no executor that can drop one'
    case 'restore_policies':
      return 'its rollback would restore the previous policy set, which this deployment cannot yet capture or replay'
    default:
      return `its rollback strategy ${strategy} is not implemented in this deployment`
  }
}
