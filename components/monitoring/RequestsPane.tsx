'use client'

/**
 * Monitoring's Requests: the last 100 requests at full height, newest first.
 *
 *   Last 100 requests                      [Filter by path]  All | Errors | Slow
 *   Today
 *   ✕  2:23:41 AM   POST /db/reviews                       500    1.2 s
 *      2:23:38 AM   GET /db/movies                         200    33 ms     ⌄
 *
 * It used to sit under a 92px metric strip, the tabs and a band of charts, so
 * at 1280×650 it showed three rows. Errors are the only rows with a glyph; a
 * 4xx status is brighter and a 5xx white, so a page of 200s reads quiet. A row
 * expands in place to everything recorded about the request; a function's
 * route opens the function. "Last 100" is said, not implied: the request log
 * is read 100 at a time (request-logs has no cursor yet).
 */

import { useState } from 'react'
import Link from 'next/link'
import { CopyField, KitButton } from '@/components/inspector/kit'
import { PaneToolbar } from '@/components/console/InstrumentBar'
import { CodeWell, DayGroup, EventRow, EventRowSkeleton } from '@/components/console/EventRow'
import { EmptyPanel, ErrorRow } from '@/components/console/states'
import { duration, formatTime, groupByDay } from '@/components/console/format'
import { FOCUS } from '@/components/console/tokens'
import { REQUEST_LOG_LIMIT, SLOW_MS, filterRequests, fmt, functionOf, type RequestFilter, type RequestRow } from './data'

const FILTERS: ReadonlyArray<{ value: RequestFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'errors', label: 'Errors' },
  { value: 'slow', label: 'Slow' },
]

/** Monochrome: brightness climbs with the trouble, never hue. */
function statusTone(status: number): string {
  if (status >= 500) return 'font-medium text-zinc-50'
  if (status >= 400) return 'text-zinc-200'
  return 'text-zinc-400'
}

/**
 * A 401 had no valid credentials: a wrong or revoked key, often the project's
 * own app holding one, or an end user's missing or expired sign-in. The log
 * keeps it as the project's traffic (a request that sent no credential at all
 * is not recorded, lib/traffic/request-recorder.ts) and says what it was. It is
 * a client error, never counted as the backend failing (lib/services/metrics.ts).
 */
const REFUSED = 'no valid key or sign-in'

export function RequestsPane({
  projectId,
  rows,
  failed,
  readAt,
  onRetry,
  retrying,
  status,
  path,
  onFilter,
  endpointUrl,
}: {
  projectId: string
  /** Null until the first read. */
  rows: readonly RequestRow[] | null
  failed: boolean
  readAt: number | null
  onRetry: () => void
  retrying: boolean
  status: RequestFilter
  path: string
  onFilter: (patch: { status?: RequestFilter; path?: string }) => void
  endpointUrl: string | null
}) {
  const [open, setOpen] = useState<string | null>(null)
  const shown = rows ? filterRequests(rows, status, path) : []
  const groups = groupByDay(shown, (r) => r.timestamp)
  const filtered = status !== 'all' || path.trim() !== ''

  const toolbar = (
    <PaneToolbar
      title={`Last ${REQUEST_LOG_LIMIT} requests`}
      count={rows && filtered ? (status === 'slow' ? `${fmt(shown.length)} over ${duration(SLOW_MS)}` : `${fmt(shown.length)} shown`) : undefined}
      search={{ value: path, onChange: (v) => onFilter({ path: v }), placeholder: 'Filter by path' }}
      view={{
        value: status,
        options: FILTERS.map((f) => ({ value: f.value, label: f.label })),
        onChange: (v) => onFilter({ status: v }),
        label: 'Show requests',
      }}
    />
  )

  if (!rows) {
    return (
      <section aria-label="Requests">
        {toolbar}
        {failed ? <ErrorRow things="requests" onRetry={onRetry} retrying={retrying} /> : <EventRowSkeleton rows={10} />}
      </section>
    )
  }

  if (rows.length === 0) {
    return (
      <section aria-label="Requests">
        {failed && readAt && <ErrorRow things="requests" staleAt={readAt} onRetry={onRetry} retrying={retrying} />}
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
      </section>
    )
  }

  return (
    <section aria-label="Requests">
      {toolbar}
      {failed && readAt && <ErrorRow things="requests" staleAt={readAt} onRetry={onRetry} retrying={retrying} />}
      {shown.length === 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-[20px] py-[14px]">
          <p className="text-[13px] leading-[20px] text-zinc-400">
            {status === 'errors' ? 'None of these failed.' : status === 'slow' ? `None of these took over ${duration(SLOW_MS)}.` : 'No request path matches.'}
          </p>
          <KitButton size="sm" onClick={() => onFilter({ status: 'all', path: '' })}>
            Show all
          </KitButton>
        </div>
      ) : (
        <div>
          {groups.map((g) => (
            <DayGroup key={g.key} label={g.label} headingLevel={3} sticky>
              {g.items.map((r) => {
                const fn = functionOf(r.path)
                const failedRow = r.status >= 500
                return (
                  <EventRow
                    key={r.id}
                    glyph={failedRow ? 'failed' : null}
                    glyphLabel={failedRow ? 'Server error' : undefined}
                    time={r.timestamp}
                    what={
                      <>
                        <span className="text-faint">{r.method}</span> {r.path}
                      </>
                    }
                    mono
                    columns={{ what: 440, result: 48 }}
                    result={
                      <span className={statusTone(r.status)} title={r.status === 401 ? `401: ${REFUSED}` : undefined}>
                        {r.status}
                      </span>
                    }
                    line={<span className={r.latency > SLOW_MS ? 'text-zinc-50' : 'text-zinc-400'}>{duration(r.latency)}</span>}
                    expanded={open === r.id}
                    onToggle={() => setOpen((o) => (o === r.id ? null : r.id))}
                  >
                    <CodeWell label="Request" copy={`${r.method} ${r.path} ${r.status} ${duration(r.latency)} ${r.timestamp}`}>
                      {[
                        `${r.method} ${r.path}`,
                        `Status    ${r.status === 401 ? `401, ${REFUSED}` : r.status}`,
                        `Took      ${duration(r.latency)}`,
                        `At        ${formatTime(r.timestamp, 'date')}, ${formatTime(r.timestamp, 'clockSeconds')}`,
                        `Request   ${r.id}`,
                      ].join('\n')}
                    </CodeWell>
                    {fn && (
                      <p className="border-t border-white/[0.06] bg-[#08090a] px-[16px] pb-[12px] text-[12.5px] leading-[18px] sm:px-[20px]">
                        <Link
                          href={`/app/projects/${projectId}/functions?fn=${encodeURIComponent(fn)}`}
                          className={`rounded-[3px] text-zinc-200 underline decoration-white/25 underline-offset-[3px] hover:text-white ${FOCUS}`}
                        >
                          Open {fn} in Functions
                        </Link>
                      </p>
                    )}
                  </EventRow>
                )
              })}
            </DayGroup>
          ))}
        </div>
      )}
    </section>
  )
}
