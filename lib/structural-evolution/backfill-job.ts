/**
 * The extraction backfill as a background job: one batch per attempt, re-queued
 * with its cursor until the host ends.
 *
 * Same contract as the maintenance backfill job (and read by the same
 * `backgroundJobState`): `done` only on the last batch, `refusal` for a stop
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
 *
 * ── Where it runs, and where its cursor is kept ─────────────────────────────
 *
 * As the maintenance backfill does (lib/autonomy/maintenance/primitives/
 * backfill-job.ts): a home project's batches go to the home queue; a regional
 * project's are regional jobs (lib/queue REGIONAL_JOB_TYPES), run by its own
 * region's scheduler, where its tables are. The cursor is the last primary key
 * a batch scanned, which for a natural key is a customer's own value, so for a
 * regional project it is kept in the region (lib/data-plane/regional-bodies.ts,
 * kind backfill_cursor), written before the job that reads it, and the
 * platform row carries only the key it is kept under. A result never shows it.
 */

import { prisma } from '@/lib/db'
import { randomUUID } from 'node:crypto'
import { enqueue, enqueueRegionalJob, REGIONAL_STATUS } from '@/lib/queue'
import { projectRegion } from '@/lib/data-plane/regional'
import { regionalBodiesFor } from '@/lib/data-plane/regional-bodies'
import { HOME_REGION } from '@/lib/regions'
import { backgroundJobState } from '@/lib/autonomy/maintenance/execute'
import { basisFingerprint, readTableFacts } from './facts'
import { backfillBatchSql, ladderAccessSql, type ExtractionSpec } from './sql'
import { BACKFILL_BATCH_ROWS } from './plan'
import { LOCK_TIMEOUT_MS } from './primitives'
import { readLiveEvolutionApproval } from './consent'
import { hostVisibility } from './reconcile'
import { workspaceAt } from './workspace'

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
  /** The previous batch's last key; always null on a regional project's job. */
  cursor: string | null
  /** Where a regional project's job finds its starting cursor in the region. */
  cursorKey?: string | null
  batches?: number
  scannedTotal?: number
  updatedTotal?: number
}

export interface EvolutionBackfillResult {
  done: boolean
  batches: number
  scanned: number
  updated: number
  /** The last key scanned. Null for a regional project, whose cursor stays in its region. */
  cursor: string | null
  refusal?: string
}

/** The sentence a batch stops with when its region no longer keeps where it starts. */
export const CURSOR_NOT_KEPT =
  'Where this copy stopped is no longer kept in its region; resuming the change starts the copy again from the beginning, which is safe.'

/** Queue a batch where its project's tables are: the home queue, or the project's own region. */
export async function queueEvolutionBackfill(payload: EvolutionBackfillPayload): Promise<{ id: string }> {
  const region = await projectRegion(payload.projectId)
  if (region === HOME_REGION) {
    return enqueue('evolution_backfill', payload as unknown as Record<string, unknown>, { projectId: payload.projectId })
  }
  // A batch resumed as it stopped already names its cursor in the region.
  let cursorKey = payload.cursorKey ?? null
  if (payload.cursor !== null) {
    // Written before the job that reads it, like every regional body.
    cursorKey = randomUUID()
    const bodies = await regionalBodiesFor(payload.projectId)
    await bodies.set('backfill_cursor', cursorKey, { payload: { cursor: payload.cursor } })
  }
  const kept: EvolutionBackfillPayload = { ...payload, cursor: null, cursorKey }
  return enqueueRegionalJob('evolution_backfill', payload.projectId, region, kept as unknown as Record<string, unknown>)
}

async function startingCursor(payload: EvolutionBackfillPayload): Promise<{ cursor: string | null } | { refusal: string }> {
  if (!payload.cursorKey) return { cursor: payload.cursor }
  const bodies = await regionalBodiesFor(payload.projectId)
  const kept = (await bodies.get('backfill_cursor', payload.cursorKey))?.payload as { cursor?: unknown } | undefined
  return typeof kept?.cursor === 'string' ? { cursor: kept.cursor } : { refusal: CURSOR_NOT_KEPT }
}

/** The batch's refusals when the table itself moved since the plan was approved. */
const tableGone = (host: string) => `${host} no longer exists`
const tableReshaped = (host: string) => `${host} changed shape since the plan was approved; the backfill stopped rather than adapt`

/**
 * Whether a stopped chain stopped because its TABLE moved: drift, which asks
 * the person again for the table as it is now. A job that vanished, died or
 * timed out is not drift, whatever its words: that is a step that failed.
 */
