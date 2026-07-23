export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getRuntimeWindowStats, baselineWindow } from '@/lib/services/metrics'
import { prisma } from '@/lib/db/postgres'
import { z } from 'zod'

const querySchema = z.object({
  timeRange: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
  projectId: z.string().uuid(),
})

const RANGE_MS: Record<'1h' | '24h' | '7d' | '30d', number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

const pctChange = (current: number, baseline: number): number =>
  baseline > 0 ? Math.round(((current - baseline) / baseline) * 100) : 0

/**
 * GET /api/monitoring/stats — the top-line telemetry strip
 * (Latency / Traffic / Stability / Reliability), derived entirely from real
 * runtime traffic in ApiRequestLog. See lib/services/metrics.ts for why.
 * 🔒 Protected: Requires authentication
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const parsed = querySchema.parse({
      timeRange: searchParams.get('timeRange') || '24h',
      projectId: searchParams.get('projectId') || undefined,
    })

    const project = await prisma.project.findFirst({
      where: { id: parsed.projectId, userId: user.userId },
      select: { id: true },
    })

    if (!project) {
      return NextResponse.json({ error: 'Invalid project access' }, { status: 403 })
    }

    const now = Date.now()
    const current = { start: new Date(now - RANGE_MS[parsed.timeRange]), end: new Date(now) }
    const baseline = baselineWindow(parsed.timeRange)

    // Two indexed queries: the current window and the one before it.
    const [cur, base] = await Promise.all([
      getRuntimeWindowStats(parsed.projectId, current.start, current.end),
      getRuntimeWindowStats(parsed.projectId, baseline.start, baseline.end),
    ])

    const responseTimeStatus: 'healthy' | 'warning' | 'critical' =
      cur.avgDuration > 1000 ? 'critical' : cur.avgDuration > 500 ? 'warning' : 'healthy'
    const errorStatus: 'healthy' | 'warning' | 'critical' =
      cur.errorRatePct > 5 ? 'critical' : cur.errorRatePct > 1 ? 'warning' : 'healthy'
    const serverErrorRatePct = cur.count > 0 ? (cur.serverErrorCount / cur.count) * 100 : 0
    const serverErrorStatus: 'healthy' | 'warning' | 'critical' =
      serverErrorRatePct > 1 ? 'critical' : cur.serverErrorCount > 0 ? 'warning' : 'healthy'
    const reliabilityStatus: 'healthy' | 'warning' | 'critical' =
      cur.count === 0 ? 'healthy' : cur.reliabilityPct < 99 ? 'critical' : cur.reliabilityPct < 99.9 ? 'warning' : 'healthy'

    return NextResponse.json({
      success: true,
      data: {
        responseTime: {
          value: Math.round(cur.avgDuration),
          change: pctChange(cur.avgDuration, base.avgDuration),
          status: responseTimeStatus,
        },
        uptime: {
          value: Number(cur.reliabilityPct.toFixed(1)),
          change: Number((cur.reliabilityPct - base.reliabilityPct).toFixed(1)),
          status: reliabilityStatus,
          hasData: cur.count > 0,
        },
        errors: {
          value: cur.errorCount,
          change: pctChange(cur.errorCount, base.errorCount),
          status: errorStatus,
        },
        // 5xx only — the number that may sit next to "Reliability" (also
        // 5xx-based) without the two ever contradicting each other on screen.
        serverErrors: {
          value: cur.serverErrorCount,
          change: pctChange(cur.serverErrorCount, base.serverErrorCount),
          status: serverErrorStatus,
        },
        requests: {
          value: cur.count,
          change: pctChange(cur.count, base.count),
          status: 'healthy',
        },
      },
    })
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: 'Validation error', details: error.errors },
        { status: 400 }
      )
    }

    console.error('Error fetching stats:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch stats', message: error.message },
      { status: 500 }
    )
  }
})
