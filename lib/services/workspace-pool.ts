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
export async function queryWorkspace<T extends Record<string, unknown> = Record<string, unknown>>(
  projectId: string,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const client = await acquireWorkspaceClient(projectId)
  try {
    const result: QueryResult<T> = await client.query(sql, params)
    return result.rows
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
