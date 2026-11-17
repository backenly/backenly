'use client'

/**
 * Realtime: the project's live changes, as they happen.
 *
 *   Realtime  ● 2 tables streaming  4 online                              [Clear] ⟳
 *   ┌ All events     16 ┬ All events  16 events ────────────────────────────────────┐
 *   │ ● reviews       8 │ Time         Event    Table            Row                 │
 *   │ ● watchlist_items │ 2:22:51 AM   insert   watchlist_items  4105a1b2            │
 *   │ Presence        2 │ 2:22:37 AM   insert   reviews          9415c3d0 rating=3 … │
 *   │                   │ Connected at 2:14 AM  insert 10, update 3, …  Last 100 kept│
 *   └───────────────────┴─────────────────────────────────────────────────────────────┘
 *
 * The jobs, in order: is live update working (the bar's glyph), watch changes
 * while testing the app (the feed, and a selected event's row in the shared
 * drawer), which tables stream (the rail), who is online (the bar).
 *
 * One fact each, said once: the connection and the streaming tables in the
 * bar, the counts per table in the rail, this session's numbers in one faint
 * line under the feed. Event kinds are plain lowercase machine words with no
 * colour: colour is for state (round 1, Realtime). Opening the page never
 * turns realtime on; it only reports it.
 *
 * The stream's lifecycle lives in useRealtimeStream (ticket first, backoff,
 * fatal vs transient), the table status in useRealtimeStatus, and what a frame
 * says in event-format.ts.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, Info, WifiOff } from 'lucide-react'
import { KIT, KitButton, KitSelect, NoticeStrip, StatusGlyph } from '@/components/inspector/kit'
import { InstrumentBar, PaneToolbar, count, type BarFact } from '@/components/console/InstrumentBar'
import { RecordDrawer, recordNav, useRecordParam } from '@/components/console/RecordDrawer'
import { ErrorRow } from '@/components/console/states'
import { FirstRun } from '@/components/console/FirstRun'
import { DayGroup, EventRowSkeleton } from '@/components/console/EventRow'
import { groupByDay } from '@/components/console/format'
import { EmptyLine, Fact, Facts } from '@/components/autonomy/rows'
import { FOCUS_INSET, GRID_HEAD, RAIL, RULE } from '@/components/console/tokens'
import { Time } from '@/components/console/Time'
import { useProjectRole } from '@/lib/hooks/useProjectRole'
import { useAgentConnection } from '@/lib/hooks/useAgentConnection'
import { FEED_LIMIT, useRealtimeStream } from './useRealtimeStream'
import { useRealtimeStatus } from './useRealtimeStatus'
import { changedColumns, countsLine, eventTitle, listingOf, pretty, type LiveEvent } from './event-format'
import { FeedRow } from './FeedRow'
import { CopyJsonButton, EventDetail, EventTitle } from './EventDetail'

/** Which events the feed shows: all of them, one table's, presence, or broadcasts. */
type Filter = 'all' | 'presence' | 'broadcast' | `t:${string}`

const tableOf = (f: Filter) => (f.startsWith('t:') ? f.slice(2) : null)

function matches(ev: LiveEvent, f: Filter): boolean {
  if (f === 'all') return true
  if (f === 'presence') return ev.type === 'presence'
  if (f === 'broadcast') return ev.type === 'broadcast'
  return ev.table === tableOf(f)
}

const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

