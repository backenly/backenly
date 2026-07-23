/**
 * END-USER AUTH TABLE CONTRACT
 * ============================
 * Single source of truth for the shape of `workspace_{projectId}.users` — the
 * table that backs every project's end-user authentication: signup, signin,
 * OAuth, password reset and token refresh.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * `users` is created by whichever path runs first: the AI from a developer
 * prompt ("a social app with users"), a CREATE_TABLE action, or an auth route's
 * own CREATE TABLE IF NOT EXISTS. Each can produce a *different* column set —
 * `password` vs `password_hash`, `createdAt` vs `created_at`, with or without
 * `role` / `is_blocked`.
 *
 * The auth routes used to hardcode column names (`RETURNING ... role`,
 * `UPDATE ... SET password`, `INSERT ... "createdAt"`). The moment the live
 * table lacked that exact column, Postgres raised SQLSTATE 42703 and the route
 * returned HTTP 500 — e.g. signup failing with `column "role" does not exist`,
 * which in turn fails the deploy readiness gate's live-endpoint check.
 *
 * THE CONTRACT
 * ------------
 * The auth system OWNS this table. `ensureAuthUsersTable` guarantees a
 * project's `users` table satisfies the auth contract before any auth route
 * touches it:
 *   - creates the table (canonical shape) when it does not exist;
 *   - self-heals an existing table with ADD COLUMN IF NOT EXISTS for any
 *     missing canonical column. Every addition is nullable or has a constant
 *     default, so on PostgreSQL 11+ it is a metadata-only operation — instant,
 *     with existing rows never rewritten.
 *
 * Callers then build SQL from the returned `AuthUsersSchema` descriptor instead
 * of hardcoding column names. A column the descriptor does not list is never
 * referenced — schema drift can no longer produce a 500.
 */

import { prisma } from '@/lib/db'

/** One row of `information_schema.columns` for the users table. */
export interface AuthUsersColumn {
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
}

/** Resolved description of a project's live `users` table. */
export interface AuthUsersSchema {
  /** `workspace_{projectId}` */
  schemaName: string
  /** Every column currently present on the users table. */
  columns: Set<string>
  /** Full column metadata in ordinal order — used to build drift-tolerant INSERTs. */
  columnMeta: AuthUsersColumn[]
  /** Physical column holding the password hash: `password` or `password_hash`. */
  passwordColumn: string
  /** Physical created-at column (`createdAt` | `created_at`), or null if none. */
  createdAtColumn: string | null
  /** Physical updated-at column (`updatedAt` | `updated_at`), or null if none. */
  updatedAtColumn: string | null
  /** Physical last-login column (`last_login` | `lastLogin`), or null if none. */
  lastLoginColumn: string | null
  hasRole: boolean
  hasIsBlocked: boolean
  hasName: boolean
}

