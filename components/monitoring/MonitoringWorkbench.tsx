'use client'

/**
 * Monitoring workbench — telemetry as an instrument surface.
 *
 * The old page stacked a hero, a metric card, tabs, two chart cards, a system
 * event card and a request-log card down a scrolling document, so the request
 * log — the thing you actually read during an incident — started below the
 * fold and never got more than its own content height.
 *
 * Rebuilt as a fixed-height console: command bar with the time range, a flush
 * metric strip, then a body where the charts take a fixed band and the request
 * log takes every remaining pixel and scrolls internally. Anomalies and system
 * events move to a right rail so they are visible without displacing the log.
 */

import { useState, useEffect, useCallback, useId } from 'react'
import { useRouter } from 'next/navigation'
import {
  Activity, TrendingUp, Globe, RefreshCw, BarChart3,
  Shield, Rocket, Upload, Database, Code, AlertTriangle,
} from 'lucide-react'
import {
  getMetrics, getStats, getAnomalies, getActiveIncidents, getPerformanceBreakdown,
  type DataPoint, type MetricStats, type Anomaly, type Incident, type PerformanceBreakdown,
} from '@/lib/api/monitoring'
import {
  CommandBar, EmptyState, IconButton, KIT, KitButton, KitTab, KitTabs, NoticeStrip, Segmented, Spinner, StatusDot,
} from '@/components/inspector/kit'
import { LogsExplorer } from './LogsExplorer'

type TimeRange = '1h' | '24h' | '7d' | '30d'

function getIconForEventType(type: string) {
  const iconMap: Record<string, any> = {
    deploy: Rocket, deployment: Rocket, scale: TrendingUp, scaling: TrendingUp,
    traffic: Globe, auth: Shield, storage: Upload, database: Database, api: Code,
  }
  return iconMap[type.toLowerCase()] || Activity
}

