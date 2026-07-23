export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db'

/**
 * GET /api/security/stats - Get security statistics
 * 🔒 Protected: Requires authentication
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const projectId = searchParams.get('projectId') || undefined

    // If projectId provided, verify ownership
    if (projectId) {
      const project = await prisma.project.findFirst({
        where: {
          id: projectId,
          userId: user.userId,
        },
      })
      
      if (!project) {
        return NextResponse.json(
          { error: 'Invalid project access' },
          { status: 403 }
        )
      }
    }

    const where = projectId ? { projectId } : {}

    // Get security issues stats
    const [totalIssues, unfixedIssues, issuesBySeverity] = await Promise.all([
      prisma.securityIssue.count({ where }),
      prisma.securityIssue.count({ where: { ...where, fixed: false } }),
      prisma.securityIssue.groupBy({
        by: ['severity'],
        where: { ...where, fixed: false },
        _count: true,
      }),
    ])

    const severityCounts = {
      high: 0,
      medium: 0,
      low: 0,
    }

    issuesBySeverity.forEach((stat) => {
      if (stat.severity in severityCounts) {
        severityCounts[stat.severity as keyof typeof severityCounts] = stat._count
      }
    })

    // Get blocked attacks stats
    const [totalAttacks, attacksLast24h, attacksByType] = await Promise.all([
      prisma.blockedAttack.count({ where }),
      prisma.blockedAttack.count({
        where: {
          ...where,
          blockedAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
      }),
      prisma.blockedAttack.groupBy({
        by: ['attackType'],
        where: {
          ...where,
          blockedAt: {
            gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
          },
        },
        _count: true,
      }),
    ])

    const attackTypeCounts: Record<string, number> = {}
    attacksByType.forEach((stat) => {
      attackTypeCounts[stat.attackType] = stat._count
    })

    // Get latest scan
    const latestScan = await prisma.securityScan.findFirst({
      where,
      orderBy: { startedAt: 'desc' },
      select: {
        score: true,
        issuesFound: true,
        completedAt: true,
      },
    })

    // Calculate security score
    let securityScore = latestScan?.score ?? 100
    if (unfixedIssues > 0) {
      // Deduct points for unfixed issues
      securityScore = Math.max(0, securityScore - (unfixedIssues * 2))
    }

    return NextResponse.json({
      securityScore: Math.min(100, securityScore),
      issues: {
        total: totalIssues,
        unfixed: unfixedIssues,
        bySeverity: severityCounts,
      },
      attacks: {
        total: totalAttacks,
        last24h: attacksLast24h,
        byType: attackTypeCounts,
      },
      latestScan: latestScan
        ? {
            score: latestScan.score,
            issuesFound: latestScan.issuesFound,
            completedAt: latestScan.completedAt,
          }
        : null,
    })
  } catch (error: any) {
    console.error('Error fetching security stats:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch security stats' },
      { status: 500 }
    )
  }
});

