'use client'

import { useParams } from 'next/navigation'
import { useEffect, useRef, useState, useCallback } from 'react'
import { Radio, WifiOff, Circle, RefreshCw, AlertTriangle } from 'lucide-react'
import { getAuthToken } from '@/lib/api/auth'
import { InspectorPageHeader } from '@/components/inspector/InspectorPageHeader'
import {
  KitCard,
  KitBadge, KitNote, SectionLabel, EmptyState,
} from '@/components/inspector/kit'

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

// Discrete states the stream can occupy. `idle` is the initial paint before the
// first connect attempt resolves; treating it separately avoids flashing a
// "Disconnected" badge for the first ~50 ms of the page load.
type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'fatal'

const DB_EVENT_TYPES = new Set(['insert', 'update', 'delete', 'presence', 'broadcast'])

// Server-side error messages we will not auto-retry on — retrying just burns
// connection slots until the user changes something (paying plan, signing in
// again, etc.). Anything else is treated as transient.
const FATAL_PATTERNS = [
  /reached its limit/i,   // realtime concurrency cap (quota-kernel)
  /unauthor/i,            // 401-shape
  /api key/i,             // auth failure
]

const isFatalServerError = (message: string | undefined) =>
  !!message && FATAL_PATTERNS.some((re) => re.test(message))

// Exponential backoff with ±25 % jitter, capped at 30 s. Matches what stable
// SSE clients use for transient
// network blips — fast enough to feel instant on a Wi-Fi flicker, slow enough
// not to hammer the server during a real outage.
function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1_000 * Math.pow(2, attempt))
  const jitter = base * (0.75 + Math.random() * 0.5)
  return Math.floor(jitter)
}

// Colored mono text, no pill chrome — same voice as the workspace home
// API surface method column.
const EVENT_STYLES: Record<string, string> = {
  insert:    'text-emerald-300/90',
  update:    'text-violet-300/90',
  delete:    'text-rose-300/90',
  presence:  'text-sky-300/90',
  broadcast: 'text-sky-300/90',
  connected: 'text-zinc-400',
}

function EventTypeBadge({ type }: { type: string }) {
  return (
    <span className={`font-mono text-[10.5px] font-semibold tracking-wide flex-shrink-0 ${EVENT_STYLES[type] ?? 'text-zinc-500'}`}>
      {type.toUpperCase()}
    </span>
  )
}

