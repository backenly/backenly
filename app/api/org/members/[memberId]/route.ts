export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { ensurePersonalOrg, userRoleInOrg, roleAtLeast, removeMember, setMemberRole, type OrgRole } from '@/lib/org'
import { z } from 'zod'

/**
 * DELETE /api/org/members/[memberId] — remove a member (§5.3). Owner/Admin only.
 * PATCH  /api/org/members/[memberId]  — change a member's role. Owner/Admin only.
 * `memberId` is the member's userId. The owner cannot be removed or demoted.
 */
export const DELETE = withAuth(async (_request: NextRequest, { user, params }) => {
  const memberId = (await params)?.memberId
  if (!memberId) return NextResponse.json({ success: false, error: 'memberId required' }, { status: 400 })

  const orgId = await ensurePersonalOrg(user.userId)
  const role = await userRoleInOrg(orgId, user.userId)
  if (!roleAtLeast(role, 'ADMIN')) {
    return NextResponse.json({ success: false, error: 'Only owners and admins can remove members.' }, { status: 403 })
  }

  const result = await removeMember(orgId, memberId)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true })
})

const RoleSchema = z.object({ role: z.enum(['ADMIN', 'DEVELOPER', 'VIEWER']) })

export const PATCH = withAuth(async (request: NextRequest, { user, params }) => {
  const memberId = (await params)?.memberId
  if (!memberId) return NextResponse.json({ success: false, error: 'memberId required' }, { status: 400 })

  const body = await request.json().catch(() => ({}))
  const parsed = RoleSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid role' }, { status: 400 })

  const orgId = await ensurePersonalOrg(user.userId)
  const role = await userRoleInOrg(orgId, user.userId)
  if (!roleAtLeast(role, 'ADMIN')) {
    return NextResponse.json({ success: false, error: 'Only owners and admins can change roles.' }, { status: 403 })
  }

  const result = await setMemberRole(orgId, memberId, parsed.data.role as OrgRole)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true })
})
