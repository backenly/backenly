'use client'

/**
 * Monitoring's Logs: every log line in the range, newest first.
 *
 *   Logs  104,620 entries        [Search logs] [All sources ▾] [All levels ▾]
 *   Today
 *   2:23:41 AM   API        Error     POST /db/reviews -> 500                  ⌄
 *   ──────────────────────────────────────────────────────────────────────────
 *   1–50 of 104,620                              Previous   1 of 2,093   Next
 *
 * It follows the page's range (it used to read every log the project ever
 * had, whatever the range said), filters with the console's own selects, and
 * a row expands in place to what was recorded with it. Other pages link
 * straight to a filtered view: Functions' menu to type=function&q=<name>, the
 * Auth user drawer to type=auth&q=<email> (decision 11).
 */

import { useEffect, useState } from 'react'
import { KitButton, KitSelect } from '@/components/inspector/kit'
import { GridFooter, PaneToolbar } from '@/components/console/InstrumentBar'
import { CodeWell, DayGroup, EventRow, EventRowSkeleton } from '@/components/console/EventRow'
import { EmptyPanel, ErrorRow } from '@/components/console/states'
import { duration, formatTime, groupByDay } from '@/components/console/format'
import { LOG_LEVELS, LOG_PAGE_SIZE, LOG_SOURCES, RANGE_WORDS, fmt, loadLogs, sourceLabel, type LogsPage, type Range } from './data'

// Monochrome: the levels that ask for a look are white, the word says which.
const LEVEL_TONE: Record<string, string> = {
  error: 'font-medium text-zinc-50',
  warning: 'font-medium text-zinc-50',
  info: 'text-zinc-400',
  debug: 'text-faint',
}
const LEVEL_WORD: Record<string, string> = { error: 'Error', warning: 'Warning', info: 'Info', debug: 'Debug' }

