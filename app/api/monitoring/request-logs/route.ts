export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { canAccessProject } from '@/lib/edition/guard'

const querySchema = z.object({
  projectId: z.string().uuid(),
  limit: z.string().optional().transform((val) => {
    if (!val || val === 'null' || val === 'undefined') return 10
    const num = parseInt(val, 10)
    return isNaN(num) ? 10 : Math.max(1, Math.min(100, num))
  }),
})

export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const parsed = querySchema.parse({
      projectId: searchParams.get('projectId') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
    })

    if (!(await canAccessProject(user.userId, parsed.projectId))) {
      return NextResponse.json(
        { success: false, error: 'Invalid project access' },
        { status: 403 }
      )
    }

    // Exclude internal platform rows (the AI rate-limiter records `/api/ai/*`
    // requests into the same table). Monitoring shows the end-user's runtime
    // traffic only — runtime resource paths never start with `/api/`.
    const logs = await prisma.apiRequestLog.findMany({
      where: {
        projectId: parsed.projectId,
        NOT: { path: { startsWith: '/api/' } },
      },
      orderBy: { timestamp: 'desc' },
      take: parsed.limit,
      select: {
        id: true,
        method: true,
        path: true,
        statusCode: true,
        duration: true,
        timestamp: true,
      },
    })

    return NextResponse.json({
      success: true,
      requestLogs: logs.map((log) => ({
        id: log.id,
        method: log.method,
        path: log.path,
        status: log.statusCode,
        latency: log.duration,
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

    console.error('Error fetching monitoring request logs:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch monitoring request logs',
      },
      { status: 500 }
    )
  }
})
