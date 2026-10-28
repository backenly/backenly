/**
 * Whether an end user is blocked, read at request time.
 *
 * The users table is FORCE row-level security with an own-rows policy
 * (lib/services/end-user-auth-table.ts), and the application role does not
 * bypass row-level security. A read with no session claims therefore matches
 * no row, so the request-time check found nothing and accepted a blocked
 * user's token; only a superuser connection, as in CI, saw the flag. Sign-in
 * and refresh already read users as the service role, and so does this.
 *
 * `db` is the project's own client, resolved by the caller before its
 * fail-open handling. A missing table or column throws as before (42P01,
 * 42703), for the caller to read as "nobody was ever blocked".
 */

import type { WorkspaceRawClient } from '@/lib/data-plane/regional'
import { rlsSessionParams, rlsSessionSql } from '@/lib/services/rls-session'

export async function readEndUserBlocked(
  db: WorkspaceRawClient,
  schemaName: string,
  userId: string,
): Promise<boolean> {
  const rows = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(rlsSessionSql(), ...rlsSessionParams({ isServiceRole: true }))
    return tx.$queryRawUnsafe<{ is_blocked: boolean | null }[]>(
      `SELECT is_blocked FROM "${schemaName}"."users" WHERE id::text = $1 LIMIT 1`,
      userId,
    )
  })
  return rows[0]?.is_blocked === true
}
