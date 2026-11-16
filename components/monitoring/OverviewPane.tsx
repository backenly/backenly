'use client'

/**
 * Monitoring's Overview: is it healthy, and where it hurts.
 *
 *   Requests 18,641 +4%      │ Server errors 12 0.06%   │ Average response 62 ms −1%
 *   ▁▂▃▃▄▅▆▇█▇▆▅            │ ▁      ▃                 │ ‾‾╲__✦__________
 *   12 AM  6 AM  12 PM  6 PM │ 12 AM  6 AM  12 PM  6 PM │ 12 AM  6 AM  12 PM  6 PM
 *   ────────────────────────────────────────────────────────────────────────────
 *   Endpoints  21
 *   Route                     Requests      Avg      p95   Error rate
 *   GET /db/movies               5,144    59 ms   153 ms        0.06%
 *
 * The totals sit in their charts' headings (there is no separate metric strip).
 * Publishes are zinc markers and Backenly's own fixes violet ones, on all three
 * charts, so a fix can be read against the latency after it. "Server errors"
 * means 5xx everywhere (Overview's Last 24 hours uses the same words).
 */

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { CopyField, Skeleton } from '@/components/inspector/kit'
import { TimeSeriesChart, type ChartMarker } from '@/components/console/TimeSeriesChart'
import { EmptyPanel, ErrorRow } from '@/components/console/states'
import { PaneToolbar } from '@/components/console/InstrumentBar'
import { Time } from '@/components/console/Time'
import { duration } from '@/components/console/format'
import { FOCUS, FOCUS_INSET, RULE } from '@/components/console/tokens'
import {
  BUCKET_MS,
  BUCKET_WORD,
  RANGE_WORDS,
  deltaWords,
  fmt,
  functionOf,
  pathOf,
  share,
  type Endpoint,
  type Overview,
  type Range,
  type RequestRow,
  type ServerErrorSeries,
} from './data'

export interface OverviewPaneProps {
  projectId: string
  range: Range
  /** The range's numbers, or null until they are read. */
  overview: Overview | null
  /** The last read failed. With `overview`, it is a failed refresh: the numbers stay. */
  failed: boolean
  /** When the shown numbers were read, for "Showing traffic from 2:14 PM". */
  readAt: number | null
  onRetry: () => void
  retrying: boolean
  /** 5xx per bucket for this range: null while it is read, 'failed' when it could not be. */
  serverErrors: ServerErrorSeries | 'failed' | null
  markers: readonly ChartMarker[]
  /** The last 100 requests, whatever their age: tells "never called" from "quiet lately". */
  requests: readonly RequestRow[] | null
  published: boolean | null
  endpointUrl: string | null
}

export function OverviewPane({
  projectId,
  range,
  overview,
  failed,
  readAt,
  onRetry,
  retrying,
  serverErrors,
  markers,
  requests,
  published,
  endpointUrl,
}: OverviewPaneProps) {
  if (!overview) {
    if (failed) {
      return (
        <div className="border-b border-white/[0.06]">
          <ErrorRow things="traffic" onRetry={onRetry} retrying={retrying} />
        </div>
      )
    }
    return <OverviewSkeleton />
  }

  const total = overview.stats.requests.value
  const stale = failed && readAt ? <ErrorRow things="traffic" staleAt={readAt} onRetry={onRetry} retrying={retrying} /> : null

  // Never called: the request log is empty too.
  if (total === 0 && requests && requests.length === 0) {
    return (
      <>
        {stale}
        <EmptyPanel
          headingLevel={2}
          title="No requests yet"
          sentence="Calls to your API show up here as they happen, with their status and latency."
          docs={{ label: 'Monitoring docs', slug: 'monitoring' }}
        >
          {endpointUrl && (
            <div className="max-w-[520px]">
              <p className="mb-[6px] text-[12px] leading-[16px] text-faint">Your API</p>
              <CopyField value={endpointUrl} label="Copy API URL" />
            </div>
          )}
        </EmptyPanel>
      </>
    )
  }

  // Called before, but not in this range.
  if (total === 0) {
    const last = requests?.[0]?.timestamp
    return (
      <>
        {stale}
        <div className="px-[20px] py-[18px]">
          <h2 className="text-[15px] font-medium leading-[22px] tracking-[-0.012em] text-white">No requests in {RANGE_WORDS[range]}</h2>
          {last && (
            <p className="mt-[4px] text-[13px] leading-[20px] text-zinc-400">
              The last one was <Time iso={last} />.
            </p>
          )}
        </div>
      </>
    )
  }

  return (
    <>
      {stale}
      {published === false && (
        <p className={`border-b ${RULE} px-[16px] py-[8px] text-[12.5px] leading-[18px] text-faint sm:px-[20px]`}>
          Not published. These are pre-release calls.
        </p>
      )}
      <ChartBand overview={overview} serverErrors={serverErrors} markers={markers} />
      <Endpoints projectId={projectId} endpoints={overview.endpoints} range={range} />
    </>
  )
}