/** A ready-to-run INSERT for a new end-user row. */
export interface UserInsertPlan {
  /** `INSERT INTO "schema"."users" (...) VALUES (...) RETURNING ...` */
  sql: string
  /** Positional parameters for `sql`. */
  values: unknown[]
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * SQL boolean that is TRUE for a synthetic internal account — the throwaway
 * users the behavioral verifier creates on every deploy to exercise signup /
 * signin / RLS. They live in the real `users` table but must NEVER surface in a
 * developer's Auth dashboard or count toward their identity metrics.
 *
 * They are identified by a reserved test email domain:
 *   - any `.internal` domain (`…@backenly.internal`, `…@test.internal`,
 *     `…@backenly-test.internal`) — `.internal` is reserved for private use
 *     (RFC 8375) and can never belong to a real end-user;
 *   - `backenly-selftest.com` — used by legacy API self-test tooling.
 *
 * Safe and future-proof: any new verifier that uses a `.internal` domain is
 * covered automatically. Interpolate directly into a WHERE clause — it contains
 * no user input.
 */
export const SYNTHETIC_USER_SQL =
  `(email ILIKE '%@%.internal' OR email ILIKE '%@backenly-selftest.com')`

/**
 * True when an email belongs to the reserved internal test space (a `.internal`
 * domain). Used by the auth runtime to keep behavioral-verifier signups from
 * counting toward a project's monthly-active-user quota or its dashboard.
 */
export function isReservedTestEmail(email: string | null | undefined): boolean {
  if (typeof email !== 'string') return false
  const e = email.trim()
  return /@[^@]+\.internal$/i.test(e) || /@backenly-selftest\.com$/i.test(e)
}

/**
 * Remove the synthetic auth artifacts a behavioral / contract verifier leaves in
 * a project's workspace schema.
 *
 * WHY: verifiers sign up throwaway `…@*.internal` accounts through the REAL
 * signup / logout endpoints to exercise auth on every deploy. Those endpoints
 * have side effects — signup issues an `_email_verifications` token, logout
 * blacklists a `jti` — but the verifier cleanup only ever deleted the `users`
 * row. The orphaned side-effect rows then surfaced in the developer's Tables
 * inspector (`_email_verifications`, `_token_blacklist`, …) looking like data
 * that appeared "automatically". Source-level guards now stop those writes for
 * `.internal` accounts, and this helper both cleans up whatever already leaked
 * and lets each verifier self-heal on its next run.
 *
 * Runs under SERVICE-ROLE — the users table is RLS-FORCED, so a plain DELETE
 * matches zero rows and the synthetic account leaks forever.
 *
 * Two modes:
 *   - `{ email }` → targeted: delete exactly one account's rows. Race-free, so
 *     a verifier can call it in its own `finally` without clobbering a
 *     concurrently-running verifier's in-flight synthetic user.
 *   - no email → sweep: delete every reserved-internal account in the project
 *     (used by the one-time backfill).
 *
 * `_token_blacklist` is keyed by `jti`, not email, so it is only reachable in
 * sweep mode: expired entries are always dropped (the token is already dead),
 * and the whole table is cleared ONLY when the project has no users left — the
 * runtime never re-validates user existence, so we must never delete a blacklist
 * entry that could still be guarding a live token belonging to a real user.
 *
 * Idempotent, best-effort per table, and never throws.
 */
export async function purgeSyntheticAuthArtifacts(
  projectId: string,
  opts?: { email?: string },
): Promise<{ table: string; deleted: number }[]> {
  const schemaName = `workspace_${projectId}`
  const { executeWithUserContext } = await import('./workspace-rls')
  const results: { table: string; deleted: number }[] = []

  // Case-insensitive exact match for targeted mode (ILIKE would treat the `_`
  // in `__http_bv_…` as a wildcard); the reserved-internal pattern for sweeps.
  const match = opts?.email
    ? { where: 'LOWER(email) = LOWER($1)', params: [opts.email] as unknown[] }
    : { where: SYNTHETIC_USER_SQL, params: [] as unknown[] }

  // Which optional auth side-tables actually exist here. Without this
  // pre-check, every absent table still issued a DELETE that Prisma logged as
  // `prisma:error … relation does not exist` before the catch below swallowed
  // it — three red blocks per probe run, per project, for a non-event. Real
  // failures were getting lost in that noise.
  const existing = new Set<string>()
  try {
    const present = await executeWithUserContext<{ table_name: string }>(
      '', true,
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schemaName],
    )
    for (const r of present) existing.add(r.table_name)
  } catch {
    /* introspection failed — fall through and let each purge try as before */
  }

  // Each executeWithUserContext runs in its own transaction, so a table that
  // does not exist in this project fails just its own DELETE, not the batch.
  const purge = async (table: string, where: string, params: unknown[]): Promise<void> => {
    // Skip only when introspection succeeded and positively excluded the table
    // — an empty set means the lookup failed, so fall back to attempting.
    if (existing.size > 0 && !existing.has(table)) return
    try {
      const rows = await executeWithUserContext<{ x: number }>(
        '', true,
        `DELETE FROM "${schemaName}"."${table}" WHERE ${where} RETURNING 1 AS x`,
        params,
      )
      if (rows.length > 0) results.push({ table, deleted: rows.length })
    } catch {
      /* table absent for this project, or non-fatal — skip */
    }
  }

  await purge('users', match.where, match.params)
  await purge('_email_verifications', match.where, match.params)
  await purge('_magic_links', match.where, match.params)
  await purge('_password_resets', match.where, match.params)

  if (!opts?.email) {
    let noUsers = false
    try {
      const remaining = await executeWithUserContext<{ n: bigint }>(
        '', true, `SELECT count(*)::bigint AS n FROM "${schemaName}"."users"`,
      )
      noUsers = remaining.length > 0 && Number(remaining[0].n) === 0
    } catch {
      /* users table absent — leave noUsers false, only prune expired below */
    }
    await purge('_token_blacklist', noUsers ? 'TRUE' : 'expires_at < NOW()', [])
  }

