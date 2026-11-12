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
 */

import type { BuildFacts } from './decision'

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
        const fromStats = r.width !== null && Number(r.reltuples) >= 0 ? estimateBtreeBytes(Number(r.reltuples), Number(r.width)) : null
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