// ─── Charts ──────────────────────────────────────────────────────────────────

function ChartBand({
  overview,
  serverErrors,
  markers,
}: {
  overview: Overview
  serverErrors: ServerErrorSeries | 'failed' | null
  markers: readonly ChartMarker[]
}) {
  const { range, start, end, stats } = overview
  const bucket = BUCKET_MS[range]
  const per = BUCKET_WORD[range]
  const daily = bucket >= 24 * 60 * 60_000
  const total = stats.requests.value
  const hasTraffic = total > 0
  const fiveXX = stats.serverErrors?.value ?? null
  const inWindow = markers.filter((m) => m.t >= start && m.t <= end)
  const kinds = { zinc: inWindow.some((m) => m.tone === 'zinc'), violet: inWindow.some((m) => m.tone === 'violet') }
  const when = RANGE_WORDS[range]

  return (
    <section aria-label="Traffic" className={`border-b ${RULE}`}>
      <div className="grid grid-cols-1 divide-y divide-white/[0.06] lg:grid-cols-3 lg:divide-x lg:divide-y-0">
        <ChartCell
          label="Requests"
          value={fmt(total)}
          note={deltaWords(stats.requests.change, hasTraffic)}
          noteTitle={`Against the ${when.replace('the last ', 'previous ')}`}
        >
          <TimeSeriesChart
            series={[{ id: 'requests', label: 'Requests', kind: 'bar', points: overview.volume, format: (v) => `${fmt(v)} ${v === 1 ? 'request' : 'requests'}` }]}
            start={start}
            end={end}
            bucketMs={bucket}
            markers={markers}
            utc={daily}
            ariaLabel={`Requests per ${per}, ${when}.`}
          />
        </ChartCell>
        <ChartCell
          label="Server errors"
          value={fiveXX === null ? 'No data' : fmt(fiveXX)}
          note={fiveXX === null ? null : share(fiveXX, total)}
          noteTitle="Share of all requests answered with a 5xx status"
        >
          {serverErrors === null ? (
            <ChartSkeleton />
          ) : serverErrors === 'failed' ? (
            <ChartNote>Could not load the counts per {per}. The total above is current.</ChartNote>
          ) : (
            <>
              <TimeSeriesChart
                series={[
                  {
                    id: 'server-errors',
                    label: 'Server errors',
                    kind: 'bar',
                    tone: 'bad',
                    points: serverErrors.points,
                    format: (v) => `${fmt(v)} server ${v === 1 ? 'error' : 'errors'}`,
                  },
                ]}
                start={start}
                end={end}
                bucketMs={bucket}
                markers={markers}
                utc={daily}
                minTop={5}
                ariaLabel={`Server errors (5xx) per ${per}, ${when}.`}
              />
              {!serverErrors.complete && <ChartNote>Bars show the latest {fmt(serverErrors.counted)}.</ChartNote>}
            </>
          )}
        </ChartCell>
        <ChartCell
          label="Average response"
          value={hasTraffic ? duration(stats.responseTime.value) : 'No data'}
          note={deltaWords(stats.responseTime.change, hasTraffic)}
          noteTitle={`Against the ${when.replace('the last ', 'previous ')}`}
        >
          <TimeSeriesChart
            series={[{ id: 'latency', label: 'Average response', kind: 'line', points: overview.latency, format: (v) => duration(v), empty: 'No requests' }]}
            start={start}
            end={end}
            bucketMs={bucket}
            markers={markers}
            utc={daily}
            yFormat={(v) => duration(v)}
            ariaLabel={`Average response time per ${per}, ${when}.`}
          />
        </ChartCell>
      </div>
      {(kinds.zinc || kinds.violet) && (
        <div className={`flex flex-wrap items-center gap-x-[16px] gap-y-[4px] border-t ${RULE} px-[16px] py-[7px] text-[12px] leading-[16px] text-faint sm:px-[20px]`}>
          {kinds.zinc && (
            <span className="inline-flex items-center gap-[6px]">
              <span aria-hidden className="h-[12px] w-0 border-l border-dashed border-zinc-400" />
              Publish
            </span>
          )}
          {kinds.violet && (
            <span className="inline-flex items-center gap-[6px]">
              <span aria-hidden className="h-[12px] w-[1.5px] rounded-full bg-violet-400" />
              Fix by Backenly
            </span>
          )}
        </div>
      )}
    </section>
  )
}

