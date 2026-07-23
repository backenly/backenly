/**
 * IN-PROCESS EVENT BUS
 * =====================
 * Decouples executors from side effects (logs, notifications, analytics).
 *
 * Architecture:
 *   Emitter → emit(event) → all registered listeners fire in parallel
 *
 * This avoids tight coupling like:
 *   executor → directly writes logs
 *   executor → directly sends notifications
 *
 * Instead each concern registers its own listener.
 * Swap for a real queue (BullMQ, Redis Streams) without changing callers.
 *
 * Events:
 *   execution.complete    — any agent action succeeded
 *   execution.failed      — any agent action failed
 *   integration.activated — an integration was enabled
 *   schema.changed        — table created / column added / FK enforced
 *   deploy.started        — deployment triggered
 *   deploy.complete       — deployment finished
 *   key.stored            — an API key was stored
 *   fix.applied           — an auto-fix was applied to a function
 *   job.completed         — a background job completed successfully
 *   job.failed            — a background job failed (may retry or be dead_letter)
 *   job.timeout           — a background job exceeded its timeout and was killed
 *   webhook.dead_letter   — a webhook endpoint has exhausted all retry attempts
 */

import { prisma } from '@/lib/db/prisma'
import { createPlatformNotification, notifyDeployComplete } from '@/lib/notifications/platform'

export type EventType =
  | 'execution.complete'
  | 'execution.failed'
  | 'integration.activated'
  | 'schema.changed'
  | 'deploy.started'
  | 'deploy.complete'
  | 'deploy.failed'
  | 'key.stored'
  | 'fix.applied'
  | 'job.completed'
  | 'job.failed'
  | 'job.timeout'
  | 'webhook.dead_letter'
  | 'auth.error_spike'

export interface BusEvent {
  type: EventType
  projectId?: string
  userId?: string
  payload: Record<string, any>
  timestamp: string
}

type EventHandler = (event: BusEvent) => void | Promise<void>

const handlers: Map<EventType, EventHandler[]> = new Map()

/**
 * Register a listener for an event type.
 * Multiple handlers per event are allowed — all run in parallel.
 */
export function on(type: EventType, handler: EventHandler): void {
  const existing = handlers.get(type) ?? []
  existing.push(handler)
  handlers.set(type, existing)
}

/**
 * Emit an event. All registered handlers run in parallel (fire-and-forget).
 * Errors in handlers are caught and logged but never bubble up to the caller.
 */
export function emit(
  type: EventType,
  projectId: string | undefined,
  payload: Record<string, any>,
  userId?: string
): void {
  const event: BusEvent = {
    type,
    projectId,
    userId,
    payload,
    timestamp: new Date().toISOString(),
  }

  const typeHandlers = handlers.get(type) ?? []
  for (const handler of typeHandlers) {
    Promise.resolve(handler(event)).catch(err => {
      console.error(`[EventBus] Handler error for ${type}:`, err?.message ?? err)
    })
  }
}

/** Remove all listeners (useful in tests). */
export function clearHandlers(): void {
  handlers.clear()
}

/** Look up the owner userId for a project. Returns null if not found. */
async function getProjectOwner(projectId: string): Promise<string | null> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    })
    return project?.userId ?? null
  } catch {
    return null
  }
}

// ─── Default Listeners — console logging ─────────────────────────────────────

on('execution.complete', (e) => {
  console.log(
    `[EventBus] ✅ execution.complete | project=${e.projectId} | action=${e.payload.action}`
  )
})

on('execution.failed', (e) => {
  console.error(
    `[EventBus] ❌ execution.failed | project=${e.projectId} | action=${e.payload.action} | error=${e.payload.error}`
  )
})

on('integration.activated', (e) => {
  console.log(
    `[EventBus] 🔗 integration.activated | project=${e.projectId} | id=${e.payload.integrationId}`
  )
})

on('schema.changed', (e) => {
  console.log(
    `[EventBus] 🗃️  schema.changed | project=${e.projectId} | tables=${e.payload.tables?.join(', ')}`
  )
})

on('deploy.complete', (e) => {
  console.log(
    `[EventBus] 🚀 deploy.complete | project=${e.projectId} | url=${e.payload.url}`
  )
})

// ─── Job Lifecycle Listeners ──────────────────────────────────────────────────

on('job.completed', async (e) => {
  if (e.payload.type === 'cleanup') return  // internal housekeeping — don't notify

  console.log(
    `[EventBus] ✅ job.completed | project=${e.projectId} | jobId=${e.payload.jobId} | type=${e.payload.type}`
  )

  if (e.projectId) {
    const userId = e.payload.userId ?? await getProjectOwner(e.projectId)
    if (userId) {
      await createPlatformNotification({
        userId,
        type: 'job_completed',
        title: 'Background job completed',
        body: `A ${e.payload.type} job completed successfully in your project.`,
        metadata: { jobId: e.payload.jobId, type: e.payload.type, projectId: e.projectId },
      })
    }
  }
})

