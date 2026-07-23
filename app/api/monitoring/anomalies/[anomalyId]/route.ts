export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db'
import { acknowledgeAnomaly, resolveAnomaly } from '@/lib/services/anomalyDetection'

// PATCH /api/monitoring/anomalies/[id] - Update anomaly status
export const PATCH = withAuth(async (
  request: NextRequest,
  { params, user }
) => {
  try {
    const { anomalyId } = await params
    const anomaly = await prisma.anomaly.findFirst({
      where: {
        id: anomalyId,
        project: { userId: user.userId },
      },
      select: { id: true },
    })

    if (!anomaly) {
      return NextResponse.json(
        { success: false, error: 'Anomaly not found or access denied' },
        { status: 404 }
      )
    }

    const body = await request.json()
    const { action } = body

    if (action === 'acknowledge') {
      await acknowledgeAnomaly(anomalyId)
    } else if (action === 'resolve') {
      await resolveAnomaly(anomalyId)
    } else {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid action. Use "acknowledge" or "resolve"',
        },
        { status: 400 }
      )
    }

    return NextResponse.json({
      success: true,
      message: `Anomaly ${action}d successfully`,
    })
  } catch (error: any) {
    console.error('Error updating anomaly:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update anomaly',
        message: error.message,
      },
      { status: 500 }
    )
  }
})
