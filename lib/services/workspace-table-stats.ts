/**
 * Unified workspace table-stats kernel — single source of truth for table row
 * counts across the platform.
 *
 * Every UI that displays "X rows" for a workspace table — the Dashboard card,
 * the Inspector sidebar, the Inspector data-pane badge — reads through this
 * kernel. The three independent call sites that used to compute the same
 * number three different ways (real COUNT via pool, real COUNT via Prisma,
 * `pg_class.reltuples` via Prisma) have all been collapsed onto this one path.
 *
 * Strategy:
 *   • Real COUNT(*) via the per-project workspace pool. `pg_class.reltuples`
 *     is unusable for fresh tables — it returns -1 until autovacuum runs
 *     ANALYZE, which is why the inspector sidebar used to show "-1" next to
 *     every newly-created table.
 *   • 30s in-process cache keyed by (projectId, tableName). Repeat dashboard
 *     paints don't re-run COUNT on every render.
 *   • Cache invalidation on every write path (insertRow / updateRow /
 *     deleteRow / table create / drop). A delete propagates to the dashboard
 *     within one render, not on next mount.
 *   • Schema name and search_path come from the workspace pool — never
 *     re-derived here. The pool already SETs search_path to the project's
 *     schema, so unqualified table references resolve correctly.
 *   • Tables above COUNT_HARD_CEILING (1M rows) fall back to the planner
 *     estimate and are flagged `estimated: true` so callers can render a "≈"
 *     prefix instead of pretending exactness.
 *
 * Throws `InvalidProjectIdError` if projectId isn't a valid UUID — defensive,
 * same rule as the canonical schema-name helper.
 */

import { queryWorkspace, queryWorkspaceAsOwner } from './workspace-pool'
import { assertValidProjectId, quoteIdent, notReservedTableSql } from '@/lib/security/workspace-schema'

export interface TableStat {
  name: string
  rows: number
  bytes: number | null
  /** True when the count is a planner estimate (only for tables above COUNT_HARD_CEILING). */
  estimated: boolean
}

const TTL_MS = 30_000
/** Tables above this size use the planner estimate — COUNT(*) at this scale is too expensive per render. */
const COUNT_HARD_CEILING = 1_000_000

interface CacheEntry { value: TableStat; at: number }
const cache = new Map<string, Map<string, CacheEntry>>()

function projectCache(projectId: string): Map<string, CacheEntry> {
  let pc = cache.get(projectId)
  if (!pc) { pc = new Map(); cache.set(projectId, pc) }
  return pc
}

/**
 * Bust the cached count for one table, or every table in the project.
 *
 * Called from every write path so the dashboard and the inspector never show
 * a stale "X rows" badge after an insert / update / delete / drop. Safe to
 * call from anywhere — no DB hit, just a map delete.
 */
export function invalidateTableStats(projectId: string, tableName?: string): void {
  if (!tableName) { cache.delete(projectId); return }
  const pc = cache.get(projectId)
  if (pc) pc.delete(tableName)
}

/**
 * List every live table in the workspace with its current row count, sorted
 * by row count descending so the heaviest tables surface first.
 *
 * Drives both the dashboard "Database" card and the inspector Tables sidebar.
 * The 30s cache means a page with both surfaces only pays one COUNT round-trip
 * per table per half-minute.
 */
export async function listTableStats(projectId: string): Promise<TableStat[]> {
  assertValidProjectId(projectId)

  const tableRows = await queryWorkspace<{ table_name: string }>(
    projectId,
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_type = 'BASE TABLE'
        AND ${notReservedTableSql('table_name')}
      ORDER BY table_name`,
  )

  if (tableRows.length === 0) return []

  const out = await Promise.all(
    tableRows.map((r) => getTableStat(projectId, r.table_name)),
  )
  return out.sort((a, b) => b.rows - a.rows)
}

/**
 * Get the cached row count for a single table; re-fetches if the cache entry
 * is missing or older than TTL_MS.
 *
 * Returns `{ rows: 0, bytes: null, estimated: false }` if the table doesn't
 * exist — silent because a dashboard render shouldn't crash just because a
 * table was dropped between fetches.
 */
export async function getTableStat(projectId: string, tableName: string): Promise<TableStat> {
  assertValidProjectId(projectId)
  const pc = projectCache(projectId)
  const hit = pc.get(tableName)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  return refresh(projectId, tableName)
}

async function refresh(projectId: string, tableName: string): Promise<TableStat> {
  const pc = projectCache(projectId)

  // pg_total_relation_size and reltuples in one round-trip. reltuples can be
  // -1 (never analyzed) — that's fine; we only use it as a fast-path for the
  // COUNT_HARD_CEILING short-circuit, never as the displayed number for small
  // tables.
  let bytes: number | null = null
  let reltuples = -1
  try {
    const meta = await queryWorkspace<{ bytes: string; reltuples: string }>(
      projectId,
      `SELECT pg_total_relation_size((current_schema() || '.' || quote_ident($1::text))::regclass)::text AS bytes,
              c.reltuples::bigint::text AS reltuples
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = $1`,
      [tableName],
    )
    if (meta[0]) {
      bytes = Number(meta[0].bytes ?? 0)
      reltuples = Number(meta[0].reltuples ?? -1)
    }
  } catch {
    // table may not exist — fall through with zero count.
  }

  // Huge-table fast path. Anything beyond a million rows pays the estimate
  // tax — at that scale, COUNT(*) is many hundreds of ms per render and the
  // user trades a tiny accuracy gap for a responsive UI.
  if (reltuples > COUNT_HARD_CEILING) {
    const stat: TableStat = { name: tableName, rows: reltuples, bytes, estimated: true }
    pc.set(tableName, { value: stat, at: Date.now() })
    return stat
  }

  // search_path is already set by the workspace pool — unqualified table
  // reference resolves to the project's schema. No schema-name interpolation
  // here means the hyphen-vs-underscore class of bug literally cannot occur.
  let rows = 0
  try {
    // Owner context: FORCE RLS binds the table owner too, so an uncontexted
    // COUNT(*) reports 0 on every policy-protected table — which is what made
    // the inspector show an empty database that was not empty.
    const result = await queryWorkspaceAsOwner<{ count: string }>(
      projectId,
      `SELECT COUNT(*)::text AS count FROM ${quoteIdent(tableName)}`,
    )
    rows = Number(result[0]?.count ?? 0)
  } catch {
    rows = 0
  }

  const stat: TableStat = { name: tableName, rows, bytes, estimated: false }
  pc.set(tableName, { value: stat, at: Date.now() })
  return stat
}
