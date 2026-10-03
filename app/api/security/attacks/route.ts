export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db'
import { z } from 'zod'
import { canAccessProject } from '@/lib/edition/guard'

const querySchema = z.object({
  page: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 1)),
  limit: z.string().optional().transform((val) => (val ? parseInt(val, 10) : 50)),
  attackType: z.string().optional(),
  projectId: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
})

/**
 * GET /api/security/attacks - Get blocked attacks
 * 🔒 Protected: Requires authentication
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const params = querySchema.parse({
      page: searchParams.get('page') || undefined,
      limit: searchParams.get('limit') || undefined,
      attackType: searchParams.get('attackType') || undefined,
      projectId: searchParams.get('projectId') || undefined,
      startDate: searchParams.get('startDate') || undefined,
      endDate: searchParams.get('endDate') || undefined,
    })

    // If projectId provided, verify ownership
    if (params.projectId) {
      if (!(await canAccessProject(user.userId, params.projectId))) {
        return NextResponse.json(
          { error: 'Invalid project access' },
          { status: 403 }
        )
      }
    }

    const page = params.page || 1
    const limit = Math.min(params.limit || 50, 100)
    const skip = (page - 1) * limit

    const where: any = {}

    if (params.attackType) {
      where.attackType = params.attackType
    }

    if (params.projectId) {
      where.projectId = params.projectId
    }

    if (params.startDate || params.endDate) {
      where.blockedAt = {}
      if (params.startDate) {
        where.blockedAt.gte = new Date(params.startDate)
      }
      if (params.endDate) {
        where.blockedAt.lte = new Date(params.endDate)
      }
    }

    const [attacks, total] = await Promise.all([
      prisma.blockedAttack.findMany({
        where,
        orderBy: { blockedAt: 'desc' },
        skip,
        take: limit,
        include: {
          project: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      prisma.blockedAttack.count({ where }),
    ])

    // Get attack type stats
    const stats = await prisma.blockedAttack.groupBy({
      by: ['attackType'],
      where,
      _count: true,
    })

    const attackTypeCounts: Record<string, number> = {}
    stats.forEach((stat) => {
      attackTypeCounts[stat.attackType] = stat._count
    })

    return NextResponse.json({
      attacks,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      stats: {
        total,
        byType: attackTypeCounts,
      },
    })
  } catch (error: any) {
    console.error('Error fetching blocked attacks:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to fetch blocked attacks' },
      { status: 500 }
    )
  }
});

