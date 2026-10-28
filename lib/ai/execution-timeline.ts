/**
 * PHASE 8: EXECUTION TIMELINE
 * ============================
 * Persistent per-action records so operators can understand what happened
 * without digging through raw logs.
 *
 * Every action executed by the AI engine produces a timeline entry that tracks:
 *   - start / end timestamps and wall-clock duration
 *   - status: pending | success | failed | self_corrected | skipped
 *   - retry count
 *   - self-corrected flag (a heal action was applied)
 *   - error classification (taxonomy code)
 *   - full per-attempt retry history
 *
 * The service is intentionally fire-and-tolerant: a DB failure here never
 * breaks the execution pipeline. All methods are safe to call without awaiting.
 *
 * An entry records how an action went, not what it handed back: a successful
 * action keeps no message, and a failed one keeps its error with credentials
 * withheld (lib/mcp/withhold-secrets.ts), as do its retries and its stored
 * arguments. What the caller is shown is untouched.
 */

import { prisma } from '@/lib/db/prisma'
import type { ErrorTaxonomyCode } from '@/lib/errors/taxonomy'
import { NOT_QUOTED, argumentShape, quotesKeptHere } from '@/lib/data-plane/residency'
import { redactSecretParams, withholdSecrets } from '@/lib/mcp/withhold-secrets'
import type { RetryAttemptRecord } from './retry-wrapper'

// ─── Types ────────────────────────────────────────────────────────────────────

export type TimelineEntryStatus =
  | 'pending'         // opened, execution in progress
  | 'success'         // completed without errors
  | 'failed'          // completed with unrecoverable error
  | 'self_corrected'  // completed after auto-healing (idempotent skip or heal action)
  | 'skipped'         // step was skipped (e.g. no-op, safety gate)

