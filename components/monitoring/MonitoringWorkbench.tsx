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

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Activity, TrendingUp, Globe, CheckCircle2, RefreshCw, BarChart3,
  Shield, Rocket, Upload, Database, Code,
} from 'lucide-react'
import {
  getMetrics, getStats, getAnomalies, getActiveIncidents, getPerformanceBreakdown,
  type DataPoint, type MetricStats, type Anomaly, type Incident, type PerformanceBreakdown,
} from '@/lib/api/monitoring'
import { KitButton, EmptyState, KIT } from '@/components/inspector/kit'

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
  const [activeView, setActiveView] = useState<'overview' | 'performance'>('overview')

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

  const stabilityValue =
    metrics && metrics.requests.value > 0
      ? `${(100 - (metrics.errors.value / metrics.requests.value) * 100).toFixed(1)}%`
      : '100%'

  const shell = (body: React.ReactNode) => (
    <div className={`flex h-[calc(100vh-48px)] flex-col overflow-hidden ${KIT.bg}`}>
      {/* ── Command bar ───────────────────────────────────── */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between gap-4 border-b border-white/[0.06] px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-600">
            <Activity className="h-3 w-3" />
            Inspector
          </span>
          <span className="h-3 w-px bg-white/10" />
          <h1 className="text-[13px] font-semibold text-zinc-100">Monitoring</h1>
          <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-emerald-300/90">
            <span className="h-[5px] w-[5px] rounded-full bg-emerald-400" />
            Live
          </span>
        </div>

        <div className="flex flex-shrink-0 items-center gap-1">
          <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
            {(['1h', '24h', '7d', '30d'] as TimeRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`rounded-md px-2.5 py-1 font-mono text-[10.5px] font-medium tabular-nums transition-colors focus:outline-none ${
                  timeRange === range ? 'bg-white/[0.06] text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {range}
              </button>
            ))}
          </div>
          <button
            onClick={() => fetchData()}
            disabled={refreshing}
            className="ml-1 rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── Metric strip ──────────────────────────────────── */}
      <div className="grid flex-shrink-0 grid-cols-2 border-b border-white/[0.06] lg:grid-cols-4">
        {[
          { label: 'Latency', value: metrics ? `${metrics.responseTime.value}ms` : '—' },
          { label: 'Traffic', value: metrics ? metrics.requests.value.toLocaleString() : '—' },
          { label: 'Stability', value: metrics ? stabilityValue : '—' },
          { label: 'Reliability', value: metrics ? `${metrics.uptime.value}%` : '—' },
        ].map((m, i) => (
          <div
            key={m.label}
            className={`px-4 py-2.5 ${i < 3 ? 'lg:border-r' : ''} ${i % 2 === 0 ? 'border-r' : ''} ${
              i < 2 ? 'border-b lg:border-b-0' : ''
            } border-white/[0.06]`}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">{m.label}</p>
            <p className="mt-1.5 font-mono text-[17px] font-medium leading-none tabular-nums text-white">{m.value}</p>
          </div>
        ))}
      </div>

      {/* ── Tabs ──────────────────────────────────────────── */}
      <div className="flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-white/[0.06] px-3">
        {([
          ['overview', 'Overview'],
          ['performance', 'Performance'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveView(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-[12px] font-medium transition-colors focus:outline-none ${
              activeView === key
                ? 'border-violet-400 text-zinc-50'
                : 'border-transparent text-zinc-500 hover:text-zinc-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex">{body}</div>
      </div>
    </div>
  )

  // Backend not live — keep the chrome so the section still reads as itself.
  if (isBackendLive === false && !loading) {
    return shell(
      <div className="flex h-full w-full flex-col items-center justify-center px-8">
        <EmptyState
          icon={BarChart3}
          title="Nothing to watch yet"
          description="Once your app goes live, I'll start tracking traffic, errors, and slow queries here."
          action={
            <KitButton variant="primary" icon={Rocket} onClick={() => router.push(`/app/projects/${projectId}/deploy`)}>
              Publish now
            </KitButton>
          }
        />
      </div>
    )
  }

  if (loading) {
    return shell(
      <div className="flex h-full w-full items-center justify-center">
        <RefreshCw className="h-4 w-4 animate-spin text-white/30" />
      </div>
    )
  }

  if (activeView === 'performance') {
    return shell(
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[13px] font-medium text-zinc-100">API performance</h2>
            <span className="font-mono text-[11px] tabular-nums text-zinc-500">
              {performanceBreakdowns.length} route{performanceBreakdowns.length === 1 ? '' : 's'}
            </span>
          </div>
          <span className="font-mono text-[10.5px] tabular-nums text-zinc-700">per-endpoint · {timeRange}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {performanceBreakdowns.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-8">
              <EmptyState
                icon={BarChart3}
                title="Nothing to measure yet"
                description="When your app starts handling real requests, I'll break down speed and reliability per endpoint."
              />
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className={KIT.gridHead}>
                  {['API route', 'Traffic', 'Speed', 'Slowest', 'Health'].map((h, i) => (
                    <th
                      key={h}
                      className={`border-b border-white/[0.06] px-3 py-2 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600 ${
                        i === 0 ? 'text-left' : 'text-right'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {performanceBreakdowns.map((b, idx) => (
                  <tr key={idx} className={`transition-colors ${KIT.rowHoverOn}`}>
                    <td className="border-b border-white/[0.04] px-3 py-[9px] font-mono text-[12px] text-zinc-300">
                      {b.endpoint || b.function || b.database}
                    </td>
                    <td className="border-b border-white/[0.04] px-3 py-[9px] text-right font-mono text-[11px] tabular-nums text-zinc-500">
                      {b.requests.toLocaleString()}
                    </td>
                    <td className="border-b border-white/[0.04] px-3 py-[9px] text-right font-mono text-[11px] tabular-nums text-zinc-500">
                      {b.avgResponseTime}ms
                    </td>
                    <td className="border-b border-white/[0.04] px-3 py-[9px] text-right font-mono text-[11px] tabular-nums text-zinc-500">
                      {b.p95}ms
                    </td>
                    <td className="border-b border-white/[0.04] px-3 py-[9px] text-right">
                      <span
                        className={`font-mono text-[11px] font-medium tabular-nums ${
                          b.errorRate > 1 ? 'text-rose-300' : b.errorRate > 0.2 ? 'text-amber-500' : 'text-emerald-300/90'
                        }`}
                      >
                        {b.errorRate}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
        {hasCharts ? (
          <div className="grid flex-shrink-0 grid-cols-1 border-b border-white/[0.06] lg:grid-cols-2">
            <Chart
              title="Response time"
              subtitle="Average latency"
              data={responseTimeData}
              unit="ms"
              threshold={200}
              thresholdLabel="Healthy threshold"
              className="lg:border-r border-white/[0.06]"
            />
            <Chart title="Request volume" subtitle="Requests per minute" data={requestVolumeData} unit="req/m" />
          </div>
        ) : (
          <div className="flex-shrink-0 border-b border-white/[0.06] py-8">
            <EmptyState
              icon={Activity}
              title="Quiet so far"
              description="The moment your app starts talking to its backend, I'll show you what's happening here."
            />
          </div>
        )}

        <div className="flex h-10 flex-shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[13px] font-medium text-zinc-100">API request log</h2>
            <span className="font-mono text-[11px] tabular-nums text-zinc-500">
              {requestLog.length} request{requestLog.length === 1 ? '' : 's'}
            </span>
          </div>
          <span className="font-mono text-[10.5px] tabular-nums text-zinc-700">{timeRange}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {requestLog.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-8">
              <EmptyState
                icon={Globe}
                title="No traffic yet"
                description="Live API calls will stream in here as soon as your app is talking to its backend."
              />
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className={KIT.gridHead}>
                  {['Method', 'Endpoint', 'Status', 'Latency', 'When'].map((h) => (
                    <th
                      key={h}
                      className="border-b border-white/[0.06] px-3 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {requestLog.map((req) => {
                  const methodColor =
                    req.method === 'POST'
                      ? 'text-emerald-300/90'
                      : req.method === 'PUT' || req.method === 'PATCH'
                      ? 'text-violet-300/90'
                      : req.method === 'DELETE'
                      ? 'text-rose-300/90'
                      : 'text-zinc-400'
                  const statusColor =
                    req.status >= 500
                      ? 'text-rose-300'
                      : req.status >= 400
                      ? 'text-amber-500'
                      : req.status >= 300
                      ? 'text-sky-300/90'
                      : 'text-emerald-300/90'
                  return (
                    <tr key={req.id} className={`transition-colors ${KIT.rowHoverOn}`}>
                      <td className="w-20 border-b border-white/[0.04] px-3 py-[7px]">
                        <span className={`font-mono text-[11px] font-semibold tracking-wide ${methodColor}`}>
                          {req.method}
                        </span>
                      </td>
                      <td className="border-b border-white/[0.04] px-3 py-[7px] font-mono text-[12px] text-zinc-300">
                        {req.path}
                      </td>
                      <td className={`w-16 border-b border-white/[0.04] px-3 py-[7px] font-mono text-[11px] tabular-nums ${statusColor}`}>
                        {req.status}
                      </td>
                      <td className="w-20 border-b border-white/[0.04] px-3 py-[7px] font-mono text-[11px] tabular-nums text-zinc-500">
                        {req.latency}ms
                      </td>
                      <td className="w-36 border-b border-white/[0.04] px-3 py-[7px] font-mono text-[10.5px] tabular-nums text-zinc-600">
                        {new Date(req.timestamp).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Right rail — anomalies and system events stay visible beside the log */}
      <div className={`hidden w-[300px] flex-shrink-0 flex-col border-l border-white/[0.06] xl:flex ${KIT.rail}`}>
        <div className="flex h-10 flex-shrink-0 items-center justify-between border-b border-white/[0.06] px-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">Signals</span>
          {anomalies.length > 0 && (
            <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium text-amber-500">
              <span className="h-[5px] w-[5px] rounded-full bg-amber-400" />
              {anomalies.length}
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {anomalies.length > 0 && (
            <div className="border-b border-white/[0.06]">
              <p className="px-3 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                Active anomalies
              </p>
              <div className={`divide-y ${KIT.divide}`}>
                {anomalies.map((anomaly) => (
                  <div key={anomaly.id} className="px-3 py-2.5">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="truncate text-[12px] font-medium text-zinc-100">{anomaly.metric}</span>
                      <span className="flex-shrink-0 font-mono text-[10.5px] font-medium tabular-nums text-amber-500">
                        {anomaly.type === 'spike' ? '↑' : '↓'} {Math.abs(anomaly.deviation).toFixed(0)}%
                      </span>
                    </div>
                    <p className="mb-1.5 text-[11.5px] leading-5 text-zinc-500">{anomaly.explanation}</p>
                    <div className="flex items-center gap-3 font-mono text-[10px] tabular-nums text-zinc-600">
                      <span>
                        exp <span className="text-zinc-400">{anomaly.expectedValue}</span>
                      </span>
                      <span>
                        act <span className="text-zinc-300">{anomaly.value}</span>
                      </span>
                      <span>{new Date(anomaly.timestamp).toLocaleTimeString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="px-3 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
            System events
          </p>
          {systemEvents.length === 0 ? (
            <p className="px-3 pb-4 text-[11.5px] leading-relaxed text-zinc-600">
              Deploys, incidents, and significant changes land here as they happen.
            </p>
          ) : (
            <div className={`divide-y ${KIT.divide}`}>
              {systemEvents.map((event) => {
                const Icon = event.icon
                return (
                  <div key={event.id} className="flex items-start gap-2.5 px-3 py-2.5">
                    <Icon className="mt-0.5 h-3 w-3 flex-shrink-0 text-zinc-600" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[11.5px] font-medium text-zinc-300">{event.message}</p>
                      <p className="mt-0.5 font-mono text-[10px] tabular-nums text-zinc-600">
                        {new Date(event.timestamp).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                    <span className="flex-shrink-0 font-mono text-[10px] text-emerald-300/80">ok</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </>
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
  const color = '#a78bfa'
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

  return (
    <div className={`px-4 py-3 ${className}`}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[12px] font-semibold text-zinc-100">{title}</h3>
          <p className="mt-0.5 text-[11px] text-zinc-500">{subtitle}</p>
        </div>
        {threshold ? (
          <div className="flex-shrink-0 text-right">
            <p className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">{thresholdLabel}</p>
            <p className="mt-0.5 font-mono text-[11px] tabular-nums text-zinc-400">
              {threshold}
              {unit}
            </p>
          </div>
        ) : (
          !exceedsThreshold && (
            <p className="flex flex-shrink-0 items-center gap-1.5 font-mono text-[10px] text-emerald-300/70">
              <CheckCircle2 className="h-3 w-3" />
              stable
            </p>
          )
        )}
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
          <polygon points={areaPoints} fill={color} fillOpacity="0.07" />
          <polyline
            points={points}
            fill="none"
            stroke={exceedsThreshold ? '#f59e0b' : color}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="absolute bottom-0 left-0 top-0 -ml-1 flex flex-col justify-between font-mono text-[10px] text-zinc-600">
          <span>{maxValue.toFixed(0)}</span>
          <span>{minValue.toFixed(0)}</span>
        </div>
      </div>
    </div>
  )
}
