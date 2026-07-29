'use client'

/**
 * Realtime workbench — the event stream as an instrument surface.
 *
 * The old page put the feed in a card sized with `calc(100vh - 380px)`, so the
 * stream got a fixed window while the page chrome above it kept its space
 * whether or not anything was streaming. A live tail should own the viewport.
 *
 * Three panes: streaming-table rail · event stream · session inspector.
 *
 * The SSE lifecycle below (jittered backoff, fatal-vs-transient classification,
 * observable countdown) is carried over unchanged — it is the reason this page
 * survives a server restart without a reload, and none of it is presentational.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { Radio, WifiOff, Circle, RefreshCw, AlertTriangle, Trash2 } from 'lucide-react'
import { getAuthToken } from '@/lib/api/auth'
import { KitNote, EmptyState, KIT } from '@/components/inspector/kit'

interface RealtimeStatusData {
  triggeredTables: string[]
  onlineUsers: number
  channel: string
}

interface LiveEvent {
  id: string
  type: string
  table?: string
  channel?: string
  timestamp: number
  truncated?: boolean
}

// `idle` is the initial paint before the first connect attempt resolves;
// treating it separately avoids flashing "Disconnected" for the first ~50ms.
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'fatal'

const DB_EVENT_TYPES = new Set(['insert', 'update', 'delete', 'presence', 'broadcast'])

// Errors we will not auto-retry on — retrying just burns connection slots until
// the user changes something (paying plan, signing in again).
const FATAL_PATTERNS = [
  /reached its limit/i,   // realtime concurrency cap (quota-kernel)
  /unauthor/i,            // 401-shape
  /api key/i,             // auth failure
]

const isFatalServerError = (message: string | undefined) =>
  !!message && FATAL_PATTERNS.some((re) => re.test(message))

// Exponential backoff with ±25% jitter, capped at 30s: fast enough to feel
// instant on a Wi-Fi flicker, slow enough not to hammer a real outage.
function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1_000 * Math.pow(2, attempt))
  const jitter = base * (0.75 + Math.random() * 0.5)
  return Math.floor(jitter)
}

const EVENT_STYLES: Record<string, string> = {
  insert:    'text-emerald-300/90',
  update:    'text-violet-300/90',
  delete:    'text-rose-300/90',
  presence:  'text-sky-300/90',
  broadcast: 'text-sky-300/90',
  connected: 'text-zinc-400',
}

function EventType({ type }: { type: string }) {
  return (
    <span className={`flex-shrink-0 font-mono text-[10.5px] font-semibold tracking-wide ${EVENT_STYLES[type] ?? 'text-zinc-500'}`}>
      {type.toUpperCase()}
    </span>
  )
}

export function RealtimeWorkbench({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<RealtimeStatusData | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [statusError, setStatusError] = useState<'auth' | 'network' | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('idle')
  const [retrySecondsLeft, setRetrySecondsLeft] = useState<number | null>(null)
  const [fatalReason, setFatalReason] = useState<string | null>(null)
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [eventCount, setEventCount] = useState(0)
  const [tableFilter, setTableFilter] = useState<string | null>(null)

  const esRef = useRef<EventSource | null>(null)
  const counterRef = useRef(0)
  const anonKeyRef = useRef<string | null>(null)
  const retryAttemptRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const destroyedRef = useRef(false)

  const authHeaders = useCallback(() => {
    const token = getAuthToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }, [])

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/realtime-status`, {
        headers: authHeaders(),
        credentials: 'include',
      })
      if (res.ok) {
        setStatus(await res.json())
        setStatusError(null)
        return
      }
      setStatusError(res.status === 401 ? 'auth' : 'network')
    } catch {
      setStatusError('network')
    } finally {
      setLoadingStatus(false)
    }
  }, [projectId, authHeaders])

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 5_000)
    return () => clearInterval(interval)
  }, [fetchStatus])

  // ── Realtime SSE lifecycle ──────────────────────────────────────────────
  // Self-healing: any transient failure schedules a jittered reconnect. Fatal
  // failures (quota cap, auth) stop retrying and surface the server message.
  useEffect(() => {
    if (!projectId) return
    destroyedRef.current = false

    const clearRetryTimers = () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      if (countdownTimerRef.current) {
        clearInterval(countdownTimerRef.current)
        countdownTimerRef.current = null
      }
      setRetrySecondsLeft(null)
    }

    const closeStream = () => {
      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }
    }

    const scheduleReconnect = () => {
      if (destroyedRef.current) return
      closeStream()
      const delay = backoffMs(retryAttemptRef.current)
      retryAttemptRef.current += 1
      setConnState('reconnecting')
      const startedAt = Date.now()
      setRetrySecondsLeft(Math.ceil(delay / 1000))
      countdownTimerRef.current = setInterval(() => {
        const left = Math.max(0, Math.ceil((delay - (Date.now() - startedAt)) / 1000))
        setRetrySecondsLeft(left)
        if (left <= 0 && countdownTimerRef.current) {
          clearInterval(countdownTimerRef.current)
          countdownTimerRef.current = null
        }
      }, 250)
      retryTimerRef.current = setTimeout(() => { openStream() }, delay)
    }

    const setFatal = (reason: string) => {
      clearRetryTimers()
      closeStream()
      setFatalReason(reason)
      setConnState('fatal')
    }

    async function openStream() {
      if (destroyedRef.current) return
      clearRetryTimers()
      setFatalReason(null)
      setConnState('connecting')

      // Anon key is server-side auto-generated on first fetch. Cache it for the
      // lifetime of this page so reconnects don't re-hit Prisma.
      if (!anonKeyRef.current) {
        try {
          const res = await fetch(`/api/projects/${projectId}/anon-key`, {
            headers: authHeaders(),
            credentials: 'include',
          })
          if (res.status === 401) {
            setFatal('Your dashboard session expired. Reload the page to continue.')
            return
          }
          if (!res.ok) {
            scheduleReconnect()
            return
          }
          const data = await res.json()
          anonKeyRef.current = data.anonKey ?? null
        } catch {
          scheduleReconnect()
          return
        }
      }
      if (destroyedRef.current) return
      if (!anonKeyRef.current) {
        setFatal("We couldn't generate this project's anon key. Try reloading.")
        return
      }

      const url = `/api/v1/${projectId}/realtime?apiKey=${encodeURIComponent(anonKeyRef.current)}`
      const es = new EventSource(url)
      esRef.current = es

      es.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data)

          if (data.type === 'connected') {
            retryAttemptRef.current = 0
            clearRetryTimers()
            setConnState('connected')
            return
          }

          if (data.type === 'error') {
            const message = typeof data.message === 'string' ? data.message : 'Realtime stream error'
            // Server closes the stream after an error frame, so we either go
            // fatal or reconnect — never both, never neither.
            if (data.code === 'PLAN_LIMIT_EXCEEDED' || data.code === 'INVALID_PROJECT' || isFatalServerError(message)) {
              setFatal(message)
            } else {
              scheduleReconnect()
            }
            return
          }

          if (DB_EVENT_TYPES.has(data.type)) setEventCount((c) => c + 1)
          const ev: LiveEvent = {
            id: `${Date.now()}-${counterRef.current++}`,
            type: data.type,
            table: data.table,
            channel: data.channel,
            timestamp: data.timestamp ?? Date.now() / 1000,
            truncated: data.truncated,
          }
          setEvents((prev) => [ev, ...prev].slice(0, 100))
        } catch { /* ignore malformed frames */ }
      }

      es.onerror = () => {
        // Browser EventSource auto-retries, but its cadence is invisible. We
        // take over so the countdown is observable and deterministic.
        if (destroyedRef.current) return
        scheduleReconnect()
      }
    }

    openStream()

    return () => {
      destroyedRef.current = true
      clearRetryTimers()
      closeStream()
    }
  }, [projectId, authHeaders])

  // ── Derived ─────────────────────────────────────────────────────────────

  const triggeredCount = status?.triggeredTables.length ?? 0
  const onlineUsers = status?.onlineUsers ?? 0

  const visibleEvents = tableFilter
    ? events.filter((e) => e.table === tableFilter || (!e.table && tableFilter === 'broadcast'))
    : events

  const activeTables = Array.from(
    new Set([
      ...(status?.triggeredTables ?? []),
      ...events.filter((e) => e.table).map((e) => e.table as string),
    ])
  )

  const stateText =
    connState === 'connected'
      ? 'Connected'
      : connState === 'reconnecting'
      ? retrySecondsLeft != null
        ? `Reconnecting in ${retrySecondsLeft}s`
        : 'Reconnecting'
      : connState === 'fatal'
      ? 'Offline'
      : 'Connecting…'

  const stateDot =
    connState === 'connected'
      ? 'bg-emerald-400'
      : connState === 'reconnecting'
      ? 'bg-amber-400'
      : connState === 'fatal'
      ? 'bg-rose-400'
      : 'bg-zinc-600'

  const stateTone =
    connState === 'connected'
      ? 'text-emerald-300/90'
      : connState === 'reconnecting'
      ? 'text-amber-500'
      : connState === 'fatal'
      ? 'text-rose-300'
      : 'text-zinc-400'

  // Empty-state copy never contradicts the command-bar state.
  const emptyState = (() => {
    if (tableFilter && events.length > 0) {
      return {
        icon: Radio,
        title: `No ${tableFilter} events yet`,
        description: `${events.length} event${events.length === 1 ? '' : 's'} on other tables this session. Choose All to see everything.`,
      }
    }
    switch (connState) {
      case 'connected':
        return {
          icon: Radio,
          title: 'Listening',
          description: 'Stream is open. Any insert, update, delete, or broadcast will appear here in real time.',
        }
      case 'reconnecting':
        return {
          icon: RefreshCw,
          title: 'Reconnecting',
          description: retrySecondsLeft != null ? `Lost the stream. Retrying in ${retrySecondsLeft}s.` : 'Lost the stream. Retrying…',
        }
      case 'fatal':
        return {
          icon: AlertTriangle,
          title: 'Stream offline',
          description: fatalReason ?? "We can't open a realtime connection right now.",
        }
      default:
        return { icon: Circle, title: 'Connecting', description: 'Opening the realtime stream…' }
    }
  })()

  const breakdown = (['insert', 'update', 'delete', 'broadcast', 'presence'] as const)
    .map((type) => ({ type, count: events.filter((e) => e.type === type).length }))
    .filter((r) => r.count > 0)

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className={`flex h-[calc(100vh-48px)] flex-col overflow-hidden ${KIT.bg}`}>

      {/* ── Command bar ───────────────────────────────────── */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between gap-4 border-b border-white/[0.06] px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
            <Radio className="h-3 w-3" />
            Inspector
          </span>
          <span className="h-3 w-px bg-white/10" />
          <h1 className="text-[13px] font-semibold text-zinc-100">Realtime</h1>
          <span className={`inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium ${stateTone}`}>
            <span className={`h-[5px] w-[5px] rounded-full ${stateDot} ${connState === 'connected' ? 'animate-pulse' : ''}`} />
            {stateText}
          </span>
        </div>

        <div className="flex flex-shrink-0 items-center gap-3">
          <span className="hidden font-mono text-[10.5px] tabular-nums text-zinc-600 sm:inline">
            {loadingStatus ? '—' : onlineUsers} online<span className="text-zinc-700"> · </span>
            {triggeredCount} streaming<span className="text-zinc-700"> · </span>
            {eventCount} event{eventCount === 1 ? '' : 's'}
          </span>
          {events.length > 0 && (
            <button
              onClick={() => { setEvents([]); setEventCount(0); setTableFilter(null) }}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[11.5px] font-medium text-zinc-300 transition-colors hover:border-white/20 hover:bg-white/[0.08]"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Advisories */}
      {statusError === 'auth' && (
        <div className="flex-shrink-0 border-b border-white/[0.06] px-4 py-2.5">
          <KitNote
            tone="warn"
            icon={WifiOff}
            title="Session expired"
            actions={
              <button
                onClick={() => window.location.reload()}
                className="flex-shrink-0 text-[12px] font-semibold text-amber-500 underline underline-offset-2 hover:text-amber-400"
              >
                Reload
              </button>
            }
          >
            Your sign-in token is stale. Reload the page or sign back in. The numbers here are last known, not live.
          </KitNote>
        </div>
      )}
      {statusError === 'network' && (
        <div className="flex-shrink-0 border-b border-white/[0.06] px-4 py-2.5">
          <KitNote tone="info" icon={Circle}>
            Couldn&apos;t refresh status. Showing last known values; retrying automatically.
          </KitNote>
        </div>
      )}
      {connState === 'fatal' && fatalReason && (
        <div className="flex-shrink-0 border-b border-white/[0.06] px-4 py-2.5">
          <KitNote
            tone="warn"
            icon={AlertTriangle}
            title="Realtime is offline"
            actions={
              <button
                onClick={() => window.location.reload()}
                className="flex-shrink-0 text-[12px] font-semibold text-amber-500 underline underline-offset-2 hover:text-amber-400"
              >
                Reload
              </button>
            }
          >
            {fatalReason}
          </KitNote>
        </div>
      )}

      {/* ── Workbench ─────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">

          {/* ── Streaming rail ─────────────────────────── */}
          <div className={`flex w-[248px] flex-shrink-0 flex-col border-r border-white/[0.06] ${KIT.rail}`}>
            <div className="flex h-10 flex-shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] px-3">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Streaming</span>
              <button
                onClick={fetchStatus}
                className="rounded-md p-1.5 text-zinc-600 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
                title="Refresh"
              >
                <RefreshCw className={`h-3 w-3 ${loadingStatus ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5">
              {activeTables.length === 0 ? (
                <div className="space-y-3 px-4 py-6 text-center">
                  <Radio className="mx-auto h-4 w-4 text-zinc-600" />
                  <div>
                    <p className="mb-0.5 text-[12px] font-semibold text-zinc-200">No triggers yet</p>
                    <p className="text-[11px] leading-relaxed text-zinc-500">
                      Create a table through your coding agent to start streaming.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-px px-2">
                  <div
                    onClick={() => setTableFilter(null)}
                    className={`group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] transition-colors ${
                      tableFilter === null
                        ? 'bg-white/[0.05] text-zinc-50'
                        : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-100'
                    }`}
                  >
                    <div
                      className={`h-[5px] w-[5px] flex-shrink-0 rounded-full ${
                        tableFilter === null ? 'bg-violet-300' : 'bg-white/[0.12] group-hover:bg-white/25'
                      }`}
                    />
                    <span className="flex-1 truncate text-[12px] font-medium">All events</span>
                    <span className="flex-shrink-0 font-mono text-[10.5px] tabular-nums text-zinc-600">{events.length}</span>
                  </div>

                  {activeTables.map((t) => {
                    const active = tableFilter === t
                    const streaming = status?.triggeredTables.includes(t)
                    const count = events.filter((e) => e.table === t).length
                    return (
                      <div
                        key={t}
                        onClick={() => setTableFilter(active ? null : t)}
                        className={`group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-[7px] transition-colors ${
                          active ? 'bg-white/[0.05] text-zinc-50' : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-100'
                        }`}
                      >
                        <div
                          className={`h-[5px] w-[5px] flex-shrink-0 rounded-full ${
                            active ? 'bg-violet-300' : streaming ? 'bg-emerald-400/70' : 'bg-white/[0.12] group-hover:bg-white/25'
                          }`}
                          title={streaming ? 'Trigger installed' : 'Seen this session'}
                        />
                        <span className="flex-1 truncate font-mono text-[12px]">{t}</span>
                        {count > 0 && (
                          <span className="flex-shrink-0 font-mono text-[10.5px] tabular-nums text-zinc-600">{count}</span>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="flex h-7 flex-shrink-0 items-center border-t border-white/[0.06] px-3 font-mono text-[10.5px] tabular-nums text-zinc-600">
              {triggeredCount} table{triggeredCount === 1 ? '' : 's'} streaming
            </div>
          </div>

          {/* ── Event stream ───────────────────────────── */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-10 flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
              <div className="flex min-w-0 items-baseline gap-2">
                <h2 className="truncate font-mono text-[13px] font-medium text-zinc-100">
                  {tableFilter ?? 'Live feed'}
                </h2>
                <span className="whitespace-nowrap font-mono text-[11px] tabular-nums text-zinc-500">
                  {visibleEvents.length} event{visibleEvents.length === 1 ? '' : 's'}
                </span>
              </div>
              <span className="flex-shrink-0 font-mono text-[10.5px] tabular-nums text-zinc-700">
                last 100 retained
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {visibleEvents.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center px-8">
                  <EmptyState
                    icon={emptyState.icon}
                    title={emptyState.title}
                    description={emptyState.description}
                  />
                </div>
              ) : (
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 z-10">
                    <tr className={KIT.gridHead}>
                      <th className="w-24 border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                        Time
                      </th>
                      <th className="w-24 border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                        Type
                      </th>
                      <th className="border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                        Source
                      </th>
                      <th className="w-28 border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
                        Payload
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleEvents.map((ev) => (
                      <tr key={ev.id} className={`transition-colors ${KIT.rowHoverOn}`}>
                        <td className="border-b border-white/[0.04] px-3 py-[7px] font-mono text-[10.5px] tabular-nums text-zinc-600">
                          {new Date(ev.timestamp * 1000).toLocaleTimeString([], {
                            hour12: false,
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </td>
                        <td className="border-b border-white/[0.04] px-3 py-[7px]">
                          <EventType type={ev.type} />
                        </td>
                        <td className="border-b border-white/[0.04] px-3 py-[7px] font-mono text-[11.5px]">
                          {ev.table ? (
                            <span className="text-zinc-300">{ev.table}</span>
                          ) : ev.channel ? (
                            <span className="text-sky-300/90">#{ev.channel}</span>
                          ) : (
                            <span className="text-zinc-700">—</span>
                          )}
                        </td>
                        <td className="border-b border-white/[0.04] px-3 py-[7px] font-mono text-[10.5px] text-zinc-600">
                          {ev.truncated ? 'truncated' : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* ── Session inspector ──────────────────────── */}
          <div className={`hidden w-[280px] flex-shrink-0 flex-col border-l border-white/[0.06] lg:flex ${KIT.rail}`}>
            <div className="flex h-10 flex-shrink-0 items-center border-b border-white/[0.06] px-3">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Session</span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <dl className={`divide-y ${KIT.divide}`}>
                {[
                  ['Connection', stateText],
                  ['Online', loadingStatus ? '—' : String(onlineUsers)],
                  ['Tables streaming', loadingStatus ? '—' : String(triggeredCount)],
                  ['Events this session', String(eventCount)],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-baseline justify-between gap-3 px-3 py-2.5">
                    <dt className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                      {label}
                    </dt>
                    <dd
                      className={`min-w-0 truncate text-right font-mono text-[11.5px] tabular-nums ${
                        label === 'Connection' ? stateTone : 'text-zinc-300'
                      }`}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>

              {breakdown.length > 0 && (
                <div className="border-t border-white/[0.06] p-3">
                  <p className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                    Event breakdown
                  </p>
                  <div className="space-y-2">
                    {breakdown.map(({ type, count }) => (
                      <div key={type} className="flex items-center justify-between">
                        <EventType type={type} />
                        <span className="font-mono text-[11.5px] font-medium tabular-nums text-zinc-300">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {status?.channel && (
                <div className="border-t border-white/[0.06] p-3">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                    PG channel
                  </p>
                  <code className="block break-all rounded-md border border-white/[0.06] bg-[#0f1015] px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-zinc-400">
                    {status.channel}
                  </code>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