export interface ExecutionSummary {
  executionId: string
  totalActions: number
  succeeded: number
  failed: number
  selfCorrected: number
  skipped: number
  totalDurationMs: number
  /** Count of errors by taxonomy code */
  errorBreakdown: Partial<Record<ErrorTaxonomyCode | 'UNKNOWN', number>>
  startedAt: Date
  completedAt: Date
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Returns true if the id was generated locally (DB write failed) */
function isLocalId(id: string) {
  return id.startsWith('local-')
}

// ─── Open / Close ─────────────────────────────────────────────────────────────

/**
 * Open a pending timeline entry at the start of an action.
 * Returns an opaque entry ID used to close the entry later.
 *
 * A project kept in another region gets its arguments' shape only: names,
 * structure, ids and counts, never the values, which can be its rows
 * (lib/data-plane/residency.ts).
 *
 * Never throws — returns a local fallback ID on DB failure.
 */
export async function openTimelineEntry(
  projectId: string,
  executionId: string,
  actionType: string,
  actionParams: Record<string, any>,
  userId?: string,
): Promise<string> {
  try {
    const quote = await quotesKeptHere(projectId)
    const entry = await (prisma as any).executionTimelineEntry.create({
      data: {
        projectId,
        userId:      userId ?? null,
        executionId,
        actionType,
        actionParams: quote ? redactSecretParams(actionParams) : argumentShape(actionParams),
        startedAt:    new Date(),
        status:       'pending',
        retryCount:   0,
        selfCorrected: false,
      },
    })
    return entry.id as string
  } catch (err) {
    console.warn('[ExecutionTimeline] Failed to open entry:', (err as any)?.message)
    return `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  }
}

/**
 * Close a timeline entry with final metrics and status.
 *
 * Never throws — silently skips on local IDs and DB failures.
 */
export async function closeTimelineEntry(
  entryId: string,
  params: {
    status: TimelineEntryStatus
    durationMs: number
    retryCount: number
    selfCorrected: boolean
    errorClassification?: ErrorTaxonomyCode | 'UNKNOWN'
    errorMessage?: string
    retryHistory?: RetryAttemptRecord[]
    metadata?: Record<string, any>
    /** The action's structured result: credentials it names are withheld from the error too. */
    resultData?: unknown
  },
): Promise<void> {
  if (isLocalId(entryId)) return

  // Withheld before the length cap, so a cut never leaves part of a credential
  // that no longer matches its shape.
  const kept = (text: string | null | undefined) => (text ? withholdSecrets(text, params.resultData) : text)

  try {
    await (prisma as any).executionTimelineEntry.update({
      where: { id: entryId },
      data: {
        completedAt:         new Date(),
        durationMs:          params.durationMs,
        status:              params.status,
        retryCount:          params.retryCount,
        selfCorrected:       params.selfCorrected,
        errorClassification: params.errorClassification ?? null,
        errorMessage:        params.errorMessage
          ? kept(params.errorMessage)!.slice(0, 2000)
          : null,
        healingApplied:      params.retryHistory
          ? params.retryHistory.map((attempt) => ({ ...attempt, errorMessage: kept(attempt.errorMessage) ?? '' }))
          : null,
        metadata:            params.metadata ? redactSecretParams(params.metadata) : null,
      },
    })
  } catch (err) {
    console.warn('[ExecutionTimeline] Failed to close entry:', (err as any)?.message)
  }
}

// ─── Query API ────────────────────────────────────────────────────────────────

/**
 * Retrieve recent timeline entries for a project, ordered newest first.
 *
 * @param projectId  Filter by project.
 * @param limit      Max rows to return. Default 50.
 * @param executionId  Optionally filter to a single execution run.
 */
export async function getTimeline(
  projectId: string,
  limit = 50,
  executionId?: string,
): Promise<any[]> {
  try {
    const where: Record<string, any> = { projectId }
    if (executionId) where.executionId = executionId

    return await (prisma as any).executionTimelineEntry.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      take: limit,
    })
  } catch (err) {
    console.warn('[ExecutionTimeline] Failed to fetch timeline:', (err as any)?.message)
    return []
  }
}

/**
 * Aggregate all timeline entries for a single execution run into a summary.
 * Suitable for the operator dashboard without raw log exposure.
 */
export async function getExecutionSummary(
  projectId: string,
  executionId: string,
): Promise<ExecutionSummary | null> {
  try {
    const entries = await (prisma as any).executionTimelineEntry.findMany({
      where: { projectId, executionId },
      orderBy: { startedAt: 'asc' },
    })

    if (!entries.length) return null

    const errorBreakdown: Partial<Record<ErrorTaxonomyCode | 'UNKNOWN', number>> = {}
    let totalDurationMs = 0
    let succeeded = 0, failed = 0, selfCorrected = 0, skipped = 0

    for (const e of entries) {
      totalDurationMs += (e.durationMs as number) ?? 0

      switch (e.status as TimelineEntryStatus) {
        case 'success':        succeeded++;    break
        case 'failed':         failed++;       break
        case 'self_corrected': selfCorrected++; break
        case 'skipped':        skipped++;      break
      }

      if (e.errorClassification) {
        const code = e.errorClassification as ErrorTaxonomyCode | 'UNKNOWN'
        errorBreakdown[code] = (errorBreakdown[code] ?? 0) + 1
      }
    }

    const first = entries[0]
    const last  = entries[entries.length - 1]

    return {
      executionId,
      totalActions:   entries.length,
      succeeded,
      failed,
      selfCorrected,
      skipped,
      totalDurationMs,
      errorBreakdown,
      startedAt:   first.startedAt as Date,
      completedAt: (last.completedAt ?? last.startedAt) as Date,
    }
  } catch (err) {
    console.warn('[ExecutionTimeline] Failed to summarize:', (err as any)?.message)
    return null
  }
}

// ─── Convenience wrapper ──────────────────────────────────────────────────────

/**
 * Run `fn` and record the result in the execution timeline automatically.
 *
 * Usage:
 *   const result = await trackAction(projectId, executionId, action, () =>
 *     executeSingleAction(action, projectId, apiKey)
 *   )
 */
export async function trackAction<T extends { success: boolean; message?: string; error?: string; data?: unknown }>(
  projectId: string,
  executionId: string,
  action: { action: string; params: Record<string, any> },
  fn: () => Promise<T>,
  opts?: {
    userId?: string
    retryCount?: number
    selfCorrected?: boolean
    errorClassification?: ErrorTaxonomyCode | 'UNKNOWN'
    retryHistory?: RetryAttemptRecord[]
  },
): Promise<T> {
  const entryId = await openTimelineEntry(
    projectId,
    executionId,
    action.action,
    action.params,
    opts?.userId,
  )

  // A project kept in another region: no message text, whose values can be
  // its rows, here or in the retry history (lib/data-plane/residency.ts).
  const quote = await quotesKeptHere(projectId)
  const message = (text: string | undefined) => (quote || !text ? text : NOT_QUOTED)
  const retryHistory = quote
    ? opts?.retryHistory
    : opts?.retryHistory?.map(attempt => ({ ...attempt, errorMessage: message(attempt.errorMessage) ?? '' }))

  const startMs = Date.now()
  let result: T

  try {
    result = await fn()
  } catch (err: any) {
    const durationMs = Date.now() - startMs
    // Close entry as failed, then rethrow
    closeTimelineEntry(entryId, {
      status:              'failed',
      durationMs,
      retryCount:          opts?.retryCount ?? 0,
      selfCorrected:       opts?.selfCorrected ?? false,
      errorClassification: opts?.errorClassification,
      errorMessage:        message(err?.message),
      retryHistory,
    }).catch(() => {})
    throw err
  }

  const durationMs = Date.now() - startMs

  let status: TimelineEntryStatus
  if (result.success) {
    status = opts?.selfCorrected ? 'self_corrected' : 'success'
  } else {
    status = 'failed'
  }

  // A success keeps no message: what an action hands back is for its caller,
  // not for the record. A failure keeps its error, with anything the result
  // names as a credential withheld (closeTimelineEntry).
  closeTimelineEntry(entryId, {
    status,
    durationMs,
    retryCount:          opts?.retryCount ?? 0,
    selfCorrected:       opts?.selfCorrected ?? false,
    errorClassification: opts?.errorClassification,
    errorMessage:        result.success ? undefined : message(result.error ?? result.message),
    retryHistory,
    resultData:          result.data,
  }).catch(() => {})

  return result
}
