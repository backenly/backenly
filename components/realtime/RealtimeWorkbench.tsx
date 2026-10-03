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
import { Radio, WifiOff, Circle, RefreshCw, AlertTriangle, Trash2, ChevronLeft } from 'lucide-react'
import { getAuthToken } from '@/lib/api/auth'
import {
  AgentPrompt, CommandBar, CopyField, EmptyState, IconButton, KIT, KitButton, NoticeStrip, StatusDot,
  type StatusTone,
} from '@/components/inspector/kit'
import { FOCUS_INSET } from '@/components/console/tokens'

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
  /reached its limit/i,   // realtime concurrency cap (quota kernel)
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
  insert:    'text-emerald-300',
  update:    'text-violet-300',
  delete:    'text-rose-300',
  presence:  'text-sky-300',
  broadcast: 'text-sky-300',
  connected: 'text-zinc-400',
}

const EVENT_BAR: Record<string, string> = {
  insert:    'bg-emerald-400/70',
  update:    'bg-violet-300/70',
  delete:    'bg-rose-400/70',
  presence:  'bg-sky-300/70',
  broadcast: 'bg-sky-300/70',
}

/** Event kinds are SQL verbs and channel names: machine text, set as such. */
function EventType({ type }: { type: string }) {
  return (
    <span className={`flex-shrink-0 font-mono text-[11.5px] font-medium tracking-[0.02em] ${EVENT_STYLES[type] ?? 'text-zinc-500'}`}>
      {type.toUpperCase()}
    </span>
  )
}

