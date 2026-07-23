'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity, TrendingUp, Server, Globe,
  CheckCircle2, XCircle, AlertTriangle, RefreshCw,
  BarChart3, ChevronRight, Shield, Rocket, Info,
  Upload, Database, Code,
} from 'lucide-react'
import {
  getMetrics,
  getStats,
  getAnomalies,
  getActiveIncidents,
  getPerformanceBreakdown,
  type DataPoint,
  type MetricStats,
  type Anomaly,
  type Incident,
  type PerformanceBreakdown,
} from '@/lib/api/monitoring'
import { getProjects } from '@/lib/api/projects'
import {
  KitCard, KitCardHeader, KitCardBody,
  KitTabs, KitTab,
  KitButton, KitBadge,
  EmptyState,
  SectionLabel,
} from '@/components/inspector/kit'
import { InspectorGovernanceFooter } from '@/components/inspector/InspectorPageHeader'

type TimeRange = '1h' | '24h' | '7d' | '30d'

function getIconForEventType(type: string) {
  const iconMap: Record<string, any> = {
    deploy: Rocket, deployment: Rocket, scale: TrendingUp, scaling: TrendingUp,
    traffic: Globe, auth: Shield, storage: Upload, database: Database, api: Code,
  }
  return iconMap[type.toLowerCase()] || Activity
}

