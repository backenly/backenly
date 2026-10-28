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
import { serviceRegion } from '@/lib/data-plane/serving'
import { HOME_REGION, type CloudRegionId } from '@/lib/regions'

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
export type JobType =
  | 'email'
  | 'webhook_delivery'
  | 'cleanup'
  | 'custom'
  | 'purge_project'
  /**
   * One batch of a Phase 6b backfill, re-queued with a cursor until the table
   * ends. It lives here rather than in a maintenance-owned loop so that
   * attempts, backoff and dead-lettering have exactly one implementation.
   */
  | 'maintenance_backfill'
  /**
   * One batch of a structural-evolution backfill (lib/structural-evolution/backfill-job.ts),
   * re-queued with a cursor until the host table ends. Here for the same reason
   * as `maintenance_backfill`: one retry lifecycle, not two.
   */
  | 'evolution_backfill'
  /**
   * An approved architecture change started where its project's tables are
   * (lib/evolution-engine/engine.ts, startWhereTheTablesAre). Only ever a
   * regional job: a project of the region a request reaches runs in it.
   */
  | 'evolution_advance'
  /** A person's undo of an architecture change, run in the same way (undoWhereTheTablesAre). */
  | 'evolution_undo'
  /** A change whose table moved since the person was asked, rehearsed again there (reRequestDecision). */
  | 'evolution_rerequest'
  /** A look for architecture changes a person asked for now (proposeWhereTheTablesAre). */
  | 'evolution_assess'

export const PURGE_JOB_TYPE = 'purge_project' as const

/**
 * Job types that still run for a PAUSED project.
 *
 * An allowlist of exemptions rather than a list of what to suspend, so a job
 * type added later is suspended by default: for a paused project that means
 * delayed, which is recoverable, where running user work Backenly then pays for
 * is not. Purges are not listed because they never enter 'queued' at all (see
 * PURGE_STATUS below) and run on their own path regardless.
 */