export function RealtimeWorkbench({ projectId }: { projectId: string }) {
  const stream = useRealtimeStream(projectId)
  const status = useRealtimeStatus(projectId)
  const role = useProjectRole(projectId)
  const agent = useAgentConnection(projectId)
  const [filter, setFilter] = useState<Filter>('all')
  const [eventId, openEvent, closeEvent] = useRecordParam('event')

  const { events } = stream
  const streaming = useMemo(() => status.status?.triggeredTables ?? [], [status.status])
  const online = status.status?.onlineUsers ?? 0

  // Every table that streams, then any other table an event came from this session.
  const tables = useMemo(() => {
    const seen = new Set(streaming)
    const extra: string[] = []
    for (const e of events) {
      if (!e.table || seen.has(e.table) || e.type === 'broadcast') continue
      seen.add(e.table)
      extra.push(e.table)
    }
    return [...streaming, ...extra.sort()]
  }, [streaming, events])

  const perTable = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of events) if (e.table && e.type !== 'broadcast') m.set(e.table, (m.get(e.table) ?? 0) + 1)
    return m
  }, [events])
  const presenceN = useMemo(() => events.filter((e) => e.type === 'presence').length, [events])
  const broadcastN = useMemo(() => events.filter((e) => e.type === 'broadcast').length, [events])

  const visible = useMemo(() => (filter === 'all' ? events : events.filter((e) => matches(e, filter))), [events, filter])
  const nav = recordNav(visible, (e) => e.id, eventId, openEvent)

  // An event id from another session, or one the filter now hides or the feed dropped, closes the drawer.
  useEffect(() => {
    if (eventId && !visible.some((e) => e.id === eventId)) closeEvent()
  }, [eventId, visible, closeEvent])

  const statusKnown = status.status !== null
  const nothingStreams = statusKnown && tables.length === 0 && events.length === 0
  const showRail = !nothingStreams && (statusKnown || events.length > 0)

  // ── The bar ───────────────────────────────────────────────────────────────
  const tablesFact = streaming.length > 0 ? plural(streaming.length, 'table') + ' streaming' : null
  const facts: Array<BarFact | null> =
    stream.state === 'connected'
      ? [{ glyph: 'live', label: 'Connected', text: tablesFact ?? undefined }, online > 0 ? { text: `${count(online)} online` } : null]
      : stream.state === 'reconnecting'
        ? [
            { glyph: 'busy', label: 'Reconnecting', text: stream.retryIn ? `Reconnecting in ${stream.retryIn} s` : 'Reconnecting', tone: 'attention' },
            tablesFact ? { text: tablesFact } : null,
          ]
        : stream.state === 'fatal'
          ? [{ glyph: 'failed', label: 'Offline', text: 'Offline', tone: 'danger' }, tablesFact ? { text: tablesFact } : null]
          : [{ glyph: 'idle', label: 'Connecting', text: 'Connecting' }, tablesFact ? { text: tablesFact } : null]

  const clear = () => {
    stream.clear()
    setFilter('all')
    closeEvent()
  }

  const reload = () => window.location.reload()

  // ── The feed's body ───────────────────────────────────────────────────────
  const filterTable = tableOf(filter)
  // Nothing streams yet: the page is the first-run state, with no column heads over it.
  let firstRun = false
  let body: ReactNode
  if (visible.length > 0) {
    const days = groupByDay(visible, (e) => e.at)
    const rows = (list: LiveEvent[]) =>
      list.map((ev) => <FeedRow key={ev.id} event={ev} current={ev.id === eventId} onOpen={openEvent} />)
    body = (
      <div role="log" aria-label="Live changes">
        {days.length > 1 ? (
          days.map((d) => (
            <DayGroup key={d.key} label={d.label} sticky>
              {rows(d.items)}
            </DayGroup>
          ))
        ) : (
          <ul className="divide-y divide-white/[0.06]">{rows(visible)}</ul>
        )}
      </div>
    )
  } else if (filter !== 'all') {
    body = (
      <EmptyLine>
        {filterTable ? (
          <>
            No <code className="font-mono text-[12px] text-zinc-200">{filterTable}</code> events yet this session.
          </>
        ) : filter === 'presence' ? (
          'No presence events yet this session.'
        ) : (
          'No broadcasts yet this session.'
        )}
      </EmptyLine>
    )
  } else if (!statusKnown && status.error) {
    body = null // the error row says it
  } else if (!statusKnown) {
    body = <EventRowSkeleton rows={6} glyph={false} />
  } else if (streaming.length === 0) {
    firstRun = true
    body = (
      <FirstRun
        picture="events"
        title="No table streams yet"
        sentence="Realtime is turned on per table, and changes to those tables appear here live."
        requests={['Turn on realtime for the tables my app shows live.']}
        projectId={projectId}
        agent={role.loading ? { status: 'loading' } : { status: agent.status, client: agent.client }}
        canConnect={role.canAdminister}
        docs={{ label: 'Realtime docs', slug: 'realtime' }}
      />
    )
  } else {
    const names = listingOf(streaming)
    body = (
      <EmptyLine>
        {stream.state === 'connected' ? (
          <>
            Listening on <TableNames names={streaming} text={names} />. Changes appear here as they happen.
          </>
        ) : stream.state === 'reconnecting' ? (
          'The stream dropped. Changes appear here once it reconnects.'
        ) : stream.state === 'fatal' ? (
          'No changes arrive while the stream is offline.'
        ) : (
          'Opening the stream.'
        )}
      </EmptyLine>
    )
  }

  const filterLabel = filter === 'all' ? 'All events' : filter === 'presence' ? 'Presence' : filter === 'broadcast' ? 'Broadcasts' : filterTable ?? ''
  const ev = nav.item

  return (
    <div className={`console-fill flex flex-col overflow-hidden ${KIT.bg}`}>
      <InstrumentBar
        title="Realtime"
        facts={facts}
        controls={
          <>
            {stream.state === 'reconnecting' && (
              <KitButton size="sm" onClick={stream.retryNow}>
                Retry now
              </KitButton>
            )}
            {events.length > 0 && (
              <KitButton size="sm" variant="ghost" onClick={clear}>
                Clear
              </KitButton>
            )}
          </>
        }
        onRefresh={() => void status.refresh()}
        refreshing={status.refreshing}
      />

      {stream.state === 'fatal' && stream.fatalReason && (
        <NoticeStrip icon={WifiOff} tone="danger" action={<KitButton size="sm" onClick={reload}>Reload</KitButton>}>
          {stream.fatalReason}
        </NoticeStrip>
      )}
      {stream.state !== 'fatal' && status.error === 'auth' && (
        <NoticeStrip icon={AlertTriangle} tone="attention" action={<KitButton size="sm" onClick={reload}>Reload</KitButton>}>
          Your session expired. Reload to see live numbers.
        </NoticeStrip>
      )}
      {stream.anonymousView && stream.state !== 'fatal' && (
        <NoticeStrip icon={Info}>
          Showing only what a signed-out visitor can read. This project can&apos;t issue a full-access stream yet.
        </NoticeStrip>
      )}
      {status.error === 'network' && statusKnown && (
        <ErrorRow things="streaming tables" staleAt={status.fetchedAt} onRetry={() => void status.refresh()} retrying={status.refreshing} />
      )}

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">
          {showRail && (
            <nav aria-label="Show events from" className={`hidden w-[232px] flex-shrink-0 overflow-y-auto overflow-x-hidden border-r ${RULE} ${RAIL} p-[8px] md:block`}>
              <ul className="space-y-px">
                <RailItem label="All events" n={events.length} active={filter === 'all'} onSelect={() => setFilter('all')} />
                {tables.map((t) => {
                  const on = streaming.includes(t)
                  return (
                    <RailItem
                      key={t}
                      label={t}
                      mono
                      glyph={on ? 'live' : 'idle'}
                      glyphLabel={on ? 'Streaming' : 'Not streaming'}
                      n={perTable.get(t) ?? 0}
                      active={filter === `t:${t}`}
                      onSelect={() => setFilter(filter === `t:${t}` ? 'all' : `t:${t}`)}
                    />
                  )
                })}
                {(presenceN > 0 || filter === 'presence') && (
                  <RailItem label="Presence" n={presenceN} active={filter === 'presence'} onSelect={() => setFilter(filter === 'presence' ? 'all' : 'presence')} />
                )}
                {(broadcastN > 0 || filter === 'broadcast') && (
                  <RailItem label="Broadcasts" n={broadcastN} active={filter === 'broadcast'} onSelect={() => setFilter(filter === 'broadcast' ? 'all' : 'broadcast')} />
                )}
              </ul>
            </nav>
          )}

          <section aria-label="Events" className="flex min-w-0 flex-1 flex-col">
            {showRail && (
              <>
                {/* A phone has no rail: the feed opens first, with the choice above it. */}
                <div className={`flex flex-shrink-0 items-center gap-[12px] border-b ${RULE} px-[16px] py-[8px] md:hidden`}>
                  <KitSelect
                    aria-label="Show events from"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value as Filter)}
                    wrapperClassName="min-w-0 flex-1"
                  >
                    <option value="all">All events</option>
                    {tables.map((t) => (
                      <option key={t} value={`t:${t}`}>
                        {t}
                      </option>
                    ))}
                    {(presenceN > 0 || filter === 'presence') && <option value="presence">Presence</option>}
                    {(broadcastN > 0 || filter === 'broadcast') && <option value="broadcast">Broadcasts</option>}
                  </KitSelect>
                  <span className="flex-shrink-0 whitespace-nowrap text-[12.5px] tabular-nums text-faint">{plural(visible.length, 'event')}</span>
                </div>
                <div className="hidden md:block">
                  <PaneToolbar title={filterLabel} mono={!!filterTable} count={plural(visible.length, 'event')} />
                </div>
              </>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {!statusKnown && status.error && (
                <ErrorRow
                  things="streaming tables"
                  stillWorks={stream.state === 'connected' ? 'The live feed still works.' : undefined}
                  onRetry={() => void status.refresh()}
                  retrying={status.refreshing}
                  className={`border-b ${RULE}`}
                />
              )}
              <div
                aria-hidden
                className={`sticky top-0 z-[3] hidden h-[34px] items-center gap-x-[16px] border-b ${RULE} ${GRID_HEAD} px-[20px] text-[12px] font-medium text-faint ${firstRun ? '' : 'md:flex'}`}
              >
                <span className="w-[88px] flex-shrink-0">Time</span>
                <span className="w-[72px] flex-shrink-0">Event</span>
                <span className="w-[168px] flex-shrink-0">Table</span>
                <span className="min-w-0 flex-1">Row</span>
              </div>
              {body}
            </div>

            {events.length > 0 && (
              <div
                className={`flex min-h-[36px] flex-shrink-0 flex-wrap items-center gap-x-[16px] gap-y-[2px] border-t ${RULE} px-[16px] py-[8px] text-[12px] leading-[16px] tabular-nums text-faint md:px-[20px]`}
              >
                {stream.connectedAt && (
                  <span>
                    Connected at <SessionClock at={stream.connectedAt} />
                  </span>
                )}
                <span>{countsLine(stream.counts)}</span>
                <span className="ml-auto">Last {FEED_LIMIT} kept</span>
              </div>
            )}
          </section>
        </div>
      </div>

      <RecordDrawer
        open={!!ev}
        onClose={closeEvent}
        title={ev ? <EventTitle event={ev} /> : ''}
        label={ev ? eventTitle(ev) : undefined}
        subtitle={ev ? <SessionClock at={ev.at} seconds /> : null}
        facts={
          ev && changedColumns(ev).length > 0 ? (
            <Facts className="!mt-[8px]">
              <Fact>
                Changed{' '}
                {changedColumns(ev).map((c, i) => (
                  <span key={c}>
                    {i > 0 && ', '}
                    <code className="font-mono text-[12px] text-zinc-300">{c}</code>
                  </span>
                ))}
              </Fact>
            </Facts>
          ) : null
        }
        onPrev={nav.onPrev}
        onNext={nav.onNext}
        position={nav.position}
        footer={ev ? <CopyJsonButton value={pretty(ev.frame)} /> : null}
      >
        {ev && <EventDetail event={ev} projectId={projectId} />}
      </RecordDrawer>
    </div>
  )
}

