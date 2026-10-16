/**
 * CRON JOB RUNNER — shared service
 * =================================
 * Two entry points:
 *
 *   runDueCronJobs()  — executes user-defined AiFunction records with
 *                       triggerType='cron' whose schedule matches now, for
 *                       the projects this process serves (dueCronJobs()).
 *                       Called every minute by:
 *                         • instrumentation.ts (node-cron, self-hosted/Hetzner)
 *                         • app/api/cron/run-ai-jobs/route.ts (Vercel Cron)
 *
 *   runSystemTasks()  — runs the housekeeping that must happen regardless of
 *                       user cron jobs, in two shares:
 *                         runRegionalSystemTasks(), every region: turn its
 *                           projects' captured row changes into deliveries
 *                         runPlatformSystemTasks(), home region only:
 *                           1. Retry failed outbound webhooks
 *                           2. Detect & fail stuck background jobs (timeout)
 *                           3. Process the background job queue
 *                           3b. Finish external purges for deleted projects
 *                           4. Auto-provision system cleanup jobs (daily)
 *                       instrumentation.ts schedules the two shares
 *                       separately; the cron route runs both.
 *
 * The cron expression for user jobs is stored in AiFunction.triggerTable,
 * e.g. "0 9 * * *" = every day at 09:00 UTC.
 */

import { prisma } from '@/lib/db/prisma'
import { partitionServed } from '@/lib/data-plane/serving'
import { matchesCronExpression } from '@/lib/services/cron-expression'
import { executeAiFunction, FunctionEvent } from '@/lib/services/ai-functions/executor'
import { retryFailedWebhooks } from '@/lib/webhooks/index'
import { drainWebhookOutbox } from '@/lib/webhooks/capture'
import { detectAndTimeoutStuckJobs, enqueue } from '@/lib/queue/index'
import { processBackgroundJobs, processPurgeJobs } from '@/lib/queue/worker'

// ─── Cron Expression Matching ─────────────────────────────────────────────────
//
// The grammar lives in cron-expression.ts, shared with the schedule parser so
// an expression the parser accepts is always one this runner can fire. The old
// in-file matcher used parseInt on each field, so the range in "0 9 * * 1-5"
// read as 1 and the job ran on Mondays only.

export { matchesCronExpression, isValidCronExpression } from '@/lib/services/cron-expression'

// ─── User Cron Jobs ───────────────────────────────────────────────────────────

export interface CronRunResult {
  ran: number
  succeeded: number
  failed: number
  checked: number
  timestamp: string
}

export interface DueCronJob {
  id: string
  name: string
  projectId: string
  triggerTable: string | null
}

/**
 * The user cron functions this process runs at `now`: active, due, of a
 * project that is neither paused nor deleted, and served here. A region's
 * scheduler runs its own projects' functions and no others
 * (lib/data-plane/serving.ts): a function's SQL and its data are in its
 * project's region, and the home region used to run every region's.
 */
export async function dueCronJobs(now: Date = new Date()): Promise<{ checked: number; due: DueCronJob[] }> {
  const cronJobs = await prisma.aiFunction.findMany({
    // A paused or deleted project's schedule does not fire. The function stays
    // `active`, so it resumes on its next tick after the project does.
    where: { status: 'active', triggerType: 'cron', project: { pausedAt: null, deletedAt: null } },
    select: { id: true, name: true, projectId: true, triggerTable: true },
  })
  const due = cronJobs.filter(job => matchesCronExpression(job.triggerTable || '0 9 * * *', now))
  const { served } = await partitionServed(due.map(job => ({ id: job.projectId, job })))
  return { checked: cronJobs.length, due: served.map(s => s.job) }
}

/**
 * Find and execute the user-defined cron AiFunctions due right now, in the
 * projects this process serves.
 */