export default function RealtimePage() {
  const params = useParams()
  const projectId = params.id as string

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
  const feedRef = useRef<HTMLDivElement>(null)
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

  // ── Realtime SSE lifecycle ────────────────────────────────────────────────
  // Self-healing: any transient failure (network blip, server restart, brief
  // pg disconnect) schedules a jittered reconnect. Fatal failures (quota cap,
  // auth) stop retrying and surface the actual server message to the user.
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

      // Anon key is server-side auto-generated on first fetch — see
      // app/api/projects/[id]/anon-key/route.ts. Cache it for the lifetime
      // of this page so reconnects don't re-hit Prisma.
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
            // Server closes the stream after emitting an error frame, so we
            // either go fatal or schedule a reconnect — never both, never
            // neither. The machine code is authoritative; the message regex
            // is the fallback for older frames without one.
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
        // Browser EventSource will auto-retry on its own, but its cadence is
        // implementation-defined and invisible to the user. We take over so
        // the countdown + jitter is observable and deterministic.
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

  const triggeredCount = status?.triggeredTables.length ?? 0
  const onlineUsers    = status?.onlineUsers ?? 0
  const isLive         = connState === 'connected'

  const visibleEvents = tableFilter
    ? events.filter(e => e.table === tableFilter || (!e.table && tableFilter === 'broadcast'))
    : events

  const activeTables = Array.from(new Set([
    ...(status?.triggeredTables ?? []),
    ...events.filter(e => e.table).map(e => e.table as string),
  ]))

  // ── Header badge — one source of truth per state ──────────────────────────
  const headerBadge = (() => {
    switch (connState) {
      case 'connected':
        return <KitBadge tone="operational">Connected</KitBadge>
      case 'reconnecting':
        return (
          <KitBadge tone="attention" icon={RefreshCw}>
            {retrySecondsLeft != null ? `Reconnecting in ${retrySecondsLeft}s` : 'Reconnecting'}
          </KitBadge>
        )
      case 'fatal':
        return <KitBadge tone="attention" icon={AlertTriangle}>Offline</KitBadge>
      case 'connecting':
      case 'idle':
      default:
        return <KitBadge tone="neutral" icon={Circle}>Connecting…</KitBadge>
    }
  })()

  // ── Live-feed dot — mirrors header state, calmer palette ──────────────────
  const dotClass = (() => {
    switch (connState) {
      case 'connected':     return 'bg-emerald-400'
      case 'reconnecting':  return 'bg-amber-400'
      case 'fatal':         return 'bg-rose-400'
      default:              return 'bg-zinc-700'
    }
  })()

  // ── Empty-state copy — never contradicts the header badge ─────────────────
  const emptyState = (() => {
    // Filtered view with events on other tables — handled separately so the
    // user understands the filter, not the connection, is hiding data.
    if (tableFilter && events.length > 0) {
      return {
        icon: Radio,
        title: `No ${tableFilter} events yet`,
        description: `${events.length} event${events.length === 1 ? '' : 's'} on other tables this session. Click All to see everything.`,
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
          description: retrySecondsLeft != null
            ? `Lost the stream. Retrying in ${retrySecondsLeft}s.`
            : 'Lost the stream. Retrying…',
        }
      case 'fatal':
        return {
          icon: AlertTriangle,
          title: 'Stream offline',
          description: fatalReason ?? "We can't open a realtime connection right now.",
        }
      case 'connecting':
      case 'idle':
      default:
        return {
          icon: Circle,
          title: 'Connecting',
          description: 'Opening the realtime stream…',
        }
    }
  })()

  return (
    <div className="min-h-screen bg-[#101116] flex flex-col">
      <InspectorPageHeader
        icon={Radio}
        title="Realtime"
        description="Live database events · push-to-client via PostgreSQL NOTIFY"
        badge={isLive ? { label: 'Live', variant: 'live' } : undefined}
        stat={`${onlineUsers} online`}
        actions={headerBadge}
      />

      <div className="flex-1 px-8 py-7">
        {statusError === 'auth' && (
          <div className="mb-5">
            <KitNote
              tone="warn"
              icon={WifiOff}
              title="Session expired"
              actions={
                <button
                  onClick={() => window.location.reload()}
                  className="text-[12px] font-semibold text-amber-500 hover:text-amber-400 underline underline-offset-2 flex-shrink-0"
                >
                  Reload
                </button>
              }
            >
              Your sign-in token is stale. Reload the page or sign back in. The numbers below are last known, not live.
            </KitNote>
          </div>
        )}
        {statusError === 'network' && (
          <div className="mb-5">
            <KitNote tone="info" icon={Circle}>
              Couldn&apos;t refresh status. Showing last known values; retrying automatically.
            </KitNote>
          </div>
        )}
        {connState === 'fatal' && fatalReason && (
          <div className="mb-5">
            <KitNote
              tone="warn"
              icon={AlertTriangle}
              title="Realtime is offline"
              actions={
                <button
                  onClick={() => window.location.reload()}
                  className="text-[12px] font-semibold text-amber-500 hover:text-amber-400 underline underline-offset-2 flex-shrink-0"
                >
                  Reload
                </button>
              }
            >
              {fatalReason}
            </KitNote>
          </div>
        )}

        {/* Inline metadata — replaces 3 oversized stat tiles. The page header
            already shows "X online" so we lead with the two pieces of info the
            header doesn't carry: streaming tables and session events. */}
        <div className="mb-4 rounded-xl border border-white/[0.07] bg-[#16171d] shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
          <div className="grid grid-cols-3 divide-x divide-white/[0.06]">
            <div className="flex items-baseline gap-2 px-4 py-3">
              <span className="font-mono text-[16px] font-medium tabular-nums leading-none text-white">{loadingStatus ? '—' : onlineUsers}</span>
              <span className="text-[11px] text-zinc-500 leading-none">online</span>
            </div>
            <div className="flex items-baseline gap-2 px-4 py-3">
              <span className="font-mono text-[16px] font-medium tabular-nums leading-none text-white">{loadingStatus ? '—' : triggeredCount}</span>
              <span className="text-[11px] text-zinc-500 leading-none">tables streaming</span>
            </div>
            <div className="flex items-baseline gap-2 px-4 py-3">
              <span className="font-mono text-[16px] font-medium tabular-nums leading-none text-white">{eventCount}</span>
              <span className="text-[11px] text-zinc-500 leading-none">events this session</span>
            </div>
          </div>
        </div>

        {/* Two-column layout: feed + sidebar */}
        <div className="flex gap-4" style={{ height: 'calc(100vh - 380px)', minHeight: 360 }}>
          {/* Left — live event feed */}
          <KitCard className="flex-1 min-w-0 flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06] flex-shrink-0">
              <div className="flex items-center justify-between mb-2.5">
                <div className="flex items-center gap-2">
                  <div className={`w-[5px] h-[5px] rounded-full flex-shrink-0 ${dotClass}`} />
                  <h2 className="text-[12.5px] font-semibold text-zinc-100">Live feed</h2>
                </div>
                {events.length > 0 && (
                  <button
                    onClick={() => { setEvents([]); setEventCount(0); setTableFilter(null) }}
                    className="text-[11.5px] text-zinc-500 hover:text-zinc-200 transition-colors font-medium focus:outline-none"
                  >
                    Clear
                  </button>
                )}
              </div>

              {activeTables.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    onClick={() => setTableFilter(null)}
                    className={`text-[11px] font-medium px-2.5 py-1 rounded-md border transition-colors ${
                      tableFilter === null
                        ? 'bg-white/[0.06] border-white/[0.10] text-zinc-100'
                        : 'border-white/[0.07] text-zinc-500 hover:text-zinc-300 hover:border-white/[0.14]'
                    }`}
                  >
                    All
                  </button>
                  {activeTables.map(t => (
                    <button
                      key={t}
                      onClick={() => setTableFilter(tableFilter === t ? null : t)}
                      className={`text-[11px] font-mono font-medium px-2.5 py-1 rounded-md border transition-colors ${
                        tableFilter === t
                          ? 'bg-white/[0.06] border-violet-400/30 text-violet-200'
                          : 'border-white/[0.07] text-zinc-500 hover:text-zinc-300 hover:border-white/[0.14]'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div ref={feedRef} className="flex-1 overflow-y-auto font-mono text-xs">
              {visibleEvents.length === 0 ? (
                <EmptyState
                  icon={emptyState.icon}
                  title={emptyState.title}
                  description={emptyState.description}
                />
              ) : (
                <div className="divide-y divide-white/[0.04]">
                  {visibleEvents.map((ev) => (
                    <div key={ev.id} className="flex items-center gap-3 px-4 py-[9px] hover:bg-white/[0.025] transition-colors">
                      <span className="text-zinc-600 text-[10.5px] w-14 flex-shrink-0 tabular-nums">
                        {new Date(ev.timestamp * 1000).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span className="flex-1 min-w-0 text-zinc-500 truncate font-mono text-[11.5px]">
                        {ev.table && <span className="text-zinc-300 mr-1.5">{ev.table}</span>}
                        {ev.channel && !ev.table && <span className="text-sky-300/90 mr-1.5">#{ev.channel}</span>}
                        {ev.truncated && <span className="text-zinc-600">(truncated)</span>}
                      </span>
                      <EventTypeBadge type={ev.type} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </KitCard>

          {/* Right — stats sidebar */}
          <div className="w-72 flex-shrink-0 flex flex-col gap-4">
            <KitCard className="p-4">
              <SectionLabel className="mb-3">Streaming tables</SectionLabel>
              {loadingStatus ? (
                <div className="text-[12px] text-zinc-600 animate-pulse">Loading…</div>
              ) : triggeredCount === 0 ? (
                <p className="text-[12px] text-zinc-500 leading-relaxed">No triggers yet. Create a table through your coding agent to start streaming.</p>
              ) : (
                <div className="space-y-1.5">
                  {status!.triggeredTables.map((t) => (
                    <div key={t} className="flex items-center gap-2">
                      <span className="w-[5px] h-[5px] rounded-full bg-emerald-400 flex-shrink-0" />
                      <span className="text-[12px] font-mono text-zinc-300 truncate">{t}</span>
                    </div>
                  ))}
                </div>
              )}
            </KitCard>

            {events.length > 0 && (
              <KitCard className="p-4">
                <SectionLabel className="mb-3">Event breakdown</SectionLabel>
                <div className="space-y-2">
                  {(['insert', 'update', 'delete', 'broadcast', 'presence'] as const).map(type => {
                    const count = events.filter(e => e.type === type).length
                    if (count === 0) return null
                    return (
                      <div key={type} className="flex items-center justify-between">
                        <EventTypeBadge type={type} />
                        <span className="font-mono text-[12px] font-medium text-zinc-300 tabular-nums">{count}</span>
                      </div>
                    )
                  })}
                </div>
              </KitCard>
            )}

            {status?.channel && (
              <KitCard className="p-4">
                <SectionLabel className="mb-2">PG channel</SectionLabel>
                <code className="text-[11px] text-zinc-400 font-mono break-all leading-relaxed">{status.channel}</code>
              </KitCard>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
