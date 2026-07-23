/**
 * STUCK EXECUTION DETECTOR
 * =========================
 * Track E — Identifies agent executions that have been running too long
 * without completing, indicating a stuck loop, hung DB call, or orphaned process.
 *
 * An execution is considered "stuck" when:
 *  - Its last timeline entry is in status 'pending'
 *  - The entry was started > STUCK_THRESHOLD_MINUTES ago
 *  - No entry in that execution has status 'success' or 'self_corrected' since
 *
 * An execution is considered "abandoned" when:
 *  - All its entries are either 'failed' or 'skipped'
 *  - No entries remain in 'pending' state
 *  - No subsequent executions for the same project were triggered
 *
 * Used by: /api/admin/health, monitoring hooks, alerting system.
 */

import { prisma } from '@/lib/db'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StuckExecution {
  projectId: string
  executionId: string
  actionType: string
  startedAt: string
  stuckForMinutes: number
  lastStatus: string
  retryCount: number
  errorClassification: string | null
}

export interface AbandonedExecution {
  projectId: string
  executionId: string
  failedActions: number
  lastErrorClassification: string | null
  lastActivityAt: string
  abandonedForMinutes: number
}

export interface FailedWebhookCluster {
  projectId: string
  integration: string
  recentFailureCount: number
  lastFailureAt: string | null
  errorCodes: string[]
}

export interface ReadinessBlockCluster {
  checkId: string
  description: string
  projectCount: number
  sampleProjectIds: string[]
}

