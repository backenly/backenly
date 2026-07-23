/**
 * BUILD FAILURE LOGGER
 * ====================
 * Structured failure logging for the build pipeline.
 *
 * Every build failure must be:
 *   1. Persisted to AuditLog (queryable from the UI)
 *   2. Emitted as a structured SSE event (visible to the frontend)
 *   3. Logged to server console with full context
 *
 * Never silently swallows failures. Never throws — it IS the error handler.
 *
 * Usage:
 *   import { logBuildFailure } from './failure-logger'
 *
 *   await logBuildFailure(ctx, 'node_failed', error, { nodeId, label, action })
 *
 * Rule: if a catch block calls this, it is NOT a silent failure.
 */

import { prisma } from '@/lib/db/prisma'

// ── Types ──────────────────────────────────────────────────────────────────────

export type FailureKind =
  | 'node_failed'         // a build node failed to execute
  | 'budget_exceeded'     // hourly mutation budget hit
  | 'lock_conflict'       // could not acquire project lock
  | 'validation_failed'   // pre-execution validation rejected the plan
  | 'resume_failed'       // continuation/resume could not bind to job
  | 'orchestration_error' // post-build orchestration failed
  | 'governance_blocked'  // approval required but not obtained
  | 'unknown'             // catch-all for unexpected errors

export interface BuildFailureContext {
  projectId: string
  userId?: string
  nodeId?: string
  nodeLabel?: string
  action?: string
  phase?: string
  emit?: (event: string, data: unknown) => void
}

export interface FailureRecord {
  kind: FailureKind
  message: string
  projectId: string
  nodeId?: string
  nodeLabel?: string
  action?: string
  occurredAt: string
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Log a build failure: persists to AuditLog, emits SSE event, logs to console.
 * Safe to call from any catch block — never throws.
 */
export async function logBuildFailure(
  ctx: BuildFailureContext,
  kind: FailureKind,
  error: unknown,
  extra?: Record<string, unknown>,
): Promise<void> {
  const message = errorMessage(error)
  const occurredAt = new Date().toISOString()

  const record: FailureRecord = {
    kind,
    message,
    projectId: ctx.projectId,
    nodeId: ctx.nodeId,
    nodeLabel: ctx.nodeLabel,
    action: ctx.action,
    occurredAt,
  }

  // 1. Console — always, even if everything else fails
  console.error(`[BuildFailure] ${kind} | project=${ctx.projectId} node=${ctx.nodeId ?? '-'} action=${ctx.action ?? '-'}: ${message}`, extra ?? '')

  // 2. SSE emit — frontend sees explicit error, not silence
  if (ctx.emit) {
    try {
      ctx.emit('step_failed', {
        kind,
        nodeId: ctx.nodeId,
        label: ctx.nodeLabel ?? ctx.action ?? kind,
        error: message,
        timestamp: occurredAt,
      })
    } catch { /* emit itself must not crash the caller */ }
  }

  // 3. AuditLog persistence — queryable from the UI
  try {
    await prisma.auditLog.create({
      data: {
        projectId: ctx.projectId,
        userId: ctx.userId ?? 'system',
        action: `BUILD_FAILURE:${kind}`,
        type: 'build',
        details: JSON.stringify({
          ...record,
          ...extra,
          errorStack: error instanceof Error ? error.stack?.slice(0, 500) : undefined,
        }),
        timestamp: new Date(),
      },
    })
  } catch { /* AuditLog write failed — console already captured it */ }
}

/**
 * Synchronous variant — only emits SSE + console, no DB write.
 * Use when you're in a sync context or the DB is unavailable.
 */
export function logBuildFailureSync(
  ctx: BuildFailureContext,
  kind: FailureKind,
  error: unknown,
): void {
  const message = errorMessage(error)
  console.error(`[BuildFailure:sync] ${kind} | project=${ctx.projectId} node=${ctx.nodeId ?? '-'}: ${message}`)
  if (ctx.emit) {
    try {
      ctx.emit('step_failed', {
        kind,
        nodeId: ctx.nodeId,
        label: ctx.nodeLabel ?? kind,
        error: message,
        timestamp: new Date().toISOString(),
      })
    } catch { /* must not throw */ }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as any).message)
  }
  return 'Unknown error'
}
