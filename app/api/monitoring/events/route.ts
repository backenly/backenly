export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const querySchema = z.object({
  projectId: z.string().uuid(),
  limit: z.string().optional().transform((val) => {
    if (!val || val === 'null' || val === 'undefined') return 10
    const num = parseInt(val, 10)
    return isNaN(num) ? 10 : Math.max(1, Math.min(50, num))
  }),
})

function eventTypeFromAudit(type: string, action: string): string {
  const normalized = `${type} ${action}`.toLowerCase()
  if (normalized.includes('deploy')) return 'deploy'
  if (normalized.includes('auth') || normalized.includes('user')) return 'auth'
  if (normalized.includes('storage') || normalized.includes('file')) return 'storage'
  if (normalized.includes('database') || normalized.includes('table') || normalized.includes('schema')) return 'database'
  if (normalized.includes('api') || normalized.includes('function')) return 'api'
  return type || 'activity'
}

function eventMessage(action: string, details?: string | null): string {
  if (!details) return action

  try {
    const parsed = JSON.parse(details)
    if (typeof parsed?.message === 'string') return parsed.message
    if (typeof parsed?.summary === 'string') return parsed.summary
    if (typeof parsed?.description === 'string') return parsed.description
  } catch {
    if (details.length <= 160) return details
  }

  return action
}

export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const parsed = querySchema.parse({
      projectId: searchParams.get('projectId') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
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
        { success: false, error: 'Invalid project access' },
        { status: 403 }
      )
    }

    const logs = await prisma.auditLog.findMany({
      where: { projectId: parsed.projectId },
      orderBy: { timestamp: 'desc' },
      take: parsed.limit,
      select: {
        id: true,
        action: true,
        type: true,
        timestamp: true,
        details: true,
      },
    })

    return NextResponse.json({
      success: true,
      events: logs.map((log) => ({
        id: log.id,
        type: eventTypeFromAudit(log.type, log.action),
        message: eventMessage(log.action, log.details),
        timestamp: log.timestamp.toISOString(),
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

    console.error('Error fetching monitoring events:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch monitoring events',
      },
      { status: 500 }
    )
  }
})