export const PAUSE_EXEMPT_JOB_TYPES: readonly JobType[] = ['cleanup']

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

  // A paused project's jobs are left queued, never claimed, so none of their
  // attempts are spent and they run as normal once the project resumes.
  // BackgroundJob.projectId has no relation to Project, hence the id list.
  const pausedIds = (
    await prisma.project.findMany({ where: { pausedAt: { not: null } }, select: { id: true } })
  ).map(p => p.id)

  const candidates = await prisma.backgroundJob.findMany({
    where: {
      status: 'queued',
      runAt: { lte: now },
      ...(pausedIds.length > 0
        ? {
            OR: [
              // `projectId NOT IN (...)` is NULL, not true, for a system job.
              { projectId: null },
              { projectId: { notIn: pausedIds } },
              { type: { in: [...PAUSE_EXEMPT_JOB_TYPES] } },
            ],
          }
        : {}),
    },
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
export async function claimPurgeJobs(limit = 5, region: CloudRegionId = serviceRegion()) {
  const now = new Date()

  await prisma.backgroundJob.updateMany({
    where: {
      type: PURGE_JOB_TYPE,
      status: PURGE_STATUS.running,
      timeoutAt: { lte: now },
    },
    data: { status: PURGE_STATUS.pending, startedAt: null, timeoutAt: null },
  })

  // Only this region's jobs: each region's scheduler purges what was kept in
  // it, whose bucket and disks are its own. Chosen in the query, so another
  // region's backlog ahead in the queue can never hide them. A job written
  // before the region was recorded is the home region's; one naming a region
  // this build does not know matches none, so no region purges the wrong place.
  const candidates = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "background_jobs"
    WHERE "type" = ${PURGE_JOB_TYPE}
      AND "status" = ${PURGE_STATUS.pending}
      AND "runAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
      AND COALESCE("payload"->>'region', ${HOME_REGION}) = ${region}
    ORDER BY "runAt" ASC
    LIMIT ${limit}`

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

// ─── Regional jobs ────────────────────────────────────────────────────────────
//
// Work requested in one region that has to be done in another. The console,
// MCP and the agent run in the home region, but a project kept elsewhere has
// its database and its snapshots there: a pg_dump of it taken here would put
// a full copy of its data in the home region, and a restore from here could
// not even read its snapshot, which is in that region's bucket. So the request
// is recorded here and carried out there, by that region's own scheduler
// (lib/queue/worker.ts processRegionalJobs).
//
// Purges' rule, for the same reason (PURGE_STATUS above): these rows never
// enter 'queued', so no generic worker, this build's or one already released,
// can claim one and complete it without a handler, or run it in the wrong
// region.
//
// A maintenance backfill of a regional project is the same kind of work: its
// ladder runs in the project's region (lib/autonomy/region-skip.ts), and the
// batches it dispatches belong there too, not to the home queue, where a
// failed batch's database error, which can quote a row, would be recorded. So
// is the copy an architecture change makes into its new table
// (lib/structural-evolution/backfill-job.ts), and so is what a person asks of
// an architecture change, its start, its undo, a rehearsal again and a look
// for changes: each reads and writes the region's database statement by
// statement, which across regions outlasts the request that asked for it
// (lib/evolution-engine/engine.ts, startWhereTheTablesAre and the rest).

/** Snapshots taken and restored for another region: what the console's snapshot panel lists. */
export const SNAPSHOT_JOB_TYPES = ['workspace_backup', 'workspace_restore'] as const

/** The work one region may ask another to do. */
export const REGIONAL_JOB_TYPES = [
  ...SNAPSHOT_JOB_TYPES,
  'maintenance_backfill',
  'evolution_backfill',
  'evolution_advance',
  'evolution_undo',
  'evolution_rerequest',
  'evolution_assess',
] as const
export type RegionalJobType = (typeof REGIONAL_JOB_TYPES)[number]

/**
 * Work that writes the project's data, and so waits while the project is
 * paused; with it, the rehearsals and looks an architecture change asks for,
 * which would wake a paused database.
 */
const REGIONAL_WRITES_HELD_WHILE_PAUSED: readonly RegionalJobType[] = [
  'maintenance_backfill',
  'evolution_backfill',
  'evolution_advance',
  'evolution_undo',
  'evolution_rerequest',
  'evolution_assess',
]

export const REGIONAL_STATUS = {
  /** Waiting for its region's scheduler. Invisible to every generic query. */
  pending: 'regional_pending',
  /** Claimed by its region's scheduler. */
  running: 'regional_running',
  /** Attempts exhausted. Terminal and never auto-pruned: the project is shown it. */
  failed: 'regional_failed',
} as const

/**
 * Long enough for any snapshot or restore (pg_dump itself stops at two minutes,
 * lib/services/workspace-backup.ts), short enough that a worker that died is
 * noticed within the hour. A run still going past it counts as an attempt.
 */
const REGIONAL_JOB_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Ask `region` to do `type` for `projectId`. The region is recorded in the
 * payload, which is where a region's claim looks for its own work.
 */
export async function enqueueRegionalJob(
  type: RegionalJobType,
  projectId: string,
  region: CloudRegionId,
  payload: Record<string, unknown> = {},
  options: { maxAttempts?: number } = {},
): Promise<{ id: string }> {
  return prisma.backgroundJob.create({
    data: {
      type,
      projectId,
      status: REGIONAL_STATUS.pending,
      payload: { ...payload, projectId, region } as Record<string, any>,
      maxAttempts: options.maxAttempts ?? 3,
      runAt: new Date(),
    },
    select: { id: true },
  })
}

/**
 * Claim up to `limit` due jobs of `region`, chosen in the query like purges.
 *
 * A job left running past its timeout by a worker that died, or one still
 * running, counts that attempt: it goes back to pending while attempts remain
 * and to failed after, so a slow restore is never started a second time
 * without anyone deciding to.
 */
export async function claimRegionalJobs(limit = 2, region: CloudRegionId = serviceRegion()) {
  const now = new Date()

  // Only this region's: whether another region's run is stale is for that
  // region to decide, where it may still be running.
  const stale = (
    await prisma.backgroundJob.findMany({
      where: { type: { in: [...REGIONAL_JOB_TYPES] }, status: REGIONAL_STATUS.running, timeoutAt: { lte: now } },
      select: { id: true, attempts: true, maxAttempts: true, payload: true },
    })
  ).filter((job) => ((job.payload ?? {}) as { region?: unknown }).region === region)
  for (const job of stale) {
    const attempts = job.attempts + 1
    await prisma.backgroundJob.updateMany({
      where: { id: job.id, status: REGIONAL_STATUS.running },
      data: attempts >= job.maxAttempts
        ? { status: REGIONAL_STATUS.failed, attempts, error: 'Timed out in its region.', completedAt: now, timeoutAt: null }
        : { status: REGIONAL_STATUS.pending, attempts, error: 'Timed out in its region; retried.', startedAt: null, timeoutAt: null },
    })
  }

  // A paused project takes no writes, so its backfill is left pending, not
  // claimed: no attempt is spent, and it runs as normal once the project
  // resumes, as the generic queue does (claimNextJobs). Snapshots are claimed:
  // taking one is how an owner gets their data out, and a restore checks again
  // where it runs.
  const candidates = await prisma.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "background_jobs"
    WHERE "type" = ANY(${[...REGIONAL_JOB_TYPES]}::text[])
      AND "status" = ${REGIONAL_STATUS.pending}
      AND "runAt" <= (${now}::timestamptz AT TIME ZONE 'UTC')
      AND "payload"->>'region' = ${region}
      AND NOT (
        "type" = ANY(${[...REGIONAL_WRITES_HELD_WHILE_PAUSED]}::text[])
        AND "projectId" IN (SELECT "id" FROM "projects" WHERE "pausedAt" IS NOT NULL)
      )
    ORDER BY "runAt" ASC
    LIMIT ${limit}`

  if (candidates.length === 0) return []

  const ids = candidates.map((c) => c.id)

  await prisma.backgroundJob.updateMany({
    where: { id: { in: ids }, status: REGIONAL_STATUS.pending },
    data: {
      status: REGIONAL_STATUS.running,
      startedAt: now,
      timeoutAt: new Date(now.getTime() + REGIONAL_JOB_TIMEOUT_MS),
    },
  })

  return prisma.backgroundJob.findMany({
    where: { id: { in: ids }, status: REGIONAL_STATUS.running },
  })
}

/** Done. `completed` is shared with the generic vocabulary, as for purges. */
export async function completeRegionalJob(id: string, result: Record<string, any>) {
  await prisma.backgroundJob.update({
    where: { id },
    data: { status: 'completed', result, completedAt: new Date(), error: null, timeoutAt: null },
  })
}

/**
 * A failed attempt: pending again after the backoff while attempts remain,
 * failed after. `error` is what the project is shown, so it is the platform's
 * own sentence, never the database's (which can quote rows).
 */
export async function failRegionalJob(id: string, error: string) {
  const job = await prisma.backgroundJob.findUnique({ where: { id } })
  if (!job) return

  const attempts = job.attempts + 1
  if (attempts >= job.maxAttempts) {
    await prisma.backgroundJob.update({
      where: { id },
      data: { status: REGIONAL_STATUS.failed, attempts, error, completedAt: new Date(), timeoutAt: null },
    })
    return
  }

  const delayMs = RETRY_DELAYS_MS[attempts] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
  await prisma.backgroundJob.update({
    where: { id },
    data: {
      status: REGIONAL_STATUS.pending,
      attempts,
      error,
      runAt: new Date(Date.now() + delayMs),
      startedAt: null,
      timeoutAt: null,
    },
  })
}

/**
 * A project's recent regional snapshots and restores, newest first: what its
 * console's snapshot panel shows as queued, running or failed, and in which
 * region. The payload stays here. Backfill batches are a maintenance ladder's,
 * which reads them itself.
 */
export async function regionalJobsOf(projectId: string, take = 10) {
  const jobs = await prisma.backgroundJob.findMany({
    where: { projectId, type: { in: [...SNAPSHOT_JOB_TYPES] } },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, type: true, status: true, error: true, createdAt: true, completedAt: true, payload: true },
  })
  return jobs.map(({ payload, ...job }) => ({ ...job, region: ((payload ?? {}) as { region?: string }).region ?? null }))
}
