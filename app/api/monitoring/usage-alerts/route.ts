import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { checkUsage, shouldAutoScale } from '@/lib/scaling/usage-monitor'
import { prisma } from '@/lib/db'
import { canAccessProject } from '@/lib/edition/guard'

/**
 * GET /api/monitoring/usage-alerts
 * Returns usage alerts and auto-scaling recommendations
 * Phase 12: Soft usage limits monitoring
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('projectId')

    if (!projectId) {
      return NextResponse.json(
        { error: 'Project ID required' },
        { status: 400 }
      )
    }

    // Verify project access
    if (!(await canAccessProject(user.userId, projectId))) {
      return NextResponse.json(
        { error: 'Project not found or access denied' },
        { status: 404 }
      )
    }

    // Fetched for the usage figures below, by id alone: authorization was
    // answered above and re-adding a userId predicate here would quietly
    // restore owner-only access.
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found or access denied' },
        { status: 404 }
      )
    }

    // Get API key usage metrics
    const apiKeys = await prisma.apiKey.findMany({
      where: { projectId },
      select: {
        id: true,
        name: true,
        requestCount: true,
        rateLimit: true,
        lastUsed: true,
      },
    })

    const totalApiCalls = apiKeys.reduce((sum, key) => sum + key.requestCount, 0)

    // Get current usage metrics (simplified)
    const currentUsage = {
      apiCalls: totalApiCalls,
      storage: Number(project.storageUsed || 0),
      users: project.activeUsers || 0,
      bandwidth: 0, // TODO: Calculate from logs
    }

    // Define soft limits
    const limits = {
      apiCalls: {
        softLimit: 100000, // 100k calls/day
        hardLimit: 200000,
        unit: 'requests/day',
      },
      storage: {
        softLimit: 10 * 1024 * 1024 * 1024, // 10GB
        hardLimit: 20 * 1024 * 1024 * 1024, // 20GB
        unit: 'bytes',
      },
      users: {
        softLimit: 10000,
        hardLimit: 50000,
        unit: 'users',
      },
      bandwidth: {
        softLimit: 100 * 1024 * 1024 * 1024, // 100GB
        hardLimit: 200 * 1024 * 1024 * 1024, // 200GB
        unit: 'bytes',
      },
    }

    // Check usage and generate alerts
    const alerts = checkUsage(currentUsage, limits)

    // Check if auto-scaling is recommended
    const baseline = {
      apiCalls: 50000,
      storage: 5 * 1024 * 1024 * 1024,
      users: 5000,
      bandwidth: 50 * 1024 * 1024 * 1024,
    }

    const scalingRecommendation = shouldAutoScale(currentUsage, baseline)

    return NextResponse.json({
      success: true,
      usage: currentUsage,
      limits,
      alerts,
      scaling: scalingRecommendation,
      timestamp: new Date().toISOString(),
    })
  } catch (error: any) {
    console.error('Error fetching usage alerts:', error)
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch usage alerts',
        message: error.message,
      },
      { status: 500 }
    )
  }
})