export function LogsPane({
  projectId,
  range,
  type,
  level,
  q,
  onFilter,
  refreshKey,
}: {
  projectId: string
  range: Range
  type: string
  level: string
  q: string
  onFilter: (patch: { type?: string; level?: string; q?: string }) => void
  /** Bumped by the page's refresh (the bar's ⟳ and every 30 s). */
  refreshKey: number
}) {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<LogsPage | null>(null)
  const [failed, setFailed] = useState(false)
  const [readAt, setReadAt] = useState<number | null>(null)
  const [busy, setBusy] = useState(true)
  const [open, setOpen] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  // The search box answers as typed; the read waits for a pause.
  const [typed, setTyped] = useState(q)
  const [seenQ, setSeenQ] = useState(q)
  if (q !== seenQ) {
    setSeenQ(q)
    setTyped(q)
  }
  const [filterKey, setFilterKey] = useState(`${range}|${type}|${level}|${q}`)
  const key = `${range}|${type}|${level}|${q}`
  if (key !== filterKey) {
    // A new filter starts at its first page.
    setFilterKey(key)
    setPage(1)
  }

  useEffect(() => {
    const t = setTimeout(() => {
      if (typed !== q) onFilter({ q: typed })
    }, 300)
    return () => clearTimeout(t)
  }, [typed, q, onFilter])

  useEffect(() => {
    let cancelled = false
    setBusy(true)
    loadLogs(projectId, { type, level, q, page, range })
      .then((body) => {
        if (cancelled) return
        setData(body)
        setFailed(false)
        setReadAt(Date.now())
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, type, level, q, page, range, refreshKey, nonce])

  const filtered = type !== 'all' || level !== 'all' || q !== ''
  const total = data?.pagination.total ?? 0
  const pages = Math.max(1, data?.pagination.totalPages ?? 1)
  const rows = data?.logs ?? []
  const groups = groupByDay(rows, (r) => r.timestamp)

  const toolbar = (
    <PaneToolbar
      title="Logs"
      count={data ? `${fmt(total)} ${total === 1 ? 'entry' : 'entries'}` : undefined}
      search={{ value: typed, onChange: setTyped, placeholder: 'Search logs' }}
      filter={
        <div className="flex w-full items-center gap-[8px] sm:w-auto">
          <KitSelect aria-label="Source" value={type} onChange={(e) => onFilter({ type: e.target.value })} wrapperClassName="flex-1 sm:w-[140px] sm:flex-none" className="sm:!h-[28px]">
            {LOG_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </KitSelect>
          <KitSelect aria-label="Level" value={level} onChange={(e) => onFilter({ level: e.target.value })} wrapperClassName="flex-1 sm:w-[124px] sm:flex-none" className="sm:!h-[28px]">
            {LOG_LEVELS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
                {s.key && data?.stats ? ` ${fmt(data.stats[s.key])}` : ''}
              </option>
            ))}
          </KitSelect>
        </div>
      }
    />
  )

  return (
    <section aria-label="Logs">
      {toolbar}
      {failed && data && readAt && (
        <ErrorRow things="logs" staleAt={readAt} onRetry={() => setNonce((n) => n + 1)} retrying={busy} />
      )}
      {!data ? (
        failed ? (
          <ErrorRow things="logs" onRetry={() => setNonce((n) => n + 1)} retrying={busy} />
        ) : (
          <EventRowSkeleton rows={10} glyph={false} />
        )
      ) : rows.length === 0 ? (
        filtered ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-[20px] py-[14px]">
            <p className="text-[13px] leading-[20px] text-zinc-400">No logs match these filters in {RANGE_WORDS[range]}.</p>
            <KitButton size="sm" onClick={() => { setTyped(''); onFilter({ type: 'all', level: 'all', q: '' }) }}>
              Clear filters
            </KitButton>
          </div>
        ) : (
          <EmptyPanel
            headingLevel={2}
            title={`No logs in ${RANGE_WORDS[range]}`}
            sentence="Requests, sign-ins and function runs write a line here as they happen."
            docs={{ label: 'Monitoring docs', slug: 'monitoring' }}
          />
        )
      ) : (
        <>
          <div aria-busy={busy || undefined}>
            {groups.map((g) => (
              <DayGroup key={g.key} label={g.label} headingLevel={3} sticky>
                {g.items.map((r) => (
                  <EventRow
                    key={r.id}
                    time={r.timestamp}
                    what={sourceLabel(r.type)}
                    columns={{ what: 88, result: 64 }}
                    // Only a level that asks for a look is written out; info is the usual line.
                    result={
                      r.severity === 'error' || r.severity === 'warning' ? (
                        <span className={LEVEL_TONE[r.severity]}>{LEVEL_WORD[r.severity]}</span>
                      ) : (
                        <span className="sr-only">{LEVEL_WORD[r.severity] ?? r.severity}</span>
                      )
                    }
                    line={r.message}
                    lineMono
                    expanded={open === r.id}
                    onToggle={() => setOpen((o) => (o === r.id ? null : r.id))}
                  >
                    <CodeWell label="Log line" copy={r.message}>
                      {[
                        r.message,
                        '',
                        r.endpoint ? `Endpoint  ${r.method ? `${r.method} ` : ''}${r.endpoint}` : null,
                        typeof r.statusCode === 'number' ? `Status    ${r.statusCode}` : null,
                        typeof r.duration === 'number' ? `Took      ${duration(r.duration)}` : null,
                        r.service ? `Service   ${r.service}` : null,
                        `At        ${formatTime(r.timestamp, 'date')}, ${formatTime(r.timestamp, 'clockSeconds')}`,
                      ]
                        .filter((x) => x !== null)
                        .join('\n')}
                    </CodeWell>
                  </EventRow>
                ))}
              </DayGroup>
            ))}
          </div>
          <GridFooter
            mode="pages"
            from={(page - 1) * LOG_PAGE_SIZE + 1}
            to={(page - 1) * LOG_PAGE_SIZE + rows.length}
            total={total}
            page={page}
            pages={pages}
            busy={busy}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(pages, p + 1))}
          />
        </>
      )}
    </section>
  )
}
