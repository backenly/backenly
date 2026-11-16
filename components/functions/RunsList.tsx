'use client'

/**
 * Function runs as one-line rows under their day (project decision 6: a log
 * entry expands in place). Used twice: All runs (every function, the page's
 * first screen) and one function's Runs.
 *
 *   Today
 *   ✓  2:18:41 AM   recommend-movies     60 ms   user 506a28c4: picks=20 genres=1
 *   ✕  7:30:01 AM   send-welcome-email  214 ms   Resend error: Too many requests…
 *
 * Failed runs are filtered on the server (?success=false): the route returns
 * at most 200 runs, so filtering here would hide yesterday's failure behind a
 * busy endpoint's successes. A failed read is said as one, never as "no runs".
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { CodeWell, DayGroup, DayGroupList, EventRow, EventRowSkeleton } from '@/components/console/EventRow'
import { ErrorRow } from '@/components/console/states'
import { GridFooter, count } from '@/components/console/InstrumentBar'
import { duration, groupByDay } from '@/components/console/format'
import { runLine, runOutput, type AiFunctionLog } from './model'

const PAGE = 50
/** The logs route's cap (app/api/projects/[id]/ai-functions/logs). */
const MAX = 200

export function RunsList({
  projectId,
  functionId,
  failedOnly,
  reloadKey,
  showName,
  openFirst = false,
  onOpenedFirst,
  empty,
}: {
  projectId: string
  /** One function's runs; every function's when absent. */
  functionId?: string
  failedOnly: boolean
  /** Bumped by the page to read again (refresh, a test run). */
  reloadKey: number
  /** The function's name as each row's subject (All runs). */
  showName: boolean
  /** Expand the newest row once it is read ("Last run failed" opens that run). */
  openFirst?: boolean
  onOpenedFirst?: () => void
  /** The line for a list with nothing in it. */
  empty: string
}) {
  const [runs, setRuns] = useState<AiFunctionLog[] | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [readAt, setReadAt] = useState<number | null>(null)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const scope = `${functionId ?? '*'}|${failedOnly}`
  const [shownScope, setShownScope] = useState(scope)
  // A different function or filter starts from its own first page (reset while rendering).
  if (scope !== shownScope) {
    setShownScope(scope)
    setRuns(null)
    setLimit(PAGE)
    setFailed(false)
    setOpen(new Set())
  }

  const seq = useRef(0)
  const read = useCallback(async () => {
    const mine = ++seq.current
    setLoading(true)
    try {
      const q = new URLSearchParams({ limit: String(limit) })
      if (functionId) q.set('functionId', functionId)
      if (failedOnly) q.set('success', 'false')
      const res = await fetch(`/api/projects/${projectId}/ai-functions/logs?${q}`, { credentials: 'include' })
      if (!res.ok) throw new Error(String(res.status))
      const data = await res.json()
      if (mine !== seq.current) return
      setRuns(Array.isArray(data?.data) ? data.data : [])
      setFailed(false)
      setReadAt(Date.now())
    } catch {
      if (mine === seq.current) setFailed(true)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [projectId, functionId, failedOnly, limit])

  useEffect(() => {
    void read()
  }, [read, reloadKey])

  // "Last run failed" asks for the newest run open.
  useEffect(() => {
    if (!openFirst || !runs || runs.length === 0) return
    setOpen((prev) => new Set([...prev, runs[0].id]))
    onOpenedFirst?.()
  }, [openFirst, runs, onOpenedFirst])

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (runs === null) {
    if (failed) return <ErrorRow things={failedOnly ? 'failed runs' : 'function runs'} onRetry={() => void read()} retrying={loading} />
    return <EventRowSkeleton rows={8} what={showName} />
  }

  const word = failedOnly ? 'failed run' : 'run'
  return (
    <div>
      {failed && readAt && <ErrorRow things="runs" staleAt={readAt} onRetry={() => void read()} retrying={loading} />}
      {runs.length === 0 ? (
        <p className="px-[16px] py-[16px] text-[13px] leading-[20px] text-zinc-400 sm:px-[20px]">{empty}</p>
      ) : (
        <>
          <DayGroupList>
            {groupByDay(runs, (r) => r.createdAt).map((g) => (
              <DayGroup key={g.key} label={g.label} sticky>
                {g.items.map((run) => {
                  const output = runOutput(run)
                  const line = runLine(run)
                  return (
                    <EventRow
                      key={run.id}
                      id={`run-${run.id}`}
                      glyph={run.success ? 'done' : 'failed'}
                      glyphLabel={run.success ? 'Succeeded' : 'Failed'}
                      time={run.createdAt}
                      what={showName ? run.function?.name ?? 'Deleted function' : undefined}
                      mono
                      result={duration(run.durationMs)}
                      line={line || undefined}
                      lineMono
                      expanded={open.has(run.id)}
                      onToggle={output ? () => toggle(run.id) : undefined}
                      columns={{ what: 184, result: 64 }}
                    >
                      <CodeWell label="Output" copy={output}>
                        {output}
                      </CodeWell>
                    </EventRow>
                  )
                })}
              </DayGroup>
            ))}
          </DayGroupList>
          <GridFooter
            mode="more"
            shown={runs.length}
            hasMore={runs.length >= limit && limit < MAX}
            onLoadMore={() => setLimit((l) => Math.min(l + PAGE, MAX))}
            loading={loading}
            note={runs.length >= limit ? `Showing the last ${count(runs.length)} ${word}s` : `${count(runs.length)} ${word}${runs.length === 1 ? '' : 's'}`}
          />
        </>
      )}
    </div>
  )
}
