/**
 * EXECUTION TRACER — Runtime Observability
 * ==========================================
 * Structured tracing for every autonomous action.
 * Without this, debugging autonomous systems becomes impossible.
 *
 * Records:
 *  - Agent runs (per-agent: what it checked, what it found, why it decided to act)
 *  - Auto-fixes (what was applied, snapshot reference)
 *  - Approval events (applied/dismissed/rolled back)
 *  - Schema drift detections
 *  - Reconciliation runs
 *
 * Stored in ExecutionLog.metadata (existing model, no new migration needed).
 * Timeline API joins ExecutionLog + HealthFinding + AutonomousAction + WorkspaceSchemaSnapshot.
 */

import { prisma } from '@/lib/db/prisma'

// ── Trace types ───────────────────────────────────────────────────────────────

export type TraceEventType =
  | 'agent_run'
  | 'auto_fix_applied'
  | 'approval_applied'
  | 'approval_dismissed'
  | 'rollback_executed'
  | 'rollback_failed'         // rollback attempted but DDL execution failed
  | 'schema_drift_detected'
  | 'reconciliation_run'
  | 'simulation_run'
  | 'orchestration_start'
  | 'orchestration_complete'
  | 'budget_exceeded'
  | 'lock_contention'

export interface AgentTrace {
  type: TraceEventType
  agentType?: string
  durationMs?: number
  findingsCount?: number
  autoFixedCount?: number
  conflictsResolved?: number
  skipped?: boolean
  skipReason?: string
  details?: Record<string, unknown>
}

export interface TimelineEntry {
  id: string
  type: TraceEventType | 'health_finding' | 'autonomous_action' | 'snapshot'
  timestamp: string
  summary: string
  severity?: string
  metadata?: Record<string, unknown>
  source: 'execution_log' | 'health_finding' | 'autonomous_action' | 'snapshot'
}

// ── Trace emission ────────────────────────────────────────────────────────────

// Patterns that must never appear in stored trace details.
// Matches: "sk-...", "Bearer ...", "postgresql://...", "mongodb://...",
//          things that look like API keys (long alphanumeric strings after "key" / "secret" / "token").
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/g,
  /bearer\s+[A-Za-z0-9\-._~+/]{20,}/gi,
  /postgresql:\/\/[^\s"']*/gi,
  /mongodb(\+srv)?:\/\/[^\s"']*/gi,
  /"(key|secret|token|password|apiKey|api_key|accessKey|access_key)"\s*:\s*"[^"]{8,}"/gi,
]

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  let str = JSON.stringify(details)
  for (const pattern of SECRET_PATTERNS) {
    str = str.replace(pattern, '[REDACTED]')
  }
  try {
    return JSON.parse(str)
  } catch {
    return { _sanitizationError: true }
  }
}

/**
 * Emit a structured trace event to the ExecutionLog.
 * Fire-and-forget safe — never throws.
 * Details are sanitized before storage to prevent accidental secret leakage.
 */
export async function emitTrace(projectId: string, trace: AgentTrace): Promise<void> {
  try {
    const safeDetails = trace.details ? sanitizeDetails(trace.details) : {}
    await prisma.executionLog.create({
      data: {
        projectId,
        intent: 'AGENT_RUN',
        strategy: trace.agentType ?? 'orchestrator',
        action: trace.type,
        durationMs: trace.durationMs ?? 0,
        success: !trace.skipReason,
        errorMsg: trace.skipReason,
        metadata: {
          eventType: trace.type,
          agentType: trace.agentType,
          findingsCount: trace.findingsCount ?? 0,
          autoFixedCount: trace.autoFixedCount ?? 0,
          conflictsResolved: trace.conflictsResolved ?? 0,
          skipped: trace.skipped ?? false,
          ...safeDetails,
        },
      },
    })
  } catch {
    // Non-fatal — observability failure never blocks execution
  }
}

// ── Timeline builder ──────────────────────────────────────────────────────────

/**
 * Build a unified timeline from all observability sources.
 * Joins ExecutionLog + HealthFinding + AutonomousAction + WorkspaceSchemaSnapshot.
 * Returns entries sorted by timestamp descending.
 */
