/**
 * DB-BACKED BACKGROUND JOB QUEUE
 * ================================
 * Persistent async task queue using PostgreSQL via Prisma.
 * No external dependencies — works without Redis.
 *
 * To swap for BullMQ/Redis: replace the implementation of enqueue,
 * claimNextJobs, completeJob, and failJob without touching callers.
 *
 * Thread-safety: claimNextJobs uses a conditional updateMany so two concurrent
 * workers can never claim the same job.
 *
 * Retry schedule (indexed by attempt number, 0-based):
 *   Attempt 1 — immediate
 *   Attempt 2 — 5 s
 *   Attempt 3 — 30 s
 *   Attempt 4 — 5 min
 *   Attempt 5 — 30 min
 *   After 5 — dead_letter
 */

import { prisma } from '@/lib/db/prisma'
import { emit } from '@/lib/events/bus'

// ── Constants ─────────────────────────────────────────────────────────────────

/** ms to wait before each retry attempt, indexed by attempt number (0-based) */
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 300_000, 1_800_000] as const

/** How long a job may stay in 'running' before it is considered stuck */
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

// ── Types ─────────────────────────────────────────────────────────────────────

// `purge_project` is the outbox record for deleting a project's files and
// storage objects after its database rows are already gone. It is enqueued
// inside the deletion transaction (lib/projects/delete.ts) rather than through
// `enqueue()`, because it must commit atomically with the schema drops.
export type JobType = 'email' | 'webhook_delivery' | 'cleanup' | 'custom' | 'purge_project'

export const PURGE_JOB_TYPE = 'purge_project' as const

/**
 * Purge jobs use their own status vocabulary, and that is the whole point.
 *
 * ── THE ROLLBACK HAZARD ─────────────────────────────────────────────────────
 *
 * `processBackgroundJobs` completes an unrecognised job type immediately with
 * `{ skipped: true }`, so that an unknown row cannot loop forever. For every
 * existing type that is harmless. For a purge it is destruction: the row IS the
 * durable instruction to delete a customer's backups and files, and a worker
 * that marks it completed without performing it has thrown that instruction
 * away with the data still on disk.
 *
 * The worker that would do this is the one already deployed. It cannot be
 * fixed by editing this repository, so the fix has to make the job invisible to
 * it rather than make it behave better.
 *
 * ── WHY A STATUS AND NOT A TYPE ─────────────────────────────────────────────
 *
 * Every query in the released code selects jobs by an explicit status:
 *
 *   claimNextJobs             status = 'queued'
 *   detectAndTimeoutStuckJobs status = 'running' AND timeoutAt <= now
 *   handleCleanupJob          status = 'dead_letter'
 *   prune-background-jobs     status IN ('completed', 'failed')
 *   build-lock reaper         type = 'build_lock'
 *
 * There is no catch-all sweep. So a row parked in a status outside that set is
 * unreachable by any of them: an old worker cannot claim it, time it out,
 * prune it, or dead-letter it. It simply waits.
 *
 * This is not a new trick. `build_lock` and `orchestration_lock` are already
 * BackgroundJob types the generic worker has no handler for, and they have
 * coexisted with it safely for exactly this reason — they never sit in
 * 'queued'. This follows the same rule.
 *
 * `completed` is deliberately shared with the generic vocabulary: once the
 * files are gone the row is ordinary history and the pruner should collect it.
 * `purgeFailed` is deliberately NOT `dead_letter` or `failed`, both of which are
 * swept on a timer — a purge that has exhausted its retries needs a human, and
 * must not be deleted out from under them.
 */
export const PURGE_STATUS = {
  /** Waiting to run. Invisible to every released query. */
  pending: 'purge_pending',
  /** Claimed by a worker that understands purges. */
  running: 'purge_running',
  /** Retries exhausted. Terminal, and never auto-pruned. */
  failed: 'purge_failed',
} as const
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'dead_letter'

