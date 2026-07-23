export const dynamic = 'force-dynamic'

/**
 * GET /api/cli/logs — request-log reads for @backenly/cli (`backenly logs`).
 *
 * Auth: x-api-key scoped key (same guard as /api/mcp/*). Read-only over
 * ApiRequestLog — the same single source of truth the Monitoring page reads.
 *
 * Query params:
 *   limit=1..200      (default 50)
 *   status=4xx|5xx|<code>  filter by status class or exact code
 *   path=<substring>  filter by request path substring
 *   since=<ISO date>  only entries after this timestamp (powers --follow)
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { mcpGuard, recordMcpCall } from '@/lib/mcp/guard'

const ENDPOINT = '/api/cli/logs'

export async function GET(request: NextRequest) {
  const startedAt = Date.now()
  const guard = await mcpGuard(request)
  if (guard.response) return guard.response
  const auth = guard.auth!

  const params = request.nextUrl.searchParams
  const limit = Math.min(Math.max(parseInt(params.get('limit') ?? '50', 10) || 50, 1), 200)
  const status = params.get('status')
  const pathFilter = params.get('path')
  const since = params.get('since')

  const where: any = { projectId: auth.projectId }
  if (status === '4xx') where.statusCode = { gte: 400, lt: 500 }
  else if (status === '5xx') where.statusCode = { gte: 500 }
  else if (status && /^\d{3}$/.test(status)) where.statusCode = parseInt(status, 10)
  if (pathFilter) where.path = { contains: pathFilter }
  if (since) {
    const sinceDate = new Date(since)
    if (!isNaN(sinceDate.getTime())) where.timestamp = { gt: sinceDate }
  }

  try {
    const rows = await prisma.apiRequestLog.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
      select: { method: true, path: true, statusCode: true, duration: true, timestamp: true },
    })

    recordMcpCall(
      { keyId: auth.keyId, projectId: auth.projectId, userId: auth.userId, endpoint: ENDPOINT, startedAt },
      { statusCode: 200, mutation: false },
    )
    return NextResponse.json({
      ok: true,
      count: rows.length,
      logs: rows.map((r) => ({
        at: r.timestamp.toISOString(),
        method: r.method,
        path: r.path,
        status: r.statusCode,
        ms: r.duration,
      })),
    })
  } catch (error: any) {
    recordMcpCall(
      { keyId: auth.keyId, projectId: auth.projectId, userId: auth.userId, endpoint: ENDPOINT, startedAt },
      { statusCode: 500, mutation: false, error: error?.message },
    )
    return NextResponse.json(
      { ok: false, error: 'Failed to read request logs', code: 'INTERNAL_ERROR' },
      { status: 500 },
    )
  }
}
