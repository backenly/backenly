export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getMetrics } from '@/lib/services/metrics'
import { withTenantIsolation, TenantIsolationError } from '@/lib/tenant/isolation'
import { z } from 'zod'

const querySchema = z.object({
  type: z.enum(['responseTime', 'requestVolume', 'errorRate', 'uptime']),
  timeRange: z.enum(['1h', '24h', '7d', '30d']).default('24h'),
  source: z.enum(['api', 'function', 'database']).optional(),
  sourceId: z.string().optional(),
})

// GET /api/monitoring/metrics - Get metrics data for charts
export async function GET(request: NextRequest) {
  try {
    return await withTenantIsolation(request, async (projectId) => {
      const searchParams = request.nextUrl.searchParams
      const parsed = querySchema.parse({
        type: searchParams.get('type'),
        timeRange: searchParams.get('timeRange') || '24h',
        source: searchParams.get('source') || undefined,
        sourceId: searchParams.get('sourceId') || undefined,
      })

      // projectId is now enforced by tenant isolation middleware
      const metrics = await getMetrics(
        parsed.type,
        parsed.timeRange,
        parsed.source,
        parsed.sourceId,
        projectId // Use validated projectId
      )

      return NextResponse.json({
        success: true,
        data: metrics,
      })
    })
  } catch (error: any) {
    if (error instanceof TenantIsolationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 403 }
      )
    }
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

    console.error('Error fetching metrics:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch metrics',
        message: error.message,
      },
      { status: 500 }
    )
  }
}

