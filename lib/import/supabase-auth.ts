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
 *
 * Two halves: copyAuthUsers reads the source (in the import's sandbox, where
 * one runs); insertAuthUsers writes the project (in the control plane), and
 * checks every user it is handed first (keptAuthUser), since the reader is
 * only as trustworthy as the source it read.
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
  /** Write one batch into the project (PgDestination.insertUsers); how many arrived. */
  write: (users: AuthUserRow[]) => Promise<number>
}

/**
 * A bcrypt hash as Backenly's sign-in reads one (lib/auth/password.ts): the
 * $2a$, $2b$ or $2y$ form, a two-digit cost, 53 characters of salt and hash.
 * Anything else arrives as no password, and its owner sets one with "Forgot
 * password", as a user who never had one does.
 */
export const KEPT_BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The longest each text a moved user carries may be; a longer one arrives empty. */
const USER_TEXT_MAX = { email: 320, name: 512, avatar_url: 2048, provider: 64, provider_id: 512, at: 40 } as const

/**
 * The user as it may be written, or null when it cannot be: an id that is a
 * uuid, an email, every other field of its type and within its length, and a
 * password only in a form Backenly keeps. Run where users are written, on
 * whatever the reader sent.
 */
export function keptAuthUser(u: unknown): AuthUserRow | null {
  const r = u as Record<string, unknown> | null
  if (!r || typeof r !== 'object') return null
  const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null)
  const at = (v: unknown): string | null => {
    const s = text(v, USER_TEXT_MAX.at)
    return s && Number.isFinite(Date.parse(s)) ? s : null
  }
  const id = typeof r.id === 'string' && UUID.test(r.id) ? r.id : null
  const email = text(r.email, USER_TEXT_MAX.email)
  if (!id || !email) return null
  return {
    id,
    email,
    password: typeof r.password === 'string' && KEPT_BCRYPT_HASH.test(r.password) ? r.password : null,
    verified: r.verified === true,
    name: text(r.name, USER_TEXT_MAX.name),
    avatar_url: text(r.avatar_url, USER_TEXT_MAX.avatar_url),
    created_at: at(r.created_at),
    last_sign_in_at: at(r.last_sign_in_at),
    banned: r.banned === true,
    provider: text(r.provider, USER_TEXT_MAX.provider),
    provider_id: text(r.provider_id, USER_TEXT_MAX.provider_id),
  }
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

/** What one moved user is counted at against the plan's room: every field it carries. */
export function userCost(u: AuthUserRow): number {
  return rowCost(Object.values(u))
}

/**
 * Write moved users into the project's users table, for whatever shape it has
 * now: each checked first (keptAuthUser); one that cannot be written is left
 * out. Returns how many arrived. An address two users shared (differing in
 * case) arrives once.
 */
export async function insertAuthUsers(projectId: string, users: readonly unknown[]): Promise<number> {
  const kept = users.map(keptAuthUser).filter((u): u is AuthUserRow => u !== null)
  if (kept.length === 0) return 0
  const { introspectAuthUsersTable } = await import('@/lib/services/end-user-auth-table')
  const { projectPool } = await import('@/lib/data-plane/regional')
  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
  const schema = await introspectAuthUsersTable(projectId)
  const pool: Pool = await projectPool(projectId, 'import', { max: 4 })
  const cols = userColumns(schema.columns, schema.passwordColumn, schema.createdAtColumn, schema.lastLoginColumn)
  const names = cols.map((c) => q(c.name)).join(', ')
  // PostgreSQL takes at most 65,535 parameters in one statement.
  const perInsert = Math.max(1, Math.floor(60_000 / cols.length))
  let written = 0
  for (let i = 0; i < kept.length; i += perInsert) {
    const params: unknown[] = []
    const tuples = kept.slice(i, i + perInsert).map(
      (u) =>
        `(${cols
          .map((c) => {
            params.push(c.value(u))
            return `$${params.length}`
          })
          .join(', ')})`,
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SET LOCAL TIME ZONE 'UTC'`)
      await client.query(rlsSessionSql(), rlsSessionParams({ isServiceRole: true }))
      const res = await client.query(`INSERT INTO ${q(schema.schemaName)}."users" (${names}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, params)
      await client.query('COMMIT')
      written += res.rowCount ?? 0
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {})
      const code = err?.code ? ` (PostgreSQL error ${err.code})` : ''
      throw new Error(`Copying users failed${code}.`)
    } finally {
      client.release()
    }
  }
  return written
}

/**
 * Read the users, in id order, inside the source snapshot the tables came
 * from, and hand each batch to `ctx.write`. Returns how many arrived.
 */
export async function copyAuthUsers(source: SourceReader, shape: AuthShape, ctx: UsersContext): Promise<number> {
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
      // Plain values only: a date the driver parsed travels as its ISO text.
      const users = rows.map((u) => ({
        ...u,
        created_at: isoOrNull(u.created_at),
        last_sign_in_at: isoOrNull(u.last_sign_in_at),
      }))
      // As many at a time as the plan's room lets in.
      copied += await writeWithinRoom(ctx.room, users, userCost, ctx.write)
      ctx.onUsers(copied)
    }
  } finally {
    await source.query('CLOSE bkn_import_users').catch(() => {})
  }
  return copied
}

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null
  return typeof v === 'string' ? v : null
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