export interface EnqueueOptions {
  /** null / undefined = system job not tied to a project */
  projectId?: string
  /** Defaults to RETRY_DELAYS_MS.length (5) */
  maxAttempts?: number
  /** Earliest time to run — defaults to now (run immediately) */
  runAt?: Date
  /** ms until a running attempt is considered timed out; defaults to 10 min */
  timeoutMs?: number
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enqueue a new background job.
 * Returns immediately after writing to DB.
 */
export async function enqueue(
  type: JobType,
  payload: Record<string, any>,
  options: EnqueueOptions = {}
) {
  const {
    projectId,
    maxAttempts = RETRY_DELAYS_MS.length,
    runAt = new Date(),
    timeoutMs = DEFAULT_JOB_TIMEOUT_MS,
  } = options

  return prisma.backgroundJob.create({
    data: {
      type,
      status: 'queued',
      payload,
      attempts: 0,
      maxAttempts,
      runAt,
      projectId: projectId ?? null,
      // timeoutAt is set when the job is claimed (transitions to running)
      // so it reflects the actual start time, not enqueue time
    },
  })
}

/**
 * Atomically claim up to `limit` due jobs and mark them as 'running'.
 *
 * Two-step approach:
 *   1. SELECT the IDs of queued jobs whose runAt <= now
 *   2. UPDATE only those IDs with status='queued' (guards against double-claim)
 *
 * Safe under concurrent workers — a job claimed by worker A will no longer
 * match the WHERE status='queued' check by worker B.
 */
export async function claimNextJobs(limit = 10) {
  const now = new Date()

  const candidates = await prisma.backgroundJob.findMany({
    where: { status: 'queued', runAt: { lte: now } },
    orderBy: { runAt: 'asc' },
    take: limit,
    select: { id: true },
  })

  if (candidates.length === 0) return []

  const ids = candidates.map(c => c.id)

  await prisma.backgroundJob.updateMany({
    where: { id: { in: ids }, status: 'queued' }, // guard: still queued
    data: {
      status: 'running',
      startedAt: now,
      timeoutAt: new Date(now.getTime() + DEFAULT_JOB_TIMEOUT_MS),
    },
  })

  return prisma.backgroundJob.findMany({
    where: { id: { in: ids }, status: 'running' },
  })
}

/**
 * Mark a job as successfully completed.
 * Emits 'job.completed' via the event bus.
 */
export async function completeJob(id: string, result?: Record<string, any>) {
  const job = await prisma.backgroundJob.update({
    where: { id },
    data: {
      status: 'completed',
      result: result ?? {},
      completedAt: new Date(),
      error: null,
    },
  })

  emit('job.completed', job.projectId ?? undefined, {
    jobId: id,
    type: job.type,
    attempts: job.attempts,
  })
}

/**
 * Record a failed attempt.
 *
 * - If attempts < maxAttempts: reschedule with exponential backoff (status → queued)
 * - If attempts >= maxAttempts: move to dead_letter and emit an event so the
 *   notification handler can alert the project owner.
 */
export async function failJob(id: string, error: string) {
  const job = await prisma.backgroundJob.findUnique({ where: { id } })
  if (!job) return

  const newAttempts = job.attempts + 1

  if (newAttempts >= job.maxAttempts) {
    await prisma.backgroundJob.update({
      where: { id },
      data: {
        status: 'dead_letter',
        attempts: newAttempts,
        error,
        completedAt: new Date(),
      },
    })

    emit('job.failed', job.projectId ?? undefined, {
      jobId: id,
      type: job.type,
      error,
      attempts: newAttempts,
      deadLetter: true,
    })
  } else {
    const delayMs = RETRY_DELAYS_MS[newAttempts] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
    const runAt = new Date(Date.now() + delayMs)

    await prisma.backgroundJob.update({
      where: { id },
      data: {
        status: 'queued',
        attempts: newAttempts,
        error,
        runAt,
        startedAt: null,
        timeoutAt: null,
      },
    })

    emit('job.failed', job.projectId ?? undefined, {
      jobId: id,
      type: job.type,
      error,
      attempts: newAttempts,
      deadLetter: false,
      retryAt: runAt.toISOString(),
    })
  }
}

/**
 * Find all jobs stuck in 'running' past their timeoutAt deadline and fail them.
 * Called every minute from the system cron.
 *
 * Returns the number of jobs that were timed out.
 */
export async function detectAndTimeoutStuckJobs(): Promise<number> {
  const now = new Date()

  const stuck = await prisma.backgroundJob.findMany({
    where: { status: 'running', timeoutAt: { lte: now } },
    select: { id: true },
  })

  for (const { id } of stuck) {
    await failJob(id, 'Job execution timed out — exceeded maximum allowed duration')

    const job = await prisma.backgroundJob.findUnique({ where: { id } })
    if (job) {
      emit('job.timeout', job.projectId ?? undefined, {
        jobId: id,
        type: job.type,
        attempts: job.attempts,
      })
    }
  }

  if (stuck.length > 0) {
    console.log(`[Queue] Timed out ${stuck.length} stuck job(s)`)
  }

  return stuck.length
}

// ─── Purge queue ──────────────────────────────────────────────────────────────
//
// A parallel claim/complete/fail trio for purge jobs. It mirrors the generic one
// above — same backoff table, same conditional-updateMany claim so two workers
// cannot take the same row — but moves rows between the PURGE_STATUS values so
// they never enter a status a released worker selects. See PURGE_STATUS.

/**
 * Claim up to `limit` due purge jobs.
 *
 * Also reclaims jobs left in `purge_running` by a worker that died mid-purge:
 * without this they would sit there forever, which is the same lost-instruction
 * failure in a different costume.
 */
export async function claimPurgeJobs(limit = 5) {
  const now = new Date()

  await prisma.backgroundJob.updateMany({
    where: {
      type: PURGE_JOB_TYPE,
      status: PURGE_STATUS.running,
      timeoutAt: { lte: now },
    },
    data: { status: PURGE_STATUS.pending, startedAt: null, timeoutAt: null },
  })

  const candidates = await prisma.backgroundJob.findMany({
    where: { type: PURGE_JOB_TYPE, status: PURGE_STATUS.pending, runAt: { lte: now } },
    orderBy: { runAt: 'asc' },
    take: limit,
    select: { id: true },
  })

  if (candidates.length === 0) return []

  const ids = candidates.map((c) => c.id)

  await prisma.backgroundJob.updateMany({
    where: { id: { in: ids }, status: PURGE_STATUS.pending },
    data: {
      status: PURGE_STATUS.running,
      startedAt: now,
      timeoutAt: new Date(now.getTime() + DEFAULT_JOB_TIMEOUT_MS),
    },
  })

  return prisma.backgroundJob.findMany({
    where: { id: { in: ids }, status: PURGE_STATUS.running },
  })
}

/** The files are gone. `completed` is shared with the generic vocabulary on purpose. */
export async function completePurgeJob(id: string, result?: Record<string, any>) {
  await prisma.backgroundJob.update({
    where: { id },
    data: {
      status: 'completed',
      result: result ?? {},
      completedAt: new Date(),
      error: null,
      timeoutAt: null,
    },
  })
}

/**
 * Record a failed purge attempt and schedule the next one.
 *
 * On exhaustion the row lands in `purge_failed` rather than `dead_letter`: the
 * data is still on disk, so the instruction must outlive every timer that
 * collects finished work.
 */
export async function failPurgeJob(id: string, error: string) {
  const job = await prisma.backgroundJob.findUnique({ where: { id } })
  if (!job) return

  const attempts = job.attempts + 1

  if (attempts >= job.maxAttempts) {
    await prisma.backgroundJob.update({
      where: { id },
      data: {
        status: PURGE_STATUS.failed,
        attempts,
        error,
        completedAt: new Date(),
        timeoutAt: null,
      },
    })
    return
  }

  const delayMs = RETRY_DELAYS_MS[attempts] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]

  await prisma.backgroundJob.update({
    where: { id },
    data: {
      status: PURGE_STATUS.pending,
      attempts,
      error,
      runAt: new Date(Date.now() + delayMs),
      startedAt: null,
      timeoutAt: null,
    },
  })
}
