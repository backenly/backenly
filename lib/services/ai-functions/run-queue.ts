/**
 * ROW-EVENT FUNCTION RUNS: QUEUED, PACED, AND KEPT UNTIL THEY FINISH
 * ==================================================================
 *
 * A row change reaches a function through the capture outbox
 * (lib/webhooks/capture.ts). The drain used to start every matching run the
 * moment it read the outbox, without waiting, up to 200 rows per project per
 * minute, and then deleted the rows. On production (2026-11-09) one bulk update
 * of 5,271 orders became 5,271 runs started 200 at a time: each no-op run
 * logged 3-5 s, because 200 at once queued on the same database connections and
 * the same function row, and the burst was still running seven minutes later.
 * A restart in that time lost every run that had not finished, since its event
 * was already gone.
 *
 * Now the drain turns each captured row into one job per matching function, in
 * this table, in the transaction that deletes the outbox row: an event is in
 * exactly one of the two places. Runs then come off the table at a bounded
 * pace and a job is deleted only after its run has finished and been recorded.
 *
 * - Each project runs at most PROJECT_CONCURRENCY at a time, and the process at
 *   most PROCESS_CONCURRENCY across projects, so one project's burst neither
 *   queues on itself nor starves the others. A run takes a slot before it
 *   claims a job, so a claimed job is always one that is running.
 * - A claim is `FOR UPDATE SKIP LOCKED` with a stamp, as the outbox's is: two
 *   processes take different jobs. A job claimed by a process that died is
 *   claimed again after RECLAIM_AFTER_SECONDS (well past a run's own 10 s
 *   limit), so a run can happen twice, never zero times: at least once, the
 *   guarantee webhooks give. A job claimed MAX_ATTEMPTS times without finishing
 *   is recorded as a failed run and dropped, so it cannot wedge the queue.
 * - A run that fails because the function threw is a recorded failure, not
 *   retried: the executor already retries an infrastructure error, and running
 *   customer code again for an error in it would repeat its side effects.
 * - Runs start in the order their rows changed; with several at once they can
 *   finish in another order, as with any parallel delivery.
 *
 * While a project has jobs, its runner keeps taking them, and moves new
 * captured rows in when it runs out, so a burst is worked through continuously
 * rather than a batch a minute.
 */

import { prisma } from '@/lib/db/prisma'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { workspaceSchemaName } from '@/lib/security/workspace-schema'
import type { FunctionEvent } from './executor'
import { RUNNABLE_FUNCTION_STATUS_FILTER } from './status'

/** The queue, one per workspace schema, beside the capture outbox. Leading underscore: never served by the API. */
export const FUNCTION_JOBS_TABLE = '_backenly_function_jobs'

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** Runs one project may have going at once. FUNCTION_RUNS_PER_PROJECT overrides it. */
export const PROJECT_CONCURRENCY = positiveInt(process.env.FUNCTION_RUNS_PER_PROJECT, 4)
/**
 * Runs one process may have going at once, across every project; only the
 * region's scheduler leader runs them (lib/scheduler/leader.ts), so this is
 * the region's. Each run is a worker thread with a 64 MB heap. Overridden by
 * FUNCTION_RUNS_PER_PROCESS.
 */
export const PROCESS_CONCURRENCY = positiveInt(process.env.FUNCTION_RUNS_PER_PROCESS, 12)
/** A claimed job older than this was left by a process that stopped, and is claimed again. */
export const RECLAIM_AFTER_SECONDS = 120
/** Claims a job may take; the next is recorded as a failure and the job dropped. */
export const MAX_ATTEMPTS = 3

export interface FunctionJob {
  functionId: string
  event: FunctionEvent
}

interface ClaimedJob {
  id: string
  function_id: string
  event: FunctionEvent
  attempts: number
}

const ensured = new Set<string>()

