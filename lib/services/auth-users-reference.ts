/**
 * A foreign key into `users` names the end-user auth table.
 *
 * That table is created by the first sign-up (ensureAuthUsersTable), so on a
 * project nobody has signed up to yet it does not exist. A migration as
 * ordinary as
 *
 *   CREATE TABLE profiles (user_id uuid REFERENCES users(id), ...)
 *
 * — the shape of nearly every app's first table, and the example in
 * apply_migration's own description — then failed with 42P01 "relation users
 * does not exist", on the direct path and again when a person approved the
 * branch merge that replays it. With end-user auth on, `users` is the
 * auth-managed table (isAuthManagedTable), so that is what such a key means:
 * create it, through the same function a sign-up uses, before the key is
 * installed. Enabling auth creates it too; this covers projects that enabled
 * auth before it did.
 *
 * Nothing is created when the table exists, for any other target, or while
 * auth is off: then `users` may be a table of the project's own that a later
 * statement of the same migration creates, and creating the auth table first
 * would turn that statement into "already existed" without its columns.
 *
 * Runs inside the caller's governed change, so the table it adds is recorded
 * with that change and restored with it.
 */
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { isEndUserAuthEnabled } from '@/lib/services/auth-status'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'

/** Whether `schemaName` holds a `users` table. */
async function usersTableExists(projectId: string, schemaName: string): Promise<boolean> {
  const db = await workspaceRawClient(projectId)
  const rows = await db.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = 'users' AND table_type = 'BASE TABLE'
      LIMIT 1`,
    schemaName,
  )
  return rows.length > 0
}

/**
 * Provision the end-user auth table when `referencedTable` is `users`, auth is
 * on and the schema has none yet. Returns true when it created one.
 */
export async function ensureReferencedAuthUsersTable(
  projectId: string,
  referencedTable: unknown,
  schemaName: string = `workspace_${projectId}`,
): Promise<boolean> {
  if (typeof referencedTable !== 'string') return false
  if (referencedTable.trim().toLowerCase().split('.').pop() !== 'users') return false
  if (await usersTableExists(projectId, schemaName)) return false
  if (!(await isEndUserAuthEnabled(projectId))) return false
  await ensureAuthUsersTable(projectId, { email: null }, schemaName)
  return true
}
