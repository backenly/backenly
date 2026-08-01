/**
 * WORKSPACE CONNECTION POOL MANAGER
 * ===================================
 * Maintains a per-project pg.Pool so workspace queries are served from
 * pre-established connections instead of creating a new connection for
 * every SET search_path + query pair.
 *
 * Why: Every workspace query currently opens a Prisma transaction which
 * acquires a connection from the shared pool, runs SET LOCAL search_path,
 * executes the query, then releases. Under load this causes pool exhaustion
 * because each concurrent request holds a connection for the full RTT.
 *
 * Solution: Dedicated Pool per project (up to MAX_POOLS total) with a
 * LRU eviction policy so idle projects don't waste connections.
 *
 * Pool parameters (can be overridden via env):
 *   WORKSPACE_POOL_MAX        — max connections per project (default: 5)
 *   WORKSPACE_POOL_IDLE_MS    — idle timeout per connection (default: 10s)
 *   WORKSPACE_POOL_MAX_POOLS  — max simultaneous project pools (default: 50)
 *   WORKSPACE_STATEMENT_TIMEOUT_MS — per-query timeout (default: 5000ms)
 *
 * Usage:
 *   import { queryWorkspace, executeWorkspace } from '@/lib/services/workspace-pool'
 *   const rows = await queryWorkspace(projectId, 'SELECT * FROM orders', [])
 */

import { Pool, PoolClient, QueryResult } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { getWorkspaceDatabaseNames } from './databaseProvisioning'

const POOL_MAX = parseInt(process.env.WORKSPACE_POOL_MAX ?? '5', 10)
const POOL_IDLE_MS = parseInt(process.env.WORKSPACE_POOL_IDLE_MS ?? '10000', 10)
const MAX_POOLS = parseInt(process.env.WORKSPACE_POOL_MAX_POOLS ?? '50', 10)
const STATEMENT_TIMEOUT_MS = parseInt(process.env.WORKSPACE_STATEMENT_TIMEOUT_MS ?? '5000', 10)

interface PoolEntry {
  pool: Pool
  lastUsed: number
}

// LRU map: key = projectId, value = PoolEntry
const pools = new Map<string, PoolEntry>()

function getOrCreatePool(projectId: string): Pool {
  const existing = pools.get(projectId)
  if (existing) {
    existing.lastUsed = Date.now()
    return existing.pool
  }

  // Evict LRU entry when at capacity
  if (pools.size >= MAX_POOLS) {
    let oldestKey: string | null = null
    let oldestTime = Infinity
    for (const [key, entry] of pools.entries()) {
      if (entry.lastUsed < oldestTime) {
        oldestTime = entry.lastUsed
        oldestKey = key
      }
    }
    if (oldestKey) {
      const evicted = pools.get(oldestKey)!
      pools.delete(oldestKey)
      // End the pool gracefully — don't wait so we don't block the caller
      evicted.pool.end().catch(() => {})
    }
  }

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('DATABASE_URL is not set')

  const pool = new Pool({
    connectionString: dbUrl,
    max: POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_MS,
    // Statement timeout is set per-query inside acquireWorkspaceClient()
  })

  // Log pool errors so they surface in server logs without crashing
  pool.on('error', (err) => {
    console.error(`[WorkspacePool] Pool error for project ${projectId}:`, err.message)
  })

  pools.set(projectId, { pool, lastUsed: Date.now() })
  return pool
}

/**
 * Resolve the project's workspace schema name — the SINGLE source of truth.
 *
 * This MUST match exactly what lib/services/workspaceDatabase.ts uses to
 * substitute the `{schema}` token, otherwise SET search_path and the
 * schema-qualified queries disagree and `current_schema()` silently falls
 * back to `public` (Postgres does not error on a missing schema in
 * search_path). That divergence is precisely how the dashboard once listed
 * the platform's own Prisma tables instead of the project's tables.
 *
 * Precedence (identical to workspaceDatabase.getWorkspaceSchema):
 *   1. The stored Workspace.postgresSchema column — authoritative even if a
 *      project was provisioned under a legacy naming rule.
 *   2. getWorkspaceDatabaseNames(projectId).postgresSchema — the canonical
 *      sanitiser (keeps hyphens), used at provision/CREATE-TABLE time.
 *
 * Never re-derive this with an ad-hoc regex. The schema name for a project
 * never changes, so we cache it per projectId to keep the hot path cheap.
 */