export async function buildTimeline(
  projectId: string,
  options?: {
    limit?: number
    types?: string[]
    since?: Date
  },
): Promise<TimelineEntry[]> {
  const limit = options?.limit ?? 100
  const since = options?.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30 days

  const [execLogs, healthFindings, autonomousActions, snapshots] = await Promise.all([
    prisma.executionLog.findMany({
      where: {
        projectId,
        intent: 'AGENT_RUN',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.healthFinding.findMany({
      where: { projectId, detectedAt: { gte: since } },
      orderBy: { detectedAt: 'desc' },
      take: 50,
    }),
    prisma.autonomousAction.findMany({
      where: { projectId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    }),
    prisma.workspaceSchemaSnapshot.findMany({
      where: { projectId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ])

  const entries: TimelineEntry[] = []

  // ── Execution logs ────────────────────────────────────────────────────────
  for (const log of execLogs) {
    const meta = (log.metadata ?? {}) as Record<string, unknown>
    const eventType = (meta.eventType as TraceEventType) ?? 'agent_run'

    entries.push({
      id: log.id,
      type: eventType,
      timestamp: log.createdAt.toISOString(),
      summary: formatExecLogSummary(log.action, log.strategy, meta),
      metadata: meta,
      source: 'execution_log',
    })
  }

  // ── Health findings ───────────────────────────────────────────────────────
  for (const finding of healthFindings) {
    const details = (finding.details ?? {}) as Record<string, unknown>
    entries.push({
      id: finding.id,
      type: 'health_finding',
      timestamp: finding.detectedAt.toISOString(),
      summary: `[${finding.severity.toUpperCase()}] ${details.title ?? finding.type} on ${details.location ?? '?'}`,
      severity: finding.severity,
      metadata: {
        status: finding.status,
        autoFixed: finding.autoFixed,
        fixAppliedAt: finding.fixAppliedAt?.toISOString(),
        ...details,
      },
      source: 'health_finding',
    })
  }

  // ── Autonomous actions ────────────────────────────────────────────────────
  for (const action of autonomousActions) {
    const fixes = action.appliedFixes as string[]
    const pending = action.pendingReview as unknown[]
    entries.push({
      id: action.id,
      type: 'auto_fix_applied',
      timestamp: action.createdAt.toISOString(),
      summary: fixes.length > 0
        ? `Auto-fixed ${fixes.length} issue(s): ${fixes.slice(0, 3).join(', ')}${fixes.length > 3 ? '…' : ''}`
        : `${pending.length} issue(s) queued for review`,
      metadata: {
        appliedFixes: fixes,
        pendingReviewCount: pending.length,
        seenByUser: action.seenByUser,
      },
      source: 'autonomous_action',
    })
  }

  // ── Schema snapshots ──────────────────────────────────────────────────────
  for (const snap of snapshots) {
    entries.push({
      id: snap.id,
      type: 'snapshot',
      timestamp: snap.createdAt.toISOString(),
      summary: `Schema snapshot v${snap.versionNum} — ${snap.tableCount} tables (trigger: ${snap.trigger})`,
      metadata: {
        versionNum: snap.versionNum,
        trigger: snap.trigger,
        tableCount: snap.tableCount,
        columnCount: snap.columnCount,
      },
      source: 'snapshot',
    })
  }

  // ── Sort by timestamp descending ─────────────────────────────────────────
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  // ── Apply type filter ────────────────────────────────────────────────────
  const filtered = options?.types
    ? entries.filter(e => options.types!.includes(e.type))
    : entries

  return filtered.slice(0, limit)
}

// ── Mutation timeline (schema-level view) ─────────────────────────────────────

/**
 * Returns a timeline of schema mutations only — diffs between snapshots.
 * Shows what changed, when, and why (trigger context).
 */
export async function buildMutationTimeline(
  projectId: string,
  limit = 20,
): Promise<Array<{ versionNum: number; createdAt: string; trigger: string; tableCount: number; columnCount: number }>> {
  const snaps = await prisma.workspaceSchemaSnapshot.findMany({
    where: { projectId },
    orderBy: { versionNum: 'desc' },
    take: limit,
    select: { versionNum: true, createdAt: true, trigger: true, tableCount: true, columnCount: true },
  })

  return snaps.map(s => ({
    versionNum: s.versionNum,
    createdAt: s.createdAt.toISOString(),
    trigger: s.trigger,
    tableCount: s.tableCount,
    columnCount: s.columnCount,
  }))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatExecLogSummary(
  action: string,
  strategy: string,
  meta: Record<string, unknown>,
): string {
  switch (action) {
    case 'orchestration_complete':
      return `Agent orchestration: ${meta.findingsCount ?? 0} findings, ${meta.autoFixedCount ?? 0} auto-fixed`
    case 'orchestration_start':
      return `Agent orchestration started`
    case 'budget_exceeded':
      return `Budget exceeded — scan skipped`
    case 'lock_contention':
      return `Lock contention — concurrent scan blocked`
    case 'rollback_failed':
      return `Rollback FAILED — schema may be in inconsistent state: ${meta.error ?? 'unknown error'}`
    case 'agent_run':
      return `${strategy} agent: ${meta.findingsCount ?? 0} finding(s)${meta.skipped ? ' (skipped)' : ''}`
    default:
      return `${strategy}: ${action}`
  }
}
