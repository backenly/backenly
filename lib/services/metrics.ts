/**
 * Metrics Collection and Aggregation Service
 * ==========================================
 * SINGLE SOURCE OF TRUTH: `ApiRequestLog`.
 *
 * Every runtime request that reaches a project's backend is written to
 * `api_request_logs` by the serverless executor (lib/services/serverlessApiExecutor.ts).
 * That table — not the legacy `metrics` table — is the only place that captures
 * real, un-self-reported runtime traffic (method, path, statusCode, duration,
 * timestamp, projectId). All monitoring reads (stats strip, charts, per-endpoint
 * performance, anomaly baselines) are derived from it here.
 *
 * The legacy `metrics` table was never populated for API traffic and `uptime`
 * was never recorded at all, which is why the whole monitoring strip used to
 * read zero (Latency 0ms / Traffic 0 / Reliability 0%). `recordMetric` is kept
 * for backward compatibility but is no longer the read path.
 *
 * Internal platform noise (the AI rate-limiter records `/api/ai/*` rows into the
 * same table with duration 0) is excluded from every query via `RUNTIME_ONLY`,
 * because monitoring is about the *end-user's* backend runtime — not our own
 * internal AI calls. Runtime resource paths never start with `/api/`.
 */

import { prisma } from '@/lib/db/postgres'
import { Prisma } from '@prisma/client'

export type MetricType = 'responseTime' | 'requestVolume' | 'errorRate' | 'uptime'
export type MetricSource = 'api' | 'function' | 'database'

export interface MetricData {
  type: MetricType
  source: MetricSource
  sourceId?: string
  value: number
  metadata?: Record<string, any>
  projectId?: string
}

export interface AggregatedMetric {
  timestamp: number
  value: number
}

export interface MetricStats {
  avg: number
  min: number
  max: number
  p50: number
  p95: number
  p99: number
  count: number
}

/**
 * A single windowed aggregate over runtime traffic. Everything the monitoring
 * surface needs about a time window is computed here in one indexed SQL pass.
 */
export interface RuntimeWindowStats {
  count: number            // total runtime requests in window
  errorCount: number       // status >= 400 (client + server errors)
  serverErrorCount: number // status >= 500 (backend failures only)
  avgDuration: number      // mean latency, ms
  minDuration: number
  maxDuration: number
  p50: number
  p95: number
  p99: number
  errorRatePct: number     // errorCount / count * 100
  /** % of requests the backend served without a 5xx. 100 when there is no traffic. */
  reliabilityPct: number
  /** % of requests that fully succeeded (< 400). 100 when there is no traffic. */
  stabilityPct: number
}

// SQL fragment shared by every query: scope to one project's *runtime* traffic
// and drop the internal AI rate-limiter rows.
const RUNTIME_PATH_FILTER = Prisma.sql`AND "path" NOT LIKE '/api/%'`

// ─── Time-range helpers ───────────────────────────────────────────────────────

const RANGE_MS: Record<'1h' | '24h' | '7d' | '30d', number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

// Bucket width for time-series charts, per range.
const BUCKET_SECONDS: Record<'1h' | '24h' | '7d' | '30d', number> = {
  '1h': 60,            // 1-minute buckets
  '24h': 60 * 60,      // 1-hour buckets
  '7d': 24 * 60 * 60,  // 1-day buckets
  '30d': 24 * 60 * 60, // 1-day buckets
}

function rangeWindow(timeRange: '1h' | '24h' | '7d' | '30d'): { start: Date; end: Date } {
  const end = new Date()
  return { start: new Date(end.getTime() - RANGE_MS[timeRange]), end }
}

/** The window immediately preceding `timeRange`, used for change/baseline math. */
export function baselineWindow(timeRange: '1h' | '24h' | '7d' | '30d'): { start: Date; end: Date } {
  const now = Date.now()
  const span = RANGE_MS[timeRange]
  return { start: new Date(now - 2 * span), end: new Date(now - span) }
}

// ─── Core aggregate (the one true read) ───────────────────────────────────────

/**
 * Aggregate a project's runtime traffic between [start, end) in a single
 * indexed query (uses the `@@index([projectId, timestamp])` on ApiRequestLog).
 */
