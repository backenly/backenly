/**
 * PHASE 10 — PER-MESSAGE DEBUG LOGGER
 * =====================================
 * Logs one structured record per AI chat message.
 *
 * Captures:
 *   - mode            (plan | build | special)
 *   - subBehavior     (EXECUTION | INSPECTION | MODIFICATION | CONTINUATION | VERIFICATION)
 *   - executionTriggered  (did the agent loop / executor actually run?)
 *   - actionsCount    (how many executor actions completed successfully)
 *   - artifactsCount  (how many distinct artifacts were created / named)
 *   - continuationSource  (sticky_store | history | none)
 *   - fallbackUsed    (true if we had to degrade to a generic response)
 *   - responseType    (the `type` field from the JSON response)
 *   - durationMs
 *
 * Storage: reuses prisma.executionLog with intent='MESSAGE_DEBUG' and all
 * Phase 10 fields packed into the existing metadata JSON column — no new
 * migrations required.
 *
 * Non-blocking everywhere: errors are swallowed so observability never
 * affects the main request flow.
 */

import { prisma } from '@/lib/db/prisma'

// ── Types ─────────────────────────────────────────────────────────────────────

export type DebugMode = 'plan' | 'build' | 'special'

export type ContinuationSource = 'sticky_store' | 'history' | 'none' | 'truncated_plan'

export interface MessageDebugEntry {
  projectId: string
  userId?: string
  /** plan = architecture/proposal chat; build = execution path; special = deploy/oauth/template/etc */
  mode: DebugMode
  /** One of the 5 build sub-behaviors, or undefined for plan/special paths */
  subBehavior?: string
  /** true if the executor / agent loop actually ran at least one action */
  executionTriggered: boolean
  /** number of actions that completed successfully */
  actionsCount: number
  /** number of distinct named artifacts produced */
  artifactsCount: number
  /** where continuation context was sourced from (relevant only when subBehavior=CONTINUATION) */
  continuationSource: ContinuationSource
  /**
   * true if the response is a generic fallback (classifier unavailable, no-context
   * continuation, etc.).  Should be false in healthy operation.
   */
  fallbackUsed: boolean
  /** the `type` field on the outgoing JSON response */
  responseType?: string
  /** wall-clock ms from request start to log call */
  durationMs: number
}

// ── Mutable context object ───────────────────────────────────────────────────
// Created once per request, mutated as the route progresses, written at exit.

export interface MessageDebugContext {
  projectId: string
  userId?: string
  mode: DebugMode
  subBehavior?: string
  executionTriggered: boolean
  actionsCount: number
  artifactsCount: number
  continuationSource: ContinuationSource
  fallbackUsed: boolean
  startedAt: number  // Date.now()
}

export function createDebugContext(projectId: string, userId?: string): MessageDebugContext {
  return {
    projectId,
    userId,
    mode: 'build',      // default; overridden when mode classifier runs
    subBehavior: undefined,
    executionTriggered: false,
    actionsCount: 0,
    artifactsCount: 0,
    continuationSource: 'none',
    fallbackUsed: false,
    startedAt: Date.now(),
  }
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Persist a per-message debug record.  Always fire-and-forget.
 */
export async function logMessageDebug(
  ctx: MessageDebugContext,
  responseType?: string,
): Promise<void> {
  const durationMs = Date.now() - ctx.startedAt
  try {
    await prisma.executionLog.create({
      data: {
        projectId: ctx.projectId,
        userId:    ctx.userId,
        intent:    'MESSAGE_DEBUG',
        strategy:  ctx.mode,
        action:    ctx.subBehavior ?? ctx.mode,
        durationMs,
        success:   !ctx.fallbackUsed,
        metadata: {
          mode:                ctx.mode,
          subBehavior:         ctx.subBehavior,
          executionTriggered:  ctx.executionTriggered,
          actionsCount:        ctx.actionsCount,
          artifactsCount:      ctx.artifactsCount,
          continuationSource:  ctx.continuationSource,
          fallbackUsed:        ctx.fallbackUsed,
          responseType:        responseType,
        } as any,
      },
    })
  } catch {
    // Non-fatal — observability must never break execution
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

export interface MessageDebugRecord {
  id: string
  mode: DebugMode
  subBehavior?: string
  executionTriggered: boolean
  actionsCount: number
  artifactsCount: number
  continuationSource: ContinuationSource
  fallbackUsed: boolean
  responseType?: string
  durationMs: number
  createdAt: Date
}

/**
 * Return the most recent per-message debug records for a project.
 */
export async function getMessageDebugLogs(
  projectId: string,
  limit = 20,
): Promise<MessageDebugRecord[]> {
  try {
    const rows = await prisma.executionLog.findMany({
      where:   { projectId, intent: 'MESSAGE_DEBUG' },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      select: {
        id: true, strategy: true, action: true,
        durationMs: true, success: true, metadata: true, createdAt: true,
      },
    })

    return rows.map(r => {
      const m = (r.metadata as Record<string, any>) ?? {}
      return {
        id:                  r.id,
        mode:                (m.mode ?? r.strategy) as DebugMode,
        subBehavior:         m.subBehavior ?? r.action ?? undefined,
        executionTriggered:  Boolean(m.executionTriggered),
        actionsCount:        Number(m.actionsCount ?? 0),
        artifactsCount:      Number(m.artifactsCount ?? 0),
        continuationSource:  (m.continuationSource ?? 'none') as ContinuationSource,
        fallbackUsed:        Boolean(m.fallbackUsed),
        responseType:        m.responseType ?? undefined,
        durationMs:          r.durationMs,
        createdAt:           r.createdAt,
      }
    })
  } catch {
    return []
  }
}