  return results
}

/** Read the current column list of `workspace_{projectId}.users`. */
async function introspectColumns(schemaName: string): Promise<AuthUsersColumn[]> {
  return prisma.$queryRawUnsafe<AuthUsersColumn[]>(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'users'
      ORDER BY ordinal_position`,
    schemaName,
  )
}

/** Turn a raw column list into the resolved `AuthUsersSchema` descriptor. */
function describe(schemaName: string, cols: AuthUsersColumn[]): AuthUsersSchema {
  const columns = new Set(cols.map((c) => c.column_name))
  return {
    schemaName,
    columns,
    columnMeta: cols,
    passwordColumn: columns.has('password')
      ? 'password'
      : columns.has('password_hash')
        ? 'password_hash'
        : 'password',
    createdAtColumn: columns.has('createdAt')
      ? 'createdAt'
      : columns.has('created_at')
        ? 'created_at'
        : null,
    updatedAtColumn: columns.has('updatedAt')
      ? 'updatedAt'
      : columns.has('updated_at')
        ? 'updated_at'
        : null,
    lastLoginColumn: columns.has('last_login')
      ? 'last_login'
      : columns.has('lastLogin')
        ? 'lastLogin'
        : null,
    hasRole: columns.has('role'),
    hasIsBlocked: columns.has('is_blocked'),
    hasName: columns.has('name'),
  }
}

/**
 * Describe a project's `users` table WITHOUT running any DDL.
 *
 * Use for read / update-only auth paths (reset-password, refresh-token) where
 * the table is already guaranteed to exist and the caller only needs to know
 * which physical column names to reference.
 */
export async function introspectAuthUsersTable(
  projectId: string,
): Promise<AuthUsersSchema> {
  const schemaName = `workspace_${projectId}`
  return describe(schemaName, await introspectColumns(schemaName))
}

/**
 * Guarantee `workspace_{projectId}.users` satisfies the auth contract, then
 * return its descriptor.
 *
 * Safe to call on every signup / OAuth callback: it is idempotent and cheap
 * (introspection plus, at most, one ALTER on the very first call per project).
 */
export async function ensureAuthUsersTable(
  projectId: string,
): Promise<AuthUsersSchema> {
  const schemaName = `workspace_${projectId}`

  // 1. Schema + canonical table. Both IF NOT EXISTS — no-ops when present.
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${schemaName}"."users" (
      "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "email"        TEXT UNIQUE NOT NULL,
      "password"     TEXT,
      "name"         TEXT,
      "role"         TEXT NOT NULL DEFAULT 'user',
      "is_blocked"   BOOLEAN NOT NULL DEFAULT FALSE,
      "last_login"   TIMESTAMP WITH TIME ZONE,
      "createdAt"    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      "updatedAt"    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `)

  // 2. Introspect the live table.
  let cols = await introspectColumns(schemaName)
  const have = new Set(cols.map((c) => c.column_name))

  // 3. Self-heal: add any missing canonical auth column. Each ADD is nullable
  //    or has a constant default → metadata-only on PG 11+, existing rows are
  //    never rewritten. Password / timestamp columns are added only when
  //    NEITHER naming variant is present, so a developer's `password_hash` /
  //    `created_at` table is left exactly as it is.
  const heal: string[] = []
  if (!have.has('password') && !have.has('password_hash'))
    heal.push(`ADD COLUMN IF NOT EXISTS "password" TEXT`)
  if (!have.has('name'))
    heal.push(`ADD COLUMN IF NOT EXISTS "name" TEXT`)
  if (!have.has('role'))
    heal.push(`ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'user'`)
  if (!have.has('is_blocked'))
    heal.push(`ADD COLUMN IF NOT EXISTS "is_blocked" BOOLEAN NOT NULL DEFAULT FALSE`)
  if (!have.has('last_login') && !have.has('lastLogin'))
    heal.push(`ADD COLUMN IF NOT EXISTS "last_login" TIMESTAMP WITH TIME ZONE`)
  if (!have.has('createdAt') && !have.has('created_at'))
    heal.push(`ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()`)
  if (!have.has('updatedAt') && !have.has('updated_at'))
    heal.push(`ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW()`)

  if (heal.length > 0) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${schemaName}"."users" ${heal.join(', ')}`,
    )
    cols = await introspectColumns(schemaName) // re-read post-heal
  }

  // 4. Guarantee the users table is protected by RLS. A user must only be able
  //    to read/update their OWN record (id = current_user_id). Without this the
  //    autonomy loop forever flags "User Auth Flow incomplete: missing
  //    rls_on_users" — so we close the gap at the single point that owns the
  //    table. Idempotent + guarded (one indexed lookup once a policy exists).
  //    Auth routes (signup/signin/reset) read users under SERVICE-ROLE, which
  //    bypasses this policy, so credential flows are unaffected. Non-fatal.
  await ensureUsersRlsPolicy(projectId).catch((e) => {
    console.warn(`[AuthUsersTable] users RLS ensure failed (non-fatal): ${e?.message}`)
  })

  return describe(schemaName, cols)
}

