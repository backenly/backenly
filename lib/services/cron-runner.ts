/**
 * CRON JOB RUNNER — shared service
 * =================================
 * Two entry points:
 *
 *   runDueCronJobs()  — executes user-defined AiFunction records with
 *                       triggerType='cron' whose schedule matches now.
 *                       Called every minute by:
 *                         • instrumentation.ts (node-cron, self-hosted/Hetzner)
 *                         • app/api/cron/run-ai-jobs/route.ts (Vercel Cron)
 *
 *   runSystemTasks()  — runs platform-level housekeeping tasks that must
 *                       happen regardless of user cron jobs:
 *                         1. Retry failed outbound webhooks
 *                         2. Detect & fail stuck background jobs (timeout)
 *                         3. Process the background job queue
 *                         4. Auto-provision system cleanup jobs (daily)
 *                       Called every minute by instrumentation.ts alongside
 *                       runDueCronJobs().
 *
 * The cron expression for user jobs is stored in AiFunction.triggerTable,
 * e.g. "0 9 * * *" = every day at 09:00 UTC.
 */

import { prisma } from '@/lib/db/prisma'
import { executeAiFunction, FunctionEvent } from '@/lib/services/ai-functions/executor'
import { retryFailedWebhooks } from '@/lib/webhooks/index'
import { detectAndTimeoutStuckJobs, enqueue } from '@/lib/queue/index'
import { processBackgroundJobs } from '@/lib/queue/worker'

// ─── Cron Expression Matching ─────────────────────────────────────────────────

export function matchesCronExpression(expr: string, now: Date): boolean {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return false

  const [minuteExpr, hourExpr, domExpr, monthExpr, dowExpr] = parts

  function matchesPart(part: string, value: number): boolean {
    if (part === '*') return true
    if (part.startsWith('*/')) {
      const step = parseInt(part.slice(2))
      return !isNaN(step) && value % step === 0
    }
    // Support comma-separated values: "1,15"
    if (part.includes(',')) {
      return part.split(',').some(p => parseInt(p.trim()) === value)
    }
    const num = parseInt(part)
    return !isNaN(num) && num === value
  }

  return (
    matchesPart(minuteExpr, now.getUTCMinutes()) &&
    matchesPart(hourExpr, now.getUTCHours()) &&
    matchesPart(domExpr, now.getUTCDate()) &&
    matchesPart(monthExpr, now.getUTCMonth() + 1) &&
    matchesPart(dowExpr, now.getUTCDay())
  )
}

// ─── User Cron Jobs ───────────────────────────────────────────────────────────

export interface CronRunResult {
  ran: number
  succeeded: number
  failed: number
  checked: number
  timestamp: string
}

/**
 * Find and execute all user-defined cron AiFunctions that are due right now.
 */
export async function runDueCronJobs(now?: Date): Promise<CronRunResult> {
  const ts = now ?? new Date()

  const cronJobs = await prisma.aiFunction.findMany({
    where: { status: 'active', triggerType: 'cron' },
    select: { id: true, name: true, projectId: true, triggerTable: true },
  })

  const dueJobs = cronJobs.filter(job =>
    matchesCronExpression(job.triggerTable || '0 9 * * *', ts)
  )

  if (dueJobs.length === 0) {
    return { ran: 0, succeeded: 0, failed: 0, checked: cronJobs.length, timestamp: ts.toISOString() }
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
    checked: cronJobs.length,
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
 * Run all platform-level housekeeping tasks.
 * Each task is isolated — a failure in one never blocks the others.
 */
export async function runSystemTasks(): Promise<void> {
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

  // 4. Auto-provision daily cleanup jobs at 02:00 UTC
  await ensureSystemCleanupJobs().catch(err =>
    console.error('[SystemTasks] cleanup provisioning failed:', err?.message)
  )
}