/** "reviews and watchlist_items", the names in mono. */
function TableNames({ names, text }: { names: readonly string[]; text: string }) {
  // Split the sentence the listing built back into names and joining words.
  const parts: ReactNode[] = []
  let rest = text
  names.forEach((n, i) => {
    const at = rest.indexOf(n)
    if (at > 0) parts.push(rest.slice(0, at))
    parts.push(
      <code key={`${n}-${i}`} className="font-mono text-[12px] text-zinc-200">
        {n}
      </code>,
    )
    rest = rest.slice(at + n.length)
  })
  if (rest) parts.push(rest)
  return <>{parts}</>
}

/** A moment of this session: "2:22 AM", or "2:22:51 AM" with seconds; the full date on hover. */
function SessionClock({ at, seconds = false }: { at: number; seconds?: boolean }) {
  return <Time iso={at} mode={seconds ? 'clockSeconds' : 'clock'} />
}

/** One filter in the rail: All events, a table, Presence, Broadcasts. */
function RailItem({
  label,
  n,
  active,
  onSelect,
  mono = false,
  glyph,
  glyphLabel,
}: {
  label: string
  n: number
  active: boolean
  onSelect: () => void
  mono?: boolean
  glyph?: 'live' | 'idle'
  glyphLabel?: string
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        className={`flex h-[32px] w-full items-center gap-[10px] rounded-[7px] px-[10px] text-left transition-colors duration-150 ${FOCUS_INSET} ${
          active ? 'bg-white/[0.07] text-zinc-50' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-100'
        }`}
      >
        <span className="flex w-[12px] flex-shrink-0 justify-center">{glyph && <StatusGlyph state={glyph} label={glyphLabel ?? glyph} />}</span>
        <span className={`min-w-0 flex-1 truncate ${mono ? 'font-mono text-[12.5px]' : 'text-[13px] font-medium'}`}>{label}</span>
        {n > 0 && <span className="flex-shrink-0 text-[12px] tabular-nums text-faint">{count(n)}</span>}
      </button>
    </li>
  )
}
