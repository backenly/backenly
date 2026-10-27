/**
 * The database login a function's SQL runs as.
 *
 * Function code used to issue its SQL on the app's own connection, and the app
 * role owns every platform table and every workspace schema, so a generated
 * function could read public.users or another project's schema. Each workspace
 * schema now has a LOGIN role holding DML on that schema alone, and function SQL
 * runs on a client that logs in as it (scripts/sql/function-roles.sql).
 *
 * The login, not a SET ROLE on the app's connection, is what makes this a
 * boundary: function code runs arbitrary SQL, and `RESET ROLE` would take a
 * switched session straight back to the app role.
 *
 * The password is derived from the platform's own secret, so it is never
 * stored and every process derives the same one. There is no fallback to the
 * app's connection: a function whose login cannot be established fails with
 * FUNCTION_DB_ROLE_UNAVAILABLE, because running it anyway is the exposure this
 * exists to close.
 *
 * The role, its grants and the login all live in the database holding the
 * project's schema, in the project's region (lib/data-plane/regional.ts). A
 * project in a region this process cannot reach fails with
 * REGION_NOT_CONFIGURED; it is never tried against another region's database.
 */

import { createHash, createHmac } from 'crypto'
import { PrismaClient } from '@prisma/client'
import { projectDatabaseUrl, regionRawClient, workspaceRawClient } from '@/lib/data-plane/regional'
import { withoutStatementCache } from '@/lib/data-plane/statement-cache'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'

export interface FunctionDbHandle {
  client: PrismaClient
  schema: string
  role: string
}

const ROLE_RE = /^bkn_fn_[0-9a-f]{12}$/
const SCHEMA_RE = /^workspace_[A-Za-z0-9_-]+$/

/** The role name for a schema. Mirrors public.backenly_fn_role_name(). */
export function functionRoleName(schema: string): string {
  return `bkn_fn_${createHash('sha256').update(schema, 'utf8').digest('hex').slice(0, 12)}`
}

export class FunctionDbRoleUnavailableError extends Error {
  readonly code = 'FUNCTION_DB_ROLE_UNAVAILABLE'
  constructor(detail: string) {
    super(
      `This function's database login is unavailable, so its SQL was not run: ${detail}. ` +
      `An operator installs it with: bash scripts/postgrest-install.sh`,
    )
    this.name = 'FunctionDbRoleUnavailableError'
  }
}

/** Same key the project env-var cipher uses, so no deployment needs a new secret. */
function derivationKey(): string {
  const key = process.env.ENV_VAR_ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!key) throw new FunctionDbRoleUnavailableError('neither ENV_VAR_ENCRYPTION_KEY nor JWT_SECRET is set')
  return key
}

export function functionRolePassword(schema: string): string {
  return createHmac('sha256', derivationKey()).update(`backenly:function-db-role:v1:${schema}`).digest('base64url')
}

/**
 * The project's own database URL (lib/data-plane/regional.ts) with the function
 * login swapped in and a small pool. The base is required: a default would be
 * the home region's database, which holds no schema for a project elsewhere.
 *
 * Prisma's statement cache is off, as on every client that runs workspace SQL:
 * function code reads whole rows of tables whose columns change
 * (lib/data-plane/statement-cache.ts).
 */
export function functionDatabaseUrl(role: string, password: string, base: string): string {
  const url = new URL(withoutStatementCache(base))
  url.username = role
  url.password = password
  url.searchParams.set('connection_limit', '2')
  url.searchParams.set('pool_timeout', '10')
  return url.toString()
}

/**
 * Create or re-assert the role and its grants, in the database holding the
 * project's schema: roles and grants live in that cluster. Returns the role name.
 */
async function syncRole(projectId: string, schema: string, password: string): Promise<string> {
  // Outside the try: a region this process cannot reach is its own error, not
  // a missing helper.
  const db = await workspaceRawClient(projectId)
  const sync = () => db.$queryRaw<Array<{ role: string }>>`
    SELECT public.backenly_fn_role_sync(${schema}, ${password}) AS role
  `
  let role: string | undefined
  try {
    let rows: Array<{ role: string }>
    try {
      rows = await sync()
    } catch (err: any) {
      // Two processes' first calls of a project's functions at once both find
      // no role and both create it, or both alter it: the second loses on the
      // catalog's unique index (23505, or 42710 once the first has committed)
      // or on the row ("tuple concurrently updated"), and its call answered
      // 500. Found by fuzzing the data API. Once more, the role exists and the
      // sync only re-asserts it.
      if (!/23505|42710|already exists|tuple concurrently updated/.test(String(err?.message ?? err))) throw err
      rows = await sync()
    }
    role = rows[0]?.role
  } catch (err: any) {
    const message = String(err?.message ?? err)
    throw new FunctionDbRoleUnavailableError(
      /backenly_fn_role_sync[\s\S]*does not exist/.test(message)
        ? 'the role helper is not installed in this database'
        : message,
    )
  }
  // The helper derives the name itself. A different answer means the SQL and
  // this module disagree, and logging in as an unexpected role is not safe.
  if (!role || !ROLE_RE.test(role) || role !== functionRoleName(schema)) {
    throw new FunctionDbRoleUnavailableError(`the helper returned an unexpected role (${role ?? 'none'})`)
  }
  return role
}

