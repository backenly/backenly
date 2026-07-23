/**
 * TELEMETRY — the loop's sensory system (read-only)
 * =================================================
 *
 * "You cannot automate what you cannot measure." Every funded autonomous
 * platform builds the sensing layer before the acting layer (Datadog Watchdog,
 * AWS DevOps Guru, SRE automation). This module derives a live per-project
 * health signal and a 3-sigma anomaly view from real request telemetry, and
 * feeds it into the control loop's risk decision.
 *
 * Read-only with respect to project/user data. It may persist Anomaly rows
 * (monitoring memory, exactly like an audit log) when explicitly asked to —
 * never as a side effect of reading.
 */

import { prisma } from '@/lib/db/prisma'

export type HealthState = 'healthy' | 'degraded' | 'anomalous' | 'unknown'

export interface MetricReading {
  current: number
  baselineMean: number
  baselineStdDev: number
  /** (current − mean) / stddev. 0 when no baseline variance. */
  z: number
}

export interface HealthSignal {
  projectId: string
  evaluatedAt: string
  windowMinutes: number
  sampleSize: number
  state: HealthState
  errorRate: MetricReading
  p95LatencyMs: MetricReading
  requestVolume: MetricReading
  /** Human, non-technical reasons the state is not "healthy". */
  reasons: string[]
}

// Datadog-style: a metric is anomalous past 3 standard deviations. Error-rate
// also trips on an absolute floor so a clean→broken jump from a tiny baseline
// (z is meaningless when stddev≈0) is still caught.
const Z_THRESHOLD = 3
const ERROR_RATE_ABS_FLOOR = 0.1 // 10% of requests failing is anomalous, period.

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base]
}

function meanStdDev(xs: number[]): { mean: number; stdDev: number } {
  if (xs.length === 0) return { mean: 0, stdDev: 0 }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length
  return { mean, stdDev: Math.sqrt(variance) }
}

function reading(current: number, baseline: number[]): MetricReading {
  const { mean, stdDev } = meanStdDev(baseline)
  const z = stdDev > 1e-9 ? (current - mean) / stdDev : 0
  return { current, baselineMean: mean, baselineStdDev: stdDev, z }
}

/**
 * Compute the live health signal: the current short window vs a baseline of
 * equal-length buckets over the trailing 24h. Pure read of ApiRequestLog.
 */
export async function computeHealthSignal(
  projectId: string,
  windowMinutes = 60,
): Promise<HealthSignal> {
  const now = Date.now()
  const winMs = windowMinutes * 60 * 1000
  const baselineSpanMs = 24 * 60 * 60 * 1000

  const logs = await prisma.apiRequestLog
    .findMany({
      where: { projectId, timestamp: { gte: new Date(now - baselineSpanMs) } },
      select: { statusCode: true, duration: true, timestamp: true },
    })
    .catch(() => [])

  const evaluatedAt = new Date(now).toISOString()
  if (logs.length === 0) {
    const z0: MetricReading = { current: 0, baselineMean: 0, baselineStdDev: 0, z: 0 }
    return {
      projectId, evaluatedAt, windowMinutes, sampleSize: 0,
      state: 'unknown',
      errorRate: z0, p95LatencyMs: z0, requestVolume: z0,
      reasons: ['No request traffic yet — nothing to measure.'],
    }
  }

  // Bucket the baseline span into window-sized slices; the most recent slice is
  // "current", the rest form the baseline distribution.
  const buckets = Math.max(2, Math.floor(baselineSpanMs / winMs))
  const errBuckets: number[] = []
  const p95Buckets: number[] = []
  const volBuckets: number[] = []

  for (let i = 0; i < buckets; i++) {
    const end = now - i * winMs
    const start = end - winMs
    const slice = logs.filter(l => {
      const t = l.timestamp.getTime()
      return t >= start && t < end
    })
    if (slice.length === 0) {
      if (i !== 0) continue // skip empty historical buckets, keep current
    }
    const errors = slice.filter(l => l.statusCode >= 500).length
    const errRate = slice.length > 0 ? errors / slice.length : 0
    const p95 = quantile(slice.map(l => l.duration).sort((a, b) => a - b), 0.95)
    if (i === 0) {
      errBuckets.unshift(errRate); p95Buckets.unshift(p95); volBuckets.unshift(slice.length)
    } else {
      errBuckets.push(errRate); p95Buckets.push(p95); volBuckets.push(slice.length)
    }
  }

  const curErr = errBuckets.shift() ?? 0
  const curP95 = p95Buckets.shift() ?? 0
  const curVol = volBuckets.shift() ?? 0

  const errorRate = reading(curErr, errBuckets)
  const p95LatencyMs = reading(curP95, p95Buckets)
  const requestVolume = reading(curVol, volBuckets)

  const reasons: string[] = []
  let anomalous = false
  let degraded = false

  if (curErr >= ERROR_RATE_ABS_FLOOR || errorRate.z >= Z_THRESHOLD) {
    anomalous = true
    reasons.push(`Error rate is ${(curErr * 100).toFixed(1)}% — well above normal.`)
  } else if (curErr > 0.02) {
    degraded = true
    reasons.push(`Error rate is mildly elevated (${(curErr * 100).toFixed(1)}%).`)
  }
  if (p95LatencyMs.z >= Z_THRESHOLD && curP95 > 0) {
    anomalous = true
    reasons.push(`Response time spiked to ${Math.round(curP95)}ms (p95).`)
  } else if (p95LatencyMs.z >= 2 && curP95 > 0) {
    degraded = true
    reasons.push(`Response time is trending up (${Math.round(curP95)}ms p95).`)
  }

  const state: HealthState = anomalous ? 'anomalous' : degraded ? 'degraded' : 'healthy'
  if (state === 'healthy') reasons.push('All measured signals are within normal range.')

  return {
    projectId, evaluatedAt, windowMinutes,
    sampleSize: logs.length,
    state, errorRate, p95LatencyMs, requestVolume, reasons,
  }
}

/**
 * Persist anomalous readings to the Anomaly table (monitoring memory). Called
 * by the cron after computing the signal — never as a side effect of reading.
 * De-dupes against an unresolved Anomaly of the same metric in the window.
 */
export async function persistAnomalies(signal: HealthSignal): Promise<number> {
  if (signal.state !== 'anomalous') return 0
  const candidates: Array<{ metric: string; r: MetricReading }> = [
    { metric: 'error_rate', r: signal.errorRate },
    { metric: 'p95_latency_ms', r: signal.p95LatencyMs },
  ].filter(c => c.r.z >= Z_THRESHOLD || (c.metric === 'error_rate' && c.r.current >= ERROR_RATE_ABS_FLOOR))

  let written = 0
  for (const c of candidates) {
    try {
      const since = new Date(Date.now() - signal.windowMinutes * 60 * 1000)
      const dup = await prisma.anomaly.count({
        where: { projectId: signal.projectId, metric: c.metric, status: 'detected', timestamp: { gte: since } },
      })
      if (dup > 0) continue
      await prisma.anomaly.create({
        data: {
          projectId: signal.projectId,
          type: 'autonomy_telemetry',
          metric: c.metric,
          value: c.r.current,
          expectedValue: c.r.baselineMean,
          deviation: c.r.z,
          explanation: signal.reasons.join(' '),
          status: 'detected',
        },
      })
      written++
    } catch {
      /* monitoring write is best-effort — never block the loop */
    }
  }
  return written
}
