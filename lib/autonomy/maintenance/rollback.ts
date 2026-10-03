/**
 * ROLLBACK — undo exactly what this execution did, or refuse
 * ===========================================================
 *
 * `rollbackSpec` was defined on every rung, validated by the planner, and
 * persisted to the ledger. No code path had ever performed one. The planner
 * even rejected plans for lacking a rollback the system could not have
 * executed if it had one.
 *
 * ── The authority is the execution record, never the plan ──────────────────
 *
 * The plan says what KIND of work should happen. It does not say what
 * happened, and it does not even name the column — that arrives in the
 * approval's bindings. So "undo this ladder's drop_column" is not a resolvable
 * instruction. Rollback loads one `maintenance_step_executions` row and acts
 * only on what that row observed.
 *
 * ── The invariant ──────────────────────────────────────────────────────────
 *
 *   Backenly may only undo a state it can prove is still the state produced
 *   by that exact execution.
 *
 * This is the new danger recovery introduces. Without it:
 *
 *     Backenly adds column X -> somebody legitimately drops and recreates X
 *     -> Backenly later "undoes" its own work and destroys the replacement
 *
 * So the current state is observed and compared against `observedPostState`
 * before anything is undone, and a mismatch stops rather than overwrites.
 *
 * ── Only positive failure makes a rollback eligible ────────────────────────
 *
 * A forward verifier that THREW proves nothing about the mutation, and
 * undoing a good change because the observer went blind is the same error as
 * recording a bad one because it went blind. `verification_error` freezes and
 * re-observes; it never enters this machine. See `lib/core/fix-verification.ts`.
 *
 * ── Three-valued, like everything else here ────────────────────────────────
 *
 * An inverse statement returning without error is not proof the prior state
 * is back. The verifier re-observes and can say confirmed, contradicted, or
 * could-not-tell, and only the first is `verified`.
 */

import { prisma } from '@/lib/db'
import { withMaintenanceSingleFlight } from './single-flight'
import {
  observeResource,
  stateMatches,
  describeDrift,
  type ResourceIdentity,
  type ResourceState,
} from './resource-state'
import { canRollback, rollbackContract, type RollbackStrategy } from './rollback-capability'
import { P, principalsToMetadata } from '@/lib/principal'

export type RollbackStatus =
  /** A positive forward failure made this undoable. Nothing has run. */
  | 'eligible'
  /** This process owns the rollback. Set by compare-and-set. */
  | 'started'
  /** The inverse ran and re-observation confirmed the prior state. */
  | 'verified'
  /** The inverse threw, or re-observation contradicted the prior state. */
  | 'failed'
  /** The inverse ran and the verifier could not tell. NEVER "restored". */
  | 'unverified'
  /** The resource is no longer what this execution left. Nothing was touched. */
  | 'blocked_stale'

export interface RollbackOutcome {
  stepExecutionId: string
  status: RollbackStatus
  detail: string
}

/**
 * Mark a step rollback-eligible after a POSITIVE forward failure.
 *
 * Separate from performing it, and deliberately the only door in: a caller
 * cannot jump straight to `started`, so "what made this eligible" is always a
 * recorded transition rather than an assumption.
 */
export async function markRollbackEligible(
  stepExecutionId: string,
  reason: string,
): Promise<boolean> {
  const n = await prisma.maintenanceStepExecution.updateMany({
    // Only from "never considered". A step already in the machine is owned by
    // whoever put it there.
    where: { id: stepExecutionId, rollbackStatus: null },
    data: { rollbackStatus: 'eligible', rollbackDetail: reason },
  })
  return n.count === 1
}

/**
 * Persist a terminal transition.
 *
 * `performed` says whether THIS call ran the inverse. Only a call that did
 * gets an audit row, and that distinction is the whole point: a later caller
 * observing that the prior state is already back is reporting the current
 * state of the world, not a second recovery action. Counting it would inflate
 * the rollback figure on the trust scoreboard with reads.
 */
