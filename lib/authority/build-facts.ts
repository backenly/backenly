/**
 * BUILD FACTS — what an index would occupy, read before deciding who builds it
 * ===========================================================================
 *
 * The authority decision bounds what an action may build on its own
 * (ActionClass.buildBounds): how big a table, how much of the storage the
 * account's plan includes. This reads the facts it is judged on. Read-only, on
 * the project's own database; nothing here is a guess dressed as a number:
 * what cannot be read is null, and the decision sends null to a person.
 *
 * ── The size of an index that does not exist yet ────────────────────────────
 *
 * A btree leaf entry is an 8-byte IndexTupleData header and the key, aligned to
 * 8 bytes, plus a 4-byte line pointer; a page holds 8,152 bytes of them, filled
 * to 90% when built (PostgreSQL's btree defaults). From the planner's row count
 * (pg_class.reltuples) and the column's average width (pg_stats.avg_width)
 * that is the leaf level; the upper levels are under 1% of it and are counted
 * generously. Deduplication only makes it smaller.
 *
 * The table bounds the estimate from above. A heap row carries a 24-byte header
 * and its line pointer and every column, an index entry an 8-byte header, its
 * line pointer and one column, and the heap is filled to 100% against the
 * index's 90%: a one-column index is not larger than its table's heap / 0.9.
 * When the planner has no statistics (a table never analyzed), that bound is
 * the estimate.
 *
 * ── A column's width under row-level security ───────────────────────────────
 *
 * `pg_stats` leaves out every table on which row-level security is active for
 * the reader (PostgreSQL 16 system_views.sql: `NOT row_security_active(c.oid)`),
 * so the planner's statistics stay out of the policies' reach. Every workspace
 * table is FORCE ROW LEVEL SECURITY and the application role is NOBYPASSRLS, so
 * in production `avg_width` was always null and every estimate was the whole
 * heap. For a 1,000,002-row table that read about twice the real size and took
 * the account past the 90% of storage Backenly leaves to a person (production
 * QA, 2026-11-16). The width is then measured instead: the average stored size
 * of the column over a page sample of about 2,000 rows, read as the service
 * role, whose escape every Backenly policy carries. Only the average leaves the
 * database. A table whose policies admit no service role gives no sample, and
 * the bound stands.
 */

import type { BuildFacts } from './decision'
import { quoteIdent } from '@/lib/security/workspace-schema'

const PAGE = 8192
/** Page minus its 24-byte header and the btree's 16-byte special space. */
const LEAF_SPACE = PAGE - 24 - 16
const LEAF_FILL = 0.9

const align8 = (n: number) => Math.ceil(n / 8) * 8

/** Bytes a one-column btree over `rows` rows of average width `avgWidth` would take. */
export function estimateBtreeBytes(rows: number, avgWidth: number): number {
  const entry = align8(8 + Math.max(1, avgWidth)) + 4
  const perLeaf = Math.max(1, Math.floor((LEAF_SPACE * LEAF_FILL) / entry))
  const leaves = Math.ceil(Math.max(0, rows) / perLeaf)
  // Upper levels, generously, and the metapage.
  return (leaves + Math.ceil(leaves / 100) + 1) * PAGE
}

/** The most a one-column index over a heap of this size can take. */
export function heapBoundBytes(heapBytes: number): number {
  return Math.ceil(heapBytes / LEAF_FILL) + 2 * PAGE
}

/** Rows a width sample aims for: enough for an average, few enough to be cheap. */
const SAMPLE_ROWS = 2_000

/** The share of pages, in percent, that holds about SAMPLE_ROWS rows. */
export function samplePercent(rows: number): number {
  if (!(rows > 0)) return 100
  return Math.min(100, Math.max(0.01, (100 * SAMPLE_ROWS) / rows))
}

/**
 * The column's average stored width, measured on a page sample read as the
 * service role, or null when nothing could be sampled. Used only when pg_stats
 * hides the column (see the header).
 */
async function sampledWidth(projectId: string, schema: string, table: string, column: string, rows: number): Promise<number | null> {
  const { queryWorkspaceAsOwner } = await import('@/lib/services/workspace-pool')
  const sample = await queryWorkspaceAsOwner<{ width: number | null; sampled: number }>(
    projectId,
    `SELECT avg(pg_column_size(s.v))::float8 AS width, count(*)::int AS sampled
       FROM (SELECT t.${quoteIdent(column)} AS v
               FROM ${quoteIdent(schema)}.${quoteIdent(table)} t TABLESAMPLE SYSTEM ($1)
              LIMIT ${SAMPLE_ROWS}) s`,
    [samplePercent(rows)],
  )
  const w = sample[0]
  return w && w.sampled > 0 && w.width !== null && Number.isFinite(Number(w.width)) ? Number(w.width) : null
}

export async function readIndexBuildFacts(projectId: string, table: string, column: string | null): Promise<BuildFacts> {
  let tableBytes: number | null = null
  let partitioned = false
  let estimatedBytes: number | null = null
  try {
    const { resolveWorkspaceSchema } = await import('@/lib/services/workspace-pool')
    const { workspaceRawClient } = await import('@/lib/data-plane/regional')
    const schema = await resolveWorkspaceSchema(projectId)
    const db = await workspaceRawClient(projectId)
    const rows = await db.$queryRawUnsafe<Array<{ kind: string; heap: string; reltuples: number; width: number | null }>>(
      `SELECT c.relkind::text AS kind,
              pg_relation_size(c.oid)::text AS heap,
              c.reltuples::float8 AS reltuples,
              (SELECT s.avg_width FROM pg_stats s
                WHERE s.schemaname = $1 AND s.tablename = $2 AND s.attname = $3 LIMIT 1) AS width
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`,
      schema,
      table,
      column ?? '',
    )
    const r = rows[0]
    if (r) {
      partitioned = r.kind === 'p'
      tableBytes = Number(r.heap)
      if (!Number.isFinite(tableBytes)) tableBytes = null
      if (tableBytes !== null) {
        const bound = heapBoundBytes(tableBytes)
        const reltuples = Number(r.reltuples)
        let width = r.width === null ? null : Number(r.width)
        // Hidden by row-level security, not absent: measure it (see the header).
        if (width === null && column && reltuples > 0) {
          width = await sampledWidth(projectId, schema, table, column, reltuples).catch(() => null)
        }
        const fromStats = width !== null && reltuples >= 0 ? estimateBtreeBytes(reltuples, width) : null
        estimatedBytes = fromStats === null ? bound : Math.min(fromStats, bound)
      }
    }
  } catch {
    tableBytes = null
    estimatedBytes = null
  }

  let storage: BuildFacts['storage']
  try {
    const { accountDbStorage } = await import('@/lib/quota/kernel')
    storage = await accountDbStorage(projectId)
  } catch {
    storage = 'unknown'
  }
  return { tableBytes, partitioned, estimatedBytes, storage }
}
