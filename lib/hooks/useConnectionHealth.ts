'use client'

import { useEffect, useState, useCallback } from 'react'

/**
 * useConnectionHealth — single source of truth for the "is a real frontend
 * connected to this backend?" question.
 *
 * Shared across:
 *   - the inspector sidebar pill   (always-visible status)
 *   - the Connect Frontend hero    (celebratory success state)
 *   - the Publish page status bar  (production confidence badge)
 *
 * Polls /api/projects/[id]/connection-health every 15s so a developer who
 * just pasted a fix into their AI builder sees the pill flip green within
 * one tick. Cheap query (5k events cap, indexed on projectId + createdAt).
 *
 * `status` is the at-a-glance summary the UI renders against:
 *   - 'idle'       : no requests yet, nothing to say
 *   - 'connected'  : ≥1 bootstrap in 24h, 0 failures → all good
 *   - 'degraded'   : both successes AND failures → partial
 *   - 'failing'    : failures only → something is wrong
 *   - 'loading'    : initial fetch in flight (avoid flicker)
 */

export type FailureKind = 'missing' | 'placeholder' | 'malformed' | 'unknown_key' | 'expired' | 'unknown'

export interface FailureGroup {
  origin: string
  kind: FailureKind
  sentKeyShape: string | null
  count: number
  lastSeen: string
  hint: string
  fixPrompt: string
}

export interface SuccessGroup {
  origin: string
  count: number
  lastSeen: string
}

export interface ConnectionHealth {
  failures: FailureGroup[]
  successes: SuccessGroup[]
  /**
   * Origin-less rejections (no Origin/Referer header): curl, bots, scanners,
   * or server-side scripts. Informational only — excluded from totals and
   * never drives the degraded/failing status.
   */
  probes?: { count: number; lastSeen: string | null }
  totals: {
    failures24h: number
    failures1h: number
    bootstraps24h: number
    distinctOriginsFailing: number
    distinctOriginsConnected: number
  }
  summaryText: string
}

export type ConnectionStatus = 'loading' | 'idle' | 'connected' | 'degraded' | 'failing'

export interface UseConnectionHealthResult {
  health: ConnectionHealth | null
  status: ConnectionStatus
  primaryOrigin: string | null     // most-active connected origin (for badge text)
  loading: boolean
  refresh: () => Promise<void>
}

export function useConnectionHealth(projectId: string | null | undefined): UseConnectionHealthResult {
  const [health, setHealth] = useState<ConnectionHealth | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!projectId) return
    try {
      const res = await fetch(`/api/projects/${projectId}/connection-health`, {
        credentials: 'include',
      })
      if (res.ok) setHealth(await res.json())
    } catch {
      // Soft-fail — the pill collapses to 'idle' rather than blocking the UI.
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
    const t = setInterval(refresh, 15_000)
    return () => clearInterval(t)
  }, [projectId, refresh])

  const status: ConnectionStatus = (() => {
    if (loading && !health) return 'loading'
    if (!health) return 'idle'
    const hasSuccess = health.totals.bootstraps24h > 0
    const hasFailure = health.totals.failures24h > 0
    if (!hasSuccess && !hasFailure) return 'idle'
    if (hasSuccess && !hasFailure) return 'connected'
    if (hasSuccess && hasFailure) return 'degraded'
    return 'failing'
  })()

  const primaryOrigin = health?.successes[0]?.origin
    ?? (status === 'failing' ? health?.failures[0]?.origin ?? null : null)
    ?? null

  return { health, status, primaryOrigin, loading, refresh }
}
