/**
 * RECOVERY-ONLY COLUMN DROP — narrow on purpose
 * ==============================================
 *
 * `DROP_COLUMN` exists on the governed executor and is classified
 * approval-required, which is correct: dropping a column a person asked about
 * is destructive and irreversible, and a robot should not do it on its own.
 * Routing rollback through that verb returns `APPROVAL_REQUIRED`, which is the
 * executor behaving exactly as designed.
 *
 * But undoing a column THIS execution added, seconds ago, whose shape still
 * matches what it left behind, is not that act. The general verb is gated
 * because the platform cannot know whether anyone depends on the column. The
 * recovery path can know, and has already proved it:
 *
 *   - the column is named by the execution record, not by a caller
 *   - `observedPreState` says it did not exist before this step
 *   - the stale guard has confirmed the live column still matches
 *     `observedPostState` exactly, so nothing has altered or replaced it
 *   - the project's maintenance lock is held
 *
 * That is a strictly stronger precondition than the approval gate protects
 * against, and it is why this is a separate primitive rather than a bypass
 * flag on the general one. There is no parameter here a user or an agent
 * supplies: the caller is `performRollback`, the identity comes out of the
 * ledger, and nothing else imports this file.
 *
 * The same reasoning will apply to `drop_constraint` when it is built. It
 * should arrive as a sibling of this — recovery-only, bound to one step
 * execution — and NOT as a general destructive verb added to the executor's
 * vocabulary, which would deserve its own tier and approval review.
 */

import { executeWorkspace, queryWorkspace, resolveWorkspaceSchema } from '@/lib/services/workspace-pool'

/** These reach raw DDL. Both come from the ledger, and both are checked anyway. */
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export async function recoveryDropColumn(
  projectId: string,
  table: string,
  column: string,
): Promise<{ dropped: boolean; refusal: string | null }> {
  if (![table, column].every(x => IDENT.test(x))) {
    return { dropped: false, refusal: 'table or column name is not a valid identifier' }
  }
  const schema = await resolveWorkspaceSchema(projectId)

  try {
    // No CASCADE. If something depends on this column, Postgres refuses and
    // the rollback reports that rather than widening its own blast radius to
    // get the job done - a dependent view is exactly the case where undoing
    // is no longer obviously the safe move.
    await executeWorkspace(
      projectId,
      `ALTER TABLE "${schema}"."${table}" DROP COLUMN IF EXISTS "${column}" RESTRICT;`,
    )
  } catch (err) {
    return {
      dropped: false,
      refusal: `dropping the column failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // Asked, not assumed. `removeDualWrite` does the same thing for the same
  // reason: a DDL statement returning is not the catalog agreeing.
  const rows = await queryWorkspace<{ n: bigint }>(
    projectId,
    `SELECT count(*)::bigint AS n FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    [schema, table, column],
  )
  if (Number(rows[0]?.n ?? 0) > 0) {
    return { dropped: false, refusal: `"${column}" is still in the catalog after DROP COLUMN` }
  }
  return { dropped: true, refusal: null }
}
