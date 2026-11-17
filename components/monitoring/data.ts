/**
 * What the Monitoring page reads, and the small rules for saying it.
 *
 * Every number comes from a route that already exists:
 *   /api/monitoring/stats         the totals for the range (requests, 5xx, average response)
 *   /api/monitoring/metrics       requests and average response per bucket
 *   /api/monitoring/performance   per-endpoint requests, average, p95, error rate
 *   /api/monitoring/request-logs  the last 100 requests
 *   /api/logs                     the log explorer, and the 5xx rows the server-errors chart counts
 *   /api/projects/[id]/rollback           published versions: the zinc chart markers
 *   /api/projects/[id]/autonomy/events    Backenly's own fixes: the violet chart markers
 *   /api/projects/[id]/state              published or not
 *
 * The server-errors chart counts 5xx responses per bucket itself. A client's
 * expired-token 401s and missing-row 404s are not server errors (round-1
 * Monitoring defect: "Success rate counts 4xx"). The 5xx rows are few by
 * nature, so they are read from /api/logs and bucketed here; when there are
 * more than MAX_5XX_ROWS of them the chart says it shows the latest ones.
 *
 * The markers do not come from /api/monitoring/events. That route returns the
 * newest audit rows of any kind, and the self-healing loop writes one every
 * minute (AUTONOMY_TICK), so in production its newest 50 rows reach back about
 * 50 minutes and carry no action to tell a fix from a held finding. Publishes
 * and fixes have their own complete reads, listed above.
 */

import type { ChartMarker, TimePoint } from '@/components/console/TimeSeriesChart'
import { bucketOf } from '@/components/console/TimeSeriesChart'

export type Range = '1h' | '24h' | '7d' | '30d'
export const RANGES: readonly Range[] = ['1h', '24h', '7d', '30d']
export const DEFAULT_RANGE: Range = '24h'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const RANGE_MS: Record<Range, number> = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }
/** One point of the server's series (lib/services/metrics.ts BUCKET_SECONDS). */
export const BUCKET_MS: Record<Range, number> = { '1h': MIN, '24h': HOUR, '7d': DAY, '30d': DAY }
/** "the last 24 hours". */
export const RANGE_WORDS: Record<Range, string> = {
  '1h': 'the last hour',
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
  '30d': 'the last 30 days',
}
/** "per hour". */
export const BUCKET_WORD: Record<Range, string> = { '1h': 'minute', '24h': 'hour', '7d': 'day', '30d': 'day' }

/** A request slower than this is "slow" (the page's long-standing threshold). */
export const SLOW_MS = 1000
/** The request log route's ceiling (app/api/monitoring/request-logs: limit ≤ 100). */
export const REQUEST_LOG_LIMIT = 100
/** How many 5xx rows the server-errors chart reads at most. */
export const MAX_5XX_ROWS = 500
export const LOG_PAGE_SIZE = 50

export const isRange = (v: string | null | undefined): v is Range => !!v && (RANGES as readonly string[]).includes(v)

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface Movement {
  value: number
  /** Percent change against the previous window of the same length. */
  change: number
}

export interface Stats {
  requests: Movement
  responseTime: Movement
  /** 5xx, the same as serverErrors. Older servers counted every response of 400 and above. */
  errors: Movement
  /** 5xx only. Older servers did not send it. */
  serverErrors?: Movement
  /** 4xx only: refused keys, bad requests, rows not found. Not failures. Older servers did not send it. */
  clientErrors?: Movement
}

export interface Endpoint {
  /** "GET /db/movies/:id" (method and path, ids collapsed). */
  endpoint: string
  requests: number
  avgResponseTime: number
  /** Percent of responses with a 5xx status. */
  errorRate: number
  /** Percent of responses with a 4xx status. Not failures. */
  clientErrorRate: number
  p95: number
}

export interface RequestRow {
  id: string
  method: string
  path: string
  status: number
  latency: number
  timestamp: string
}

