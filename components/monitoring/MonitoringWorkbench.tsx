'use client'

/**
 * Monitoring: HTTP traffic and logs (project decision 11). The one instrument
 * page of the Operate group: it owns the viewport and is used during
 * incidents.
 *
 *   Monitoring  ● Published   Overview  Requests  Logs    Updated 12 s ago  [1h|24h|7d|30d]  ⟳
 *
 * - Overview: the three charts (requests, server errors, average response)
 *   with their totals in their headings, publishes and Backenly's fixes as
 *   markers, then the Endpoints table (OverviewPane).
 * - Requests: the last 100 requests at full height (RequestsPane).
 * - Logs: every log line in the range (LogsPane).
 *
 * Its state is in the URL (useMonitoringParams), so a view links and survives
 * a reload. It re-reads every 30 s and on ⟳; a failed re-read keeps the last
 * numbers with a line saying how old they are. Gone from the old page: the
 * metric strip (its numbers are in the chart headings), "Success rate" (it
 * counted 4xx; "Server errors" means 5xx everywhere), the invented "Target
 * 200 ms" line, the System events rail (Autonomy and History keep those),
 * the Publish button (Deploy publishes), and a dead incidents read.
 *
 * Below md the frame is an ordinary page that scrolls; from md it fills the
 * canvas and each view scrolls inside it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { InstrumentBar } from '@/components/console/InstrumentBar'
import type { ChartMarker } from '@/components/console/TimeSeriesChart'
import { KIT } from '@/components/inspector/kit'
import { getProject } from '@/lib/api/projects'
import { LogsPane } from './LogsPane'
import { OverviewPane } from './OverviewPane'
import { RequestsPane } from './RequestsPane'
import { RANGES, loadLiveState, loadMarkers, loadOverview, loadRequests, loadServerErrors, type Overview, type RequestRow, type ServerErrorSeries } from './data'
import { useMonitoringParams, type View } from './useMonitoringParams'

const TABS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'requests', label: 'Requests' },
  { id: 'logs', label: 'Logs' },
]

/** How often the page re-reads (it said so in a label before; the freshness fact says it now). */
const POLL_MS = 30_000

export function MonitoringWorkbench({ projectId }: { projectId: string }) {
  const [params, setParams] = useMonitoringParams()
  const { view, range } = params

  const [overview, setOverview] = useState<Overview | null>(null)
  const [overviewFailed, setOverviewFailed] = useState(false)
  const [overviewAt, setOverviewAt] = useState<number | null>(null)
  const [serverErrors, setServerErrors] = useState<ServerErrorSeries | 'failed' | null>(null)
  const [markers, setMarkers] = useState<ChartMarker[]>([])
  const [requests, setRequests] = useState<RequestRow[] | null>(null)
  const [requestsFailed, setRequestsFailed] = useState(false)
  const [requestsAt, setRequestsAt] = useState<number | null>(null)
  const [published, setPublished] = useState<boolean | null>(null)
  const [endpointUrl, setEndpointUrl] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [tick, setTick] = useState(0)
  const [freshAt, setFreshAt] = useState<number | null>(null)
  const rangeRef = useRef(range)

  // A new range starts from placeholders, not from the old range's numbers.
  const [seenRange, setSeenRange] = useState(range)
  if (seenRange !== range) {
    setSeenRange(range)
    setOverview(null)
    setOverviewFailed(false)
    setServerErrors(null)
  }

  const read = useCallback(async () => {
    rangeRef.current = range
    setRefreshing(true)
    const asked = range
    const [ov, rq] = await Promise.allSettled([loadOverview(projectId, asked), loadRequests(projectId)])
    if (rangeRef.current !== asked) return
    if (ov.status === 'fulfilled') {
      setOverview(ov.value)
      setOverviewFailed(false)
      setOverviewAt(Date.now())
      void loadServerErrors(projectId, asked, ov.value.start, ov.value.end)
        .then((s) => { if (rangeRef.current === asked) setServerErrors(s) })
        .catch(() => { if (rangeRef.current === asked) setServerErrors((cur) => (cur && cur !== 'failed' ? cur : 'failed')) })
      void loadMarkers(projectId, ov.value.start).then((m) => { if (rangeRef.current === asked) setMarkers(m) }).catch(() => {})
    } else {
      setOverviewFailed(true)
    }
    if (rq.status === 'fulfilled') {
      setRequests(rq.value)
      setRequestsFailed(false)
      setRequestsAt(Date.now())
    } else {
      setRequestsFailed(true)
    }
    if (ov.status === 'fulfilled' || rq.status === 'fulfilled') setFreshAt(Date.now())
    setRefreshing(false)
  }, [projectId, range])

  useEffect(() => {
    void read()
    const timer = setInterval(() => {
      if (!document.hidden) {
        void read()
        setTick((t) => t + 1)
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [read])

  // Published or not, and the address calls go to: read once.
  useEffect(() => {
    let cancelled = false
    loadLiveState(projectId)
      .then((s) => { if (!cancelled) setPublished(s.published) })
      .catch(() => {})
    getProject(projectId)
      .then((p) => {
        const q = p as typeof p & { publicUrl?: string | null; apiUrlProd?: string | null }
        if (!cancelled) setEndpointUrl(q?.publicUrl || q?.apiUrlProd || q?.apiBaseUrl || null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectId])

  const refresh = () => {
    void read()
    setTick((t) => t + 1)
  }

  const panelId = 'monitoring-view'

  return (
    <div
      className={`flex flex-col ${KIT.bg} md:h-[calc(100dvh_-_var(--console-bar)_-_var(--console-gap)_-_2px)] md:overflow-hidden md:rounded-[13px]`}
    >
      <InstrumentBar<(typeof RANGES)[number]>
        title="Monitoring"
        loading={published === null}
        facts={[
          published === null
            ? null
            : published
              ? { glyph: 'live', label: 'Published', text: 'Published' }
              : { glyph: 'idle', label: 'Not published', text: 'Not published' },
        ]}
        tabs={TABS}
        activeTab={view}
        onTab={(id) => setParams({ view: id as View })}
        panelId={panelId}
        freshness={freshAt ? new Date(freshAt).toISOString() : null}
        range={{
          value: range,
          options: RANGES.map((r) => ({ value: r, label: r })),
          onChange: (r) => setParams({ range: r }),
        }}
        onRefresh={refresh}
        refreshing={refreshing}
      />
      <div id={panelId} role="tabpanel" aria-label={TABS.find((t) => t.id === view)?.label} className="md:min-h-0 md:flex-1 md:overflow-y-auto">
        {view === 'overview' && (
          <OverviewPane
            projectId={projectId}
            range={range}
            overview={overview}
            failed={overviewFailed}
            readAt={overviewAt}
            onRetry={refresh}
            retrying={refreshing}
            serverErrors={serverErrors}
            markers={markers}
            requests={requests}
            published={published}
            endpointUrl={endpointUrl}
          />
        )}
        {view === 'requests' && (
          <RequestsPane
            projectId={projectId}
            rows={requests}
            failed={requestsFailed}
            readAt={requestsAt}
            onRetry={refresh}
            retrying={refreshing}
            status={params.status}
            path={params.path}
            onFilter={(patch) => setParams(patch)}
            endpointUrl={endpointUrl}
          />
        )}
        {view === 'logs' && (
          <LogsPane
            projectId={projectId}
            range={range}
            type={params.type}
            level={params.level}
            q={params.q}
            onFilter={setParams}
            refreshKey={tick}
          />
        )}
      </div>
    </div>
  )
}
