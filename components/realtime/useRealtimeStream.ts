'use client'

/**
 * The Realtime page's live stream: one EventSource per connect, kept alive
 * across server restarts and Wi-Fi flickers without a reload.
 *
 * Carried over from the old workbench, unchanged in what it decides:
 *
 * - Ticket first. Every connect asks the console for a fresh single-use ticket
 *   (app/api/projects/[id]/realtime-ticket): it sees every change, as the
 *   console's row browser shows every row, and puts no long-lived key in a
 *   URL. Only a project that cannot issue one (409) falls back to the public
 *   anon key, and `anonymousView` says so, because that stream receives only
 *   what a signed-out visitor could read.
 * - Self-healing. A transient failure schedules a reconnect with exponential
 *   backoff and ±25% jitter, capped at 30 s, and counts down so the page can
 *   say "Reconnecting in 4 s". `retryNow` skips the wait.
 * - Fatal is final. A failure that retrying cannot fix (the plan's connection
 *   cap, a signed-out session, a project that is gone, paused or locked) stops
 *   retrying and keeps the server's own words in `fatalReason`.
 *
 * What changed: each connect attempt is cancelled with its own effect run.
 * The old guard was one shared ref, so under React's development double mount
 * the first attempt's await resumed after the second mount had reset it and
 * opened a second stream. And every frame is kept whole (event-format.ts):
 * the page used to drop `data` and `old`.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getAuthToken } from '@/lib/api/auth'
import { getProject } from '@/lib/api/projects'
import { FEED_EVENT_TYPES, toLiveEvent, type LiveEvent } from './event-format'

/** `idle` is the first paint, before the first attempt starts. */
export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'fatal'

/** The feed keeps this many events, newest first. */
export const FEED_LIMIT = 100

/** Error codes no retry can fix. */
const FATAL_CODES = new Set(['PLAN_LIMIT_EXCEEDED', 'INVALID_PROJECT', 'PROJECT_PAUSED', 'PROJECT_LOCKED'])
/** Server messages no retry can fix: the concurrency cap, a 401-shaped refusal, a bad key. */
const FATAL_PATTERNS = [/reached its limit/i, /unauthor/i, /api key/i]

export const isFatalFrame = (code: unknown, message: string | undefined) =>
  (typeof code === 'string' && FATAL_CODES.has(code)) || (!!message && FATAL_PATTERNS.some((re) => re.test(message)))

/** Exponential backoff with ±25% jitter, capped at 30 s. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * Math.pow(2, attempt))
  return Math.floor(base * (0.75 + random() * 0.5))
}

const SESSION_EXPIRED = 'Your session expired. Reload to see live changes.'

export interface RealtimeStream {
  state: ConnectionState
  /** Whole seconds until the next attempt, while reconnecting. */
  retryIn: number | null
  /** Why the stream stopped for good, in the server's words where it gave any. */
  fatalReason: string | null
  /** The stream runs on the anon key: it shows only what a signed-out visitor could read. */
  anonymousView: boolean
  /** When the current stream said it was connected, in ms. */
  connectedAt: number | null
  /** Newest first, at most FEED_LIMIT. */
  events: LiveEvent[]
  /** Every event received since the last Clear, by kind, beyond the kept 100. */
  counts: Record<string, number>
  /** Empty the feed and its counts. */
  clear: () => void
  /** While reconnecting: try now instead of waiting out the countdown. */
  retryNow: () => void
}