async function settle(
  projectId: string,
  stepExecutionId: string,
  status: RollbackStatus,
  detail: string,
  performed = false,
): Promise<RollbackOutcome> {
  await prisma.maintenanceStepExecution.update({
    where: { id: stepExecutionId },
    data: { rollbackStatus: status, rollbackDetail: detail, rollbackAt: new Date() },
  })
  if (performed) {
    await prisma.auditLog
      .create({
        data: {
          projectId,
          action: 'MAINTENANCE_ROLLBACK_PERFORMED',
          type: 'autonomy',
          details: JSON.stringify({ stepExecutionId, status, detail, at: new Date().toISOString() }),
          // The maintenance loop both requests and performs a rollback; the
          // authority for it came from the approval that permitted the forward
          // step, which this row does not resolve, so it stays null rather than
          // being attributed to whoever happens to be nearby.
          metadata: principalsToMetadata({
            requestedBy: P.maintenance(),
            executedBy: P.maintenance(),
            authorizedBy: null,
          }) as any,
          timestamp: new Date(),
        },
      })
      .catch(() => {})
  }
  return { stepExecutionId, status, detail }
}

/**
 * What a strategy needs in order to undo itself, and how to check it worked.
 *
 * One entry per executable strategy. A strategy the registry calls
 * unsupported has none, and `performRollback` refuses before reaching here —
 * so this table can never quietly become the thing that decides capability.
 */
type Inverse = (args: {
  projectId: string
  identity: ResourceIdentity
  preState: ResourceState
  /**
   * The forward step's recorded result.
   *
   * `restore_reader_config` needs the BYTES it replaced, and the observed
   * states hold hashes - those exist to decide whether the resource is still
   * ours, which is a different job from putting it back. Regenerating
   * "equivalent" code would not be a restoration.
   */
  result: unknown
}) => Promise<void>

const INVERSES: Partial<Record<RollbackStrategy, Inverse>> = {
  drop_column: async ({ projectId, identity }) => {
    if (identity.kind !== 'column') throw new Error('drop_column needs a column identity')
    // NOT the general DROP_COLUMN verb. That one is approval-required and
    // answers APPROVAL_REQUIRED here, which is the executor behaving exactly
    // as designed: dropping a column somebody asked about is destructive and
    // a robot should not do it alone.
    //
    // Undoing a column THIS execution added, whose shape the stale guard has
    // just confirmed still matches what it left behind, is a different act
    // with a strictly stronger precondition. See the primitive's header.
    const { recoveryDropColumn } = await import('./primitives/recovery-drop-column')
    const r = await recoveryDropColumn(projectId, identity.table, identity.column)
    if (!r.dropped) throw new Error(r.refusal ?? 'the column could not be dropped')
  },

  drop_trigger: async ({ projectId, identity }) => {
    if (identity.kind !== 'trigger') throw new Error('drop_trigger needs a trigger identity')
    // The existing primitive, which also re-reads the catalog afterwards and
    // refuses if the trigger survived its own DROP.
    const { removeDualWrite } = await import('./primitives/dual-write')
    const r = await removeDualWrite(projectId, identity.table, identity.targetColumn)
    if (!r.removed) throw new Error(r.refusal ?? 'the trigger could not be dropped')
  },

  restore_reader_config: async ({ identity, result }) => {
    if (identity.kind !== 'readers') throw new Error('restore_reader_config needs a readers identity')
    // The bytes, from the forward step's own record. `revertReaders` writes
    // back each function's exact previous source.
    const switched = (result as { switchedReaders?: unknown[] } | null)?.switchedReaders
    if (!Array.isArray(switched) || switched.length === 0) {
      throw new Error('the forward step recorded no switched readers to restore')
    }
    const { revertReaders } = await import('./primitives/switch-readers')
    const r = await revertReaders(switched as never)
    if (r.failures.length > 0) throw new Error(r.failures.join('; '))
  },
}

/**
 * Undo one step execution, or say precisely why not.
 *
 * Every gate is re-evaluated inside the project lock. Reading the row, then
 * taking the lock, then acting on what was read is the same
 * check-then-use race the rest of this subsystem has been closing: another
 * worker can move the row in between, and the loser would roll back on stale
 * information.
 */
