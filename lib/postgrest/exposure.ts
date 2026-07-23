/**
 * PHASE 3 — which tables the PostgREST data plane is allowed to serve.
 *
 * The legacy executor answered this implicitly: it looked up an `ApiDefinition`
 * and 404'd when there wasn't one. That lookup was doing real authorization work
 * that is easy to mistake for routing. It is what kept `users` off the public
 * API, what made a disabled resource stop responding, and what made per-operation
 * toggles mean anything.
 *
 * PostgREST has no equivalent — it serves every table the role can reach. Moving
 * execution to PostgREST therefore does not just change how a query runs, it
 * removes an authorization gate unless that gate is rebuilt here.
 *
 * Database grants are the primary defence for credential tables (see
 * `scripts/sql/postgrest-schema-registry.sql`); this module is the second layer
 * and the one that carries per-resource and per-operation intent, which grants
 * cannot express.
 */

import { prisma } from '@/lib/db'

export type Operation = 'list' | 'get' | 'create' | 'update' | 'delete'

export interface ExposureDecision {
  allowed: boolean
  /** Present when denied — already safe to return to the caller. */
  status?: number
  error?: string
  code?: string
  /** True when the table carries a deleted_at column. */
  hasSoftDelete?: boolean
}

/** Method + shape → the operation the old executor would have named. */
export function operationFor(method: string, hasRecordId: boolean): Operation | null {
  switch (method.toUpperCase()) {
    case 'GET':    return hasRecordId ? 'get' : 'list'
    case 'POST':   return 'create'
    case 'PUT':
    case 'PATCH':  return hasRecordId ? 'update' : null
    case 'DELETE': return hasRecordId ? 'delete' : null
    default:       return null
  }
}

/**
 * PostgREST would happily serve these. The legacy API never did, because no
 * ApiDefinition was ever generated for them. Listed explicitly so the denial is
 * a stated rule rather than an accident of what the generator happens to skip.
 */
const NEVER_EXPOSED = new Set(['users'])

function isInternalTable(table: string): boolean {
  return table.startsWith('_') || NEVER_EXPOSED.has(table.toLowerCase())
}

/**
 * Deny-list only. The catalog decides what exists; grants and RLS decide who may
 * touch it. This function's whole job is refusing the tables that must never be
 * client-reachable by NAME, early and cheaply.
 *
 * ── Why ApiDefinition no longer gates this (2026-07-21) ─────────────────────
 *
 * It used to require an `ApiDefinition` row and 404 without one. That made sense
 * when the legacy executor served only tables an ApiDefinition existed for — the
 * row WAS the exposure decision.
 *
 * Under PostgREST it is a second source of truth for a question Postgres already
 * answers, and a strictly worse one: a table can exist and be grant-reachable
 * while its projection is missing, stale, or disabled. Every combination is a
 * way for the dashboard and the runtime to disagree — which they did. The APIs
 * page was advertising CRUD on `_email_verifications`, a table the runtime 404s
 * and Postgres has revoked.
 *
 * This is how PostgREST works: the API is the schema. Fewer things
 * that can disagree is also the property self-healing depends on — drift scales
 * with the number of sources of truth.
 *
 * ── What now protects a row ─────────────────────────────────────────────────
 *
 * RLS, alone. Removing this gate removed the second lock, so
 * `backenly_pgrst_cutover_blockers` REFUSES any schema containing a
 * client-reachable table with RLS disabled — proven to fire and to go quiet
 * again. That blocker is not optional decoration; it is the other half of this
 * change, and this comment exists so nobody relaxes it without knowing that.
 */
export async function checkExposure(
  projectId: string,
  table: string,
  _operation: Operation,
): Promise<ExposureDecision> {
  if (isInternalTable(table)) {
    // Deliberately the same 404 an unknown table gets. A distinct "forbidden"
    // would confirm the table exists, which is a small disclosure but a free one
    // to avoid.
    return { allowed: false, status: 404, error: `Resource "${table}" not found`, code: 'NOT_FOUND' }
  }

  // Per-operation gating is gone with the ApiDefinition it was stored on.
  // PostgREST expresses the same thing as grants (SELECT/INSERT/UPDATE/DELETE
  // per role), which is enforced by the database rather than by remembering to
  // check a JSON column — and cannot be bypassed by reaching the table another
  // way. A table that genuinely must be read-only is granted read-only.
  return { allowed: true }
}

/**
 * `operations` is stored in more than one shape across the table's history
 * (string array, object-with-method array, keyed object). Every shape is
 * handled, and an UNRECOGNISED shape denies rather than allows — a stored value
 * this code cannot read is not evidence of permission.
 */
export function isOperationEnabled(operations: unknown, operation: Operation): boolean {
  const METHOD_FOR: Record<Operation, string[]> = {
    list:   ['get', 'list'],
    get:    ['get', 'list'],
    create: ['post', 'create'],
    update: ['put', 'patch', 'update'],
    delete: ['delete'],
  }
  const wanted = METHOD_FOR[operation]

  if (Array.isArray(operations)) {
    const names = operations
      .map(o => (typeof o === 'string' ? o : (o as any)?.method ?? (o as any)?.name ?? ''))
      .filter(Boolean)
      .map(s => String(s).toLowerCase())
    if (names.length === 0) return false
    return names.some(n => wanted.includes(n))
  }

  if (operations && typeof operations === 'object') {
    const obj = operations as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      if (wanted.includes(k.toLowerCase()) && v !== false) return true
    }
    return false
  }

  return false
}

/**
 * Does this table have a `deleted_at` column?
 *
 * Read from the live catalog rather than from an ApiDefinition, because the
 * soft-delete predicate must reflect the table as it actually is. Cached per
 * request-burst; a wrong answer in the permissive direction would expose deleted
 * rows, so a failed lookup is treated as "yes, filter them out".
 */
const softDeleteCache = new Map<string, { value: boolean; expiresAt: number }>()
const SOFT_DELETE_TTL_MS = 60_000

export async function tableHasSoftDelete(schema: string, table: string): Promise<boolean> {
  const cacheKey = `${schema}.${table}`
  const hit = softDeleteCache.get(cacheKey)
  if (hit && hit.expiresAt > Date.now()) return hit.value

  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = 'deleted_at'`,
      schema,
      table,
    )
    const value = Number(rows[0]?.n ?? 0) > 0
    softDeleteCache.set(cacheKey, { value, expiresAt: Date.now() + SOFT_DELETE_TTL_MS })
    return value
  } catch (err) {
    console.error(
      `[postgrest/exposure] Could not determine soft-delete for ${cacheKey}; ` +
      `filtering deleted rows out as a precaution.`,
      err instanceof Error ? err.message : err,
    )
    // Filtering a column that does not exist yields a PostgREST error, which is
    // a visible failure. The opposite mistake serves deleted rows silently.
    return true
  }
}

export function clearSoftDeleteCache(): void {
  softDeleteCache.clear()
}