/**
 * Idempotently install the `own_rows` RLS policy on the users table, keyed on
 * `id` (the users table's own primary key is the ownership column). Runs the DDL
 * at most once per project — after a PermissionPolicy row exists it is a single
 * indexed lookup that returns early.
 */
async function ensureUsersRlsPolicy(projectId: string): Promise<void> {
  const existing = await prisma.permissionPolicy.findFirst({
    where: { projectId, tableName: 'users' },
    select: { id: true },
  })
  if (existing) return

  const { applyPermissionPolicy } = await import('./workspace-rls')
  const result = await applyPermissionPolicy(projectId, {
    tableName: 'users',
    template: 'own_rows',
    userIdColumn: 'id',
  })
  if (result.success) {
    console.log(`[AuthUsersTable] ✅ own_rows RLS applied to users (id-scoped) for ${projectId}`)
  } else {
    console.warn(`[AuthUsersTable] users RLS not applied: ${result.message}`)
  }
}

/**
 * CHECK-constraint allowed values for the users table.
 *
 * Returns a map of column → first quoted literal in the CHECK expression
 * (e.g. `role IN ('admin','customer')` → `{ role: 'admin' }`). Lets signup
 * honour a developer's enum-style constraints instead of 500-ing with a 23514
 * when our hardcoded default ('user', 'active', …) is not in their list.
 */
async function loadCheckConstraintValues(
  schemaName: string,
): Promise<Record<string, string>> {
  try {
    const rows = await prisma.$queryRawUnsafe<
      { attname: string; consrc: string }[]
    >(
      `SELECT a.attname, pg_get_constraintdef(c.oid) AS consrc
         FROM pg_constraint c
         JOIN pg_class t      ON t.oid = c.conrelid
         JOIN pg_namespace n  ON n.oid = t.relnamespace
         JOIN pg_attribute a  ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'c'
          AND n.nspname = $1
          AND t.relname = 'users'`,
      schemaName,
    )
    const out: Record<string, string> = {}
    for (const row of rows) {
      const m = row.consrc.match(/'([^']+)'/)
      if (m) out[row.attname] = m[1]
    }
    return out
  } catch {
    return {}
  }
}

/** Type-safe placeholder value for a required column we have no value for. */
function fallbackFor(dataType: string): unknown {
  const t = dataType.toLowerCase()
  if (t.includes('bool')) return false
  if (
    t.includes('int') ||
    t.includes('numeric') ||
    t.includes('real') ||
    t.includes('double') ||
    t.includes('float') ||
    t.includes('decimal')
  )
    return 0
  if (t.includes('json')) return '{}'
  if (t.includes('timestamp') || t === 'date' || t.includes('time'))
    return new Date().toISOString()
  return ''
}

/**
 * Build a schema-tolerant INSERT for a new end-user row.
 *
 * `provided` is a map of column → value the caller wants set (id, email, name,
 * password, plus any OAuth columns). The builder:
 *   - includes only columns that actually exist on the table;
 *   - lets the database assign `id` whenever the column has a default
 *     (gen_random_uuid() or a SERIAL sequence) — the real id comes back via
 *     RETURNING, so this works for both UUID and integer primary keys;
 *   - honours CHECK constraints (a developer's `role IN ('admin','customer')`
 *     would otherwise reject the hardcoded 'user' default → SQLSTATE 23514);
 *   - supplies a type-safe fallback for any other NOT NULL column without a
 *     default, so a developer-added required column never 500s signup;
 *   - produces a RETURNING clause that lists ONLY columns that exist.
 *
 * The caller is responsible for executing `plan.sql` with `plan.values`
 * (under service-role context — signup runs before the user has a session).
 */
