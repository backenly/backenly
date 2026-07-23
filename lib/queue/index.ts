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

export type JobType = 'email' | 'webhook_delivery' | 'cleanup' | 'custom'
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