export function MonitoringWorkbench({ projectId }: { projectId: string }) {
  const router = useRouter()
  const [timeRange, setTimeRange] = useState<TimeRange>('24h')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [activeView, setActiveView] = useState<'overview' | 'performance' | 'logs'>('overview')

  const [metrics, setMetrics] = useState<MetricStats | null>(null)
  const [responseTimeData, setResponseTimeData] = useState<DataPoint[]>([])
  const [requestVolumeData, setRequestVolumeData] = useState<DataPoint[]>([])
  const [anomalies, setAnomalies] = useState<Anomaly[]>([])
  const [, setIncidents] = useState<Incident[]>([])
  const [performanceBreakdowns, setPerformanceBreakdowns] = useState<PerformanceBreakdown[]>([])
  const [isBackendLive, setIsBackendLive] = useState<boolean | null>(null)
  const [systemEvents, setSystemEvents] = useState<any[]>([])
  const [requestLog, setRequestLog] = useState<
    Array<{ id: string; method: string; path: string; status: number; latency: number; timestamp: string }>
  >([])

  useEffect(() => {
    const fetchLiveState = async () => {
      try {
        const stateRes = await fetch(`/api/projects/${projectId}/state`, { credentials: 'include' })
        if (stateRes.ok) {
          const state = await stateRes.json()
          const hasContent =
            (state.hasContent ?? false) ||
            (state.capabilities ?? []).some((c: { name: string }) => c.name === 'Authentication')
          setIsBackendLive(!!(state.isLive && hasContent))
        } else {
          setIsBackendLive(false)
        }
      } catch {
        setIsBackendLive(false)
      }
    }
    fetchLiveState()
  }, [projectId])

  const fetchData = useCallback(async () => {
    try {
      if (!projectId) {
        setLoading(false)
        setRefreshing(false)
        return
      }
      setRefreshing(true)

      const [statsData, anomaliesData, incidentsData, eventsData, requestLogsData] = await Promise.all([
        getStats(timeRange, projectId).catch(() => null),
        getAnomalies(10, projectId).catch(() => []),
        getActiveIncidents(projectId).catch(() => []),
        fetch(`/api/monitoring/events?projectId=${projectId}&limit=8`)
          .then((res) => (res.ok ? res.json() : { events: [] }))
          .then((data) => data.events || [])
          .catch(() => []),
        fetch(`/api/monitoring/request-logs?projectId=${projectId}&limit=100`)
          .then((res) => (res.ok ? res.json() : { requestLogs: [] }))
          .then((data) => data.requestLogs || [])
          .catch(() => []),
      ])

      const [responseTime, requestVolume, apiPerformance] = await Promise.all([
        getMetrics('responseTime', timeRange, undefined, undefined, projectId).catch(() => []),
        getMetrics('requestVolume', timeRange, undefined, undefined, projectId).catch(() => []),
        getPerformanceBreakdown(timeRange, 'api', projectId).catch(() => []),
      ])

      setMetrics(
        statsData ?? {
          responseTime: { value: 0, change: 0, status: 'healthy' },
          requests: { value: 0, change: 0, status: 'healthy' },
          errors: { value: 0, change: 0, status: 'healthy' },
          uptime: { value: 0, change: 0, status: 'healthy' },
        }
      )
      setResponseTimeData(responseTime)
      setRequestVolumeData(requestVolume)
      setPerformanceBreakdowns(apiPerformance)
      setAnomalies(anomaliesData)
      setIncidents(incidentsData)
      setSystemEvents(eventsData.map((event: any) => ({ ...event, icon: getIconForEventType(event.type) })))
      setRequestLog(requestLogsData)
    } catch (error: any) {
      console.error('Error fetching monitoring data:', error)
      setMetrics({
        responseTime: { value: 0, change: 0, status: 'healthy' },
        requests: { value: 0, change: 0, status: 'healthy' },
        errors: { value: 0, change: 0, status: 'healthy' },
        uptime: { value: 0, change: 0, status: 'healthy' },
      })
      setResponseTimeData([])
      setRequestVolumeData([])
      setPerformanceBreakdowns([])
      setAnomalies([])
      setIncidents([])
      setRequestLog([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [timeRange, projectId])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Rates only mean something once there is traffic to divide by. With none,
  // the strip says so instead of printing a reassuring 100%.
  const requestCount = metrics?.requests.value ?? 0
  const hasTraffic = requestCount > 0
  const successRate = hasTraffic && metrics ? 100 - (metrics.errors.value / requestCount) * 100 : null
  const rangeLabel = { '1h': 'hour', '24h': '24 hours', '7d': '7 days', '30d': '30 days' }[timeRange]

  const deltaHint = (change: number | undefined, invert = false) => {
    if (!hasTraffic || !change || !Number.isFinite(change)) return undefined
    const up = change > 0
    const bad = invert ? up : !up
    return (
      <span className={bad ? 'text-amber-200/80' : 'text-zinc-500'}>
        {up ? '+' : '−'}
        {Math.abs(change).toFixed(0)}% vs previous {rangeLabel}
      </span>
    )
  }

  const shell = (body: React.ReactNode) => (
    <div className={`console-fill flex flex-col overflow-hidden ${KIT.bg}`}>
      {/* ── Command bar ───────────────────────────────────── */}
      <CommandBar
        title="Monitoring"
        context={
          isBackendLive == null ? undefined : (
            <StatusDot
              tone={isBackendLive ? 'operational' : 'neutral'}
              label={isBackendLive ? 'Published' : 'Not published'}
            />
          )
        }
      >
        <span className="hidden text-[12px] text-zinc-600 md:inline">Refreshes every 30s</span>
        <Segmented<TimeRange>
          label="Time range"
          size="sm"
          value={timeRange}
          onChange={setTimeRange}
          options={(['1h', '24h', '7d', '30d'] as TimeRange[]).map((r) => ({ value: r, label: r }))}
        />
        <IconButton
          icon={RefreshCw}
          label="Refresh now"
          onClick={() => fetchData()}
          disabled={refreshing}
          className={refreshing ? '[&_svg]:animate-spin' : ''}
        />
      </CommandBar>

      {/* ── Metric strip ──────────────────────────────────── */}
      <div className="grid flex-shrink-0 grid-cols-2 gap-px border-b border-white/[0.06] bg-white/[0.06] lg:grid-cols-4">
        <Metric
          label="Avg latency"
          value={metrics == null ? null : hasTraffic ? `${metrics.responseTime.value} ms` : 'No data'}
          hint={deltaHint(metrics?.responseTime.change, true)}
          tone={metrics?.responseTime.status}
        />
        <Metric
          label="Requests"
          value={metrics == null ? null : requestCount.toLocaleString()}
          hint={deltaHint(metrics?.requests.change) ?? (metrics ? `Last ${rangeLabel}` : undefined)}
        />
        <Metric
          label="Success rate"
          title="Requests answered without a 4xx or 5xx"
          value={metrics == null ? null : successRate == null ? 'No data' : `${successRate.toFixed(1)}%`}
          hint={hasTraffic && metrics ? `${metrics.errors.value.toLocaleString()} errored` : undefined}
          tone={metrics?.errors.status}
        />
        <Metric
          label="Reliability"
          title="Requests answered without a server error (5xx)"
          value={metrics == null ? null : hasTraffic ? `${metrics.uptime.value}%` : 'No data'}
          hint={hasTraffic ? 'Without a server error' : undefined}
          tone={metrics?.uptime.status}
        />
      </div>

      {/* ── Tabs ──────────────────────────────────────────── */}
      <KitTabs className="flex-shrink-0 px-3 sm:px-4">
        <KitTab active={activeView === 'overview'} onClick={() => setActiveView('overview')}>Overview</KitTab>
        <KitTab active={activeView === 'performance'} onClick={() => setActiveView('performance')}>Endpoints</KitTab>
        <KitTab active={activeView === 'logs'} onClick={() => setActiveView('logs')}>Logs</KitTab>
      </KitTabs>

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">{body}</div>
      </div>
    </div>
  )

  // Ahead of BOTH gates below, deliberately.
  //
  // Logs read a different endpoint and own their loading, empty and error
  // states, so the workbench's shared spinner would block a panel that is
  // already capable of showing its own. More importantly the "backend not
  // live" gate would swallow this tab entirely: a deployment with no traffic
  // still records system and auth logs, and sending that case to "nothing to
  // watch yet" hides the very entries an operator opens this tab to read.
  if (activeView === 'logs') {
    return shell(<LogsExplorer projectId={projectId} />)
  }

  if (loading) {
    return shell(
      <div className="flex h-full w-full items-center justify-center text-zinc-500">
        <Spinner className="h-4 w-4" />
      </div>
    )
  }

  // Not published AND nothing recorded: there is genuinely nothing to show.
  // Traffic that arrives before publishing (tests, a local frontend, an agent
  // exercising endpoints) is real, so it is shown rather than hidden behind
  // this state while the strip above reports it.
  if (isBackendLive === false && !hasTraffic && requestLog.length === 0) {
    return shell(
      <div className="flex h-full w-full flex-col items-center justify-center overflow-y-auto px-6">
        <EmptyState
          icon={BarChart3}
          title="Nothing to watch yet"
          description="Traffic, errors and slow endpoints appear here as soon as something calls this backend. Publishing gives your app a stable URL to call."
          action={
            <KitButton variant="primary" icon={Rocket} onClick={() => router.push(`/app/projects/${projectId}/deploy`)}>
              Publish
            </KitButton>
          }
        />
      </div>
    )
  }

  if (activeView === 'performance') {
    return shell(
      <div className="flex min-w-0 flex-1 flex-col">
        <PaneHeader
          title="Endpoints"
          count={`${performanceBreakdowns.length} ${performanceBreakdowns.length === 1 ? 'route' : 'routes'}`}
          aside={`Last ${rangeLabel}`}
        />
        <div className="min-h-0 flex-1 overflow-auto">
          {performanceBreakdowns.length === 0 ? (
            <div className="flex min-h-full flex-col items-center justify-center px-6">
              <EmptyState
                icon={BarChart3}
                title="Nothing to measure yet"
                description="Once requests arrive, each endpoint gets its own traffic, speed and error rate here."
              />
            </div>
          ) : (
            <div className="min-w-full overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className={KIT.gridHead}>
                    <th className={`${TH} text-left`}>Route</th>
                    <th className={`${TH} text-right`}>Requests</th>
                    <th className={`${TH} text-right`}>Avg</th>
                    <th className={`${TH} text-right`}>p95</th>
                    <th className={`${TH} text-right`}>Error rate</th>
                  </tr>
                </thead>
                <tbody>
                  {performanceBreakdowns.map((b, idx) => (
                    <tr key={idx} className={`transition-colors ${KIT.rowHoverOn}`}>
                      <td className={`${TD} font-mono text-[12.5px] text-zinc-200`}>{b.endpoint || b.function || b.database}</td>
                      <td className={`${TD} text-right text-[12.5px] tabular-nums text-zinc-300`}>{b.requests.toLocaleString()}</td>
                      <td className={`${TD} text-right text-[12.5px] tabular-nums text-zinc-300`}>{b.avgResponseTime} ms</td>
                      <td className={`${TD} text-right text-[12.5px] tabular-nums text-zinc-400`}>{b.p95} ms</td>
                      <td className={`${TD} text-right`}>
                        <span
                          className={`text-[12.5px] tabular-nums ${
                            b.errorRate > 1 ? 'text-rose-300' : b.errorRate > 0.2 ? 'text-amber-200' : 'text-zinc-400'
                          }`}
                        >
                          {b.errorRate}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Overview ─────────────────────────────────────────────────────────────
  const hasCharts = responseTimeData.length > 0 || requestVolumeData.length > 0

  return shell(
    <>
      {/* Main column — charts band on top, request log takes the rest */}
      <div className="flex min-w-0 flex-1 flex-col">
        {isBackendLive === false && (
          <NoticeStrip
            icon={Rocket}
            action={
              <KitButton size="sm" onClick={() => router.push(`/app/projects/${projectId}/deploy`)}>
                Publish
              </KitButton>
            }
          >
            <strong>Not published yet.</strong> These requests reached the backend before it had a public release.
          </NoticeStrip>
        )}

        {hasCharts ? (
          <div className="grid flex-shrink-0 grid-cols-1 border-b border-white/[0.06] lg:grid-cols-2">
            <Chart
              title="Response time"
              subtitle="Average, ms"
              data={responseTimeData}
              unit=" ms"
              threshold={200}
              thresholdLabel="Target"
              className="border-white/[0.06] lg:border-r"
            />
            <Chart title="Request volume" subtitle="Requests per minute" data={requestVolumeData} unit="/min" />
          </div>
        ) : (
          <div className="flex-shrink-0 border-b border-white/[0.06] py-6">
            <EmptyState
              icon={Activity}
              title="Quiet so far"
              description="Charts draw once there is enough traffic in this window to plot."
            />
          </div>
        )}

        <PaneHeader
          title="Requests"
          count={`${requestLog.length} ${requestLog.length === 1 ? 'request' : 'requests'}`}
          aside="Newest first"
        />

        <div className="min-h-0 flex-1 overflow-auto">
          {requestLog.length === 0 ? (
            <div className="flex min-h-full flex-col items-center justify-center px-6">
              <EmptyState
                icon={Globe}
                title="No requests yet"
                description="Every call to this backend's API lands here with its status and latency."
              />
            </div>
          ) : (
            <div className="min-w-full overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse">
                <thead className="sticky top-0 z-10">
                  <tr className={KIT.gridHead}>
                    <th className={`${TH} w-20 text-left`}>Method</th>
                    <th className={`${TH} text-left`}>Path</th>
                    <th className={`${TH} w-20 text-left`}>Status</th>
                    <th className={`${TH} w-24 text-right`}>Latency</th>
                    <th className={`${TH} w-36 text-right`}>When</th>
                  </tr>
                </thead>
                <tbody>
                  {requestLog.map((req) => {
                    const statusTone =
                      req.status >= 500 ? 'failed' : req.status >= 400 ? 'attention' : req.status >= 300 ? 'neutral' : 'operational'
                    return (
                      <tr key={req.id} className={`transition-colors ${KIT.rowHoverOn}`}>
                        <td className={TD}>
                          <span className={`font-mono text-[11.5px] font-medium tracking-[0.02em] ${METHOD_TONE[req.method] ?? 'text-zinc-400'}`}>
                            {req.method}
                          </span>
                        </td>
                        <td className={`${TD} max-w-0 w-full truncate font-mono text-[12.5px] text-zinc-200`} title={req.path}>
                          {req.path}
                        </td>
                        <td className={TD}>
                          <StatusDot tone={statusTone} label={<span className="tabular-nums">{req.status}</span>} />
                        </td>
                        <td className={`${TD} text-right text-[12.5px] tabular-nums ${req.latency > 1000 ? 'text-amber-200' : 'text-zinc-300'}`}>
                          {req.latency} ms
                        </td>
                        <td className={`${TD} text-right text-[12.5px] tabular-nums text-zinc-500`}>
                          <time dateTime={new Date(req.timestamp).toISOString()} title={new Date(req.timestamp).toLocaleString()}>
                            {new Date(req.timestamp).toLocaleString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Right rail — anomalies and system events stay visible beside the log */}
      <div className={`hidden w-[300px] flex-shrink-0 flex-col border-l border-white/[0.06] xl:flex ${KIT.rail}`}>
        <div className="flex h-[44px] flex-shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
          <span className="text-[13px] font-medium text-zinc-200">Signals</span>
          {anomalies.length > 0 && (
            <StatusDot tone="attention" label={`${anomalies.length} ${anomalies.length === 1 ? 'anomaly' : 'anomalies'}`} />
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {anomalies.length > 0 && (
            <section className="border-b border-white/[0.06]">
              <h3 className="px-4 pb-1 pt-4 text-[12px] font-medium text-zinc-500">Anomalies</h3>
              <ul className="divide-y divide-white/[0.05]">
                {anomalies.map((anomaly) => (
                  <li key={anomaly.id} className="px-4 py-3">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-300" strokeWidth={1.75} />
                        <span className="truncate text-[13px] font-medium text-zinc-100">{anomaly.metric}</span>
                      </span>
                      <span className="flex-shrink-0 text-[12.5px] tabular-nums text-amber-200">
                        {anomaly.type === 'spike' ? '+' : '−'}
                        {Math.abs(anomaly.deviation).toFixed(0)}%
                      </span>
                    </div>
                    <p className="text-[12.5px] leading-[19px] text-zinc-400">{anomaly.explanation}</p>
                    <p className="mt-1.5 text-[12px] tabular-nums text-zinc-500">
                      Expected {anomaly.expectedValue}, saw <span className="text-zinc-300">{anomaly.value}</span>
                      <span className="text-zinc-700"> · </span>
                      {new Date(anomaly.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="px-4 pb-1 pt-4 text-[12px] font-medium text-zinc-500">System events</h3>
            {systemEvents.length === 0 ? (
              <p className="px-4 pb-4 pt-1 text-[12.5px] leading-[19px] text-zinc-500">
                Deploys, incidents and significant changes land here as they happen.
              </p>
            ) : (
              <ul className="divide-y divide-white/[0.05]">
                {collapseEvents(systemEvents).map(({ event, repeats }) => (
                  <li key={event.id} className="flex items-start gap-3 px-4 py-2.5">
                    <SystemEventIcon type={event.type} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] leading-[19px] text-zinc-200 [overflow-wrap:break-word]">
                        {humanizeEvent(event.message)}
                        {repeats > 1 && <span className="ml-1.5 text-[12px] tabular-nums text-zinc-500">×{repeats}</span>}
                      </p>
                      <p className="mt-0.5 text-[12px] tabular-nums text-zinc-500">
                        {new Date(event.timestamp).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  )
}

/** Event codes such as DATA_PLANE_RESTART_UNCONFIGURED read as a sentence. */
function humanizeEvent(message: string): string {
  if (typeof message !== 'string') return String(message ?? '')
  if (!/^[A-Z0-9_]+$/.test(message)) return message
  const words = message.toLowerCase().split('_').filter(Boolean).join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Consecutive identical events (a check that fires every minute) become one row with a count. */
function collapseEvents(events: any[]): Array<{ event: any; repeats: number }> {
  const out: Array<{ event: any; repeats: number }> = []
  for (const event of events) {
    const last = out[out.length - 1]
    if (last && last.event.message === event.message && last.event.type === event.type) last.repeats++
    else out.push({ event, repeats: 1 })
  }
  return out
}

const TH = 'h-[36px] whitespace-nowrap border-b border-white/[0.06] px-3 text-[12px] font-medium text-zinc-500'
const TD = 'h-[36px] whitespace-nowrap border-b border-white/[0.04] px-3'

const METHOD_TONE: Record<string, string> = {
  GET: 'text-zinc-400',
  POST: 'text-emerald-300',
  PUT: 'text-violet-300',
  PATCH: 'text-violet-300',
  DELETE: 'text-rose-300',
}

function SystemEventIcon({ type }: { type: string }) {
  const cls = 'mt-[3px] h-3.5 w-3.5 flex-shrink-0 text-zinc-500'
  switch ((type || '').toLowerCase()) {
    case 'deploy': case 'deployment': return <Rocket className={cls} strokeWidth={1.75} />
    case 'scale': case 'scaling': return <TrendingUp className={cls} strokeWidth={1.75} />
    case 'traffic': return <Globe className={cls} strokeWidth={1.75} />
    case 'auth': return <Shield className={cls} strokeWidth={1.75} />
    case 'storage': return <Upload className={cls} strokeWidth={1.75} />
    case 'database': return <Database className={cls} strokeWidth={1.75} />
    case 'api': return <Code className={cls} strokeWidth={1.75} />
    default: return <Activity className={cls} strokeWidth={1.75} />
  }
}

function PaneHeader({ title, count, aside }: { title: string; count?: string; aside?: string }) {
  return (
    <div className="flex h-[44px] flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
      <div className="flex min-w-0 items-center gap-3">
        <h2 className="text-[13px] font-medium text-zinc-100">{title}</h2>
        {count && <span className="whitespace-nowrap text-[12px] tabular-nums text-zinc-500">{count}</span>}
      </div>
      {aside && <span className="flex-shrink-0 text-[12px] text-zinc-600">{aside}</span>}
    </div>
  )
}

function Metric({
  label,
  value,
  hint,
  tone,
  title,
}: {
  label: string
  value: string | null
  hint?: React.ReactNode
  tone?: 'healthy' | 'warning' | 'critical'
  title?: string
}) {
  const valueTone = value === 'No data'
    ? 'text-zinc-600'
    : tone === 'critical' ? 'text-rose-300' : tone === 'warning' ? 'text-amber-200' : 'text-zinc-50'
  return (
    <div className="min-w-0 bg-[#0c0d0f] px-4 py-3 sm:px-5" title={title}>
      <p className="truncate text-[12px] text-zinc-500">{label}</p>
      {value == null ? (
        <span className="mt-2 block h-[22px] w-16 animate-pulse rounded-[5px] bg-white/[0.06]" />
      ) : (
        <p className={`mt-1 truncate text-[20px] font-semibold leading-[28px] tracking-[-0.02em] tabular-nums ${valueTone}`}>{value}</p>
      )}
      <p className="mt-0.5 h-[16px] truncate text-[12px] leading-[16px] text-zinc-500">{hint}</p>
    </div>
  )
}

// ─── Chart — calm, no glow, single accent line ───────────────────────────────

function Chart({
  title,
  subtitle,
  data,
  unit,
  threshold,
  thresholdLabel,
  className = '',
}: {
  title: string
  subtitle: string
  data: DataPoint[]
  unit: string
  threshold?: number
  thresholdLabel?: string
  className?: string
}) {
  const color = '#c4b5fd'
  const gradientId = `mon-${useId().replace(/:/g, '')}`
  const maxValue = Math.max(...data.map((d) => d.value), threshold || 0, 1)
  const minValue = Math.min(...data.map((d) => d.value), 0)
  const range = maxValue - minValue || 1
  const points = data
    .map((p, idx) => {
      const x = (idx / (data.length - 1 || 1)) * 100
      const y = 100 - ((p.value - minValue) / range) * 100
      return `${x},${y}`
    })
    .join(' ')
  const areaPoints = `0,100 ${points} 100,100`
  const thresholdY = threshold ? 100 - ((threshold - minValue) / range) * 100 : null
  const exceedsThreshold = threshold && data.some((d) => d.value > threshold)

  const latest = data.length ? data[data.length - 1].value : null

  return (
    <div className={`px-4 py-4 sm:px-5 ${className}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-medium text-zinc-100">{title}</h3>
          <p className="mt-0.5 text-[12px] text-zinc-500">{subtitle}</p>
        </div>
        <div className="flex-shrink-0 text-right">
          {latest != null && (
            <p className="text-[13px] font-medium tabular-nums text-zinc-100">
              {Math.round(latest).toLocaleString()}
              <span className="text-zinc-500">{unit}</span>
            </p>
          )}
          {threshold ? (
            <p className={`mt-0.5 text-[12px] tabular-nums ${exceedsThreshold ? 'text-amber-200' : 'text-zinc-500'}`}>
              {thresholdLabel} {threshold}
              {unit}
            </p>
          ) : null}
        </div>
      </div>
      <div className="relative h-[128px]">
        <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0">
          {[0, 25, 50, 75, 100].map((y) => (
            <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="0.15" />
          ))}
          {thresholdY !== null && (
            <line
              x1="0"
              y1={thresholdY}
              x2="100"
              y2={thresholdY}
              stroke={exceedsThreshold ? '#f59e0b' : '#6b7280'}
              strokeWidth="0.3"
              strokeDasharray="2,2"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.16" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <polygon points={areaPoints} fill={`url(#${gradientId})`} />
          <polyline
            points={points}
            fill="none"
            stroke={exceedsThreshold ? '#f59e0b' : color}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="pointer-events-none absolute bottom-0 left-0 top-0 flex flex-col justify-between text-[11px] tabular-nums text-zinc-600">
          <span>{maxValue.toFixed(0)}</span>
          <span>{minValue.toFixed(0)}</span>
        </div>
      </div>
    </div>
  )
}