function ChartCell({
  label,
  value,
  note,
  noteTitle,
  children,
}: {
  label: string
  value: string
  note?: string | null
  noteTitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 px-[16px] pb-[10px] pt-[14px] sm:px-[20px]">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-[10px] gap-y-[2px]">
        <h2 className="text-[13px] leading-[20px] text-zinc-300">{label}</h2>
        <span className={`text-[15px] font-medium leading-[20px] tabular-nums tracking-[-0.01em] ${value === 'No data' ? 'text-faint' : 'text-white'}`}>
          {value}
        </span>
        {note && (
          <span title={noteTitle} className="text-[12px] leading-[16px] tabular-nums text-faint">
            {note}
            {noteTitle && <span className="sr-only"> ({noteTitle.toLowerCase()})</span>}
          </span>
        )}
      </div>
      <div className="mt-[8px]">{children}</div>
    </div>
  )
}

function ChartNote({ children }: { children: React.ReactNode }) {
  return <p className="mt-[2px] text-[12px] leading-[16px] text-faint">{children}</p>
}

function ChartSkeleton() {
  return (
    <div aria-hidden className="flex h-[158px] items-end gap-[4px] pb-[20px] pt-[18px]">
      {[38, 52, 44, 61, 70, 58, 74, 66, 49, 57, 63, 41].map((h, i) => (
        <span key={i} className="block flex-1" style={{ height: `${h}%` }}>
          <Skeleton className="h-full !rounded-[2px]" />
        </span>
      ))}
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading traffic">
      <div className={`grid grid-cols-1 divide-y divide-white/[0.06] border-b ${RULE} lg:grid-cols-3 lg:divide-x lg:divide-y-0`}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="px-[16px] pb-[10px] pt-[14px] sm:px-[20px]">
            <Skeleton className="h-[13px] w-[132px]" />
            <div className="mt-[8px]">
              <ChartSkeleton />
            </div>
          </div>
        ))}
      </div>
      <div aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className={`flex items-center gap-[24px] border-b ${RULE} px-[20px] py-[11px]`}>
            <Skeleton className={`h-[12px] ${i % 2 ? 'w-[180px]' : 'w-[220px]'}`} />
            <Skeleton className="ml-auto h-[11px] w-[48px]" />
            <Skeleton className="hidden h-[11px] w-[40px] sm:block" />
            <Skeleton className="hidden h-[11px] w-[40px] sm:block" />
            <Skeleton className="h-[11px] w-[40px]" />
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

type SortKey = 'route' | 'requests' | 'avg' | 'p95' | 'errors'
const COLUMNS: Array<{ key: SortKey; label: string; title?: string; right: boolean; wide?: boolean }> = [
  { key: 'route', label: 'Route', right: false },
  { key: 'requests', label: 'Requests', right: true },
  { key: 'avg', label: 'Avg', title: 'Average response', right: true, wide: true },
  { key: 'p95', label: 'p95', title: '95 of every 100 requests were faster than this', right: true, wide: true },
  { key: 'errors', label: 'Error rate', title: 'Share answered with a 4xx or 5xx status', right: true },
]

const sortValue: Record<SortKey, (e: Endpoint) => number | string> = {
  route: (e) => pathOf(e.endpoint),
  requests: (e) => e.requests,
  avg: (e) => e.avgResponseTime,
  p95: (e) => e.p95,
  errors: (e) => e.errorRate,
}

