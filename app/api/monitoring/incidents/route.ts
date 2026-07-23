export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getActiveIncidents, getIncidents, createIncident, CreateIncidentData } from '@/lib/services/incidents'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const querySchema = z.object({
  status: z.enum(['active', 'resolved', 'acknowledged']).optional(),
  severity: z.enum(['critical', 'warning', 'info']).optional(),
  projectId: z.string().uuid(),
  limit: z.string().optional().transform((val) => {
    if (!val) return 50
    const num = parseInt(val, 10)
    return isNaN(num) ? 50 : Math.max(1, Math.min(100, num))
  }),
})

const createIncidentSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  severity: z.enum(['critical', 'warning', 'info']),
  affectedServices: z.array(z.string()),
  projectId: z.string().uuid(),
  metadata: z.record(z.any()).optional(),
})

/**
 * GET /api/monitoring/incidents - Get incidents
 * 🔒 Protected: Requires authentication
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const parsed = querySchema.parse({
      status: searchParams.get('status') ?? undefined,
      severity: searchParams.get('severity') ?? undefined,
      projectId: searchParams.get('projectId') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
    })

    const project = await prisma.project.findFirst({
      where: {
        id: parsed.projectId,
        userId: user.userId,
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Invalid project access' },
        { status: 403 }
      )
    }

    const incidents = parsed.status === 'active'
      ? await getActiveIncidents(parsed.projectId)
      : await getIncidents(parsed.projectId, parsed.status, parsed.severity, parsed.limit || 50)

    return NextResponse.json({
      success: true,
      data: incidents.map((incident) => ({
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

    console.error('Error fetching incidents:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch incidents',
        message: error.message,
      },
      { status: 500 }
    )
  }
});

/**
 * POST /api/monitoring/incidents - Create incident
 * 🔒 Protected: Requires authentication
 */
export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    const body = await request.json()
    const validated = createIncidentSchema.parse(body)

    const project = await prisma.project.findFirst({
      where: {
        id: validated.projectId,
        userId: user.userId,
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Invalid project access' },
        { status: 403 }
      )
    }

    const incidentId = await createIncident(validated as CreateIncidentData)

    return NextResponse.json({
      success: true,
      data: { id: incidentId },
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

    console.error('Error creating incident:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to create incident',
        message: error.message,
      },
      { status: 500 }
    )
  }
});