export async function buildUserInsert(
  schema: AuthUsersSchema,
  provided: Record<string, unknown>,
): Promise<UserInsertPlan> {
  const { schemaName, columnMeta } = schema

  const checkOverrides = await loadCheckConstraintValues(schemaName)

  // Well-known defaults for standard auth columns. Caller-provided values win.
  const known: Record<string, unknown> = {
    role: checkOverrides.role ?? 'user',
    status: checkOverrides.status ?? 'active',
    is_active: true,
    is_blocked: false,
    email_verified: false,
    verified: false,
    // Any other text column with a CHECK constraint inherits its first allowed
    // literal — keeps signup tolerant of custom enum-style columns.
    ...Object.fromEntries(
      Object.entries(checkOverrides).filter(
        ([k]) => k !== 'role' && k !== 'status',
      ),
    ),
    ...provided,
  }

  // Timestamp columns: set to "now" under their actual physical name so a
  // NOT NULL timestamp without a default still gets a value.
  if (schema.createdAtColumn && known[schema.createdAtColumn] === undefined)
    known[schema.createdAtColumn] = new Date().toISOString()
  if (schema.updatedAtColumn && known[schema.updatedAtColumn] === undefined)
    known[schema.updatedAtColumn] = new Date().toISOString()

  const cols: string[] = []
  const vals: unknown[] = []
  const types: string[] = []

  for (const col of columnMeta) {
    const n = col.column_name
    // Auto-generating primary key (UUID default or SERIAL sequence): let the
    // database assign it and read it back via RETURNING.
    if (n === 'id' && col.column_default !== null) continue

    if (n in known && known[n] !== undefined) {
      cols.push(`"${n}"`)
      vals.push(known[n])
      types.push(col.data_type)
      continue
    }
    // Columns that are nullable or have a default can be safely omitted.
    if (col.column_default !== null || col.is_nullable === 'YES') continue
    // A required column we have no value for — supply a type-safe fallback so
    // the INSERT still succeeds.
    cols.push(`"${n}"`)
    vals.push(fallbackFor(col.data_type))
    types.push(col.data_type)
  }

  const placeholders = vals.map((v, i) => {
    const dt = (types[i] ?? '').toLowerCase()
    if (typeof v === 'string' && UUID_RE.test(v)) return `$${i + 1}::uuid`
    if (dt.includes('timestamp') || dt === 'date' || dt.includes('time'))
      return `$${i + 1}::timestamptz`
    if (dt.includes('json')) return `$${i + 1}::jsonb`
    return `$${i + 1}`
  })

  // RETURNING only ever names columns that exist on the table.
  const wanted = ['id', 'email', 'name', 'role'].filter((c) =>
    schema.columns.has(c),
  )
  const returning =
    wanted.length > 0 ? wanted.map((c) => `"${c}"`).join(', ') : '*'

  return {
    sql: `INSERT INTO "${schemaName}"."users" (${cols.join(', ')})
          VALUES (${placeholders.join(', ')})
          RETURNING ${returning}`,
    values: vals,
  }
}

/**
 * Record the moment an end-user authenticated, so the Auth dashboard's
 * "active · 30d" metric reflects real activity.
 *
 * Fully self-contained and fire-and-forget safe:
 *   - ensures the `last_login` column exists (metadata-only ADD on PG 11+);
 *   - stamps NOW() for the given user id under SERVICE-ROLE, so the users
 *     table's RLS (own_rows / admin_only) does not block the write.
 *
 * Never throws — call sites `.catch(() => {})` it. A failure here must never
 * break sign-in.
 */
export async function stampLastLogin(
  projectId: string,
  userId: string | number,
): Promise<void> {
  const schemaName = `workspace_${projectId}`
  const { executeWithUserContext } = await import('./workspace-rls')
  // Add the column if a legacy table predates the contract. IF NOT EXISTS keeps
  // this idempotent and cheap; it is a no-op once the column is present.
  await executeWithUserContext(
    '',
    true,
    `ALTER TABLE "${schemaName}"."users" ADD COLUMN IF NOT EXISTS "last_login" TIMESTAMP WITH TIME ZONE`,
  )
  await executeWithUserContext(
    '',
    true,
    `UPDATE "${schemaName}"."users" SET "last_login" = NOW() WHERE id = $1`,
    [userId],
  )
}
