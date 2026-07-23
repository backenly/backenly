import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withProjectAccess } from '@/lib/auth/route-protection'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export const GET = withProjectAccess(async (request: NextRequest, { projectId }) => {
  try {
    const { searchParams } = new URL(request.url)
    const limit = Math.min(
      Number(searchParams.get('limit') || DEFAULT_LIMIT) || DEFAULT_LIMIT,
      MAX_LIMIT,
    )
    const eventType = searchParams.get('eventType')
    const status = searchParams.get('status')
    const cursor = searchParams.get('cursor')

    const where: Record<string, unknown> = { projectId }
    if (eventType) where.eventType = eventType
    if (status) where.status = status
    if (cursor) where.createdAt = { lt: new Date(cursor) }

    const events = await (prisma as any).backendEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      select: {
        id: true,
        projectId: true,
        eventType: true,
        actorType: true,
        actorId: true,
        summary: true,
        beforeState: true,
        afterState: true,
        reason: true,
        riskLevel: true,
        status: true,
        receiptId: true,
        createdAt: true,
      },
    })

    const page = events.slice(0, limit)
    const nextCursor = events.length > limit
      ? page[page.length - 1]?.createdAt?.toISOString()
      : null

    return NextResponse.json({
      success: true,
      events: page,
      nextCursor,
    })
  } catch (error) {
    console.error('[Backend Events API] Error:', error)
    return NextResponse.json({ error: 'Failed to load backend events' }, { status: 500 })
  }
})
