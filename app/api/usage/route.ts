export const dynamic = 'force-dynamic'

/**
 * GET /api/usage
 *
 * Returns per-project usage for the authenticated user for the current (or specified) month.
 * Includes sandbox countdown info for sandbox projects.
 *
 * Query params:
 *   month     — optional YYYY-MM (defaults to current month)
 *   projectId — optional, filter to a single project
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'
import { getUserSubscription } from '@/lib/billing'
import { getSandboxStatus } from '@/lib/billing/sandbox'

export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const userId = user.userId
    const { searchParams } = new URL(request.url)
    const monthParam = searchParams.get('month')
    const projectIdFilter = searchParams.get('projectId')

    const month = monthParam ?? new Date().toISOString().slice(0, 7)

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: 'INVALID_MONTH', message: 'month must be in YYYY-MM format' },
        { status: 400 }
      )
    }

    const sub = await getUserSubscription(userId)

    const projectWhere: Record<string, unknown> = { userId }
    if (projectIdFilter) projectWhere.id = projectIdFilter

    const projects = await prisma.project.findMany({
      where: projectWhere,
      select: {
        id: true,
        name: true,
        expiresAt: true,
        isDeployed: true,
        environment: true,
        createdAt: true,
        projectUsage: { where: { month }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    })

    const projectData = projects.map((p) => {
      const usage = p.projectUsage[0]
      const sandboxStatus = getSandboxStatus({ expiresAt: p.expiresAt })

      return {
        projectId: p.id,
        projectName: p.name,
        environment: p.environment,
        isSandbox: sandboxStatus.isSandbox,
        isExpired: sandboxStatus.isExpired,
        expiresAt: p.expiresAt,
        daysRemaining: sandboxStatus.daysRemaining,
        countdownMessage: sandboxStatus.countdownMessage,
        apiUnitsUsed: Number(usage?.apiUnitsUsed ?? 0),
        dbStorageUsedMb: usage?.dbStorageUsedMb ?? 0,
        fileStorageUsedMb: usage?.fileStorageUsedMb ?? 0,
        realtimeEvents: Number(usage?.realtimeEvents ?? 0),
      }
    })

    const totals = {
      apiUnitsUsed: projectData.reduce((s, p) => s + p.apiUnitsUsed, 0),
      dbStorageUsedMb: projectData.reduce((s, p) => s + p.dbStorageUsedMb, 0),
      fileStorageUsedMb: projectData.reduce((s, p) => s + p.fileStorageUsedMb, 0),
      realtimeEvents: projectData.reduce((s, p) => s + p.realtimeEvents, 0),
    }

    const [yr, mo] = month.split('-').map(Number)
    const resetAt = new Date(Date.UTC(yr, mo, 1)).toISOString()

    return NextResponse.json({
      month,
      plan: sub?.plan.name ?? 'SANDBOX',
      isPayAsYouGo: sub?.plan.isPayAsYouGo ?? false,
      isSandboxPlan: sub?.plan.isSandboxPlan ?? true,
      projects: projectData,
      totals,
      resetAt,
    })
  } catch (error: any) {
    console.error('[Usage API] Error:', error)
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: error.message || 'Failed to fetch usage' },
      { status: 500 }
    )
  }
})
