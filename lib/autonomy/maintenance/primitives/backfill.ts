/**
 * BACKFILL — catching up the rows that already existed
 * ====================================================
 *
 * `dual_write` keeps the target column correct for every write from now on.
 * This fills in the rows that were written before it was installed, in bounded
 * batches, resumably.
 *
 * ── Why `RUN_DATA_MIGRATION` could not be reused ────────────────────────────
 *
 * It has a `backfill` op and it is atomic by design: one statement, one
 * transaction, every row. On a small table that is the right answer. On a live
 * one it takes a row lock on the entire table and holds it until it finishes,
 * which is a write outage measured in however long the table takes — and if it
 * is killed at 95% it has done nothing at all.
 *
 * So this is batched and resumable instead, and `classifyMaintenanceStep` calls
 * it Tier 2: additive in schema terms, emphatically not additive in cost.
 *
 * ── The cursor advances over rows SCANNED, not rows WRITTEN ─────────────────
 *
 * Each batch skips rows already equal to `transform(source)`, so re-running it
 * is cheap and idempotent. But a batch where every row was already correct
 * writes nothing, and a cursor that only advanced past written rows would then
 * never move: the job would re-scan the same window forever, making progress
 * that a "rows updated" counter would report as zero. The cursor is the largest
 * key the batch LOOKED at.
 *
 * ── Lock timeout is transaction-local, on this transaction ──────────────────
 *
 * `SET LOCAL lock_timeout` applies to the transaction it runs in, and Prisma
 * pools connections — so issuing it through a pooled helper sets it on whichever
 * connection answered, for whatever runs there next, and not necessarily on the
 * statement it was meant to bound. `prisma.$transaction` pins one connection for
 * its callback, which is why the SET and the UPDATE are inside it together.
 *
 * A batch that cannot take its locks in time raises, does not retry in place,
 * and leaves the cursor where it was. BackgroundJob owns what happens next:
 * attempts, backoff, dead-lettering. None of that is reimplemented here.
 */

import { prisma } from '@/lib/db'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { transformProblem, transformSql, type Transform } from '../transform'

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Rows per batch. Small enough that one batch is never a visible stall. */
export const DEFAULT_BATCH_ROWS = 2_000

/** How long a batch waits for its locks before giving up. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000

export interface BackfillSpec {
  projectId: string
  table: string
  sourceColumn: string
  targetColumn: string
  transform: Transform
  batchRows?: number
  lockTimeoutMs?: number
}

export interface BackfillBatchResult {
  /** Rows the batch examined. Less than the batch size means the table ended. */
  scanned: number
  /** Rows actually written. Zero is normal and is not "no progress". */
  updated: number
  /** Where the next batch resumes. Null when there is nothing left. */
  cursor: string | null
  done: boolean
  refusal: string | null
}

interface KeyFact { column: string; udt: string }

/**
 * The primary key, and its type.
 *
 * The type matters: the cursor is carried between jobs as text, and comparing
 * it as text would order `10` before `9` on an integer key — skipping most of
 * the table while reporting a clean finish. It is cast back to the column's own
 * type for every comparison.
 */
