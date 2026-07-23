export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db'
import { getIncident, updateIncident, acknowledgeIncident, resolveIncident } from '@/lib/services/incidents'
import { z } from 'zod'

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).optional(),
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  status: z.enum(['active', 'resolved', 'acknowledged']).optional(),
  affectedServices: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
})

// GET /api/monitoring/incidents/[id] - Get single incident
export const GET = withAuth(async (
  request: NextRequest,
  { params, user }
) => {
  try {
    const { incidentId } = await params
    const access = await prisma.incident.findFirst({
      where: {
        id: incidentId,
        project: { userId: user.userId },
      },
      select: { id: true },
    })

    if (!access) {
      return NextResponse.json(
        {
          success: false,
          error: 'Incident not found or access denied',
        },
        { status: 404 }
      )
    }

    const incident = await getIncident(incidentId)

    if (!incident) {
      return NextResponse.json(
        {
          success: false,
          error: 'Incident not found',
        },
        { status: 404 }
      )
    }

    return NextResponse.json({
      success: true,
      data: {
        id: incident.id,
        title: incident.title,
        description: incident.description,
        severity: incident.severity,
        status: incident.status,
        startedAt: incident.startedAt.toISOString(),
        resolvedAt: incident.resolvedAt?.toISOString(),
        acknowledgedAt: incident.acknowledgedAt?.toISOString(),
        affectedServices: incident.affectedServices,
        project: incident.project,
        acknowledgedBy: incident.acknowledgedByUser,
      },
    })
  } catch (error: any) {
    console.error('Error fetching incident:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch incident',
        message: error.message,
      },
      { status: 500 }
    )
  }
})

// PATCH /api/monitoring/incidents/[id] - Update incident
export const PATCH = withAuth(async (
  request: NextRequest,
  { params, user }
) => {
  try {
    const { incidentId } = await params
    const incident = await prisma.incident.findFirst({
      where: {
        id: incidentId,
        project: { userId: user.userId },
      },
      select: { id: true },
    })

    if (!incident) {
      return NextResponse.json(
        { success: false, error: 'Incident not found or access denied' },
        { status: 404 }
      )
    }

    const body = await request.json()
    const { action, ...updateData } = body

    // Handle special actions
    if (action === 'acknowledge') {
      await acknowledgeIncident(incidentId, user.userId)
    } else if (action === 'resolve') {
      await resolveIncident(incidentId)
    } else {
      // Regular update
      const validated = updateSchema.parse(updateData)
      await updateIncident(incidentId, validated)
    }

    return NextResponse.json({
      success: true,
      message: 'Incident updated successfully',
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

    console.error('Error updating incident:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update incident',
        message: error.message,
      },
      { status: 500 }
    )
  }
})
