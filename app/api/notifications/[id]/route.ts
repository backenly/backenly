export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { authenticateRequest } from '@/lib/auth/middleware'

/**
 * PATCH /api/notifications/:id
 * Mark a single notification as read (or unread).
 * Body: { read: boolean }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId) {
    return NextResponse.json({ error: auth.error ?? 'Unauthorized' }, { status: 401 })
  }

  const { id } = params
  const body = await request.json().catch(() => ({}))
  const read: boolean = body.read !== false  // default true

  const existing = await prisma.platformNotification.findUnique({
    where: { id },
    select: { userId: true },
  })

  if (!existing) {
    return NextResponse.json({ error: 'Notification not found' }, { status: 404 })
  }
  if (existing.userId !== auth.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const updated = await prisma.platformNotification.update({
    where: { id },
    data: { read, readAt: read ? new Date() : null },
    select: { id: true, read: true, readAt: true },
  })

  return NextResponse.json(updated)
}

/**
 * DELETE /api/notifications/:id
 * Delete a single notification.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId) {
    return NextResponse.json({ error: auth.error ?? 'Unauthorized' }, { status: 401 })
  }

  const { id } = params

  const existing = await prisma.platformNotification.findUnique({
    where: { id },
    select: { userId: true },
  })

  if (!existing) {
    return NextResponse.json({ error: 'Notification not found' }, { status: 404 })
  }
  if (existing.userId !== auth.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  await prisma.platformNotification.delete({ where: { id } })

  return NextResponse.json({ deleted: true })
}
