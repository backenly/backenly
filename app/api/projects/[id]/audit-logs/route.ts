import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth/jwt'

/**
 * GET /api/projects/:projectId/audit-logs
 * Get delegation audit logs for a project (admin only)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  try {
    // Verify authentication
    const authHeader = request.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
    }

    const token = authHeader.substring(7)
    const payload = verifyToken(token)
    
    if (!payload || !payload.userId) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const { projectId } = params
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '50')
    const action = searchParams.get('action')

    // Verify project ownership
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        userId: payload.userId,
      },
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
    }

    // Get audit logs
    const logs = await prisma.delegationAuditLog.findMany({
      where: {
        connection: {
          projectId,
        },
        ...(action ? { action } : {}),
      },
      include: {
        connection: {
          select: {
            provider: true,
            projectId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })

    // Calculate stats
    const stats = await prisma.delegationAuditLog.groupBy({
      by: ['action'],
      where: {
        connection: {
          projectId,
        },
      },
      _count: true,
    })

    return NextResponse.json({
      logs,
      stats: stats.map(s => ({
        action: s.action,
        count: s._count,
      })),
      total: logs.length,
    })
  } catch (error: any) {
    console.error('[Audit Logs API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch audit logs' },
      { status: 500 }
    )
  }
}