export function stoppedForDrift(detail: string, host: string): boolean {
  return detail.includes(`refused: ${tableGone(host)}`) || detail.includes(`refused: ${tableReshaped(host)}`)
}

class IncompleteView extends Error {
  constructor(public reason: string) {
    super(`incomplete view: ${reason}`)
  }
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

  // The project's own region: this job runs there (lib/queue REGIONAL_JOB_TYPES).
  const at = await workspaceAt(payload.projectId)
  const { schema } = at
  const host = await readTableFacts(at, payload.spec.host)
  if (!host) return stop(tableGone(payload.spec.host))
  if (basisFingerprint(host) !== payload.basisFingerprint) return stop(tableReshaped(payload.spec.host))

  const live = await readLiveEvolutionApproval(payload.projectId, payload.planId)
  if (!live || live.planVersion !== payload.planVersion) {
    return stop(`${PAUSED_REFUSAL} consent for this change was withdrawn; the backfill stopped at its cursor and resumes from it`)
  }

  const start = await startingCursor(payload)
  if ('refusal' in start) return stop(start.refusal)
  // What a result may show of a cursor: nothing, for a project kept elsewhere.
  const shown = (c: string | null) => (at.quote ? c : null)

  const sql = backfillBatchSql(host, payload.spec, { schema }, BACKFILL_BATCH_ROWS)
  const { rlsSessionSql, rlsSessionParams } = await import('@/lib/services/rls-session')
  type BatchRow = { scanned: bigint; upserted: bigint; removed: bigint; next_cursor: string | null }
  const batch = () =>
    at.db.$transaction(async tx => {
      await tx.$executeRawUnsafe(
        rlsSessionSql(1),
        ...rlsSessionParams({ userId: '', isServiceRole: true, userRole: 'service' }),
      )
      // The ladder's own context: the satellite's owner policy admits the copy,
      // and Backenly's own read policy on the host shows every row to it.
      await tx.$executeRawUnsafe(ladderAccessSql(payload.spec))
      // A copy of what the platform happens to see is not a backfill.
      const view = await hostVisibility(tx, payload.spec, { schema })
      if (!view.complete) throw new IncompleteView(view.reason ?? 'unknown')
      // Same transaction, same connection: SET LOCAL bounds the batch below it.
      // NOWAIT covers the host rows; this bounds the satellite side.
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`)
      return tx.$queryRawUnsafe<BatchRow[]>(sql, start.cursor)
    })
  let rows: BatchRow[] = []
  for (let attempt = 0; ; attempt++) {
    try {
      rows = await batch()
      break
    } catch (err) {
      if (err instanceof IncompleteView) {
        return stop(`Backenly cannot see every row of ${payload.spec.host}: ${err.reason}; the backfill stopped rather than copy part of it`)
      }
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
  const cursor = r?.next_cursor ?? start.cursor
  const done = scannedNow < BACKFILL_BATCH_ROWS

  if (!done) {
    await queueEvolutionBackfill({ ...payload, cursor, cursorKey: null, batches, scannedTotal: scanned, updatedTotal: updated })
  }
  return { done, batches, scanned, updated, cursor: shown(cursor) }
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
  const fields = { id: true, status: true, payload: true, result: true, error: true, attempts: true } as const
  const newest = await prisma.backgroundJob
    .findFirst({
      where: { projectId, type: 'evolution_backfill', payload: { path: ['planVersion'], equals: planVersion } },
      orderBy: { createdAt: 'desc' },
      select: fields,
    })
    .catch(() => null)
  const job = newest ?? (await prisma.backgroundJob.findUnique({ where: { id: firstJobId }, select: fields }).catch(() => null))
  const jobId = job?.id ?? firstJobId
  const result = (job?.result ?? null) as Partial<EvolutionBackfillResult> | null
  if (job?.status === 'completed' && typeof result?.refusal === 'string' && result.refusal.startsWith(PAUSED_REFUSAL)) {
    return { jobId, state: 'paused', detail: result.refusal, resumeFrom: job.payload as unknown as EvolutionBackfillPayload }
  }
  return { jobId, ...backgroundJobState(job, firstJobId) }
}

/** A chain for this plan version that is queued or running right now, if any. */
export async function inFlightChain(projectId: string, planVersion: string): Promise<string | null> {
  const job = await prisma.backgroundJob
    .findFirst({
      where: {
        projectId,
        type: 'evolution_backfill',
        status: { in: ['queued', 'running', REGIONAL_STATUS.pending, REGIONAL_STATUS.running] },
        payload: { path: ['planVersion'], equals: planVersion },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    .catch(() => null)
  return job?.id ?? null
}
