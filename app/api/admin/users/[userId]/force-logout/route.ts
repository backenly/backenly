export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/users/[userId]/force-logout
 *
 * Forces a single user's sessions to end immediately. Implemented by deleting
 * every Session row for that user — verifySession() returns invalid as soon
 * as the row is gone (the in-process cache TTL is 15 s).
 *
 * FOUNDER-ONLY.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/auth/requireFounder'
import { authenticateRequest } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db/prisma'
import { deleteAllUserSessions } from '@/lib/auth/session'
import { recordSecurityEvent } from '@/lib/platform/controls'

export async function POST(
  request: NextRequest,
  { params }: { params: { userId: string } },
) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const auth = await authenticateRequest(request)
  if (!auth.authenticated || !auth.userId || !auth.userEmail) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { userId } = params
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, deletedAt: true },
  })
  if (!target || target.deletedAt) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  // Cheap re-fetch of session count so we can report it back to the UI.
  const sessionCount = await prisma.session.count({ where: { userId } })
  await deleteAllUserSessions(userId)

  await prisma.auditLog.create({
    data: {
      action: 'USER_FORCE_LOGOUT',
      type: 'admin',
      userId: auth.userId,
      userEmail: auth.userEmail,
      details: `Force-logged-out ${target.email} (${sessionCount} session${sessionCount === 1 ? '' : 's'})`,
      metadata: { targetUserId: userId, sessionCount } as object,
    },
  })
  await recordSecurityEvent({
    kind: 'kill_switch',
    severity: 'high',
    userId: auth.userId,
    userEmail: auth.userEmail,
    summary: `Force-logout of ${target.email} — ${sessionCount} session(s) killed`,
    detail: { targetUserId: userId, targetEmail: target.email, sessionCount },
  }).catch(() => {})

  return NextResponse.json({
    success: true,
    userId,
    email: target.email,
    sessionsRevoked: sessionCount,
  })
}