on('job.failed', async (e) => {
  console.warn(
    `[EventBus] ⚠️  job.failed | project=${e.projectId} | jobId=${e.payload.jobId} | ` +
    `attempts=${e.payload.attempts} | deadLetter=${e.payload.deadLetter} | error=${e.payload.error}`
  )

  // Only notify when the job is permanently dead (dead-letter queue)
  if (e.payload.deadLetter && e.projectId) {
    const userId = e.payload.userId ?? await getProjectOwner(e.projectId)
    if (userId) {
      await createPlatformNotification({
        userId,
        type: 'job_failed',
        title: 'Background job permanently failed',
        body:
          `A ${e.payload.type} job has failed after ${e.payload.attempts} attempt(s) and been moved to the dead-letter queue. ` +
          `Last error: ${String(e.payload.error).slice(0, 200)}`,
        metadata: { jobId: e.payload.jobId, type: e.payload.type, projectId: e.projectId, errorMessage: e.payload.error },
      })
    }
  }
})

on('job.timeout', async (e) => {
  console.warn(
    `[EventBus] ⏰ job.timeout | project=${e.projectId} | jobId=${e.payload.jobId} | type=${e.payload.type}`
  )

  if (e.projectId) {
    const userId = await getProjectOwner(e.projectId)
    if (userId) {
      await createPlatformNotification({
        userId,
        type: 'job_failed',
        title: 'Background job timed out',
        body: `A ${e.payload.type} job (ID: ${e.payload.jobId}) exceeded its maximum execution time and was terminated.`,
        metadata: { jobId: e.payload.jobId, type: e.payload.type, projectId: e.projectId },
      })
    }
  }
})

// ─── Webhook Dead-Letter Listener ─────────────────────────────────────────────

on('webhook.dead_letter', async (e) => {
  console.error(
    `[EventBus] 💀 webhook.dead_letter | project=${e.projectId} | webhookId=${e.payload.webhookId} | url=${e.payload.targetUrl}`
  )

  if (e.projectId) {
    const userId = await getProjectOwner(e.projectId)
    if (userId) {
      await createPlatformNotification({
        userId,
        type: 'system',
        title: 'Webhook endpoint persistently failing',
        body:
          `Webhook to ${e.payload.targetUrl} has failed ${e.payload.attempts} time(s) and been moved to dead-letter. ` +
          `Last error: ${String(e.payload.error).slice(0, 200)}. ` +
          `Check that your endpoint is reachable and returns a 2xx status.`,
        metadata: {
          webhookId: e.payload.webhookId,
          targetUrl: e.payload.targetUrl,
          attempts: e.payload.attempts,
          projectId: e.projectId,
        },
      })
    }
  }
})

on('deploy.complete', async (e) => {
  console.log(
    `[EventBus] 🚀 deploy.complete | project=${e.projectId} | url=${e.payload.url}`
  )

  if (e.projectId) {
    const userId = e.userId ?? await getProjectOwner(e.projectId)
    if (userId) {
      await notifyDeployComplete(
        userId,
        e.projectId,
        e.payload.projectName ?? e.projectId,
        e.payload.url
      )
    }
  }
})

// ─── Event-Driven Workspace Observer ─────────────────────────────────────────
// Fire an immediate targeted health scan whenever key events happen instead of
// waiting for the 6-hour cron tick.  All handlers are fire-and-forget.

async function triggerObserverForProject(projectId: string, reason: string): Promise<void> {
  try {
    const { runObserverForProject } = await import('@/lib/services/workspace-observer')
    await runObserverForProject(projectId)
    console.log(`[EventBus] WorkspaceObserver triggered by ${reason} for project=${projectId}`)
  } catch (err: any) {
    console.error(`[EventBus] Observer trigger failed (${reason}):`, err?.message)
  }
}

// schema.changed → verify the change landed cleanly and check for RLS gaps
on('schema.changed', (e) => {
  if (e.projectId) {
    triggerObserverForProject(e.projectId, 'schema.changed')
  }
})

// fix.applied → verify the fix actually resolved the issue
on('fix.applied', (e) => {
  if (e.projectId) {
    triggerObserverForProject(e.projectId, 'fix.applied')
  }
})

// deploy.failed → log a deploy_failure finding immediately
on('deploy.failed', (e) => {
  if (e.projectId) {
    triggerObserverForProject(e.projectId, 'deploy.failed')
  }
})

// webhook.dead_letter → re-scan so the broken_webhook finding is written
on('webhook.dead_letter', (e) => {
  if (e.projectId) {
    triggerObserverForProject(e.projectId, 'webhook.dead_letter')
  }
})

// auth.error_spike → immediately scan for the auth_spike finding
on('auth.error_spike', (e) => {
  if (e.projectId) {
    triggerObserverForProject(e.projectId, 'auth.error_spike')
  }
})