const schemaNameCache = new Map<string, string>()

export async function resolveWorkspaceSchema(projectId: string): Promise<string> {
  const cached = schemaNameCache.get(projectId)
  if (cached) return cached

  const fallback = getWorkspaceDatabaseNames(projectId).postgresSchema
  let schemaName = fallback
  try {
    const ws = await prisma.workspace.findFirst({
      where: { projectId },
      select: { postgresSchema: true },
    })
    if (ws?.postgresSchema) schemaName = ws.postgresSchema
  } catch {
    // DB lookup failed — fall back to the canonical computed name rather
    // than block the query. Don't cache a fallback derived from an error;
    // a later call may resolve the authoritative stored value.
    return fallback
  }

  schemaNameCache.set(projectId, schemaName)
  return schemaName
}

/**
 * Acquire a client from the project pool, set the workspace search_path, and
 * apply the statement timeout.  The caller MUST release the client via
 * client.release() — use acquireWorkspaceClient() in a try/finally block or
 * prefer queryWorkspace() / executeWorkspace() helpers below.
 */
export async function acquireWorkspaceClient(projectId: string): Promise<PoolClient> {
  const schemaName = await resolveWorkspaceSchema(projectId)
  const pool = getOrCreatePool(projectId)
  const client = await pool.connect()

  try {
    // Set search_path AND statement timeout for every acquired connection.
    // Using SET (not SET LOCAL) so the setting persists for the lifetime of
    // this pool connection — avoids re-sending it on every query.
    await client.query(
      `SET search_path TO "${schemaName}", public; SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`
    )
  } catch (err) {
    client.release(true) // destroy this connection — don't reuse with wrong state
    throw err
  }

  return client
}

/**
 * Run a parameterised query in the project's workspace schema.
 * Handles connection acquisition, search_path, timeout, and release.
 */
/**
 * Highest `$n` placeholder in a statement — the number of parameters Postgres
 * will demand. Placeholders inside string literals and line comments do not
 * count, because Postgres does not treat them as parameters either; a probe
 * whose WHERE clause searches for the literal text '$1' must not be read as
 * taking a parameter.
 */
export function requiredParamCount(sql: string): number {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$([A-Za-z_]\w*)\$[\s\S]*?\$\1\$/g, ' ') // dollar-quoted bodies
  const found = stripped.match(/\$(\d+)/g)
  if (!found) return 0
  return Math.max(...found.map((p) => Number(p.slice(1))))
}

/**
 * THE SILENT-PROBE GUARD.
 *
 * A statement whose parameter count disagrees with the arguments handed to it is
 * rejected by Postgres before it runs — "bind message supplies N parameters, but
 * prepared statement requires M". That error is correct and immediate, and it
 * has still cost this codebase three separate outages, because every caller that
 * makes this mistake is a PROBE, and probes wrap their queries in a fail-soft
 * catch. The rejection becomes an empty result, an empty result reads as "I
 * looked and found nothing", and a detector reports healthy forever without ever
 * having run:
 *
 *   detectMissingRls       passed `schemaName` twice to a one-placeholder query.
 *                          The flagship security probe was dead in EVERY
 *                          environment for months while the dashboard was green.
 *   getEndUserAuthUsage    passed a parameter to a statement with none, so
 *                          `hasIdentities` was false on every project ever, and
 *                          the auth evidence gate ran on half its evidence.
 *
 * Postgres already catches this; what it cannot do is stop the caller swallowing
 * it. So the check moves to where the swallow cannot reach — before the query is
 * issued — and throws a message that names the mismatch instead of a generic
 * bind error. A fail-soft catch will still swallow THIS throw, which is why the
 * companion guard (tests/unit/probe-query-contract.spec.ts) asserts the message
 * shape: any probe fixture exercising a mismatched call now fails loudly with a
 * sentence that says exactly what is wrong, rather than silently returning [].
 *
 * Deliberately not a lint rule. The SQL in this codebase is assembled from
 * template literals and helper fragments (`notReservedTableSql`), so a static
 * pass cannot count placeholders without evaluating them — and a linter that is
 * wrong about a third of the call sites gets suppressed, which is worse than no
 * linter. Counting at runtime is exact, needs no allowlist, and the probe
 * fixtures now execute every one of these paths in CI.
 */