export function useRealtimeStream(projectId: string): RealtimeStream {
  const [state, setState] = useState<ConnectionState>('idle')
  const [retryIn, setRetryIn] = useState<number | null>(null)
  const [fatalReason, setFatalReason] = useState<string | null>(null)
  const [anonymousView, setAnonymousView] = useState(false)
  const [connectedAt, setConnectedAt] = useState<number | null>(null)
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})

  // The current run's "try now", set inside the effect.
  const retryNowRef = useRef<() => void>(() => {})
  const counterRef = useRef(0)
  // The anon key and the project's API base are read once per page, not per reconnect.
  const anonKeyRef = useRef<string | null>(null)
  // {origin}/api/v1/{id} in the project's own region: a project outside the
  // home region streams from its region's service (lib/data-plane/serving.ts).
  const apiBaseRef = useRef<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    let alive = true
    let attempt = 0
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let countdown: ReturnType<typeof setInterval> | null = null

    const authHeaders = (): Record<string, string> => {
      const token = getAuthToken()
      return token ? { Authorization: `Bearer ${token}` } : {}
    }

    const clearTimers = () => {
      if (retryTimer) clearTimeout(retryTimer)
      if (countdown) clearInterval(countdown)
      retryTimer = null
      countdown = null
      setRetryIn(null)
    }

    const closeStream = () => {
      es?.close()
      es = null
    }

    const scheduleReconnect = () => {
      if (!alive) return
      closeStream()
      clearTimers()
      const delay = backoffMs(attempt)
      attempt += 1
      setState('reconnecting')
      setConnectedAt(null)
      const startedAt = Date.now()
      setRetryIn(Math.max(1, Math.ceil(delay / 1000)))
      countdown = setInterval(() => {
        const left = Math.max(0, Math.ceil((delay - (Date.now() - startedAt)) / 1000))
        setRetryIn(left)
        if (left <= 0 && countdown) {
          clearInterval(countdown)
          countdown = null
        }
      }, 250)
      retryTimer = setTimeout(() => void open(), delay)
    }

    const setFatal = (reason: string) => {
      clearTimers()
      closeStream()
      setConnectedAt(null)
      setFatalReason(reason)
      setState('fatal')
    }

    async function open() {
      if (!alive) return
      clearTimers()
      setFatalReason(null)
      setState('connecting')

      let credential: string | null = null
      try {
        const res = await fetch(`/api/projects/${projectId}/realtime-ticket`, {
          method: 'POST',
          headers: authHeaders(),
          credentials: 'include',
        })
        if (!alive) return
        if (res.status === 401) return setFatal(SESSION_EXPIRED)
        if (res.ok) {
          const body = await res.json().catch(() => null)
          if (!alive) return
          if (body?.ticket) credential = `ticket=${encodeURIComponent(body.ticket)}`
          setAnonymousView(false)
        } else if (res.status !== 409) {
          return scheduleReconnect()
        }
      } catch {
        return scheduleReconnect()
      }

      if (!credential) {
        // No ticket: the anon key, minted by the server on its first read.
        if (!anonKeyRef.current) {
          try {
            const res = await fetch(`/api/projects/${projectId}/anon-key`, { headers: authHeaders(), credentials: 'include' })
            if (!alive) return
            if (res.status === 401) return setFatal(SESSION_EXPIRED)
            if (!res.ok) return scheduleReconnect()
            const body = await res.json().catch(() => null)
            if (!alive) return
            anonKeyRef.current = body?.anonKey ?? null
          } catch {
            return scheduleReconnect()
          }
        }
        if (!anonKeyRef.current) return setFatal("This project's anon key could not be made. Reload to try again.")
        credential = `apiKey=${encodeURIComponent(anonKeyRef.current)}`
        setAnonymousView(true)
      }

      if (!apiBaseRef.current) {
        try {
          apiBaseRef.current = (await getProject(projectId)).apiBaseUrl ?? null
        } catch {
          return scheduleReconnect()
        }
        if (!alive) return
      }
      if (!apiBaseRef.current) return setFatal("This project's API address is not available from this console. Reload to try again.")

      const source = new EventSource(`${apiBaseRef.current}/realtime?${credential}`)
      es = source

      source.onmessage = (msg) => {
        if (!alive || es !== source) return
        let frame: any
        try {
          frame = JSON.parse(msg.data)
        } catch {
          return // a malformed frame is skipped, not fatal
        }
        if (!frame || typeof frame !== 'object') return
        if (frame.type === 'connected') {
          attempt = 0
          clearTimers()
          setConnectedAt(Date.now())
          setState('connected')
          return
        }
        if (frame.type === 'error') {
          const message = typeof frame.message === 'string' ? frame.message : 'The realtime stream stopped.'
          // The server closes the stream after an error frame: fatal or reconnect, never both, never neither.
          if (isFatalFrame(frame.code, message)) setFatal(message)
          else scheduleReconnect()
          return
        }
        if (!FEED_EVENT_TYPES.has(frame.type)) return
        const ev = toLiveEvent(frame, `e${Date.now().toString(36)}${(counterRef.current++).toString(36)}`)
        if (!ev) return
        setCounts((c) => ({ ...c, [ev.type]: (c[ev.type] ?? 0) + 1 }))
        setEvents((prev) => [ev, ...prev].slice(0, FEED_LIMIT))
      }

      source.onerror = () => {
        // EventSource retries on its own, at a cadence nobody can see. Take
        // over, so the countdown is real and the backoff is ours.
        if (!alive || es !== source) return
        scheduleReconnect()
      }
    }

    retryNowRef.current = () => {
      if (!alive) return
      attempt = 0
      void open()
    }

    void open()

    return () => {
      alive = false
      clearTimers()
      closeStream()
      retryNowRef.current = () => {}
    }
  }, [projectId])

  const clear = useCallback(() => {
    setEvents([])
    setCounts({})
  }, [])
  const retryNow = useCallback(() => retryNowRef.current(), [])

  return { state, retryIn, fatalReason, anonymousView, connectedAt, events, counts, clear, retryNow }
}