const TH = 'h-[36px] whitespace-nowrap border-b border-white/[0.06] px-3 text-left text-[12px] font-medium text-zinc-500'
const TD = 'h-[36px] whitespace-nowrap border-b border-white/[0.04] px-3'

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
  const [mobilePane, setMobilePane] = useState<'tables' | 'feed'>('tables')

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

  const stateTone: StatusTone =
    connState === 'connected'
      ? 'operational'
      : connState === 'reconnecting'
      ? 'attention'
      : connState === 'fatal'
      ? 'failed'
      : 'neutral'

  // Empty-state copy never contradicts the command-bar state.
  const emptyState = (() => {
    if (tableFilter && events.length > 0) {
      return {
        icon: Radio,
        title: `No ${tableFilter} events yet`,
        description: `${events.length} event${events.length === 1 ? '' : 's'} on other tables this session. Choose All events to see everything.`,
      }
    }
    switch (connState) {
      case 'connected':
        return triggeredCount === 0
          ? {
              icon: Radio,
              title: 'Connected, nothing streaming',
              description: 'Realtime is opt-in per table. Once a table streams, every insert, update and delete on it appears here as it happens.',
            }
          : {
              icon: Radio,
              title: 'Listening',
              description: 'The stream is open. Inserts, updates, deletes and broadcasts appear here as they happen.',
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
  // Payload size only matters when the server had to cut one short.
  const anyTruncated = visibleEvents.some((e) => e.truncated)
  const breakdownMax = Math.max(1, ...breakdown.map((b) => b.count))

  const selectTable = (t: string | null) => {
    setTableFilter(t)
    setMobilePane('feed')
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className={`console-fill flex flex-col overflow-hidden ${KIT.bg}`}>

      {/* ── Command bar ───────────────────────────────────── */}
      <CommandBar
        title="Realtime"
        context={
          <>
            <StatusDot tone={stateTone} label={stateText} pulse={connState === 'connected'} />
            <span className="hidden tabular-nums sm:inline">
              {loadingStatus ? '–' : onlineUsers} online
              <span className="text-zinc-700"> · </span>
              {triggeredCount} {triggeredCount === 1 ? 'table' : 'tables'} streaming
            </span>
          </>
        }
      >
        {events.length > 0 && (
          <KitButton
            size="sm"
            variant="ghost"
            icon={Trash2}
            onClick={() => { setEvents([]); setEventCount(0); setTableFilter(null) }}
          >
            Clear feed
          </KitButton>
        )}
      </CommandBar>

      {/* Advisories */}
      {statusError === 'auth' && (
        <NoticeStrip
          icon={WifiOff}
          tone="attention"
          action={<KitButton size="sm" onClick={() => window.location.reload()}>Reload</KitButton>}
        >
          <strong>Your session expired.</strong> The numbers here are the last known values, not live ones.
        </NoticeStrip>
      )}
      {statusError === 'network' && (
        <NoticeStrip icon={Circle}>
          Couldn&apos;t refresh status. Showing the last known values and retrying automatically.
        </NoticeStrip>
      )}
      {connState === 'fatal' && fatalReason && (
        <NoticeStrip
          icon={AlertTriangle}
          tone="danger"
          action={<KitButton size="sm" onClick={() => window.location.reload()}>Reload</KitButton>}
        >
          <strong>Realtime is offline.</strong> {fatalReason}
        </NoticeStrip>
      )}

      {/* ── Workbench ─────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">

          {/* ── Streaming rail ─────────────────────────── */}
          <div className={`w-full flex-shrink-0 flex-col border-r border-white/[0.06] md:w-[256px] ${KIT.rail} ${mobilePane === 'tables' ? 'flex' : 'hidden md:flex'}`}>
            <div className="flex h-[44px] flex-shrink-0 items-center justify-between gap-2 border-b border-white/[0.06] pl-4 pr-2">
              <span className="text-[13px] font-medium text-zinc-200">Tables</span>
              <IconButton
                icon={RefreshCw}
                label="Refresh status"
                onClick={fetchStatus}
                className={loadingStatus ? '[&_svg]:animate-spin' : ''}
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1.5">
              {activeTables.length === 0 ? (
                <div className="px-4 py-4">
                  <p className="text-[13px] font-medium text-zinc-200">No tables streaming</p>
                  <p className="mt-1 text-[12.5px] leading-[19px] text-zinc-500">
                    Realtime is opt-in. Ask your agent to turn it on for the tables your app listens to.
                  </p>
                </div>
              ) : (
                <ul className="space-y-px px-2">
                  <li>
                    <button
                      type="button"
                      aria-current={tableFilter === null ? 'true' : undefined}
                      onClick={() => selectTable(null)}
                      className={`flex h-[32px] w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left transition-colors ${FOCUS_INSET} ${
                        tableFilter === null
                          ? 'bg-white/[0.07] text-zinc-50'
                          : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
                      }`}
                    >
                      <Radio className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" strokeWidth={1.75} />
                      <span className="flex-1 truncate text-[13px] font-medium">All events</span>
                      <span className="flex-shrink-0 text-[12px] tabular-nums text-zinc-500">{events.length}</span>
                    </button>
                  </li>

                  {activeTables.map((t) => {
                    const active = tableFilter === t
                    const streaming = status?.triggeredTables.includes(t)
                    const count = events.filter((e) => e.table === t).length
                    return (
                      <li key={t}>
                        <button
                          type="button"
                          aria-current={active ? 'true' : undefined}
                          onClick={() => selectTable(active ? null : t)}
                          title={streaming ? 'Streaming: change trigger installed' : 'Seen this session'}
                          className={`flex h-[32px] w-full items-center gap-2.5 rounded-[7px] px-2.5 text-left transition-colors ${FOCUS_INSET} ${
                            active ? 'bg-white/[0.07] text-zinc-50' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
                          }`}
                        >
                          <span className="flex w-3.5 flex-shrink-0 justify-center">
                            <StatusDot tone={streaming ? 'operational' : 'neutral'} />
                          </span>
                          <span className="flex-1 truncate font-mono text-[12.5px]">{t}</span>
                          {count > 0 && (
                            <span className="flex-shrink-0 text-[12px] tabular-nums text-zinc-500">{count}</span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>

            <div className="flex h-[36px] flex-shrink-0 items-center border-t border-white/[0.06] px-4 text-[12px] tabular-nums text-zinc-500">
              {triggeredCount} {triggeredCount === 1 ? 'table' : 'tables'} streaming
            </div>
          </div>

          {/* ── Event stream ───────────────────────────── */}
          <div className={`min-w-0 flex-1 flex-col ${mobilePane === 'feed' ? 'flex' : 'hidden md:flex'}`}>
            <div className="flex h-[44px] flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-3 sm:px-4">
              <div className="flex min-w-0 items-center gap-3">
                <button
                  type="button"
                  onClick={() => setMobilePane('tables')}
                  className="-ml-1 flex h-[32px] w-[32px] flex-shrink-0 items-center justify-center rounded-[7px] bg-white/[0.04] text-zinc-200 transition-colors hover:bg-white/[0.07] md:hidden"
                  aria-label="Back to tables"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <h2 className={`truncate text-[13px] font-medium text-zinc-100 ${tableFilter ? 'font-mono' : ''}`}>
                  {tableFilter ?? 'All events'}
                </h2>
                <span className="whitespace-nowrap text-[12px] tabular-nums text-zinc-500">
                  {visibleEvents.length} {visibleEvents.length === 1 ? 'event' : 'events'}
                </span>
              </div>
              <span className="flex-shrink-0 text-[12px] text-zinc-600">Newest first · last 100 kept</span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite" aria-relevant="additions">
              {visibleEvents.length === 0 ? (
                <div className="flex min-h-full flex-col items-center justify-center px-6">
                  <EmptyState
                    icon={emptyState.icon}
                    title={emptyState.title}
                    description={emptyState.description}
                    action={
                      connState === 'connected' && triggeredCount === 0 && !tableFilter ? (
                        <AgentPrompt prompt="Enable realtime on the orders table so the app gets live updates." />
                      ) : undefined
                    }
                  />
                </div>
              ) : (
                <div className="min-w-full overflow-x-auto">
                  <table className="w-full min-w-[440px] border-collapse">
                    <thead className="sticky top-0 z-10">
                      <tr className={KIT.gridHead}>
                        <th className={`${TH} w-28`}>Time</th>
                        <th className={`${TH} w-28`}>Event</th>
                        <th className={TH}>Source</th>
                        {anyTruncated && <th className={`${TH} w-28`}>Payload</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleEvents.map((ev) => (
                        <tr key={ev.id} className={`transition-colors ${KIT.rowHoverOn}`}>
                          <td className={`${TD} text-[12.5px] tabular-nums text-zinc-500`}>
                            {new Date(ev.timestamp * 1000).toLocaleTimeString([], {
                              hour12: false,
                              hour: '2-digit',
                              minute: '2-digit',
                              second: '2-digit',
                            })}
                          </td>
                          <td className={TD}>
                            <EventType type={ev.type} />
                          </td>
                          <td className={`${TD} font-mono text-[12.5px]`}>
                            {ev.table ? (
                              <span className="text-zinc-200">{ev.table}</span>
                            ) : ev.channel ? (
                              <span className="text-sky-300/90">#{ev.channel}</span>
                            ) : (
                              <span className="text-zinc-600">none</span>
                            )}
                          </td>
                          {anyTruncated && (
                            <td className={`${TD} text-[12.5px]`}>
                              {ev.truncated && <span className="text-amber-200/90">Truncated</span>}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* ── Session inspector ──────────────────────── */}
          <div className={`hidden w-[288px] flex-shrink-0 flex-col border-l border-white/[0.06] lg:flex ${KIT.rail}`}>
            <div className="flex h-[44px] flex-shrink-0 items-center border-b border-white/[0.06] px-4">
              <span className="text-[13px] font-medium text-zinc-200">This session</span>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <dl className="divide-y divide-white/[0.05]">
                {([
                  ['Connection', <StatusDot key="c" tone={stateTone} label={stateText} />],
                  ['Online now', loadingStatus ? '–' : onlineUsers.toLocaleString()],
                  ['Tables streaming', loadingStatus ? '–' : triggeredCount.toLocaleString()],
                  ['Events received', eventCount.toLocaleString()],
                ] as Array<[string, React.ReactNode]>).map(([label, value]) => (
                  <div key={label} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <dt className="flex-shrink-0 text-[13px] text-zinc-500">{label}</dt>
                    <dd className="min-w-0 truncate text-right text-[13px] tabular-nums text-zinc-200">{value}</dd>
                  </div>
                ))}
              </dl>

              {breakdown.length > 0 && (
                <section className="border-t border-white/[0.06] px-4 py-4">
                  <h3 className="mb-3 text-[13px] font-medium text-zinc-200">By event</h3>
                  <ul className="space-y-2.5">
                    {breakdown.map(({ type, count }) => (
                      <li key={type}>
                        <div className="mb-1 flex items-center justify-between">
                          <EventType type={type} />
                          <span className="text-[12.5px] tabular-nums text-zinc-300">{count}</span>
                        </div>
                        <div className="h-[3px] overflow-hidden rounded-full bg-white/[0.05]">
                          <div
                            className={`h-full rounded-full ${EVENT_BAR[type] ?? 'bg-zinc-500'}`}
                            style={{ width: `${(count / breakdownMax) * 100}%` }}
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {status?.channel && (
                <section className="border-t border-white/[0.06] px-4 py-4">
                  <h3 className="text-[13px] font-medium text-zinc-200">Postgres channel</h3>
                  <p className="mb-2 mt-0.5 text-[12.5px] leading-[19px] text-zinc-500">
                    Changes are published with NOTIFY on this channel.
                  </p>
                  <CopyField value={status.channel} />
                </section>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
