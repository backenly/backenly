'use client'

/**
 * The live half of the projects list: what waits on the person, when the
 * self-healing loop last checked, whether their agent has connected
 * (GET /api/projects/status, lib/projects/live-status.ts).
 *
 * Asked only once the list is on screen, so the list never waits for it, and
 * again every minute while the tab is visible: the loop passes once a minute,
 * so "Checked 40 s ago" would turn into a stale claim if it were read once.
 * A failed read keeps the last good answer; with none, the list simply shows
 * no live state.
 */

import { useEffect, useState } from 'react'

export interface LiveStatus {
  waiting: number
  lastCheckAt: string | null
  agentLastSeenAt: string | null
}

export interface LiveStatusState {
  /** Per project id; null until the first answer. */
  byId: Map<string, LiveStatus> | null
  /** True once the first read finished, answered or not. */
  settled: boolean
}

const POLL_MS = 60_000

/** Kept per organization, so coming back to the page shows the last answer at once. */
const kept = new Map<string, Map<string, LiveStatus>>()

export function useLiveStatus(orgId: string | null, enabled: boolean): LiveStatusState {
  const key = orgId ?? ''
  const [state, setState] = useState<LiveStatusState & { key: string }>(() => {
    const hit = kept.get(key)
    return { key, byId: hit ?? null, settled: !!hit }
  })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastRead = 0

    const read = async () => {
      lastRead = Date.now()
      try {
        const res = await fetch(orgId ? `/api/projects/status?orgId=${encodeURIComponent(orgId)}` : '/api/projects/status', {
          credentials: 'include',
          cache: 'no-store',
        })
        const body = res.ok ? await res.json().catch(() => null) : null
        if (cancelled) return
        if (Array.isArray(body?.data)) {
          const byId = new Map<string, LiveStatus>()
          for (const row of body.data as Array<LiveStatus & { id: string }>) {
            byId.set(row.id, {
              waiting: typeof row.waiting === 'number' ? row.waiting : 0,
              lastCheckAt: row.lastCheckAt ?? null,
              agentLastSeenAt: row.agentLastSeenAt ?? null,
            })
          }
          kept.set(key, byId)
          setState({ key, byId, settled: true })
        } else {
          setState((s) => (s.key === key && s.settled ? s : { key, byId: s.key === key ? s.byId : null, settled: true }))
        }
      } catch {
        if (!cancelled) {
          setState((s) => (s.key === key && s.settled ? s : { key, byId: s.key === key ? s.byId : null, settled: true }))
        }
      } finally {
        if (!cancelled) schedule()
      }
    }

    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible') read()
        else schedule()
      }, POLL_MS)
    }

    // Back on the tab after a while: read now rather than at the next tick.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRead > POLL_MS / 2) {
        clearTimeout(timer)
        read()
      }
    }

    read()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, orgId, key])

  // Another organization's answer never stands in for this one's.
  if (state.key !== key) {
    const hit = kept.get(key)
    return { byId: hit ?? null, settled: !!hit }
  }
  return { byId: state.byId, settled: state.settled }
}

/** The current time, moved on every `everyMs` while the tab is visible, for relative times. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') setNow(Date.now())
    }, everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now
}
