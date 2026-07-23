'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * useAutonomyStatus — shared, lightweight read of the project's autonomy
 * trust report. Backs the dashboard Autonomy card and the chat-header pill,
 * so both surfaces show the same level + pending count without double-fetching.
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
}

export interface UseAutonomyStatusResult {
  status: AutonomyStatus | null
  loading: boolean
  refresh: () => Promise<void>
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

  const refresh = useCallback(async () => {
    if (!projectId) return
    try {
      const res = await fetch(`/api/projects/${projectId}/autonomy`, {
        credentials: 'include',
      })
      if (!res.ok) return
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
      })
    } catch {
      // Soft-fail — surfaces fall back to neutral / hidden state.
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

  return { status, loading, refresh }
}