async function primaryKey(schema: string, table: string): Promise<KeyFact | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string; udt_name: string }>>(
    `SELECT kcu.column_name, c.udt_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       JOIN information_schema.columns c
         ON c.table_schema = kcu.table_schema AND c.table_name = kcu.table_name
        AND c.column_name = kcu.column_name
      WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
    schema,
    table,
  ).catch(() => [])

  // A composite key has no single ordering column to resume from, so it is a
  // refusal rather than a guess at which part to page by.
  if (rows.length !== 1) return null
  const { column_name: column, udt_name: udt } = rows[0]
  if (!IDENT.test(column) || !IDENT.test(udt)) return null
  return { column, udt }
}

/**
 * Run one batch, starting after `cursor`.
 *
 * Returns a refusal rather than throwing for anything decided before the write.
 * A failure DURING the write — a lock timeout, a bad cast — throws, because that
 * is what BackgroundJob's retry lifecycle is for.
 */
export async function runBackfillBatch(
  spec: BackfillSpec,
  cursor: string | null,
): Promise<BackfillBatchResult> {
  const { projectId, table, sourceColumn, targetColumn } = spec
  const batchRows = Math.max(1, Math.floor(spec.batchRows ?? DEFAULT_BATCH_ROWS))
  const lockTimeoutMs = Math.max(1, Math.floor(spec.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS))
  const refuse = (refusal: string): BackfillBatchResult => ({
    scanned: 0, updated: 0, cursor, done: false, refusal,
  })

  if (![table, sourceColumn, targetColumn].every(x => IDENT.test(x))) {
    return refuse('table or column name is not a valid identifier')
  }
  if (sourceColumn === targetColumn) return refuse('source and target are the same column')
  const problem = transformProblem(spec.transform)
  if (problem) return refuse(problem)

  const schema = await resolveWorkspaceSchema(projectId)
  const key = await primaryKey(schema, table)
  if (!key) {
    return refuse(`table "${table}" has no single-column primary key to resume from`)
  }

  // $1 is the cursor; the transform appends its own values after it. Aliased to
  // `t` because the UPDATE has the batch CTE in scope beside the table.
  const params: unknown[] = [cursor]
  const expected = transformSql(spec.transform, `t."${sourceColumn}"`, params)
  const limitLiteral = String(batchRows)

  const sql = `
WITH batch AS (
  SELECT "${key.column}" AS k
    FROM "${schema}"."${table}"
   WHERE $1::text IS NULL OR "${key.column}" > ($1::text)::"${key.udt}"
   ORDER BY "${key.column}"
   LIMIT ${limitLiteral}
), upd AS (
  UPDATE "${schema}"."${table}" AS t
     SET "${targetColumn}" = ${expected}
    FROM batch b
   WHERE t."${key.column}" = b.k
     AND t."${targetColumn}" IS DISTINCT FROM ${expected}
  RETURNING 1
)
SELECT (SELECT count(*) FROM batch)::bigint                  AS scanned,
       (SELECT count(*) FROM upd)::bigint                    AS updated,
       -- The last key of the ordered window, NOT max(k): PostgreSQL has no
       -- max() aggregate for uuid, which is the most common primary key here,
       -- so an aggregate would fail on exactly the tables this runs against.
       -- ORDER BY works for every type that can be paged through at all.
       (SELECT k::text FROM batch ORDER BY k DESC LIMIT 1)   AS next_cursor`

  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')

  const rows = await prisma.$transaction(async tx => {
    // The service-role claim, in THIS transaction.
    //
    // The product enables RLS on every tenant table it creates, so without a
    // claim the UPDATE matches no rows and reports `updated: 0` as success —
    // a backfill that silently does nothing. It cannot be delegated to
    // `queryWorkspaceAsOwner`, which opens a transaction of its own: the claim,
    // the lock timeout and the UPDATE have to share one transaction, or
    // `SET LOCAL` bounds a statement on a different connection.
    //
    // `set_config(..., true)` is transaction-local, so the elevated context
    // reverts at commit and never reaches the next borrower of this connection.
    await tx.$executeRawUnsafe(
      rlsSessionSql(1),
      ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }),
    )
    // Same transaction, same connection, bounding the UPDATE below it.
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`)
    return tx.$queryRawUnsafe<Array<{ scanned: bigint; updated: bigint; next_cursor: string | null }>>(
      sql,
      ...params,
    )
  })

  const row = rows[0]
  const scanned = Number(row?.scanned ?? 0)
  return {
    scanned,
    updated: Number(row?.updated ?? 0),
    // A short batch means the ordered scan reached the end of the table.
    cursor: row?.next_cursor ?? cursor,
    done: scanned < batchRows,
    refusal: null,
  }
}
