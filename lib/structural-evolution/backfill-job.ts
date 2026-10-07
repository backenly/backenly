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
 *
 * ── It re-checks consent before every batch ─────────────────────────────────
 *
 * Withdrawing consent pauses the change, and a chain of batches already in the
 * queue is part of the change. A batch that finds no live consent for its exact
 * plan version stops with `paused`, keeping its cursor, so resuming continues
 * from the same key rather than starting again.
 *
 * ── It never waits for a writer ─────────────────────────────────────────────
 *
 * The batch takes its rows with FOR SHARE NOWAIT (see backfillBatchSql). A row
 * being written fails the batch at once with 55P03; the batch is retried here
 * a few times, briefly, and then thrown to BackgroundJob's backoff. Waiting
 * instead would queue every later writer of that row behind the backfill, and
 * would make the backfill one side of a possible deadlock.
 */

import { prisma } from '@/lib/db'
import { enqueue } from '@/lib/queue'
import { inspectBackgroundJob } from '@/lib/autonomy/maintenance/execute'
import { basisFingerprint, readTableFacts } from './facts'
import { backfillBatchSql, ladderAccessSql, type ExtractionSpec } from './sql'
import { BACKFILL_BATCH_ROWS } from './plan'
import { LOCK_TIMEOUT_MS } from './primitives'
import { readLiveEvolutionApproval } from './consent'

/** A batch that met a row being written is retried this many times, after these waits. */
export const LOCKED_ROW_RETRY_MS = [100, 400, 1_600] as const

/** Prefix of the refusal a batch reports when consent was withdrawn. Resumable. */
export const PAUSED_REFUSAL = 'paused:'

function isLockNotAvailable(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string } } | null
  const text = `${e?.code ?? ''} ${e?.meta?.code ?? ''} ${err instanceof Error ? err.message : String(err)}`
  return /55P03|could not obtain lock|lock timeout/i.test(text)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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

  const live = await readLiveEvolutionApproval(payload.projectId, payload.planId)
  if (!live || live.planVersion !== payload.planVersion) {
    return stop(`${PAUSED_REFUSAL} consent for this change was withdrawn; the backfill stopped at its cursor and resumes from it`)
  }

  const sql = backfillBatchSql(host, payload.spec, { schema }, BACKFILL_BATCH_ROWS)
  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
  type BatchRow = { scanned: bigint; upserted: bigint; removed: bigint; next_cursor: string | null }
  const batch = () =>
    prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe(
        rlsSessionSql(1),
        ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }),
      )
      // The ladder's own context: the satellite's owner policy admits the copy.
      await tx.$executeRawUnsafe(ladderAccessSql(payload.spec))
      // Same transaction, same connection: SET LOCAL bounds the batch below it.
      // NOWAIT covers the host rows; this bounds the satellite side.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`)
      return tx.$queryRawUnsafe<BatchRow[]>(sql, payload.cursor)
    })
  let rows: BatchRow[] = []
  for (let attempt = 0; ; attempt++) {
    try {
      rows = await batch()
      break
    } catch (err) {
      // Anything else, and a row still locked after the last wait, goes to
      // BackgroundJob's own retry with backoff.
      if (!isLockNotAvailable(err) || attempt >= LOCKED_ROW_RETRY_MS.length) throw err
      await sleep(LOCKED_ROW_RETRY_MS[attempt])
    }
  }

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

export interface ChainState {
  /** The newest job of the chain, whose state is the chain's state. */
  jobId: string
  state: 'pending' | 'done' | 'failed' | 'paused'
  detail: string
  /** For a paused chain: the batch that stopped, to be queued again as it was. */
  resumeFrom?: EvolutionBackfillPayload
}

/**
 * The state of a backfill chain, read from its newest job.
 *
 * Each batch queues the next one, so the job the ledger recorded at dispatch is
 * only the chain's FIRST link, and it completes with `done: false` the moment a
 * second batch exists. Every link carries the plan version, so the chain is
 * followed by it to its newest job. A chain stopped by a withdrawn consent is
 * `paused`, not failed: it carries the payload to continue from its cursor.
 */
export async function inspectEvolutionChain(projectId: string, planVersion: string, firstJobId: string): Promise<ChainState> {
  const newest = await prisma.backgroundJob
    .findFirst({
      where: { projectId, type: 'evolution_backfill', payload: { path: ['planVersion'], equals: planVersion } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, payload: true, result: true },
    })
    .catch(() => null)
  const jobId = newest?.id ?? firstJobId
  const result = (newest?.result ?? null) as Partial<EvolutionBackfillResult> | null
  if (newest?.status === 'completed' && typeof result?.refusal === 'string' && result.refusal.startsWith(PAUSED_REFUSAL)) {
    return { jobId, state: 'paused', detail: result.refusal, resumeFrom: newest.payload as unknown as EvolutionBackfillPayload }
  }
  return { jobId, ...(await inspectBackgroundJob(jobId)) }
}

/** A chain for this plan version that is queued or running right now, if any. */
export async function inFlightChain(projectId: string, planVersion: string): Promise<string | null> {
  const job = await prisma.backgroundJob
    .findFirst({
      where: {
        projectId,
        type: 'evolution_backfill',
        status: { in: ['queued', 'running'] },
        payload: { path: ['planVersion'], equals: planVersion },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    .catch(() => null)
  return job?.id ?? null
}
