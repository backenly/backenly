import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withProjectAccess } from '@/lib/auth/route-protection'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

export const GET = withProjectAccess(async (request: NextRequest, { projectId }) => {
  try {
    const { searchParams } = new URL(request.url)
    const limit = Math.min(
      Number(searchParams.get('limit') || DEFAULT_LIMIT) || DEFAULT_LIMIT,
      MAX_LIMIT,
    )
    const cursor = searchParams.get('cursor')

    const where: Record<string, unknown> = { projectId }
    if (cursor) where.createdAt = { lt: new Date(cursor) }

    const receipts = await (prisma as any).changeReceipt.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        projectId: true,
        eventIds: true,
        title: true,
        summary: true,
        resourcesChanged: true,
        riskLevel: true,
        rollbackAvailable: true,
        rollbackId: true,
        createdAt: true,
        events: {
          orderBy: { createdAt: 'asc' },
          take: 20,
          select: {
            id: true,
            eventType: true,
            summary: true,
            reason: true,
            riskLevel: true,
            status: true,
            createdAt: true,
          },
        },
      },
    })

    const page = receipts.slice(0, limit)
    const nextCursor = receipts.length > limit
      ? page[page.length - 1]?.createdAt?.toISOString()
      : null

    return NextResponse.json({
      success: true,
      receipts: page,
      nextCursor,
    })
  } catch (error) {
    console.error('[Change Receipts API] Error:', error)
    return NextResponse.json({ error: 'Failed to load change receipts' }, { status: 500 })
  }
})