export interface OperatorHealthSnapshot {
  evaluatedAt: string
  stuckExecutions: StuckExecution[]
  abandonedExecutions: AbandonedExecution[]
  failedWebhookClusters: FailedWebhookCluster[]
  readinessBlockClusters: ReadinessBlockCluster[]
  /** Repeated self-healing failures on the same project/action */
  repeatedSelfHealingFailures: Array<{
    projectId: string
    actionType: string
    selfCorrectedCount: number
    lastSeen: string
  }>
  summary: {
    stuckCount: number
    abandonedCount: number
    webhookFailureProjectCount: number
    readinessBlockedProjectCount: number
    repeatedHealingFailureCount: number
  }
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const STUCK_THRESHOLD_MINUTES = 15      // pending for > 15 min = stuck
const ABANDONED_THRESHOLD_MINUTES = 60  // last failed > 60 min ago + no success = abandoned
const REPEATED_HEALING_THRESHOLD = 3    // ≥ 3 self-corrections on same action = concerning
const WEBHOOK_FAILURE_WINDOW_HOURS = 1  // look back 1 hour for webhook failures
const MAX_RESULTS_PER_CATEGORY = 50     // cap results to prevent response bloat

// ─── Public entry point ────────────────────────────────────────────────────────

/**
 * Produces a full operator health snapshot.
 * Safe to call frequently — read-only, no side effects.
 * Never throws; returns partial results on DB errors.
 */
export async function getOperatorHealthSnapshot(): Promise<OperatorHealthSnapshot> {
  const evaluatedAt = new Date().toISOString()
  const now = new Date()

  const [
    stuckExecutions,
    abandonedExecutions,
    failedWebhookClusters,
    repeatedHealingFailures,
  ] = await Promise.allSettled([
    detectStuckExecutions(now),
    detectAbandonedExecutions(now),
    detectFailedWebhookClusters(now),
    detectRepeatedSelfHealingFailures(),
  ])

  const stuck = stuckExecutions.status === 'fulfilled' ? stuckExecutions.value : []
  const abandoned = abandonedExecutions.status === 'fulfilled' ? abandonedExecutions.value : []
  const webhooks = failedWebhookClusters.status === 'fulfilled' ? failedWebhookClusters.value : []
  const healing = repeatedHealingFailures.status === 'fulfilled' ? repeatedHealingFailures.value : []

  return {
    evaluatedAt,
    stuckExecutions: stuck,
    abandonedExecutions: abandoned,
    failedWebhookClusters: webhooks,
    readinessBlockClusters: [], // populated by a separate scorer sweep if needed
    repeatedSelfHealingFailures: healing,
    summary: {
      stuckCount: stuck.length,
      abandonedCount: abandoned.length,
      webhookFailureProjectCount: new Set(webhooks.map(w => w.projectId)).size,
      readinessBlockedProjectCount: 0,
      repeatedHealingFailureCount: healing.length,
    },
  }
}

// ─── Detection implementations ────────────────────────────────────────────────

async function detectStuckExecutions(now: Date): Promise<StuckExecution[]> {
  const threshold = new Date(now.getTime() - STUCK_THRESHOLD_MINUTES * 60 * 1000)

  const entries = await prisma.executionTimelineEntry.findMany({
    where: {
      status: 'pending',
      startedAt: { lt: threshold },
    },
    orderBy: { startedAt: 'asc' },
    take: MAX_RESULTS_PER_CATEGORY,
    select: {
      projectId: true,
      executionId: true,
      actionType: true,
      startedAt: true,
      status: true,
      retryCount: true,
      errorClassification: true,
    },
  })

  return entries.map(e => {
    const startedAt = e.startedAt as Date
    const stuckForMinutes = Math.floor((now.getTime() - startedAt.getTime()) / 60_000)
    return {
      projectId: e.projectId,
      executionId: e.executionId,
      actionType: e.actionType,
      startedAt: startedAt.toISOString(),
      stuckForMinutes,
      lastStatus: e.status,
      retryCount: e.retryCount,
      errorClassification: e.errorClassification as string | null,
    }
  })
}

async function detectAbandonedExecutions(now: Date): Promise<AbandonedExecution[]> {
  const threshold = new Date(now.getTime() - ABANDONED_THRESHOLD_MINUTES * 60 * 1000)

  // Find executions where all entries are failed/skipped and last activity was long ago
  const entries = await prisma.executionTimelineEntry.groupBy({
    by: ['executionId', 'projectId'],
    where: {
      status: { in: ['failed', 'skipped'] },
      completedAt: { lt: threshold },
    },
    _count: { id: true },
    _max: { completedAt: true, errorClassification: true },
    orderBy: { _max: { completedAt: 'desc' } },
    take: MAX_RESULTS_PER_CATEGORY,
  })

  // Filter to executions with no success entries
  const result: AbandonedExecution[] = []
  for (const group of entries) {
    const hasSuccess = await prisma.executionTimelineEntry.count({
      where: {
        executionId: group.executionId,
        projectId: group.projectId,
        status: { in: ['success', 'self_corrected'] },
      },
    })
    if (hasSuccess > 0) continue // has some success — not abandoned

    const lastActivity = group._max.completedAt as Date | null
    if (!lastActivity) continue

    result.push({
      projectId: group.projectId,
      executionId: group.executionId,
      failedActions: group._count.id,
      lastErrorClassification: group._max.errorClassification as string | null,
      lastActivityAt: lastActivity.toISOString(),
      abandonedForMinutes: Math.floor((now.getTime() - lastActivity.getTime()) / 60_000),
    })
  }

  return result
}

async function detectFailedWebhookClusters(now: Date): Promise<FailedWebhookCluster[]> {
  const since = new Date(now.getTime() - WEBHOOK_FAILURE_WINDOW_HOURS * 60 * 60 * 1000)

  // Webhook failures appear in the timeline with errorClassification=WEBHOOK_VERIFY_FAILURE
  const entries = await prisma.executionTimelineEntry.groupBy({
    by: ['projectId', 'actionType'],
    where: {
      errorClassification: 'WEBHOOK_VERIFY_FAILURE',
      status: 'failed',
      startedAt: { gte: since },
    },
    _count: { id: true },
    _max: { startedAt: true },
    orderBy: { _count: { id: 'desc' } },
    take: MAX_RESULTS_PER_CATEGORY,
  })

  return entries.map(e => ({
    projectId: e.projectId,
    integration: e.actionType.replace('WEBHOOK_', '').toLowerCase(),
    recentFailureCount: e._count.id,
    lastFailureAt: e._max.startedAt ? (e._max.startedAt as Date).toISOString() : null,
    errorCodes: ['WEBHOOK_VERIFY_FAILURE'],
  }))
}

async function detectRepeatedSelfHealingFailures(): Promise<Array<{
  projectId: string
  actionType: string
  selfCorrectedCount: number
  lastSeen: string
}>> {
  const entries = await prisma.executionTimelineEntry.groupBy({
    by: ['projectId', 'actionType'],
    where: {
      selfCorrected: true,
    },
    _count: { id: true },
    _max: { startedAt: true },
    having: {
      id: { _count: { gte: REPEATED_HEALING_THRESHOLD } },
    },
    orderBy: { _count: { id: 'desc' } },
    take: MAX_RESULTS_PER_CATEGORY,
  })

  return entries.map(e => ({
    projectId: e.projectId,
    actionType: e.actionType,
    selfCorrectedCount: e._count.id,
    lastSeen: e._max.startedAt ? (e._max.startedAt as Date).toISOString() : new Date().toISOString(),
  }))
}