export interface LogRow {
  id: string
  type: string
  severity: string
  message: string
  service?: string | null
  endpoint?: string | null
  method?: string | null
  statusCode?: number | null
  duration?: number | null
  timestamp: string
}

export interface LogsPage {
  logs: LogRow[]
  pagination: { page: number; limit: number; total: number; totalPages: number }
  stats: { total: number; error: number; warning: number; info: number; debug: number }
}

export interface Overview {
  range: Range
  /** The window the numbers cover, epoch ms. */
  start: number
  end: number
  stats: Stats
  volume: TimePoint[]
  latency: TimePoint[]
  endpoints: Endpoint[]
}

export interface ServerErrorSeries {
  points: TimePoint[]
  /** Every 5xx in the window was read (false: only the latest MAX_5XX_ROWS). */
  complete: boolean
  counted: number
}

// ─── Reads ───────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 10_000

/** GET a JSON body, or throw with the server's own words. */
export async function getJson<T>(url: string, projectId: string): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'X-Project-Id': projectId }
    try {
      const token = localStorage.getItem('auth-token')
      if (token) headers.Authorization = `Bearer ${token}`
    } catch {
      // No storage (private mode): the session cookie still authenticates.
    }
    const res = await fetch(url, { credentials: 'include', headers, signal: ctrl.signal })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
      throw new Error(body.error || body.message || `Request failed with ${res.status}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

const qs = (o: Record<string, string | number | undefined | null>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  return q.toString()
}

const toPoints = (rows: Array<{ timestamp: number; value: number }> | undefined): TimePoint[] =>
  (rows ?? []).map((r) => ({ t: Number(r.timestamp), v: Number(r.value) })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))

/** The range's totals, series and endpoints, read together so they describe one moment. */
export async function loadOverview(projectId: string, range: Range): Promise<Overview> {
  const end = Date.now()
  const start = end - RANGE_MS[range]
  const [stats, volume, latency, endpoints] = await Promise.all([
    getJson<{ data: Stats }>(`/api/monitoring/stats?${qs({ timeRange: range, projectId })}`, projectId),
    getJson<{ data: Array<{ timestamp: number; value: number }> }>(`/api/monitoring/metrics?${qs({ type: 'requestVolume', timeRange: range, projectId })}`, projectId),
    getJson<{ data: Array<{ timestamp: number; value: number }> }>(`/api/monitoring/metrics?${qs({ type: 'responseTime', timeRange: range, projectId })}`, projectId),
    getJson<{ data: Array<Partial<Endpoint> & { id?: string }> }>(`/api/monitoring/performance?${qs({ timeRange: range, source: 'api', projectId })}`, projectId),
  ])
  if (!stats?.data?.requests) throw new Error('The stats answer had no totals')
  return {
    range,
    start,
    end,
    stats: stats.data,
    volume: toPoints(volume.data),
    latency: toPoints(latency.data),
    endpoints: (endpoints.data ?? [])
      .map((e) => ({
        endpoint: String(e.endpoint ?? e.id ?? ''),
        requests: Number(e.requests ?? 0),
        avgResponseTime: Number(e.avgResponseTime ?? 0),
        errorRate: Number(e.errorRate ?? 0),
        clientErrorRate: Number(e.clientErrorRate ?? 0),
        p95: Number(e.p95 ?? 0),
      }))
      .filter((e) => e.endpoint),
  }
}

/** The runtime requests answered 5xx in the window, counted per bucket. */
export async function loadServerErrors(projectId: string, range: Range, start: number, end: number): Promise<ServerErrorSeries> {
  const limit = 100
  const times: number[] = []
  let total = 0
  for (let page = 1; times.length < MAX_5XX_ROWS; page++) {
    const body = await getJson<LogsPage>(
      `/api/logs?${qs({ projectId, type: 'api', severity: 'error', startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString(), page, limit })}`,
      projectId,
    )
    total = body.pagination?.total ?? 0
    for (const r of body.logs ?? []) {
      // Runtime requests only (the request recorder also writes platform /api/* rows), and 5xx only.
      if (typeof r.statusCode !== 'number' || r.statusCode < 500) continue
      if ((r.endpoint ?? '').startsWith('/api/')) continue
      const t = Date.parse(r.timestamp)
      if (Number.isFinite(t)) times.push(t)
    }
    if (!body.logs?.length || page >= (body.pagination?.totalPages ?? 1)) break
  }
  return { points: countPerBucket(times, BUCKET_MS[range]), complete: total <= MAX_5XX_ROWS, counted: times.length }
}

export async function loadRequests(projectId: string): Promise<RequestRow[]> {
  const body = await getJson<{ requestLogs?: RequestRow[] }>(`/api/monitoring/request-logs?${qs({ projectId, limit: REQUEST_LOG_LIMIT })}`, projectId)
  return body.requestLogs ?? []
}

/** Published or not, and whether anything is built. */
export async function loadLiveState(projectId: string): Promise<{ published: boolean; built: boolean }> {
  const s = await getJson<{ isLive?: boolean; hasContent?: boolean; capabilities?: Array<{ name: string }> }>(
    `/api/projects/${projectId}/state`,
    projectId,
  )
  const built = !!s.hasContent || (s.capabilities ?? []).some((c) => c.name === 'Authentication')
  return { published: !!(s.isLive && built), built }
}

/**
 * Publishes (zinc) and Backenly's fixes (violet) since `since`. Each read may
 * fail on its own; a chart without markers is still a true chart.
 */
export async function loadMarkers(projectId: string, since: number): Promise<ChartMarker[]> {
  const [versions, fixes] = await Promise.all([
    getJson<{ versions?: Array<{ version: number; publishedAt: string }> }>(`/api/projects/${projectId}/rollback`, projectId).catch(() => null),
    getJson<{ events?: Array<{ at: string; what?: string; full?: string }> }>(
      `/api/projects/${projectId}/autonomy/events?${qs({ since: new Date(since).toISOString(), limit: 50 })}`,
      projectId,
    ).catch(() => null),
  ])
  const out: ChartMarker[] = []
  for (const v of versions?.versions ?? []) {
    const t = Date.parse(v.publishedAt)
    if (Number.isFinite(t) && t >= since) out.push({ t, tone: 'zinc', label: `Published v${v.version}` })
  }
  for (const e of fixes?.events ?? []) {
    const t = Date.parse(e.at)
    if (Number.isFinite(t) && t >= since) out.push({ t, tone: 'violet', label: plainWhat(e.what ?? 'Backenly made a fix') })
  }
  return out.sort((a, b) => a.t - b.t)
}

/** The fix sentence's machine quoting ("watchlist_items.movie_id") read as words. */
function plainWhat(s: string): string {
  return s.replace(/"([^"]+)"/g, '$1').replace(/\s+/g, ' ').trim()
}

export interface LogsQuery {
  type: string
  level: string
  q: string
  page: number
  range: Range
}

export async function loadLogs(projectId: string, query: LogsQuery): Promise<LogsPage & { start: number; end: number }> {
  const end = Date.now()
  const start = end - RANGE_MS[query.range]
  const body = await getJson<LogsPage>(
    `/api/logs?${qs({
      projectId,
      page: query.page,
      limit: LOG_PAGE_SIZE,
      type: query.type === 'all' ? undefined : query.type,
      severity: query.level === 'all' ? undefined : query.level,
      search: query.q || undefined,
      startDate: new Date(start).toISOString(),
      endDate: new Date(end).toISOString(),
    })}`,
    projectId,
  )
  return {
    logs: body.logs ?? [],
    pagination: body.pagination ?? { page: query.page, limit: LOG_PAGE_SIZE, total: 0, totalPages: 0 },
    stats: body.stats ?? { total: 0, error: 0, warning: 0, info: 0, debug: 0 },
    start,
    end,
  }
}

// ─── Saying it ───────────────────────────────────────────────────────────────

const nf = new Intl.NumberFormat('en-US')
/** "18,641". */
export const fmt = (n: number) => nf.format(Math.round(n))

/** Moments counted into the server's epoch-aligned buckets. */
export function countPerBucket(times: readonly number[], bucketMs: number): TimePoint[] {
  const m = new Map<number, number>()
  for (const t of times) {
    const b = bucketOf(t, bucketMs)
    m.set(b, (m.get(b) ?? 0) + 1)
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v }))
}

/**
 * "+4%", "−1%", or null when there is nothing to say (no traffic, no change).
 * Against a window with almost no traffic (a project's first days) the
 * percentage is noise ("+36397%"), so it reads "Up from almost none".
 */
export function deltaWords(change: number | undefined, hasTraffic: boolean): string | null {
  if (!hasTraffic || change === undefined || !Number.isFinite(change) || change === 0) return null
  if (change >= 1000) return 'Up from almost none'
  return `${change > 0 ? '+' : '−'}${fmt(Math.abs(change))}%`
}

/** A share of all requests: "0.06%", "<0.01%", "1.2%". */
export function share(part: number, whole: number): string | null {
  if (!whole || part <= 0) return null
  const pct = (part / whole) * 100
  if (pct < 0.01) return '<0.01%'
  if (pct < 1) return `${pct.toFixed(2).replace(/0$/, '')}%`
  if (pct < 10) return `${pct.toFixed(1).replace(/\.0$/, '')}%`
  return `${Math.round(pct)}%`
}

/** "/fn/recommend-movies" → "recommend-movies": a function's HTTP route opens the function. */
export function functionOf(path: string): string | null {
  const m = /^\/fn\/([^/?#]+)/.exec(path)
  return m ? decodeURIComponent(m[1]) : null
}

/** "GET /fn/recommend-movies" → the path part. */
export function pathOf(endpoint: string): string {
  const i = endpoint.indexOf(' ')
  return i === -1 ? endpoint : endpoint.slice(i + 1)
}

export type RequestFilter = 'all' | 'errors' | 'slow'
export const isRequestFilter = (v: string | null | undefined): v is RequestFilter => v === 'all' || v === 'errors' || v === 'slow'

export function filterRequests(rows: readonly RequestRow[], status: RequestFilter, path: string): RequestRow[] {
  const needle = path.trim().toLowerCase()
  return rows.filter(
    (r) =>
      (status === 'all' || (status === 'errors' ? r.status >= 400 : r.latency > SLOW_MS)) &&
      (!needle || r.path.toLowerCase().includes(needle)),
  )
}

/** The log sources /api/logs can filter by, in words. */
export const LOG_SOURCES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'all', label: 'All sources' },
  { value: 'api', label: 'API' },
  { value: 'auth', label: 'Auth' },
  { value: 'database', label: 'Database' },
  { value: 'function', label: 'Functions' },
  { value: 'system', label: 'System' },
]
export const LOG_LEVELS: ReadonlyArray<{ value: string; label: string; key?: 'error' | 'warning' | 'info' | 'debug' }> = [
  { value: 'all', label: 'All levels' },
  { value: 'error', label: 'Errors', key: 'error' },
  { value: 'warning', label: 'Warnings', key: 'warning' },
  { value: 'info', label: 'Info', key: 'info' },
  { value: 'debug', label: 'Debug', key: 'debug' },
]
export const isLogSource = (v: string | null | undefined) => LOG_SOURCES.some((s) => s.value === v)
export const isLogLevel = (v: string | null | undefined) => LOG_LEVELS.some((s) => s.value === v)

/** A log row's source in words. */
export function sourceLabel(type: string): string {
  return LOG_SOURCES.find((s) => s.value === type)?.label.replace(/^Functions$/, 'Function') ?? (type ? type[0].toUpperCase() + type.slice(1) : 'Log')
}
