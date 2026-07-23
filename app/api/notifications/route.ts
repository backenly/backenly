export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { authenticateRequest } from '@/lib/auth/middleware'

/**
 * GET /api/notifications
 * List platform notifications for the authenticated user.
 * Query params:
 *   unread=true  — only unread notifications
 *   limit=N      — max results (default 50, max 100)
 *   cursor=<id>  — pagination cursor (last seen id)
 */
export async function GET(request: NextRequest) {
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId) {
    return NextResponse.json({ error: auth.error ?? 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const unreadOnly = searchParams.get('unread') === 'true'
  const rawLimit = parseInt(searchParams.get('limit') ?? '50', 10)
  const limit = Math.min(Math.max(1, rawLimit), 100)
  const cursor = searchParams.get('cursor') ?? undefined

  const where = {
    userId: auth.userId,
    ...(unreadOnly ? { read: false } : {}),
  }

  const notifications = await prisma.platformNotification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      type: true,
      title: true,
      body: true,
      read: true,
      readAt: true,
      metadata: true,
      createdAt: true,
    },
  })

  const hasMore = notifications.length > limit
  const items = hasMore ? notifications.slice(0, limit) : notifications
  const nextCursor = hasMore ? items[items.length - 1].id : null

  const unreadCount = await prisma.platformNotification.count({
    where: { userId: auth.userId, read: false },
  })

  return NextResponse.json({ notifications: items, nextCursor, unreadCount })
}

/**
 * PATCH /api/notifications
 * Mark all notifications as read (bulk).
 * Body: { ids?: string[] }  — if omitted, marks ALL unread as read
 */
export async function PATCH(request: NextRequest) {
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId) {
    return NextResponse.json({ error: auth.error ?? 'Unauthorized' }, { status: 401 })
  }

  let ids: string[] | undefined
  try {
    const body = await request.json().catch(() => ({}))
    if (Array.isArray(body.ids)) ids = body.ids
  } catch {}

  const where = {
    userId: auth.userId,
    read: false,
    ...(ids ? { id: { in: ids } } : {}),
  }

  const result = await prisma.platformNotification.updateMany({
    where,
    data: { read: true, readAt: new Date() },
  })

  return NextResponse.json({ updated: result.count })
}

/**
 * DELETE /api/notifications
 * Delete notifications by ids.
 * Body: { ids: string[] }
 */
export async function DELETE(request: NextRequest) {
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId) {
    return NextResponse.json({ error: auth.error ?? 'Unauthorized' }, { status: 401 })
  }

  let ids: string[] = []
  try {
    const body = await request.json()
    if (Array.isArray(body.ids)) ids = body.ids
  } catch {}

  if (ids.length === 0) {
    return NextResponse.json({ error: 'ids array is required' }, { status: 400 })
  }

  const result = await prisma.platformNotification.deleteMany({
    where: { id: { in: ids }, userId: auth.userId },
  })

  return NextResponse.json({ deleted: result.count })
}
