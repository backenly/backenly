/**
 * Supabase Auth users → the new project's end users.
 *
 * auth.users rows become rows of the project's `users` table (the end-user
 * auth contract, lib/services/end-user-auth-table.ts) with the SAME ids, so
 * every `user_id` the app's tables carry still names the same person, and
 * with their bcrypt hashes as they are: Supabase hashes with bcrypt ($2a$),
 * which Backenly's sign-in verifies directly (lib/auth/password.ts), so a
 * moved user signs in with the password they already have.
 *
 *   - Signed up with Google, GitHub and the like and no password: moved with
 *     their provider and provider id (oauth_provider / oauth_id, the columns
 *     Backenly's own OAuth callback links on), and sign in again with that
 *     provider once it is set up in Backenly.
 *   - Email only, no password (magic link): moved; they sign in with a magic
 *     link or set a password with "Forgot password".
 *   - Phone-only and anonymous users have no email, which Backenly's users
 *     table requires: counted and said, not moved.
 *   - Banned users arrive blocked. Deleted users do not arrive.
 */

import type { Pool } from 'pg'
import { ImportInputError } from './driver'
import { MAX_IMPORT_USERS, type RowRoom, userCountRefusal, writeWithinRoom } from './limits'
import type { SourceReader } from './net'
import { authUsersQuery, type AuthShape, type AuthUserRow } from './pg-source'
import { rowCost, throwIfAborted } from './pg-engine'
import { waitForHeadroom } from './pressure'

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`

/**
 * Bring the project's users table to the auth contract, with the columns the
 * moved users need. Schema work: run inside the import's opening governed change.
 */
export async function prepareUsersTable(projectId: string, opts: { social: boolean }): Promise<void> {
  const { ensureAuthUsersTable } = await import('@/lib/services/end-user-auth-table')
  const { ensureEmailVerifiedColumn } = await import('@/lib/services/end-user-auth-flows')
  const { workspaceRawClient } = await import('@/lib/data-plane/regional')
  const schema = await ensureAuthUsersTable(projectId, { email: null })
  // Supabase's confirmed / unconfirmed carries over: existing rows verified, new rows not.
  await ensureEmailVerifiedColumn(projectId, schema.schemaName)
  if (opts.social) {
    const db = await workspaceRawClient(projectId)
    await db.$executeRawUnsafe(
      `ALTER TABLE ${q(schema.schemaName)}."users"
         ADD COLUMN IF NOT EXISTS oauth_provider TEXT,
         ADD COLUMN IF NOT EXISTS oauth_id TEXT,
         ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
    )
  }
}

export interface UsersContext {
  signal: AbortSignal
  onUsers: (copied: number) => void
  /** The same room as the tables' rows: users are rows of the project's database too. */
  room: RowRoom
}

/** The users rows to insert, column by column, for whatever shape the users table has now. */
function userColumns(columns: Set<string>, passwordColumn: string, createdAt: string | null, lastLogin: string | null) {
  const cols: Array<{ name: string; value: (u: AuthUserRow) => unknown }> = [
    { name: 'id', value: (u) => u.id },
    { name: 'email', value: (u) => u.email },
    { name: passwordColumn, value: (u) => u.password },
  ]
  if (columns.has('name')) cols.push({ name: 'name', value: (u) => u.name })
  if (columns.has('email_verified')) cols.push({ name: 'email_verified', value: (u) => u.verified })
  if (columns.has('is_blocked')) cols.push({ name: 'is_blocked', value: (u) => u.banned })
  if (createdAt) cols.push({ name: createdAt, value: (u) => u.created_at })
  if (lastLogin) cols.push({ name: lastLogin, value: (u) => u.last_sign_in_at })
  if (columns.has('oauth_provider')) cols.push({ name: 'oauth_provider', value: (u) => (u.password ? null : u.provider) })
  if (columns.has('oauth_id')) cols.push({ name: 'oauth_id', value: (u) => (u.password ? null : u.provider_id) })
  if (columns.has('avatar_url')) cols.push({ name: 'avatar_url', value: (u) => u.avatar_url })
  return cols
}

/**
 * Copy the users, in id order, inside the source snapshot the tables came
 * from. Returns how many arrived.
 */
export async function copyAuthUsers(source: SourceReader, projectId: string, shape: AuthShape, ctx: UsersContext): Promise<number> {
  const { introspectAuthUsersTable } = await import('@/lib/services/end-user-auth-table')
  const { projectPool } = await import('@/lib/data-plane/regional')
  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
  const schema = await introspectAuthUsersTable(projectId)
  const pool: Pool = await projectPool(projectId, 'import', { max: 4 })
  const cols = userColumns(schema.columns, schema.passwordColumn, schema.createdAtColumn, schema.lastLoginColumn)
  const names = cols.map((c) => q(c.name)).join(', ')

  /** Insert these users' rows; how many arrived. */
  const insert = async (values: unknown[][]): Promise<number> => {
    const params: unknown[] = []
    const tuples = values.map((row) => `(${row.map((v) => {
      params.push(v)
      return `$${params.length}`
    }).join(', ')})`)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL TIME ZONE 'UTC'`)
      await client.query(rlsSessionSql(), rlsSessionParams({ isServiceRole: true }))
      const res = await client.query(`INSERT INTO ${q(schema.schemaName)}."users" (${names}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, params)
      await client.query('COMMIT')
      return res.rowCount ?? 0
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {})
      const code = err?.code ? ` (PostgreSQL error ${err.code})` : ''
      throw new Error(`Copying users failed${code}.`)
    } finally {
      client.release()
    }
  }

  let copied = 0
  let read = 0
  ctx.onUsers(0)
  await source.query(`DECLARE bkn_import_users NO SCROLL CURSOR FOR ${authUsersQuery(shape)}`)
  try {
    for (;;) {
      throwIfAborted(ctx.signal)
      await waitForHeadroom(ctx.signal)
      const { rows } = await source.query<AuthUserRow>(`FETCH FORWARD 500 FROM bkn_import_users`)
      if (rows.length === 0) break
      // The preview counted the users; a source that sends more than one import moves stops here.
      read += rows.length
      if (read > MAX_IMPORT_USERS) throw new ImportInputError(userCountRefusal(null))
      const values = rows.map((u) => cols.map((c) => c.value(u)))
      // As many at a time as the plan's room lets in. An address two source
      // users shared (differing in case) arrives once.
      copied += await writeWithinRoom(ctx.room, values, rowCost, insert)
      ctx.onUsers(copied)
    }
  } finally {
    await source.query('CLOSE bkn_import_users').catch(() => {})
  }
  return copied
}

/** How many users the project's users table holds, read as the service role. */
export async function countProjectUsers(projectId: string): Promise<number> {
  const { executeWithUserContext } = await import('@/lib/services/workspace-rls')
  const { workspaceSchemaName } = await import('@/lib/security/workspace-schema')
  const rows = await executeWithUserContext<{ n: string }>(
    projectId,
    '',
    true,
    `SELECT count(*)::bigint::text AS n FROM ${q(workspaceSchemaName(projectId))}."users"`,
  )
  return Number(rows[0]?.n ?? 0)
}