export default function MonitoringPage({ projectId: initialProjectId }: { projectId?: string } = {}) {
  const router = useRouter()
  const [timeRange, setTimeRange] = useState<TimeRange>('24h')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [activeView, setActiveView] = useState<'overview' | 'performance'>('overview')
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null)
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(initialProjectId ?? null)

  const [metrics, setMetrics] = useState<MetricStats | null>(null)
  const [responseTimeData, setResponseTimeData] = useState<DataPoint[]>([])
  const [requestVolumeData, setRequestVolumeData] = useState<DataPoint[]>([])
  const [anomalies, setAnomalies] = useState<Anomaly[]>([])
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [performanceBreakdowns, setPerformanceBreakdowns] = useState<PerformanceBreakdown[]>([])
  const [isBackendLive, setIsBackendLive] = useState<boolean | null>(null)
  const [systemEvents, setSystemEvents] = useState<any[]>([])
  const [requestLog, setRequestLog] = useState<Array<{ id: string; method: string; path: string; status: number; latency: number; timestamp: string }>>([])

  useEffect(() => {
    const fetchProject = async () => {
      try {
        if (initialProjectId) {
          setCurrentProjectId(initialProjectId)
          try {
            const stateRes = await fetch(`/api/projects/${initialProjectId}/state`, { credentials: 'include' })
            if (stateRes.ok) {
              const state = await stateRes.json()
              const hasContent = (state.hasContent ?? false) ||
                (state.capabilities ?? []).some((c: { name: string }) => c.name === 'Authentication')
              setIsBackendLive(!!(state.isLive && hasContent))
            } else {
              setIsBackendLive(false)
            }
          } catch {
            setIsBackendLive(false)
          }
          return
        }

        const projects = await getProjects()
        if (projects.length > 0) {
          const project = projects[0]
          setCurrentProjectId(project.id)
          try {
            const stateRes = await fetch(`/api/projects/${project.id}/state`, { credentials: 'include' })
            if (stateRes.ok) {
              const state = await stateRes.json()
              const hasContent = (state.hasContent ?? false) ||
                (state.capabilities ?? []).some((c: { name: string }) => c.name === 'Authentication')
              setIsBackendLive(!!(state.isLive && hasContent))
            } else {
              setIsBackendLive(false)
            }
          } catch {
            setIsBackendLive(false)
          }
        }
      } catch (error) {
        console.error('Error fetching project:', error)
      }
    }
    fetchProject()
  }, [initialProjectId])

  const fetchData = useCallback(async () => {
    try {
      if (!currentProjectId) {
        setLoading(false)
        setRefreshing(false)
        return
      }

      setRefreshing(true)
      const [statsData, anomaliesData, incidentsData, eventsData, requestLogsData] = await Promise.all([
        getStats(timeRange, currentProjectId).catch(() => null),
        getAnomalies(10, currentProjectId).catch(() => []),
        getActiveIncidents(currentProjectId).catch(() => []),
        fetch(`/api/monitoring/events?projectId=${currentProjectId || ''}&limit=5`)
          .then(res => res.ok ? res.json() : { events: [] })
          .then(data => data.events || [])
          .catch(() => []),
        fetch(`/api/monitoring/request-logs?projectId=${currentProjectId || ''}&limit=10`)
          .then(res => res.ok ? res.json() : { requestLogs: [] })
          .then(data => data.requestLogs || [])
          .catch(() => []),
      ])

      const [responseTime, requestVolume, apiPerformance] = await Promise.all([
        getMetrics('responseTime', timeRange, undefined, undefined, currentProjectId).catch(() => []),
        getMetrics('requestVolume', timeRange, undefined, undefined, currentProjectId).catch(() => []),
        getPerformanceBreakdown(timeRange, 'api', currentProjectId).catch(() => []),
      ])

      if (statsData) {
        setMetrics(statsData)
      } else {
        setMetrics({
          responseTime: { value: 0, change: 0, status: 'healthy' },
          requests: { value: 0, change: 0, status: 'healthy' },
          errors: { value: 0, change: 0, status: 'healthy' },
          uptime: { value: 0, change: 0, status: 'healthy' },
        })
      }

      setResponseTimeData(responseTime.length > 0 ? responseTime : [])
      setRequestVolumeData(requestVolume.length > 0 ? requestVolume : [])
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
  }, [timeRange, currentProjectId])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30000)
    return () => clearInterval(interval)
  }, [fetchData])

  // Backend-not-live empty state — calm, no glow
  if (isBackendLive === false && !loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center px-8">
        <EmptyState
          icon={BarChart3}
          title="Nothing to watch yet"
          description="Once your app goes live, I'll start tracking traffic, errors, and slow queries here."
          action={
            <KitButton
              variant="primary"
              icon={Rocket}
              onClick={() => {
                const projectId = localStorage.getItem('current-project-id')
                if (projectId) router.push(`/app/projects/${projectId}/deploy`)
                else router.push('/app')
              }}
            >
              Publish now
            </KitButton>
          }
        />
      </div>
    )
  }

  const stabilityValue = metrics && metrics.requests.value > 0
    ? `${(100 - (metrics.errors.value / metrics.requests.value) * 100).toFixed(1)}%`
    : '100%'

  return (
    <div className="px-8 py-7">
      {/* Toast */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="fixed top-8 right-8 z-50"
          >
            <KitCard className="px-5 py-3 flex items-center gap-3">
              {toast.type === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
              {toast.type === 'error'   && <XCircle className="w-4 h-4 text-rose-400" />}
              {toast.type === 'info'    && <Info className="w-4 h-4 text-violet-300" />}
              <span className="text-[13px] text-zinc-200">{toast.message}</span>
            </KitCard>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toolbar — time range + refresh. The "Observability Runtime" hero text
          was a duplicate of the InspectorPageHeader; only the controls remain. */}
      <div className="mb-4 flex items-center justify-end gap-1">
        <div className="flex items-center gap-0.5 rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
          {(['1h', '24h', '7d', '30d'] as TimeRange[]).map(range => (
            <button
              key={range}
              onClick={() => setTimeRange(range)}
              className={`px-2.5 py-1 rounded-md font-mono text-[10.5px] font-medium tabular-nums transition-colors focus:outline-none ${
                timeRange === range
                  ? 'bg-white/[0.06] text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {range}
            </button>
          ))}
        </div>
        <button
          onClick={() => fetchData()}
          disabled={refreshing}
          className="ml-1 p-1.5 text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.04] rounded-md transition-colors"
          title="Refresh"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Top-line metrics — a single horizontal telemetry strip. Big numbers
          still legible, but no oversized colored icon chips for each one (that
          made it read like a marketing dashboard, not a runtime view). */}
      {metrics && (
        <div className="mb-4 grid grid-cols-2 lg:grid-cols-4 bg-[#16171d] border border-white/[0.07] rounded-xl overflow-hidden shadow-[0_16px_44px_-28px_rgba(0,0,0,0.9)]">
          {[
            { label: 'Latency',     value: `${metrics.responseTime.value}ms` },
            { label: 'Traffic',     value: metrics.requests.value.toLocaleString() },
            { label: 'Stability',   value: stabilityValue },
            { label: 'Reliability', value: `${metrics.uptime.value}%` },
          ].map((m, i) => (
            <div key={m.label} className={`px-4 py-3.5 ${i < 3 ? 'lg:border-r border-white/[0.06]' : ''} ${i % 2 === 0 ? 'border-r lg:border-r border-white/[0.06]' : ''} ${i < 2 ? 'border-b lg:border-b-0 border-white/[0.06]' : ''}`}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-600">{m.label}</p>
              <p className="font-mono text-[20px] font-medium text-white tabular-nums leading-none mt-2.5">{m.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Section tabs */}
      <div className="mb-5">
        <KitTabs>
          <KitTab active={activeView === 'overview'}    onClick={() => setActiveView('overview')}>Overview</KitTab>
          <KitTab active={activeView === 'performance'} onClick={() => setActiveView('performance')}>Performance</KitTab>
        </KitTabs>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <RefreshCw className="w-5 h-5 text-zinc-500 animate-spin" />
        </div>
      ) : activeView === 'overview' ? (
        <div className="space-y-6">
          {/* Anomalies */}
          {anomalies.length > 0 && (
            <KitCard>
              <KitCardHeader
                title="Active anomalies"
                description="Deviations from your baseline traffic patterns."
                actions={<KitBadge tone="attention">{anomalies.length} active</KitBadge>}
              />
              <div className="divide-y divide-white/[0.04] px-1 py-1">
                {anomalies.map((anomaly) => (
                  <div
                    key={anomaly.id}
                    className="px-3 py-3 rounded-md hover:bg-white/[0.02] transition-colors"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2.5 mb-1 flex-wrap">
                          <span className="text-[12.5px] font-medium text-zinc-100">{anomaly.metric}</span>
                          <span className="font-mono text-[10.5px] font-medium text-amber-500 tabular-nums">
                            {anomaly.type === 'spike' ? '↑' : '↓'} {Math.abs(anomaly.deviation).toFixed(0)}% {anomaly.type}
                          </span>
                        </div>
                        <p className="text-[12px] text-zinc-500 mb-1.5 leading-5">{anomaly.explanation}</p>
                        <div className="flex items-center gap-4 font-mono text-[10.5px] text-zinc-600 tabular-nums">
                          <span>expected <span className="text-zinc-400">{anomaly.expectedValue}</span></span>
                          <span>actual <span className="text-zinc-300">{anomaly.value}</span></span>
                          <span>{new Date(anomaly.timestamp).toLocaleTimeString()}</span>
                        </div>
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 text-zinc-700 flex-shrink-0 mt-1" />
                    </div>
                  </div>
                ))}
              </div>
            </KitCard>
          )}

          {/* Charts */}
          {(responseTimeData.length > 0 || requestVolumeData.length > 0) ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ChartCard
                title="Response time"
                subtitle="Average latency"
                data={responseTimeData}
                unit="ms"
                color="#a78bfa"
                threshold={200}
                thresholdLabel="Healthy threshold"
                contextLabel="Latency is within expected healthy range"
              />
              <ChartCard
                title="Request volume"
                subtitle="Requests per minute"
                data={requestVolumeData}
                unit="req/m"
                color="#a78bfa"
                contextLabel="Traffic patterns stable"
              />
            </div>
          ) : (
            <KitCard>
              <EmptyState
                icon={Activity}
                title="Quiet so far"
                description="The moment your app starts talking to its backend, I'll show you what's happening here."
              />
            </KitCard>
          )}

          {/* System events */}
          <div>
            <SectionLabel className="mb-3">Recent system events</SectionLabel>
            <KitCard>
              {systemEvents.length > 0 ? (
                <div className="divide-y divide-white/[0.04]">
                  {systemEvents.map((event) => {
                    const Icon = event.icon
                    return (
                      <div key={event.id} className="flex items-center gap-3 px-4 py-[11px]">
                        <Icon className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-[12.5px] font-medium text-zinc-200 truncate">{event.message}</p>
                          <p className="font-mono text-[10.5px] text-zinc-600 mt-0.5 tabular-nums">
                            {new Date(event.timestamp).toLocaleString('en-US', {
                              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                            })}
                          </p>
                        </div>
                        <KitBadge tone="operational">success</KitBadge>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <EmptyState
                  icon={Activity}
                  title="No events yet"
                  description="Deploys, incidents, and significant changes will land here as they happen."
                />
              )}
            </KitCard>
          </div>

          {/* API request log */}
          <div>
            <SectionLabel className="mb-3">API request log</SectionLabel>
            <KitCard>
              {requestLog.length > 0 ? (
                <table className="w-full">
                  <thead className="border-b border-white/[0.06]">
                    <tr>
                      <th className="px-4 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">Method</th>
                      <th className="px-4 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">Endpoint</th>
                      <th className="px-4 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">Status</th>
                      <th className="px-4 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">Latency</th>
                      <th className="px-4 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">When</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {requestLog.map((req) => {
                      const methodColor =
                        req.method === 'POST' ? 'text-emerald-300/90'
                        : req.method === 'PUT' || req.method === 'PATCH' ? 'text-violet-300/90'
                        : req.method === 'DELETE' ? 'text-rose-300/90'
                        : 'text-zinc-400'
                      const statusColor =
                        req.status >= 500 ? 'text-rose-300'
                        : req.status >= 400 ? 'text-amber-500'
                        : req.status >= 300 ? 'text-sky-300/90'
                        : 'text-emerald-300/90'
                      return (
                        <tr key={req.id} className="hover:bg-white/[0.02] transition-colors">
                          <td className="px-4 py-[9px]"><span className={`font-mono text-[11px] font-semibold tracking-wide ${methodColor}`}>{req.method}</span></td>
                          <td className="px-4 py-[9px] text-[12px] font-mono text-zinc-300">{req.path}</td>
                          <td className={`px-4 py-[9px] font-mono text-[11px] tabular-nums ${statusColor}`}>{req.status}</td>
                          <td className="px-4 py-[9px] font-mono text-[11px] text-zinc-500 tabular-nums">{req.latency}ms</td>
                          <td className="px-4 py-[9px] font-mono text-[10.5px] text-zinc-600 tabular-nums">
                            {new Date(req.timestamp).toLocaleString('en-US', {
                              month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                            })}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              ) : (
                <EmptyState
                  icon={Globe}
                  title="No traffic yet"
                  description="Live API calls will stream in here as soon as your app is talking to its backend."
                />
              )}
            </KitCard>
          </div>
        </div>
      ) : (
        <KitCard>
          <KitCardHeader title="API performance" description="Per-endpoint latency, traffic, and error rates." />
          {performanceBreakdowns.length === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="Nothing to measure yet"
              description="When your app starts handling real requests, I'll break down speed and reliability per endpoint."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-white/[0.06]">
                  <tr>
                    <th className="px-4 py-2 text-left text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">API route</th>
                    <th className="px-4 py-2 text-right text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">Traffic</th>
                    <th className="px-4 py-2 text-right text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">Speed</th>
                    <th className="px-4 py-2 text-right text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">Slowest</th>
                    <th className="px-4 py-2 text-right text-[9.5px] font-semibold uppercase tracking-[0.1em] text-zinc-600">Health</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {performanceBreakdowns.map((b, idx) => (
                    <tr key={idx} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-[9px]">
                        <span className="text-[12px] font-mono text-zinc-300">{b.endpoint || b.function || b.database}</span>
                      </td>
                      <td className="px-4 py-[9px] text-right text-[11px] font-mono text-zinc-500 tabular-nums">{b.requests.toLocaleString()}</td>
                      <td className="px-4 py-[9px] text-right text-[11px] font-mono text-zinc-500 tabular-nums">{b.avgResponseTime}ms</td>
                      <td className="px-4 py-[9px] text-right text-[11px] font-mono text-zinc-500 tabular-nums">{b.p95}ms</td>
                      <td className="px-4 py-[9px] text-right">
                        <span className={`text-[11px] font-mono font-medium tabular-nums ${b.errorRate > 1 ? 'text-rose-300' : b.errorRate > 0.2 ? 'text-amber-500' : 'text-emerald-300/90'}`}>
                          {b.errorRate}%
                        </span>
                      </td>
                      <td className="px-4 py-[9px] text-right">
                        <ChevronRight className="w-3.5 h-3.5 text-zinc-700 inline" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </KitCard>
      )}

      <InspectorGovernanceFooter />
    </div>
  )
}

// ─── Chart card — calm, no glow, single accent line ──────────────────────────
function ChartCard({
  title, subtitle, data, unit, color, threshold, thresholdLabel, contextLabel,
}: {
  title: string
  subtitle: string
  data: DataPoint[]
  unit: string
  color: string
  threshold?: number
  thresholdLabel?: string
  contextLabel?: string
}) {
  const maxValue = Math.max(...data.map(d => d.value), threshold || 0, 1)
  const minValue = Math.min(...data.map(d => d.value), 0)
  const range = maxValue - minValue || 1
  const points = data.map((p, idx) => {
    const x = (idx / (data.length - 1 || 1)) * 100
    const y = 100 - ((p.value - minValue) / range) * 100
    return `${x},${y}`
  }).join(' ')
  const areaPoints = `0,100 ${points} 100,100`
  const thresholdY = threshold ? 100 - ((threshold - minValue) / range) * 100 : null
  const exceedsThreshold = threshold && data.some(d => d.value > threshold)

  return (
    <KitCard className="p-5">
      <div className="mb-5 flex items-start justify-between">
        <div>
          <h3 className="text-[12.5px] font-semibold text-zinc-100">{title}</h3>
          <p className="text-[11.5px] text-zinc-500 mt-0.5">{subtitle}</p>
          {contextLabel && (
            <p className="font-mono text-[10.5px] text-emerald-300/80 mt-2 flex items-center gap-1.5">
              <CheckCircle2 className="w-3 h-3" />
              {contextLabel}
            </p>
          )}
        </div>
        {threshold && (
          <div className="text-right">
            <p className="text-[9.5px] text-zinc-600 uppercase tracking-[0.1em] font-semibold">{thresholdLabel}</p>
            <p className="font-mono text-[11px] text-zinc-400 mt-0.5 tabular-nums">{threshold}{unit}</p>
          </div>
        )}
      </div>
      <div className="relative" style={{ height: '220px' }}>
        <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0">
          {[0, 25, 50, 75, 100].map((y) => (
            <line key={y} x1="0" y1={y} x2="100" y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth="0.15" />
          ))}
          {thresholdY !== null && (
            <line
              x1="0" y1={thresholdY} x2="100" y2={thresholdY}
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
        <div className="absolute left-0 top-0 bottom-0 flex flex-col justify-between text-[10.5px] text-zinc-600 -ml-2 font-mono">
          <span>{maxValue.toFixed(0)}</span>
          <span>{minValue.toFixed(0)}</span>
        </div>
      </div>
    </KitCard>
  )
}
