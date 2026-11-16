'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * useAutonomyStatus — shared, lightweight read of the project's autonomy
 * trust report. Backs the Overview's Self-healing row and its "Waiting on
 * you" rows, from one read of GET /api/projects/[id]/autonomy.
 *
 * `executionMode` is the server's statement of whether this deployment can
 * apply a repair at all (lib/autonomy/execution-mode.ts). The dial alone said
 * "Autopilot" on a deployment that only watches; the Overview now reads this
 * before it claims anything is being repaired (2026-11-16).
 *
 * Refresh policy mirrors useConnectionHealth: pull on mount, on tab focus, and
 * on visibilitychange. No background polling — the trust report is computed
 * over a 30-day window, so per-second freshness is wasted work.
 */

export type AutonomyLevel = 'OFF' | 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE'

export interface AutonomyLastAction {
  at: string
  kind: string
  summary: string
  /** Consecutive occurrences this row stands for (folded server-side). */
  repeat?: number
}

/** What the loop will actually do on this deployment (lib/autonomy/execution-mode.ts). */
export interface AutonomyExecution {
  mode: 'live' | 'shadow'
  /** live · loop_off · deployment_flag_off · project_dial_off */
  reason: string
  explanation: string
  /** True only when the loop can currently apply a fix to this project. */
  repairsAreApplied: boolean
}

/** One change held for a person, as the trust report lists it (Autonomy's queue reads the same). */
export interface AutonomyPendingApproval {
  id: string
  type: string
  severity: string
  detectedAt: string
  reason?: string
  details: Record<string, unknown> | null
}

export interface AutonomyStatus {
  level: AutonomyLevel
  cap: AutonomyLevel
  pendingCount: number
  autonomousFixes: number
  rollbacks: number
  /** Share of autonomous fixes not later rolled back, 0..1 (null if none yet). */
  verifiedRate: number | null
  /** Size of the declarative invariant catalogue the loop reconciles toward. */
  invariantCount: number | null
  lastAction: AutonomyLastAction | null
  /**
   * The guardrail receipt feed, newest first — the same rows the Autonomy page
   * lists under "Recent guardrail actions", already folded by repeat and
   * already stripped of internal bookkeeping (see lib/autonomy/trust-report).
   * The dashboard renders the top few beneath the loop as proof the loop ran;
   * the full log stays on Autonomy.
   */
  recentActivity: AutonomyLastAction[]
  /** Null from a server that predates the field: then nothing is claimed either way. */
  executionMode: AutonomyExecution | null
  /** When Backenly last applied a fix of its own, from the report's applied changes. */
  lastFixAt: string | null
  /** What Backenly holds for a person (repairs and architecture changes), uncapped. */
  pendingApprovals: AutonomyPendingApproval[]
}

export interface UseAutonomyStatusResult {
  status: AutonomyStatus | null
  loading: boolean
  /** The last read failed. With a status, that status is the last good one. */
  error: boolean
  refresh: () => Promise<void>
}

function parseExecution(raw: unknown): AutonomyExecution | null {
  const e = raw as Partial<AutonomyExecution> | null | undefined
  if (!e || (e.mode !== 'live' && e.mode !== 'shadow') || typeof e.repairsAreApplied !== 'boolean') return null
  return {
    mode: e.mode,
    reason: typeof e.reason === 'string' ? e.reason : e.mode,
    explanation: typeof e.explanation === 'string' ? e.explanation : '',
    repairsAreApplied: e.repairsAreApplied,
  }
}

/** The newest moment among the applied changes, else the newest fix in the activity feed. */
function lastFixOf(report: any, activity: AutonomyLastAction[]): string | null {
  const times: number[] = []
  if (Array.isArray(report?.appliedChanges)) {
    for (const c of report.appliedChanges) {
      const t = typeof c?.at === 'string' ? Date.parse(c.at) : NaN
      if (Number.isFinite(t)) times.push(t)
    }
  }
  if (times.length === 0) {
    for (const a of activity) {
      if (a.kind !== 'auto_fix' && a.kind !== 'applied') continue
      const t = Date.parse(a.at)
      if (Number.isFinite(t)) times.push(t)
    }
  }
  return times.length ? new Date(Math.max(...times)).toISOString() : null
}

// Display labels only — the persisted values (OFF/CONSERVATIVE/BALANCED/
// AGGRESSIVE) are unchanged in the DB/billing/breaker logic. The product
// ships THREE modes (2026-07-18): legacy BALANCED rows label as Autopilot.
// See components/AutonomyGuardrailsSettings.tsx, which owns the same mapping
// for the Settings dial.
const LEVEL_LABEL: Record<AutonomyLevel, string> = {
  OFF: 'Off',
  CONSERVATIVE: 'Review-only',
  BALANCED: 'Autopilot',
  AGGRESSIVE: 'Autopilot',
}

export function levelLabel(level: AutonomyLevel | null | undefined): string {
  if (!level) return '—'
  return LEVEL_LABEL[level] ?? '—'
}

export function useAutonomyStatus(
  projectId: string | null | undefined,
): UseAutonomyStatusResult {
  const [status, setStatus] = useState<AutonomyStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  const refresh = useCallback(async () => {
    if (!projectId) return
    try {
      const res = await fetch(`/api/projects/${projectId}/autonomy`, {
        credentials: 'include',
      })
      if (!res.ok) {
        setError(true)
        return
      }
      const report = await res.json()
      const activity: AutonomyLastAction[] = Array.isArray(report?.recentActivity)
        ? report.recentActivity
            .filter((a: any) => a && typeof a.at === 'string' && typeof a.summary === 'string')
            .map((a: any) => ({
              at: a.at,
              kind: String(a.kind ?? 'other'),
              summary: a.summary,
              repeat: typeof a.repeat === 'number' ? a.repeat : 1,
            }))
        : []
      const recent = activity[0] ?? null
      setStatus({
        level: (report?.level ?? 'OFF') as AutonomyLevel,
        cap: (report?.cap ?? 'CONSERVATIVE') as AutonomyLevel,
        pendingCount: Array.isArray(report?.pendingApprovals)
          ? report.pendingApprovals.length
          : 0,
        autonomousFixes: Number(report?.scoreboard?.autonomousFixes ?? 0),
        rollbacks: Number(report?.scoreboard?.rollbacks ?? 0),
        verifiedRate:
          typeof report?.scoreboard?.verifiedRate === 'number'
            ? report.scoreboard.verifiedRate
            : null,
        invariantCount:
          typeof report?.invariantCount === 'number' ? report.invariantCount : null,
        lastAction: recent,
        recentActivity: activity,
        executionMode: parseExecution(report?.executionMode),
        lastFixAt: lastFixOf(report, activity),
        pendingApprovals: Array.isArray(report?.pendingApprovals)
          ? report.pendingApprovals
              .filter((p: any) => p && typeof p.id === 'string' && typeof p.type === 'string')
              .map((p: any) => ({
                id: p.id,
                type: p.type,
                severity: String(p.severity ?? 'info'),
                detectedAt: String(p.detectedAt ?? ''),
                reason: typeof p.reason === 'string' ? p.reason : undefined,
                details: p.details && typeof p.details === 'object' ? p.details : null,
              }))
          : [],
      })
      setError(false)
    } catch {
      // A failed read keeps the last good status and says it failed.
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (!projectId) {
      setLoading(false)
      return
    }
    refresh()
    const onVisible = () => {
      if (!document.hidden) refresh()
    }
    const onFocus = () => refresh()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [projectId, refresh])

  return { status, loading, error, refresh }
}
