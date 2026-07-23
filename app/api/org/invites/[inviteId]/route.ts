export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { ensurePersonalOrg, userRoleInOrg, roleAtLeast, revokeInvite } from '@/lib/org'

/**
 * DELETE /api/org/invites/[inviteId] — revoke a pending invite (§5.3).
 * Owner/Admin only, scoped to the caller's organization.
 */
export const DELETE = withAuth(async (
  _request: NextRequest,
  { user, params },
) => {
  const inviteId = (await params)?.inviteId
  if (!inviteId) return NextResponse.json({ success: false, error: 'inviteId required' }, { status: 400 })

  const orgId = await ensurePersonalOrg(user.userId)
  const role = await userRoleInOrg(orgId, user.userId)
  if (!roleAtLeast(role, 'ADMIN')) {
    return NextResponse.json({ success: false, error: 'Only owners and admins can revoke invites.' }, { status: 403 })
  }

  const ok = await revokeInvite(inviteId, orgId)
  if (!ok) return NextResponse.json({ success: false, error: 'Invite not found or already handled.' }, { status: 404 })
  return NextResponse.json({ success: true })
})
