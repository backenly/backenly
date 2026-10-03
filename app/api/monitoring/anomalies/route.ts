export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getRecentAnomalies, detectAnomalies, storeAnomaly } from '@/lib/services/anomalyDetection'
import { z } from 'zod'
import { canAccessProject, canWriteProject } from '@/lib/edition/guard'

const querySchema = z.object({
  limit: z.string().optional().transform((val) => {
    if (!val || val === 'null' || val === 'undefined') return 10
    const num = parseInt(val, 10)
    return isNaN(num) ? 10 : Math.max(1, Math.min(100, num))
  }),
  projectId: z.string().uuid(),
  status: z.enum(['detected', 'acknowledged', 'resolved']).optional(),
})

/**
 * GET /api/monitoring/anomalies - Get recent anomalies
 * 🔒 Protected: Requires authentication
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const parsed = querySchema.parse({
      limit: searchParams.get('limit') ?? undefined,
      projectId: searchParams.get('projectId') ?? undefined,
      status: searchParams.get('status') ?? undefined,
    })

    if (!(await canAccessProject(user.userId, parsed.projectId))) {
      return NextResponse.json(
        { error: 'Invalid project access' },
        { status: 403 }
      )
    }

    const anomalies = await getRecentAnomalies(parsed.limit, parsed.projectId, parsed.status)

    return NextResponse.json({
      success: true,
      data: anomalies.map((a) => ({
        id: a.id,
        type: a.type,
        metric: a.metric,
        timestamp: a.timestamp.toISOString(),
        value: a.value,
        expectedValue: a.expectedValue,
        deviation: a.deviation,
        explanation: a.explanation,
        status: a.status,
      })),
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

    console.error('Error fetching anomalies:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch anomalies',
        message: error.message,
      },
      { status: 500 }
    )
  }
});

// POST /api/monitoring/anomalies/detect - Trigger anomaly detection
export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    const body = await request.json()
    const { timeRange = '24h', projectId } = body
    const parsedProjectId = z.string().uuid().parse(projectId)

    if (!(await canWriteProject(user.userId, parsedProjectId))) {
      return NextResponse.json({ error: 'Invalid project access' }, { status: 403 })
    }

    // Detect anomalies for all metric types
    const [responseTimeAnomalies, requestVolumeAnomalies, errorRateAnomalies] = await Promise.all([
      detectAnomalies('responseTime', timeRange, parsedProjectId),
      detectAnomalies('requestVolume', timeRange, parsedProjectId),
      detectAnomalies('errorRate', timeRange, parsedProjectId),
    ])

    const allAnomalies = [
      ...responseTimeAnomalies,
      ...requestVolumeAnomalies,
      ...errorRateAnomalies,
    ]

    // Store detected anomalies
    const storedIds = await Promise.all(
      allAnomalies.map((anomaly) => storeAnomaly(anomaly))
    )

    return NextResponse.json({
      success: true,
      data: {
        detected: allAnomalies.length,
        anomalies: allAnomalies.map((a, idx) => ({
          id: storedIds[idx],
          ...a,
        })),
      },
    })
  } catch (error: any) {
    console.error('Error detecting anomalies:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to detect anomalies',
        message: error.message,
      },
      { status: 500 }
    )
  }
})
