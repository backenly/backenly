/**
 * The requests a project's runtime API served, for Monitoring and for agents.
 *
 * Rows come from lib/traffic/request-recorder.ts, which strips the project
 * prefix and the query string before anything is stored, so a path here never
 * carries a token. Platform routes (`/api/...`) are excluded, as the Monitoring
 * page excludes them: they are Backenly's traffic, not the project's.
 */

import { prisma } from '@/lib/db/prisma'

export const MAX_REQUEST_LOGS = 200

export interface RequestLogFilter {
  method?: string
  /** Only responses with at least this status, e.g. 400 for failures, 500 for server errors. */
  minStatus?: number
  /** Only paths starting with this, e.g. "/db/orders" or "/fn/". */
  pathPrefix?: string
  /** Only the last N minutes. */
  sinceMinutes?: number
  limit?: number
}

export interface RequestLogRow {
  id: string
  method: string
  path: string
  status: number
  latencyMs: number
  timestamp: string
}

export async function queryRequestLogs(projectId: string, filter: RequestLogFilter = {}): Promise<RequestLogRow[]> {
  const limit = Number.isFinite(filter.limit)
    ? Math.min(Math.max(Math.trunc(filter.limit as number), 1), MAX_REQUEST_LOGS)
    : 50
  const since = Number.isFinite(filter.sinceMinutes) && (filter.sinceMinutes as number) > 0
    ? new Date(Date.now() - (filter.sinceMinutes as number) * 60_000)
    : undefined

  const rows = await prisma.apiRequestLog.findMany({
    where: {
      projectId,
      NOT: { path: { startsWith: '/api/' } },
      ...(filter.method ? { method: filter.method.toUpperCase() } : {}),
      ...(Number.isFinite(filter.minStatus) ? { statusCode: { gte: filter.minStatus } } : {}),
      ...(filter.pathPrefix ? { path: { startsWith: filter.pathPrefix } } : {}),
      ...(since ? { timestamp: { gte: since } } : {}),
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
    select: { id: true, method: true, path: true, statusCode: true, duration: true, timestamp: true },
  })

  return rows.map((r) => ({
    id: r.id,
    method: r.method,
    path: r.path,
    status: r.statusCode,
    latencyMs: r.duration,
    timestamp: r.timestamp.toISOString(),
  }))
}
