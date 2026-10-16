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
 *
 * ── Where it runs, and where its cursor is kept ─────────────────────────────
 *
 * A home project's batches go to the home queue, as they always have. A
 * regional project's are regional jobs (lib/queue REGIONAL_JOB_TYPES), run by
 * its region's own scheduler, where its ladder runs too
 * (lib/autonomy/region-skip.ts). Its cursor is the last primary key a batch
 * scanned, which for a natural key is a customer's own value, so it is kept in
 * the region (lib/data-plane/regional-bodies.ts, kind backfill_cursor) and the
 * platform row carries only the key it is kept under. Each job's starting
 * cursor is written once, before the job, under a key of its own, so a retry
 * still resumes exactly where its job began.
 */

import { randomUUID } from 'crypto'
import { enqueue, enqueueRegionalJob } from '@/lib/queue'
import { projectRegion } from '@/lib/data-plane/regional'
import { regionalBodiesFor } from '@/lib/data-plane/regional-bodies'
import { HOME_REGION } from '@/lib/regions'
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
  /**
   * Null on the first batch; the previous batch's last key after that. Always
   * null on a regional project's job, whose cursor is kept in its region.
   */
  cursor: string | null
  /** Where a regional project's job finds its cursor in the region. */
  cursorKey?: string | null
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
  /** The last key scanned. Null for a regional project, whose cursor stays in its region. */
  cursor: string | null
  /** Set when the batch refused before writing. Not an error; a stop. */
  refusal?: string
}

/** The sentence a batch refuses with when its region no longer keeps where it starts. */
export const CURSOR_NOT_KEPT =
  'Where this backfill stopped is no longer kept in its region; run the plan again to start it over.'

/** Queue a batch where its project's data is: the home queue, or the project's region. */
export async function queueBackfillJob(payload: BackfillJobPayload): Promise<{ id: string }> {
  const region = await projectRegion(payload.projectId)
  if (region === HOME_REGION) {
    return enqueue('maintenance_backfill', payload as unknown as Record<string, unknown>, {
      projectId: payload.projectId,
    })
  }

  let cursorKey: string | null = null
  if (payload.cursor !== null) {
    // Written before the job that reads it, like every regional body.
    cursorKey = randomUUID()
    const bodies = await regionalBodiesFor(payload.projectId)
    await bodies.set('backfill_cursor', cursorKey, { payload: { cursor: payload.cursor } })
  }
  const kept: BackfillJobPayload = { ...payload, cursor: null, cursorKey }
  return enqueueRegionalJob('maintenance_backfill', payload.projectId, region, kept as unknown as Record<string, unknown>)
}

async function startingCursor(payload: BackfillJobPayload): Promise<{ cursor: string | null } | { refusal: string }> {
  if (!payload.cursorKey) return { cursor: payload.cursor }
  const bodies = await regionalBodiesFor(payload.projectId)
  const kept = (await bodies.get('backfill_cursor', payload.cursorKey))?.payload as { cursor?: unknown } | undefined
  return typeof kept?.cursor === 'string' ? { cursor: kept.cursor } : { refusal: CURSOR_NOT_KEPT }
}

/**
 * Run one batch and queue the next.
 *
 * A refusal ends the chain without queueing another job: the conditions that
 * produce one — no single-column primary key, a column that is not an
 * identifier, an unrenderable transform, a cursor its region no longer keeps —
 * do not become true by waiting, so re-queueing would spin. The result records
 * why it stopped.
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
  // What a result may show of a cursor: nothing, for a project kept elsewhere.
  const regional = (await projectRegion(payload.projectId)) !== HOME_REGION
  const shown = (cursor: string | null) => (regional ? null : cursor)

  const start = await startingCursor(payload)
  if ('refusal' in start) {
    return {
      done: false,
      batches: payload.batches ?? 0,
      scanned: payload.scannedTotal ?? 0,
      updated: payload.updatedTotal ?? 0,
      cursor: null,
      refusal: start.refusal,
    }
  }

  const batch = await runBackfillBatch(spec, start.cursor)
  const batches = (payload.batches ?? 0) + 1
  const scanned = (payload.scannedTotal ?? 0) + batch.scanned
  const updated = (payload.updatedTotal ?? 0) + batch.updated

  if (batch.refusal) {
    return { done: false, batches, scanned, updated, cursor: shown(start.cursor), refusal: batch.refusal }
  }

  if (!batch.done) {
    await queueBackfillJob({
      ...payload,
      cursor: batch.cursor,
      cursorKey: null,
      batches,
      scannedTotal: scanned,
      updatedTotal: updated,
    })
  }

  return { done: batch.done, batches, scanned, updated, cursor: shown(batch.cursor) }
}
