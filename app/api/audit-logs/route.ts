export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth } from '@/lib/auth/middleware'

export async function GET(request: NextRequest) {
  try {
    // 🔒 Scope audit logs to the authenticated user. Previously this returned
    // EVERY user's audit trail to any logged-in caller — a textbook info
    // disclosure (other users' actions, emails, project IDs).
    const user = await requireAuth(request)

    const searchParams = request.nextUrl.searchParams
    const page = parseInt(searchParams.get('page') || '1')
    const limit = parseInt(searchParams.get('limit') || '50')
    const type = searchParams.get('type') || undefined
    const skip = (page - 1) * limit

    const where: any = { userId: user.userId }
    if (type) where.type = type
    
    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        include: {
          user: {
            select: {
              email: true,
              name: true,
            },
          },
        },
        orderBy: {
          timestamp: 'desc',
        },
      }),
      prisma.auditLog.count({ where }),
    ])
    
    return NextResponse.json({
      logs: logs.map(log => ({
        id: log.id,
        action: log.action,
        type: log.type,
        timestamp: log.timestamp,
        user: log.userEmail || log.user?.email,
        details: log.details,
        metadata: log.metadata,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('Get audit logs error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch audit logs' },
      { status: 500 }
    )
  }
}

