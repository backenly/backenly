/**
 * The backfill as a background job: one batch per attempt, re-queued with its
 * cursor until the table ends.
 *
 * Splitting it this way is what makes the work interruptible. A handler that
 * looped until done would hold one job "running" for however long the table
 * takes, and a process restart in the middle would lose the cursor and start
 * over — the exact property that made `RUN_DATA_MIGRATION`'s atomic backfill
 * unusable here.
 *
 * Retries are NOT implemented in this file. A batch that raises — a lock
 * timeout, a bad cast — propagates, and BackgroundJob's own lifecycle decides
 * whether to retry it, when, and when to stop. The cursor is unchanged by a
 * failed batch, so a retry resumes from the same place rather than skipping the
 * window it could not write.
 */

import { enqueue } from '@/lib/queue'
import { runBackfillBatch, type BackfillSpec } from './backfill'
import type { Transform } from '../transform'

export interface BackfillJobPayload {
  projectId: string
  planVersion: string
  idempotencyKey: string
  table: string
  sourceColumn: string
  targetColumn: string
  transform: Transform
  batchRows?: number
  lockTimeoutMs?: number
  /** Null on the first batch; the previous batch's last key after that. */
  cursor: string | null
  /** Batches completed so far, carried across jobs for reporting. */
  batches?: number
  scannedTotal?: number
  updatedTotal?: number
}

export interface BackfillJobResult {
  done: boolean
  batches: number
  scanned: number
  updated: number
  cursor: string | null
  /** Set when the batch refused before writing. Not an error; a stop. */
  refusal?: string
}

/**
 * Run one batch and queue the next.
 *
 * A refusal ends the chain without queueing another job: the conditions that
 * produce one — no single-column primary key, a column that is not an
 * identifier, an unrenderable transform — do not become true by waiting, so
 * re-queueing would spin. The result records why it stopped.
 */
export async function handleBackfillJob(payload: BackfillJobPayload): Promise<BackfillJobResult> {
  const spec: BackfillSpec = {
    projectId: payload.projectId,
    table: payload.table,
    sourceColumn: payload.sourceColumn,
    targetColumn: payload.targetColumn,
    transform: payload.transform,
    batchRows: payload.batchRows,
    lockTimeoutMs: payload.lockTimeoutMs,
  }

  const batch = await runBackfillBatch(spec, payload.cursor)
  const batches = (payload.batches ?? 0) + 1
  const scanned = (payload.scannedTotal ?? 0) + batch.scanned
  const updated = (payload.updatedTotal ?? 0) + batch.updated

  if (batch.refusal) {
    return { done: false, batches, scanned, updated, cursor: payload.cursor, refusal: batch.refusal }
  }

  if (!batch.done) {
    const next: BackfillJobPayload = {
      ...payload,
      cursor: batch.cursor,
      batches,
      scannedTotal: scanned,
      updatedTotal: updated,
    }
    await enqueue('maintenance_backfill', next as unknown as Record<string, unknown>, {
      projectId: payload.projectId,
    })
  }

  return { done: batch.done, batches, scanned, updated, cursor: batch.cursor }
}