/** Create the queue for a project. Idempotent, and done once per process per project. */
export async function ensureFunctionJobs(projectId: string): Promise<void> {
  if (ensured.has(projectId)) return
  const schema = workspaceSchemaName(projectId)
  const db = await workspaceRawClient(projectId)
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${schema}"."${FUNCTION_JOBS_TABLE}" (
       id          bigserial   PRIMARY KEY,
       function_id text        NOT NULL,
       event       jsonb       NOT NULL,
       attempts    integer     NOT NULL DEFAULT 0,
       created_at  timestamptz NOT NULL DEFAULT now(),
       claimed_at  timestamptz
     )`,
  )
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "${FUNCTION_JOBS_TABLE}_waiting_idx"
       ON "${schema}"."${FUNCTION_JOBS_TABLE}" (id) WHERE claimed_at IS NULL`,
  )
  ensured.add(projectId)
}

/**
 * Queue `jobs` and delete the outbox rows they came from, in one transaction:
 * an event is either still in the outbox or queued, never neither.
 */
export async function enqueueReleasingOutbox(
  projectId: string,
  jobs: FunctionJob[],
  outboxTable: string,
  outboxIds: string[],
): Promise<void> {
  if (jobs.length === 0 && outboxIds.length === 0) return
  if (jobs.length > 0) await ensureFunctionJobs(projectId)
  const schema = workspaceSchemaName(projectId)
  const db = await workspaceRawClient(projectId)
  await db.$transaction(async (tx) => {
    if (jobs.length > 0) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "${schema}"."${FUNCTION_JOBS_TABLE}" (function_id, event)
         SELECT f, e::jsonb FROM unnest($1::text[], $2::text[]) AS u(f, e)`,
        jobs.map((j) => j.functionId),
        jobs.map((j) => JSON.stringify(j.event)),
      )
    }
    if (outboxIds.length > 0) {
      await tx.$executeRawUnsafe(`DELETE FROM "${schema}"."${outboxTable}" WHERE id = ANY($1::bigint[])`, outboxIds)
    }
  })
}

/**
 * Runs queued for a project and not finished yet, by function: the backlog an
 * agent reads with the run log. A project with no queue has none.
 */
export async function queuedFunctionRuns(projectId: string): Promise<Map<string, number>> {
  const schema = workspaceSchemaName(projectId)
  const db = await workspaceRawClient(projectId)
  const rows = await db
    .$queryRawUnsafe<Array<{ function_id: string; n: number }>>(
      `SELECT function_id, count(*)::int AS n FROM "${schema}"."${FUNCTION_JOBS_TABLE}" GROUP BY function_id`,
    )
    .catch(() => [] as Array<{ function_id: string; n: number }>)
  return new Map(rows.map((r) => [r.function_id, r.n]))
}

// ── Pacing ───────────────────────────────────────────────────────────────────

/** A counting semaphore: at most `size` holders, released in arrival order. */
class Slots {
  private free: number
  private readonly waiting: Array<() => void> = []
  constructor(size: number) {
    this.free = size
  }
  async take(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1
      return
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve))
  }
  give(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.free += 1
  }
}

const processSlots = new Slots(PROCESS_CONCURRENCY)
const runners = new Map<string, Promise<RunnerOutcome>>()

export interface RunnerOutcome {
  ran: number
  abandoned: number
}

/**
 * Start working through a project's queue unless this process already is.
 * Returns at once; `refill` moves newly captured rows in when the queue runs
 * dry (the capture drain), so a burst keeps flowing.
 */
export function kickFunctionRuns(projectId: string, refill: () => Promise<number>): Promise<RunnerOutcome> {
  const running = runners.get(projectId)
  if (running) return running
  const runner = workThrough(projectId, refill)
    .catch((err: any) => {
      console.warn(`[functions] queue runner for ${projectId} stopped:`, err?.message ?? err)
      return { ran: 0, abandoned: 0 }
    })
    .finally(() => runners.delete(projectId))
  runners.set(projectId, runner)
  return runner
}

async function workThrough(projectId: string, refill: () => Promise<number>): Promise<RunnerOutcome> {
  const outcome: RunnerOutcome = { ran: 0, abandoned: 0 }
  for (;;) {
    let drained = false
    await Promise.all(
      Array.from({ length: PROJECT_CONCURRENCY }, async () => {
        for (;;) {
          await processSlots.take()
          let job: ClaimedJob | null = null
          try {
            job = await claimOne(projectId)
            if (!job) {
              drained = true
              return
            }
            const result = await runJob(projectId, job).catch((err: any) => {
              // Left claimed: claimed again once RECLAIM_AFTER_SECONDS have passed.
              console.warn(`[functions] queued run ${job!.id} for ${projectId} did not finish:`, err?.message ?? err)
              return 'left' as const
            })
            if (result === 'abandoned') outcome.abandoned += 1
            else if (result === 'ran') outcome.ran += 1
          } finally {
            processSlots.give()
          }
        }
      }),
    )
    if (!drained) continue
    // Empty: take in whatever was captured meanwhile, and stop when there is none.
    const moved = await refill().catch(() => 0)
    if (moved === 0) return outcome
  }
}

async function claimOne(projectId: string): Promise<ClaimedJob | null> {
  const schema = workspaceSchemaName(projectId)
  const db = await workspaceRawClient(projectId)
  const rows = await db
    .$queryRawUnsafe<ClaimedJob[]>(
      `WITH due AS (
         SELECT id FROM "${schema}"."${FUNCTION_JOBS_TABLE}"
          WHERE claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $1)
          ORDER BY id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE "${schema}"."${FUNCTION_JOBS_TABLE}" j
          SET claimed_at = now(), attempts = j.attempts + 1
         FROM due
        WHERE j.id = due.id
       RETURNING j.id::text AS id, j.function_id, j.event, j.attempts`,
      RECLAIM_AFTER_SECONDS,
    )
    .catch((err: any) => {
      // A project whose queue was never created has nothing queued.
      if (/does not exist/.test(String(err?.message ?? ''))) return [] as ClaimedJob[]
      throw err
    })
  return rows[0] ?? null
}

async function release(projectId: string, jobId: string): Promise<void> {
  const schema = workspaceSchemaName(projectId)
  const db = await workspaceRawClient(projectId)
  await db.$executeRawUnsafe(`DELETE FROM "${schema}"."${FUNCTION_JOBS_TABLE}" WHERE id = $1::bigint`, jobId)
}

/**
 * Run one claimed job, then delete it. A job claimed more than MAX_ATTEMPTS
 * times was taken by processes that stopped before finishing it: it is
 * recorded as a failed run and dropped instead of run again.
 */
async function runJob(projectId: string, job: ClaimedJob): Promise<'ran' | 'abandoned'> {
  if (job.attempts > MAX_ATTEMPTS) {
    const { recordFunctionRun } = await import('./run-records')
    await recordFunctionRun({
      functionId: job.function_id,
      projectId,
      success: false,
      logs: [],
      error:
        `Not run: this ${job.event.type} on ${job.event.table ?? 'a table'} was started ${MAX_ATTEMPTS} times ` +
        `and the process running it stopped each time, so it was dropped.`,
      durationMs: 0,
      triggerType: job.event.type,
    })
    await release(projectId, job.id)
    return 'abandoned'
  }
  const { executeAiFunction } = await import('./executor')
  // Recorded by the executor, success or failure; a throw here leaves the job
  // claimed, to be claimed again once RECLAIM_AFTER_SECONDS have passed.
  await executeAiFunction(job.function_id, projectId, job.event)
  await release(projectId, job.id)
  return 'ran'
}

/** For tests: the runners going in this process, and the slots taken. */
export function __runQueueState(): { runners: number } {
  return { runners: runners.size }
}

/**
 * The row-event functions of a project that can run, matched to captured rows
 * by the drain. A function whose last run failed ('error') still runs, so the
 * next event can recover it; only one switched off is left out.
 */
export async function rowEventFunctions(
  projectId: string,
  triggerTypes: string[],
): Promise<Array<{ id: string; triggerType: string; triggerTable: string | null }>> {
  return prisma.aiFunction.findMany({
    where: { projectId, status: RUNNABLE_FUNCTION_STATUS_FILTER, triggerType: { in: triggerTypes } },
    select: { id: true, triggerType: true, triggerTable: true },
  })
}