/**
 * Whether scripts/sql/function-roles.sql is installed in a region's database
 * (home by default; each region needs its own copy). A catalog probe, so
 * nothing logs an error.
 */
export async function functionRoleHelperInstalled(region: CloudRegionId = HOME_REGION): Promise<boolean> {
  const rows = await regionRawClient(region).$queryRaw<Array<{ ok: boolean }>>`
    SELECT to_regprocedure('public.backenly_fn_role_sync(text, text)') IS NOT NULL AS ok
  `
  return rows[0]?.ok === true
}

/** Create or re-assert a project's function login without opening a client on it. */
export async function provisionFunctionRole(projectId: string): Promise<{ role: string; existed: boolean }> {
  const schema = await resolveWorkspaceSchema(projectId)
  if (!SCHEMA_RE.test(schema)) {
    throw new FunctionDbRoleUnavailableError(`"${schema}" is not a workspace schema`)
  }
  const db = await workspaceRawClient(projectId)
  const rows = await db.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${functionRoleName(schema)}
  `
  const role = await syncRole(projectId, schema, functionRolePassword(schema))
  return { role, existed: (rows[0]?.n ?? 0) > 0 }
}

// ── Clients ─────────────────────────────────────────────────────────────────
//
// One small client per project, kept while in use. Grants are re-synced at most
// every SYNC_TTL_MS: tables the app role creates are covered at once by default
// privileges, and this catches tables any other role created.

const MAX_CLIENTS = 16
const SYNC_TTL_MS = 5 * 60 * 1000
const IDLE_MS = 10 * 60 * 1000

interface Entry { handle: FunctionDbHandle; syncedAt: number; usedAt: number }
const clients = new Map<string, Entry>()
/** A sync under way for a schema, which a call arriving meanwhile waits on. */
const syncing = new Map<string, Promise<FunctionDbHandle>>()

function evict(schema: string): void {
  const entry = clients.get(schema)
  if (!entry) return
  clients.delete(schema)
  entry.handle.client.$disconnect().catch(() => {})
}

function evictIdleAndOverflow(): void {
  const now = Date.now()
  for (const [schema, entry] of clients) {
    if (now - entry.usedAt > IDLE_MS) evict(schema)
  }
  while (clients.size >= MAX_CLIENTS) {
    const oldest = [...clients.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)[0]
    evict(oldest[0])
  }
}

/** The client a project's function SQL runs on, logged in as its own role. */
export async function functionDbClient(projectId: string): Promise<FunctionDbHandle> {
  const schema = await resolveWorkspaceSchema(projectId)
  if (!SCHEMA_RE.test(schema)) {
    throw new FunctionDbRoleUnavailableError(`"${schema}" is not a workspace schema`)
  }

  const now = Date.now()
  const cached = clients.get(schema)
  if (cached && now - cached.syncedAt < SYNC_TTL_MS) {
    cached.usedAt = now
    return cached.handle
  }

  // Calls that arrive together share one sync and one client. Each used to run
  // its own: the syncs raced on the same role (one answered 500, found by
  // fuzzing the data API), and each built a client, the last one replacing the
  // others without closing them.
  const inFlight = syncing.get(schema)
  if (inFlight) return inFlight
  const run = (async () => {
    const password = functionRolePassword(schema)
    const role = await syncRole(projectId, schema, password)
    if (cached) {
      cached.syncedAt = now
      cached.usedAt = now
      return cached.handle
    }

    evictIdleAndOverflow()
    const client = new PrismaClient({
      datasourceUrl: functionDatabaseUrl(role, password, await projectDatabaseUrl(projectId)),
    })
    const handle = { client, schema, role }
    clients.set(schema, { handle, syncedAt: now, usedAt: now })
    return handle
  })()
  syncing.set(schema, run)
  try {
    return await run
  } finally {
    syncing.delete(schema)
  }
}

/**
 * Drop the project's client and sync, so the next call re-asserts the role.
 * Used after the login is refused, e.g. once a rotated secret changed the
 * derived password.
 */
export async function forgetFunctionDbClient(projectId: string): Promise<void> {
  evict(await resolveWorkspaceSchema(projectId))
}