export async function runDueCronJobs(now?: Date): Promise<CronRunResult> {
  const ts = now ?? new Date()

  const { checked, due: dueJobs } = await dueCronJobs(ts)

  if (dueJobs.length === 0) {
    return { ran: 0, succeeded: 0, failed: 0, checked, timestamp: ts.toISOString() }
  }

  const event: FunctionEvent = {
    type: 'cron',
    data: { scheduledAt: ts.toISOString(), timestamp: ts.getTime() },
  }

  const results = await Promise.allSettled(
    dueJobs.map(job => executeAiFunction(job.id, job.projectId, event))
  )

  const succeeded = results.filter(
    r => r.status === 'fulfilled' && (r.value as any).success
  ).length
  const failed = results.length - succeeded

  console.log(`[CronRunner] User jobs: ${dueJobs.length} ran — ${succeeded} ok, ${failed} failed`)

  return {
    ran: dueJobs.length,
    succeeded,
    failed,
    checked,
    timestamp: ts.toISOString(),
  }
}

// ─── Auto-provision System Cleanup Jobs ──────────────────────────────────────

/** Ensure daily log-cleanup and dead-letter-cleanup jobs are scheduled. */
async function ensureSystemCleanupJobs(): Promise<void> {
  const now = new Date()
  const isMidnightWindow =
    now.getUTCHours() === 2 && now.getUTCMinutes() === 0 // 02:00 UTC daily

  if (!isMidnightWindow) return

  // Queue cleanup jobs — they are idempotent so double-queueing is harmless
  // (the worker skips if nothing to clean)
  await Promise.all([
    enqueue('cleanup', { cleanupType: 'old_logs' }),
    enqueue('cleanup', { cleanupType: 'dead_letter_jobs' }),
  ]).catch(err => {
    console.warn('[SystemTasks] Failed to enqueue cleanup jobs:', err?.message)
  })

  console.log('[SystemTasks] Enqueued daily cleanup jobs')
}

// ─── System Tasks ─────────────────────────────────────────────────────────────

/**
 * Run all housekeeping tasks: this region's share, then the platform's. For a
 * deployment with one region, which is every self-hosted one and the cron
 * route. Each task is isolated — a failure in one never blocks the others.
 */
export async function runSystemTasks(): Promise<void> {
  // BEFORE the retry pass, not after: draining first means an event captured
  // this minute gets its first attempt this minute. Reversed, every delivery
  // that failed on attempt one would wait an extra tick for a retry pass that
  // had already run before the log existed.
  await runRegionalSystemTasks()
  await runPlatformSystemTasks()
}

/**
 * This region's share, run by every region's scheduler: turn the row changes
 * captured in its projects' databases into webhook deliveries
 * (drainWebhookOutbox reads only the projects this process serves).
 */
export async function runRegionalSystemTasks(): Promise<void> {
  await drainWebhookOutbox().catch(err =>
    console.error('[SystemTasks] webhook outbox drain failed:', err?.message)
  )
}

/**
 * The platform's share, run once, by the home region's scheduler: rows in the
 * platform database that any project may own. The background queue, purges
 * and delivery retries still serve every region from here; running each
 * project's job in its own region needs the job to carry that region (a purge
 * outlives its project's row) and is the next change.
 */
export async function runPlatformSystemTasks(): Promise<void> {
  // 1. Retry outbound webhooks whose nextRetryAt has passed
  await retryFailedWebhooks().catch(err =>
    console.error('[SystemTasks] webhook retry failed:', err?.message)
  )

  // 2. Detect background jobs stuck in 'running' past their timeoutAt
  await detectAndTimeoutStuckJobs().catch(err =>
    console.error('[SystemTasks] timeout detection failed:', err?.message)
  )

  // 3. Process the background job queue (up to 10 jobs per tick)
  await processBackgroundJobs().catch(err =>
    console.error('[SystemTasks] job processing failed:', err?.message)
  )

  // 3b. Finish deleting files for projects whose rows are already gone.
  //     Separate from the queue above because purge jobs deliberately never
  //     enter the 'queued' status a released worker would claim and complete
  //     without a handler. See PURGE_STATUS in lib/queue/index.ts.
  await processPurgeJobs().catch(err =>
    console.error('[SystemTasks] purge processing failed:', err?.message)
  )

  // 4. Auto-provision daily cleanup jobs at 02:00 UTC
  await ensureSystemCleanupJobs().catch(err =>
    console.error('[SystemTasks] cleanup provisioning failed:', err?.message)
  )
}