export async function getRuntimeWindowStats(
  projectId: string,
  start: Date,
  end: Date,
): Promise<RuntimeWindowStats> {
  const rows = await prisma.$queryRaw<Array<{
    count: number
    error_count: number
    server_error_count: number
    avg_duration: number
    min_duration: number
    max_duration: number
    p50: number
    p95: number
    p99: number
  }>>(Prisma.sql`
    SELECT
      COUNT(*)::int                                                                      AS count,
      COUNT(*) FILTER (WHERE "statusCode" >= 400)::int                                    AS error_count,
      COUNT(*) FILTER (WHERE "statusCode" >= 500)::int                                    AS server_error_count,
      COALESCE(AVG("duration"), 0)::float                                                 AS avg_duration,
      COALESCE(MIN("duration"), 0)::float                                                 AS min_duration,
      COALESCE(MAX("duration"), 0)::float                                                 AS max_duration,
      COALESCE(percentile_cont(0.5)  WITHIN GROUP (ORDER BY "duration"), 0)::float         AS p50,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY "duration"), 0)::float         AS p95,
      COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY "duration"), 0)::float         AS p99
    FROM "api_request_logs"
    WHERE "projectId" = ${projectId}
      AND "timestamp" >= ${start}
      AND "timestamp" <  ${end}
      ${RUNTIME_PATH_FILTER}
  `)

  const r = rows[0]
  const count = Number(r?.count ?? 0)
  const errorCount = Number(r?.error_count ?? 0)
  const serverErrorCount = Number(r?.server_error_count ?? 0)

  return {
    count,
    errorCount,
    serverErrorCount,
    avgDuration: Number(r?.avg_duration ?? 0),
    minDuration: Number(r?.min_duration ?? 0),
    maxDuration: Number(r?.max_duration ?? 0),
    p50: Number(r?.p50 ?? 0),
    p95: Number(r?.p95 ?? 0),
    p99: Number(r?.p99 ?? 0),
    errorRatePct: count > 0 ? (errorCount / count) * 100 : 0,
    // No traffic ⇒ nothing has failed. Report a calm 100% rather than a
    // misleading 0% (the old bug that made brand-new projects look broken).
    reliabilityPct: count > 0 ? ((count - serverErrorCount) / count) * 100 : 100,
    stabilityPct: count > 0 ? ((count - errorCount) / count) * 100 : 100,
  }
}

/**
 * Record a metric (legacy write path — kept for compatibility; not the read path).
 */
export async function recordMetric(data: MetricData): Promise<void> {
  if (!data.projectId) return
  await prisma.metric.create({
    data: {
      type: data.type,
      source: data.source,
      sourceId: data.sourceId,
      value: data.value,
      metadata: data.metadata || {},
      projectId: data.projectId,
    },
  })
}

// ─── MetricStats (per-type view over a window) ────────────────────────────────

/**
 * Project a RuntimeWindowStats aggregate onto the legacy per-type MetricStats
 * shape so existing callers (stats route, anomaly detection) keep working —
 * only now backed by real traffic.
 *
 *   responseTime → latency distribution (avg/min/max/p50/p95/p99), count = requests
 *   requestVolume → avg = total requests in window, count = total requests
 *   errorRate     → avg = error-rate %, count = number of error requests
 *   uptime        → avg = reliability %, count = total requests
 */
function projectStats(type: MetricType, w: RuntimeWindowStats): MetricStats {
  switch (type) {
    case 'responseTime':
      return {
        avg: w.avgDuration, min: w.minDuration, max: w.maxDuration,
        p50: w.p50, p95: w.p95, p99: w.p99, count: w.count,
      }
    case 'requestVolume':
      return {
        avg: w.count, min: w.count, max: w.count,
        p50: w.count, p95: w.count, p99: w.count, count: w.count,
      }
    case 'errorRate':
      return {
        avg: w.errorRatePct, min: 0, max: w.errorRatePct,
        p50: w.errorRatePct, p95: w.errorRatePct, p99: w.errorRatePct,
        count: w.errorCount,
      }
    case 'uptime':
      return {
        avg: w.reliabilityPct, min: w.reliabilityPct, max: w.reliabilityPct,
        p50: w.reliabilityPct, p95: w.reliabilityPct, p99: w.reliabilityPct,
        count: w.count,
      }
  }
}

/**
 * Aggregated statistics for a metric over the trailing `timeRange`.
 */
export async function getMetricStats(
  type: MetricType,
  timeRange: '1h' | '24h' | '7d' | '30d',
  _source?: MetricSource,
  _sourceId?: string,
  projectId?: string,
): Promise<MetricStats> {
  if (!projectId) {
    return { avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0, count: 0 }
  }
  const { start, end } = rangeWindow(timeRange)
  const w = await getRuntimeWindowStats(projectId, start, end)
  return projectStats(type, w)
}

/**
 * Aggregated statistics for an explicit [start, end) window — used for baselines.
 */
