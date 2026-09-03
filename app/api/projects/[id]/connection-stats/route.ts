import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth/jwt'
import { canAccessProject } from '@/lib/edition/guard'

/**
 * GET /api/projects/:projectId/connection-stats
 * Get connection statistics and usage analytics
 */
export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
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

    const projectId = params.id

    // Verify project ownership
    if (!(await canAccessProject(payload.userId, projectId))) {
      return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
    }

    // Get active connections with usage stats
    const activeConnections = await prisma.delegatedConnection.findMany({
      where: {
        projectId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        provider: true,
        usageCount: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    })

    // Get total connections ever created
    const totalConnections = await prisma.delegatedConnection.count({
      where: { projectId },
    })

    // Get revoked connections count
    const revokedCount = await prisma.delegatedConnection.count({
      where: {
        projectId,
        revokedAt: { not: null },
      },
    })

    // Get expired connections count
    const expiredCount = await prisma.delegatedConnection.count({
      where: {
        projectId,
        expiresAt: { lt: new Date() },
        revokedAt: null,
      },
    })

    // Get usage stats per provider
    const usageByProvider = await prisma.delegatedConnection.groupBy({
      by: ['provider'],
      where: {
        projectId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      _sum: {
        usageCount: true,
      },
      _count: true,
    })

    // Get recent activity (last 24 hours)
    const recentActivity = await prisma.delegationAuditLog.count({
      where: {
        connection: { projectId },
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
    })

    // Calculate total API calls via delegation
    const totalApiCalls = activeConnections.reduce(
      (sum, conn) => sum + conn.usageCount,
      0
    )

    return NextResponse.json({
      active: activeConnections.length,
      totalConnections,
      revokedCount,
      expiredCount,
      totalApiCalls,
      recentActivity,
      byProvider: usageByProvider.map(p => ({
        provider: p.provider,
        activeConnections: p._count,
        totalApiCalls: p._sum.usageCount || 0,
      })),
      connections: activeConnections.map(conn => ({
        id: conn.id,
        provider: conn.provider,
        usageCount: conn.usageCount,
        createdAt: conn.createdAt,
        lastUsedAt: conn.lastUsedAt,
        expiresAt: conn.expiresAt,
        timeRemaining: Math.max(
          0,
          Math.floor((conn.expiresAt.getTime() - Date.now()) / 1000)
        ),
      })),
    })
  } catch (error: any) {
    console.error('[Connection Stats API] Error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch connection statistics' },
      { status: 500 }
    )
  }
}
