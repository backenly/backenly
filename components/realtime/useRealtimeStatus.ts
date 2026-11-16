'use client'

/**
 * Which tables stream and who is online: GET /api/projects/[id]/realtime-status,
 * read every 5 s while the page is open.
 *
 * Reading never turns realtime on (the route says so at length): realtime is
 * opt-in per table, and the page only reports it.
 *
 * A failed first read leaves `status` null with `error` set, so the page shows
 * its error row and never the "no table streams yet" state it cannot know is
 * true. A failed later read keeps the last answer and `fetchedAt` says how old
 * it is ("Showing streaming tables from 2:14 PM").
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getAuthToken } from '@/lib/api/auth'

export interface RealtimeStatus {
  triggeredTables: string[]
  onlineUsers: number
}

export const STATUS_POLL_MS = 5_000

export interface RealtimeStatusState {
  status: RealtimeStatus | null
  /** No answer yet, and no failure yet. */
  loading: boolean
  /** The last read failed: the session ended ('auth') or anything else ('network'). */
  error: 'auth' | 'network' | null
  /** When `status` was read, in ms. */
  fetchedAt: number | null
  /** Read now (the bar's refresh, Try again). */
  refresh: () => Promise<void>
  /** A read asked for by the person is in flight (polls do not spin the button). */
  refreshing: boolean
}

function parse(body: unknown): RealtimeStatus | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const tables = Array.isArray(b.triggeredTables) ? b.triggeredTables.filter((t): t is string => typeof t === 'string') : []
  const online = typeof b.onlineUsers === 'number' && Number.isFinite(b.onlineUsers) ? b.onlineUsers : 0
  return { triggeredTables: tables, onlineUsers: online }
}

export function useRealtimeStatus(projectId: string): RealtimeStatusState {
  const [status, setStatus] = useState<RealtimeStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<'auth' | 'network' | null>(null)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const alive = useRef(true)

  const read = useCallback(async () => {
    try {
      const token = getAuthToken()
      const res = await fetch(`/api/projects/${projectId}/realtime-status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      })
      if (!alive.current) return
      if (res.ok) {
        const parsed = parse(await res.json().catch(() => null))
        if (!alive.current) return
        if (parsed) {
          setStatus(parsed)
          setFetchedAt(Date.now())
          setError(null)
          return
        }
        setError('network')
        return
      }
      setError(res.status === 401 ? 'auth' : 'network')
    } catch {
      if (alive.current) setError('network')
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    alive.current = true
    void read()
    const timer = setInterval(() => void read(), STATUS_POLL_MS)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [read])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await read()
    } finally {
      if (alive.current) setRefreshing(false)
    }
  }, [read])

  return { status, loading, error, fetchedAt, refresh, refreshing }
}