function Endpoints({ projectId, endpoints, range }: { projectId: string; endpoints: readonly Endpoint[]; range: Range }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'requests', desc: true })
  const rows = useMemo(() => {
    const val = sortValue[sort.key]
    return [...endpoints].sort((a, b) => {
      const x = val(a)
      const y = val(b)
      const c = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y) : Number(x) - Number(y)
      return sort.desc ? -c : c
    })
  }, [endpoints, sort])
  const by = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== 'route' }))

  return (
    <section aria-label="Endpoints">
      <PaneToolbar title="Endpoints" count={fmt(endpoints.length)} className="border-b-0" />
      {endpoints.length === 0 ? (
        <p className={`border-t ${RULE} px-[20px] py-[14px] text-[13px] leading-[20px] text-zinc-400`}>
          No endpoint was called in {RANGE_WORDS[range]}.
        </p>
      ) : (
        <table className="w-full table-fixed border-collapse text-left">
          <caption className="sr-only">Endpoints called in {RANGE_WORDS[range]}, sorted by {COLUMNS.find((c) => c.key === sort.key)?.label.toLowerCase()}</caption>
          <colgroup>
            <col />
            <col className="w-[84px] sm:w-[104px]" />
            <col className="hidden w-[88px] sm:table-column" />
            <col className="hidden w-[88px] sm:table-column" />
            <col className="w-[84px] sm:w-[104px]" />
          </colgroup>
          <thead>
            <tr className={`border-y ${RULE} bg-[#0e0f11]`}>
              {COLUMNS.map((c) => {
                const on = sort.key === c.key
                const Icon = sort.desc ? ChevronDown : ChevronUp
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : undefined}
                    className={`h-[34px] p-0 text-[12px] font-medium ${c.wide ? 'hidden sm:table-cell' : ''} ${c.right ? 'text-right' : ''}`}
                  >
                    <button
                      type="button"
                      onClick={() => by(c.key)}
                      title={c.title}
                      className={`inline-flex h-[34px] w-full items-center gap-[4px] px-[12px] first:pl-[16px] sm:first:pl-[20px] ${c.right ? 'justify-end' : ''} ${
                        on ? 'text-zinc-200' : 'text-faint hover:text-zinc-200'
                      } transition-colors duration-150 ${FOCUS_INSET}`}
                    >
                      {c.label}
                      {on && <Icon aria-hidden className="h-3 w-3 flex-shrink-0" strokeWidth={2} />}
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.05]">
            {rows.map((e) => {
              const fn = functionOf(pathOf(e.endpoint))
              const [method, ...rest] = e.endpoint.split(' ')
              const path = rest.join(' ')
              const label = (
                <>
                  <span className="text-zinc-400">{method}</span> <span className="text-zinc-200">{path}</span>
                </>
              )
              return (
                <tr key={e.endpoint} className="transition-colors duration-150 hover:bg-[#121316]">
                  <td className="py-[9px] pl-[16px] pr-[12px] align-top font-mono text-[12px] leading-[18px] [overflow-wrap:anywhere] sm:pl-[20px]">
                    {fn ? (
                      <Link
                        href={`/app/projects/${projectId}/functions?fn=${encodeURIComponent(fn)}`}
                        title={`Open ${fn} in Functions`}
                        className={`rounded-[3px] underline decoration-white/20 underline-offset-[3px] transition-colors duration-150 hover:decoration-white/60 ${FOCUS}`}
                      >
                        {label}
                      </Link>
                    ) : (
                      label
                    )}
                  </td>
                  <td className="px-[12px] py-[9px] text-right align-top text-[12.5px] leading-[18px] tabular-nums text-zinc-200">{fmt(e.requests)}</td>
                  <td className="hidden px-[12px] py-[9px] text-right align-top text-[12.5px] leading-[18px] tabular-nums text-zinc-300 sm:table-cell">
                    {duration(e.avgResponseTime)}
                  </td>
                  <td className="hidden px-[12px] py-[9px] text-right align-top text-[12.5px] leading-[18px] tabular-nums text-zinc-300 sm:table-cell">
                    {duration(e.p95)}
                  </td>
                  <td
                    className={`py-[9px] pl-[12px] pr-[16px] text-right align-top text-[12.5px] leading-[18px] tabular-nums sm:pr-[20px] ${
                      e.errorRate >= 5 ? 'font-medium text-zinc-50' : e.errorRate > 0 ? 'text-zinc-300' : 'text-faint'
                    }`}
                  >
                    {errorRateText(e.errorRate)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

/** "0%", "0.06%", "1.2%". */
function errorRateText(pct: number): string {
  if (!pct) return '0%'
  if (pct < 0.01) return '<0.01%'
  if (pct < 1) return `${Number(pct.toFixed(2))}%`
  return `${Number(pct.toFixed(1))}%`
}
