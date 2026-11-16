'use client'

/**
 * Overview's "Last 24 hours": the three numbers Monitoring leads with, under
 * Monitoring's own labels and definitions, read from the same route
 * (GET /api/monitoring/stats, ApiRequestLog).
 *
 *   Requests          Server errors          Average response
 *   18,641            11  0.06%              62 ms
 *
 * Full numbers ("18,641", never "19k"), so the Overview and Monitoring print
 * the same figure. Server errors are 5xx only, as Monitoring counts them, with
 * their share of requests; white only when the server says the rate
 * is worth a look. Reliability is gone: it restated the same 5xx count as a
 * percentage beside it. With no traffic the panel says so in one line.
 */

import { useCallback, useEffect, useState } from 'react'
import { Skeleton } from '@/components/inspector/kit'
import { Panel } from '@/components/autonomy/rows'
import { ErrorRow } from '@/components/console/states'

interface Reading {
  value: number
  status: string
}

interface StatsResponse {
  responseTime: Reading
  serverErrors?: Reading
  requests: Reading
}

// Monochrome: a reading that needs a look is white, not amber or red; the number says how bad.
const TONE: Record<string, string> = {
  warning: 'text-zinc-50',
  critical: 'text-zinc-50',
}

/** "0.06%", "<0.01%", "12%": the server-error share as Monitoring would say it. */
export function errorShare(errors: number, requests: number): string {
  if (requests <= 0 || errors <= 0) return '0%'
  const pct = (errors / requests) * 100
  if (pct < 0.01) return '<0.01%'
  if (pct < 10) return `${Number(pct.toFixed(2))}%`
  return `${Math.round(pct)}%`
}

export function ObservabilityStrip({ projectId, refreshSignal = 0 }: { projectId: string; refreshSignal?: number }) {
  const [stats, setStats] = useState<StatsResponse | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [retrying, setRetrying] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/monitoring/stats?projectId=${projectId}&timeRange=24h`, { credentials: 'include' })
      const body = res.ok ? await res.json() : null
      if (!body?.data?.requests) throw new Error('no stats')
      setStats(body.data)
      setState('ready')
    } catch {
      // A failed refresh keeps the numbers already shown.
      setState((s) => (s === 'ready' ? 'ready' : 'error'))
    } finally {
      setRetrying(false)
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load, refreshSignal])

  if (state === 'error') {
    return (
      <Panel>
        <ErrorRow
          things="traffic"
          onRetry={() => {
            setRetrying(true)
            void load()
          }}
          retrying={retrying}
        />
      </Panel>
    )
  }

  const requests = stats?.requests.value ?? 0
  if (state === 'ready' && requests === 0) {
    return (
      <Panel>
        <p className="px-[20px] py-[14px] text-[13px] leading-[20px] text-zinc-400">No requests in the last 24 hours.</p>
      </Panel>
    )
  }

  const errors = stats?.serverErrors ?? { value: 0, status: 'healthy' }
  const cells: Array<{ key: string; label: string; value: string; extra?: string; tone?: string }> = [
    { key: 'requests', label: 'Requests', value: requests.toLocaleString('en-US') },
    {
      key: 'errors',
      label: 'Server errors',
      value: errors.value.toLocaleString('en-US'),
      extra: errors.value > 0 ? errorShare(errors.value, requests) : undefined,
      tone: errors.value > 0 ? TONE[errors.status] : undefined,
    },
    {
      key: 'latency',
      label: 'Average response',
      value: `${(stats?.responseTime.value ?? 0).toLocaleString('en-US')} ms`,
      tone: TONE[stats?.responseTime.status ?? ''],
    },
  ]

  return (
    <Panel>
      <dl className="grid grid-cols-1 divide-y divide-white/[0.06] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {cells.map((c) => (
          <div key={c.key} className="flex min-w-0 items-baseline justify-between gap-[12px] px-[20px] py-[12px] sm:block sm:py-[14px]">
            <dt className="text-[12.5px] leading-[18px] text-faint">{c.label}</dt>
            <dd className="flex min-w-0 items-baseline gap-[8px] sm:mt-[4px]">
              {state === 'loading' ? (
                <Skeleton className="h-[22px] w-[72px]" />
              ) : (
                <>
                  <span className={`text-[20px] font-medium leading-[26px] tracking-[-0.02em] tabular-nums ${c.tone ?? 'text-white'}`}>{c.value}</span>
                  {c.extra && <span className="text-[12.5px] tabular-nums text-faint">{c.extra}</span>}
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  )
}