function assertParamArity(projectId: string, sql: string, params: unknown[]): void {
  const required = requiredParamCount(sql)
  if (required === params.length) return
  const preview = sql.trim().replace(/\s+/g, ' ').slice(0, 120)
  throw new Error(
    `[workspace-query] parameter arity mismatch for project ${projectId}: ` +
      `the statement uses ${required} placeholder(s) but ${params.length} argument(s) were supplied. ` +
      `Postgres would reject this bind, and a fail-soft catch would turn that into an empty ` +
      `result — i.e. a probe that reports "nothing found" without ever running. ` +
      `Statement: ${preview}${sql.trim().length > 120 ? '…' : ''}`,
  )
}

export async function queryWorkspace<T extends Record<string, unknown> = Record<string, unknown>>(
  projectId: string,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  assertParamArity(projectId, sql, params)
  const client = await acquireWorkspaceClient(projectId)
  try {
    const result: QueryResult<T> = await client.query(sql, params)
    return result.rows
  } finally {
    client.release()
  }
}

/**
 * Run a query in the workspace schema AS THE PROJECT OWNER — RLS applies, but
 * the service-role escape every Backenly policy carries is satisfied.
 *
 * ── Why this is a separate function ────────────────────────────────────────
 *
 * `queryWorkspace` sets search_path and a statement timeout and nothing else,
 * so a query it runs arrives with no RLS session variables at all. Under FORCE
 * ROW LEVEL SECURITY — which every workspace table has, and which binds the
 * table's owner too — `backenly_jwt_claim('sub')` is then null and the
 * service-role clause is false, so an owner-scoped policy matches no rows.
 *
 * `SELECT COUNT(*)` therefore returned 0 for tables holding real data, and the
 * dashboard rendered "Table is empty · No rows yet. Data lands here the moment
 * your app or agent writes to it" over a table the customer's app was reading
 * from successfully. The count is not wrong about the query; the query was
 * asking as nobody.
 *
 * This is deliberately NOT folded into `queryWorkspace`. That function is used
 * by paths that must stay subject to policy, and quietly granting all of them a
 * service-role context would turn a display bug into a data-exposure one. Ask
 * for owner context explicitly, at the call site that needs it.
 */
export async function queryWorkspaceAsOwner<T extends Record<string, unknown> = Record<string, unknown>>(
  projectId: string,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  assertParamArity(projectId, sql, params)
  const { rlsSessionSql, rlsSessionParams } = await import('./rls-session')
  const client = await acquireWorkspaceClient(projectId)
  try {
    // `set_config(..., true)` is transaction-local, so the elevated context
    // cannot leak to the next borrower of this pooled connection.
    await client.query('BEGIN')
    try {
      await client.query(
        rlsSessionSql(),
        rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }),
      )
      const result: QueryResult<T> = await client.query(sql, params)
      await client.query('COMMIT')
      return result.rows
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    client.release()
  }
}

/**
 * Run a parameterised DML (INSERT / UPDATE / DELETE) in the project's workspace schema.
 * Returns the number of affected rows.
 */
export async function executeWorkspace(
  projectId: string,
  sql: string,
  params: unknown[] = []
): Promise<number> {
  assertParamArity(projectId, sql, params)
  const client = await acquireWorkspaceClient(projectId)
  try {
    const result = await client.query(sql, params)
    return result.rowCount ?? 0
  } finally {
    client.release()
  }
}

/**
 * Run multiple statements in a single workspace transaction.
 * The callback receives the pg.PoolClient — call client.query() directly.
 * Automatically COMMIT on success, ROLLBACK on throw.
 */
export async function withWorkspaceTransaction<T>(
  projectId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await acquireWorkspaceClient(projectId)
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Gracefully shut down all pools — called on server shutdown.
 */
export async function closeAllWorkspacePools(): Promise<void> {
  const endings = [...pools.values()].map(e => e.pool.end().catch(() => {}))
  pools.clear()
  await Promise.all(endings)
}

// Graceful shutdown hooks (server-side only)
if (typeof window === 'undefined') {
  process.on('SIGTERM', () => closeAllWorkspacePools().catch(() => {}))
  process.on('SIGINT',  () => closeAllWorkspacePools().catch(() => {}))
}