export async function getMetricStatsBetween(
  type: MetricType,
  start: Date,
  end: Date,
  projectId?: string,
): Promise<MetricStats> {
  if (!projectId) {
    return { avg: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0, count: 0 }
  }
  const w = await getRuntimeWindowStats(projectId, start, end)
  return projectStats(type, w)
}

// ─── Time series (chart data) ─────────────────────────────────────────────────

/**
 * Bucketed time series for charts, derived from runtime traffic.
 *   responseTime → avg latency per bucket
 *   requestVolume → request count per bucket
 *   errorRate     → error count per bucket
 *   uptime        → reliability % per bucket
 */
export async function getMetrics(
  type: MetricType,
  timeRange: '1h' | '24h' | '7d' | '30d',
  _source?: MetricSource,
  _sourceId?: string,
  projectId?: string,
): Promise<AggregatedMetric[]> {
  if (!projectId) return []

  const { start } = rangeWindow(timeRange)
  const bucketSec = BUCKET_SECONDS[timeRange]

  const rows = await prisma.$queryRaw<Array<{
    bucket: number
    count: number
    avg_duration: number
    error_count: number
    server_error_count: number
  }>>(Prisma.sql`
    SELECT
      (floor(extract(epoch FROM "timestamp") / ${bucketSec}) * ${bucketSec})::bigint       AS bucket,
      COUNT(*)::int                                                                         AS count,
      COALESCE(AVG("duration"), 0)::float                                                    AS avg_duration,
      COUNT(*) FILTER (WHERE "statusCode" >= 400)::int                                       AS error_count,
      COUNT(*) FILTER (WHERE "statusCode" >= 500)::int                                       AS server_error_count
    FROM "api_request_logs"
    WHERE "projectId" = ${projectId}
      AND "timestamp" >= ${start}
      ${RUNTIME_PATH_FILTER}
    GROUP BY bucket
    ORDER BY bucket ASC
  `)

  return rows.map((r) => {
    const count = Number(r.count)
    const serverErrors = Number(r.server_error_count)
    let value: number
    switch (type) {
      case 'responseTime':  value = Math.round(Number(r.avg_duration)); break
      case 'requestVolume': value = count; break
      case 'errorRate':     value = Number(r.error_count); break
      case 'uptime':        value = count > 0 ? Number((((count - serverErrors) / count) * 100).toFixed(1)) : 100; break
    }
    return { timestamp: Number(r.bucket) * 1000, value }
  })
}

// ─── Per-endpoint performance breakdown ───────────────────────────────────────

/**
 * Per-endpoint performance, grouped by `METHOD /normalized/path`. Path
 * parameters (numeric ids and UUIDs) are collapsed to `:id` so that
 * `/companies/1` and `/companies/2` roll up into one `/companies/:id` row with
 * correct percentiles computed server-side.
 */
export async function getPerformanceBreakdown(
  timeRange: '1h' | '24h' | '7d' | '30d',
  source: MetricSource,
  projectId?: string,
): Promise<Array<{
  id: string
  requests: number
  avgResponseTime: number
  errorRate: number
  p95: number
  p99: number
}>> {
  // Only API traffic is captured in the request log. Function/database
  // breakdowns aren't tracked here — return empty honestly rather than faking.
  if (!projectId || source !== 'api') return []

  const { start } = rangeWindow(timeRange)

  const rows = await prisma.$queryRaw<Array<{
    endpoint: string
    requests: number
    error_count: number
    avg_duration: number
    p95: number
    p99: number
  }>>(Prisma.sql`
    SELECT
      "method" || ' ' || regexp_replace(
        regexp_replace("path", '/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '/:id', 'g'),
        '/[0-9]+', '/:id', 'g'
      )                                                                              AS endpoint,
      COUNT(*)::int                                                                  AS requests,
      COUNT(*) FILTER (WHERE "statusCode" >= 400)::int                               AS error_count,
      COALESCE(AVG("duration"), 0)::float                                            AS avg_duration,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY "duration"), 0)::float    AS p95,
      COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY "duration"), 0)::float    AS p99
    FROM "api_request_logs"
    WHERE "projectId" = ${projectId}
      AND "timestamp" >= ${start}
      ${RUNTIME_PATH_FILTER}
    GROUP BY endpoint
    ORDER BY requests DESC
  `)

  return rows.map((r) => {
    const requests = Number(r.requests)
    const errorCount = Number(r.error_count)
    return {
      id: r.endpoint,
      requests,
      avgResponseTime: Math.round(Number(r.avg_duration)),
      errorRate: requests > 0 ? Number(((errorCount / requests) * 100).toFixed(2)) : 0,
      p95: Math.round(Number(r.p95)),
      p99: Math.round(Number(r.p99)),
    }
  })
}
