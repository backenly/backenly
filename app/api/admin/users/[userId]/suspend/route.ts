export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

/**
 * POST /api/admin/users/[userId]/suspend
 *
 * Suspend or unsuspend a platform user.
 * Suspended users receive 403 on every authenticated request.
 *
 * Body: { suspend: true | false, reason?: string }
 *
 * FOUNDER-ONLY.
 */
export async function POST(request: NextRequest, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  const authError = await requireFounder(request)
  if (authError) return authError

  const { userId } = params
  const body = await request.json().catch(() => ({}))
  const { suspend, reason } = body ?? {}

  if (typeof suspend !== 'boolean') {
    return NextResponse.json({ error: '"suspend" (boolean) is required' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, deletedAt: true, suspendedAt: true },
  })

  if (!user || user.deletedAt) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  if (suspend && user.suspendedAt) {
    return NextResponse.json({ message: 'User is already suspended', user: { id: user.id, email: user.email } })
  }
  if (!suspend && !user.suspendedAt) {
    return NextResponse.json({ message: 'User is not suspended', user: { id: user.id, email: user.email } })
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      suspendedAt: suspend ? new Date() : null,
      // Bump tokenVersion so all existing JWTs are immediately invalidated
      tokenVersion: { increment: 1 },
    },
    select: { id: true, email: true, suspendedAt: true, tokenVersion: true },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      action: suspend ? 'USER_SUSPENDED' : 'USER_UNSUSPENDED',
      type: 'admin',
      userId,
      userEmail: user.email,
      details: reason ?? (suspend ? 'Suspended by admin' : 'Unsuspended by admin'),
    },
  })

  return NextResponse.json({
    success: true,
    userId,
    email: updated.email,
    suspended: !!updated.suspendedAt,
    suspendedAt: updated.suspendedAt,
  })
}
