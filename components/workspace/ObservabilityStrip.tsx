'use client'

/**
 * ObservabilityStrip — the honest Overview metrics row
 * (IA restructure §6.2).
 *
 * Four tiles, one story: the last 24 hours of real runtime traffic
 * (ApiRequestLog via /api/monitoring/stats). Storage and live realtime
 * connections were dropped from the strip — each already has a dedicated
 * panel on this same page showing the same number, and a metric shown twice
 * is a metric trusted half as much. Deliberately NO CPU / Memory / Disk
 * charts — we are multi-tenant on one box, so per-project machine metrics
 * would be fiction.
 *
 * The failures tile counts SERVER errors (5xx) so it can never contradict
 * the Reliability tile beside it (also 5xx-based). Client 4xx noise lives in
 * Monitoring where it can be explored, not on the headline strip.
 *
 * Flat kit: mono tabular numerals, hairlines, zinc by default, violet/amber/rose
 * only to signal a status worth noticing.
 */

import { useEffect, useState } from 'react'
import { Activity, Gauge, Timer, AlertTriangle } from 'lucide-react'

interface StatsResponse {
  responseTime: { value: number; status: string }
  uptime: { value: number; status: string; hasData: boolean }
  errors: { value: number; status: string }
  serverErrors?: { value: number; status: string }
  requests: { value: number; status: string }
}

interface ObservabilityStripProps {
  projectId: string
}

const STATUS_TEXT: Record<string, string> = {
  healthy: 'text-zinc-100',
  warning: 'text-amber-300',
  critical: 'text-rose-300',
}

export function ObservabilityStrip({ projectId }: ObservabilityStripProps) {
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    fetch(`/api/monitoring/stats?projectId=${projectId}&timeRange=24h`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j?.data) setStats(j.data) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [projectId])

  const hasTraffic = (stats?.requests.value ?? 0) > 0
  const failed = stats?.serverErrors ?? { value: 0, status: 'healthy' }

  const tiles: Array<{ key: string; icon: any; label: string; value: string; text: string; hint?: string }> = [
    {
      // The 24h window is stated once by the section heading above the strip,
      // so the tiles no longer each carry a "· 24h" suffix.
      key: 'requests', icon: Activity, label: 'Requests',
      value: fmtCount(stats?.requests.value ?? 0), text: 'text-zinc-100',
    },
    {
      key: 'reliability', icon: Gauge, label: 'Reliability',
      value: stats?.uptime.hasData ? `${stats.uptime.value}%` : '—',
      text: stats?.uptime.hasData ? STATUS_TEXT[stats.uptime.status] ?? 'text-zinc-100' : 'text-zinc-600',
      hint: stats?.uptime.hasData ? undefined : 'No traffic yet',
    },
    {
      key: 'latency', icon: Timer, label: 'Avg response',
      value: hasTraffic ? `${stats?.responseTime.value ?? 0}ms` : '—',
      text: hasTraffic ? STATUS_TEXT[stats?.responseTime.status ?? 'healthy'] ?? 'text-zinc-100' : 'text-zinc-600',
    },
    {
      key: 'failures', icon: AlertTriangle, label: 'Failed',
      value: fmtCount(failed.value),
      text: failed.value > 0 ? STATUS_TEXT[failed.status] ?? 'text-amber-300' : 'text-zinc-100',
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/[0.07] bg-white/[0.05] lg:grid-cols-4">
      {tiles.map((t) => {
        const Icon = t.icon
        return (
          <div key={t.key} className="bg-[#16171d] px-4 py-3.5">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-600">
              <Icon className="h-3 w-3" />
              {t.label}
            </div>
            <div className={`mt-1.5 font-mono text-[19px] font-medium tabular-nums leading-none ${loaded ? t.text : 'text-zinc-700'}`}>
              {loaded ? t.value : '·'}
            </div>
            {t.hint && <div className="mt-1 text-[10px] text-zinc-600">{t.hint}</div>}
          </div>
        )
      })}
    </div>
  )
}

function fmtCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
