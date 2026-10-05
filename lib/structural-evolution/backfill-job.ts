/**
 * The extraction backfill as a background job: one batch per attempt, re-queued
 * with its cursor until the host ends.
 *
 * Same contract as the maintenance backfill job (and read by the same
 * `inspectBackgroundJob`): `done` only on the last batch, `refusal` for a stop
 * that waiting cannot fix, a throw for anything BackgroundJob should retry.
 *
 * ── The job re-checks the host before every batch ───────────────────────────
 *
 * A backfill can run for a long time and the owner can change `orders` in the
 * middle of it. The batch SQL is rendered from the host's facts, so each batch
 * re-reads them and refuses unless they still hash to the basis the approved
 * plan was built on. A column type changed underneath a half-finished backfill
 * is a stop, not something to adapt to.
 */

import { prisma } from '@/lib/db'
import { enqueue } from '@/lib/queue'
import { basisFingerprint, readTableFacts } from './facts'
import { backfillBatchSql, type ExtractionSpec } from './sql'
import { BACKFILL_BATCH_ROWS } from './plan'
import { LOCK_TIMEOUT_MS } from './primitives'

export interface EvolutionBackfillPayload {
  projectId: string
  planId: string
  planVersion: string
  basisFingerprint: string
  spec: ExtractionSpec
  cursor: string | null
  batches?: number
  scannedTotal?: number
  updatedTotal?: number
}

export interface EvolutionBackfillResult {
  done: boolean
  batches: number
  scanned: number
  updated: number
  cursor: string | null
  refusal?: string
}

export async function handleEvolutionBackfillJob(payload: EvolutionBackfillPayload): Promise<EvolutionBackfillResult> {
  const batches = (payload.batches ?? 0) + 1
  const stop = (refusal: string): EvolutionBackfillResult => ({
    done: false,
    batches,
    scanned: payload.scannedTotal ?? 0,
    updated: payload.updatedTotal ?? 0,
    cursor: payload.cursor,
    refusal,
  })

  const { resolveWorkspaceSchema } = await import('@/lib/services/workspace-pool')
  const schema = await resolveWorkspaceSchema(payload.projectId)
  const host = await readTableFacts(schema, payload.spec.host)
  if (!host) return stop(`${payload.spec.host} no longer exists`)
  if (basisFingerprint(host) !== payload.basisFingerprint) {
    return stop(`${payload.spec.host} changed shape since the plan was approved; the backfill stopped rather than adapt`)
  }

  const sql = backfillBatchSql(host, payload.spec, { schema }, BACKFILL_BATCH_ROWS)
  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
  const rows = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(
      rlsSessionSql(1),
      ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }),
    )
    // Same transaction, same connection: SET LOCAL bounds the batch below it.
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`)
    return tx.$queryRawUnsafe<Array<{ scanned: bigint; upserted: bigint; removed: bigint; next_cursor: string | null }>>(
      sql,
      payload.cursor,
    )
  })

  const r = rows[0]
  const scannedNow = Number(r?.scanned ?? 0)
  const scanned = (payload.scannedTotal ?? 0) + scannedNow
  const updated = (payload.updatedTotal ?? 0) + Number(r?.upserted ?? 0) + Number(r?.removed ?? 0)
  const cursor = r?.next_cursor ?? payload.cursor
  const done = scannedNow < BACKFILL_BATCH_ROWS

  if (!done) {
    const next: EvolutionBackfillPayload = { ...payload, cursor, batches, scannedTotal: scanned, updatedTotal: updated }
    await enqueue('evolution_backfill', next as unknown as Record<string, unknown>, { projectId: payload.projectId })
  }
  return { done, batches, scanned, updated, cursor }
}