export async function performRollback(input: {
  projectId: string
  stepExecutionId: string
}): Promise<RollbackOutcome> {
  const { projectId, stepExecutionId } = input

  const flight = await withMaintenanceSingleFlight(projectId, async () => {
    // RELOADED inside the lock, never passed in.
    const row = await prisma.maintenanceStepExecution.findUnique({
      where: { id: stepExecutionId },
      select: {
        id: true,
        stepKind: true,
        rollback: true,
        rollbackStatus: true,
        result: true,
        resourceIdentity: true,
        observedPreState: true,
        observedPostState: true,
      },
    })
    if (!row) return { stepExecutionId, status: 'failed' as const, detail: 'no such step execution' }

    if (row.rollbackStatus !== 'eligible') {
      return {
        stepExecutionId,
        status: (row.rollbackStatus as RollbackStatus) ?? 'failed',
        detail:
          row.rollbackStatus === null
            ? 'this step was never marked rollback-eligible, and only a positive forward failure may do that'
            : `rollback is already ${row.rollbackStatus}`,
      }
    }

    const spec = row.rollback as { strategy?: RollbackStrategy } | null
    const strategy = spec?.strategy
    if (!strategy) {
      return settle(projectId, stepExecutionId, 'failed', 'the step recorded no rollback strategy')
    }
    if (strategy === 'none_required') {
      return settle(projectId, stepExecutionId, 'verified', 'the step mutated nothing, so there is nothing to undo')
    }

    // Capability is re-asked here, not trusted from planning time. A
    // deployment can be rolled back to one without the handler between the
    // forward run and the recovery.
    if (!canRollback(strategy)) {
      return settle(
        projectId,
        stepExecutionId,
        'failed',
        `this deployment cannot perform ${strategy} (${rollbackContract(strategy)})`,
      )
    }
    const inverse = INVERSES[strategy]
    if (!inverse) {
      // The registry says implemented and no handler exists. Fail loudly
      // rather than silently skipping: that disagreement is the exact class of
      // bug the registry was introduced to prevent.
      return settle(
        projectId,
        stepExecutionId,
        'failed',
        `${strategy} is registered as implemented but has no inverse handler`,
      )
    }

    const identity = row.resourceIdentity as ResourceIdentity | null
    const preState = row.observedPreState as ResourceState | null
    const postState = row.observedPostState as ResourceState | null
    if (!identity || !preState || !postState) {
      // Steps executed before recovery authority was recorded. Refusing is the
      // only safe answer: without the observed post-state there is no way to
      // tell this resource from a later one wearing the same name.
      return settle(
        projectId,
        stepExecutionId,
        'blocked_stale',
        'this execution predates recovery authority and recorded no observed state, so nothing can prove what it left behind',
      )
    }

    // ── The stale guard ──────────────────────────────────────────────────
    const current = await observeResource(projectId, identity).catch((err: unknown) => {
      throw new Error(
        `could not observe the resource: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
    if (!stateMatches(postState, current)) {
      return settle(
        projectId,
        stepExecutionId,
        'blocked_stale',
        `refusing to undo: ${describeDrift(postState, current)}. Something changed this since the ` +
          'maintenance step ran, and rolling back now would overwrite that rather than undo our own work.',
      )
    }

    // Compare-and-set. Even if a future path bypasses the lock, two callers
    // cannot both own this transition.
    const claimed = await prisma.maintenanceStepExecution.updateMany({
      where: { id: stepExecutionId, rollbackStatus: 'eligible' },
      data: { rollbackStatus: 'started', rollbackAt: new Date() },
    })
    if (claimed.count !== 1) {
      return { stepExecutionId, status: 'started' as const, detail: 'another process claimed this rollback' }
    }

    try {
      await inverse({ projectId, identity, preState, result: row.result })
    } catch (err: unknown) {
      return settle(
        projectId,
        stepExecutionId,
        'failed',
        `the inverse did not complete: ${err instanceof Error ? err.message : String(err)}`,
        // The inverse RAN. Whether it half-mutated is exactly what nobody
        // knows, which is why this is audited as a performed attempt rather
        // than filed as a decision not to act.
        true,
      )
    }

    // ── Independent verification ─────────────────────────────────────────
    //
    // The inverse returning is not proof. Ask the database what is actually
    // there now, and require the recorded prior state.
    let after: ResourceState
    try {
      after = await observeResource(projectId, identity)
    } catch (err: unknown) {
      return settle(
        projectId,
        stepExecutionId,
        'unverified',
        `the inverse ran and the check that would confirm it could not complete: ${
          err instanceof Error ? err.message : String(err)
        }. This is NOT a restoration.`,
        true,
      )
    }

    if (!stateMatches(preState, after)) {
      return settle(
        projectId,
        stepExecutionId,
        'failed',
        `the inverse ran and the prior state was not restored: ${describeDrift(preState, after)}`,
        true,
      )
    }

    return settle(
      projectId,
      stepExecutionId,
      'verified',
      'the prior state was restored and independently confirmed',
      true,
    )
  })

  if (!flight.ran) {
    return {
      stepExecutionId,
      status: 'eligible',
      detail: 'another process is working on this project; rollback was not attempted',
    }
  }
  return flight.value
}
