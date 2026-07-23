export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { ensurePersonalOrg, userRoleInOrg, roleAtLeast, orgIsPaid, setMemberScope } from '@/lib/org'
import { z } from 'zod'

/**
 * PUT /api/org/members/[memberId]/scope — set a member's access mode
 * (Pro+ feature). Owner/Admin only. `memberId` is the member's userId.
 *
 *   { restricted: false }                          → org-wide access
 *   { restricted: true, projectIds: [id, ...] }    → limited to those projects
 *
 * Creating a restriction requires a paid plan (BUILDER/SCALE). REMOVING one is
 * always allowed — a downgraded org must be able to widen access back to
 * org-wide, and enforcement of any remaining restriction still runs in
 * verifyProjectAccess regardless of plan.
 */
const ScopeSchema = z.object({
  restricted: z.boolean(),
  projectIds: z.array(z.string().uuid()).default([]),
})

export const PUT = withAuth(async (request: NextRequest, { user, params }) => {
  const memberId = (await params)?.memberId
  if (!memberId) return NextResponse.json({ success: false, error: 'memberId required' }, { status: 400 })

  const body = await request.json().catch(() => ({}))
  const parsed = ScopeSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }

  const orgId = await ensurePersonalOrg(user.userId)
  const role = await userRoleInOrg(orgId, user.userId)
  if (!roleAtLeast(role, 'ADMIN')) {
    return NextResponse.json({ success: false, error: 'Only owners and admins can change project access.' }, { status: 403 })
  }

  // Setting (not clearing) a restriction is the paid capability.
  if (parsed.data.restricted && !(await orgIsPaid(orgId))) {
    return NextResponse.json(
      { success: false, error: 'Project-scoped access is a Pro feature. Upgrade to limit members to specific projects.', code: 'PLAN_UPGRADE_REQUIRED' },
      { status: 402 },
    )
  }

  const result = await setMemberScope(orgId, memberId, {
    restricted: parsed.data.restricted,
    projectIds: parsed.data.projectIds ?? [],
  })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true })
})
