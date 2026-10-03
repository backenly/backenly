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
 * One strip split by hairlines (kit StatStrip), tabular Geist numerals, zinc by
 * default, amber/rose only for a reading worth noticing.
 */

import { useEffect, useState } from 'react'
import { Stat, StatStrip } from '@/components/inspector/kit'

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

type Tone = 'neutral' | 'good' | 'warn' | 'bad'

// A healthy reading stays neutral: colour is for the reading that needs you.
const STATUS_TONE: Record<string, Tone> = {
  healthy: 'neutral',
  warning: 'warn',
  critical: 'bad',
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

  const tiles: Array<{ key: string; label: string; value: string; tone: Tone; hint?: string }> = [
    {
      // The 24h window is stated once by the heading above the strip, so the
      // readings do not each carry a "24h" suffix.
      key: 'requests', label: 'Requests',
      value: fmtCount(stats?.requests.value ?? 0), tone: 'neutral',
    },
    {
      key: 'reliability', label: 'Reliability',
      value: stats?.uptime.hasData ? `${stats.uptime.value}%` : '—',
      tone: stats?.uptime.hasData ? STATUS_TONE[stats.uptime.status] ?? 'neutral' : 'neutral',
      hint: stats?.uptime.hasData ? undefined : 'No traffic yet',
    },
    {
      key: 'latency', label: 'Average response',
      value: hasTraffic ? `${stats?.responseTime.value ?? 0} ms` : '—',
      tone: hasTraffic ? STATUS_TONE[stats?.responseTime.status ?? 'healthy'] ?? 'neutral' : 'neutral',
    },
    {
      key: 'failures', label: 'Server errors',
      value: fmtCount(failed.value),
      tone: failed.value > 0 ? STATUS_TONE[failed.status] ?? 'warn' : 'neutral',
    },
  ]

  return (
    <StatStrip>
      {tiles.map((t) => (
        <Stat
          key={t.key}
          label={t.label}
          value={t.value}
          hint={t.hint}
          tone={t.tone}
          loading={!loaded}
        />
      ))}
    </StatStrip>
  )
}

function fmtCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
