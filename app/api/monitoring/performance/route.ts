export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getPerformanceBreakdown } from '@/lib/services/metrics'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const querySchema = z.object({
  timeRange: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
  source: z.enum(['api', 'function', 'database']).default('api'),
  projectId: z.string().uuid(),
})

/**
 * GET /api/monitoring/performance - Get performance breakdown
 * 🔒 Protected: Requires authentication
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const parsed = querySchema.parse({
      timeRange: searchParams.get('timeRange') ?? '24h',
      source: searchParams.get('source') ?? 'api',
      projectId: searchParams.get('projectId') ?? undefined,
    })

    const project = await prisma.project.findFirst({
      where: {
        id: parsed.projectId,
        userId: user.userId,
      },
      select: { id: true },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Invalid project access' },
        { status: 403 }
      )
    }

    const breakdown = await getPerformanceBreakdown(
      parsed.timeRange,
      parsed.source,
      parsed.projectId
    )

    // Format response to match UI expectations
    const formatted = breakdown.map((item) => {
      const result: any = {
        requests: item.requests,
        avgResponseTime: item.avgResponseTime,
        errorRate: item.errorRate,
        p95: item.p95,
        p99: item.p99,
      }

      // Add source-specific field
      if (parsed.source === 'api') {
        result.endpoint = item.id
      } else if (parsed.source === 'function') {
        result.function = item.id
      } else if (parsed.source === 'database') {
        result.database = item.id
      }

      return result
    })

    return NextResponse.json({
      success: true,
      data: formatted,
    })
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          success: false,
          error: 'Validation error',
          details: error.errors,
        },
        { status: 400 }
      )
    }

    console.error('Error fetching performance breakdown:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch performance breakdown',
        message: error.message,
      },
      { status: 500 }
    )
  }
});
