export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'
import { ensurePersonalOrg, userRoleInOrg, roleAtLeast, orgIsPaid, createInvite, type OrgRole } from '@/lib/org'
import { sendOrgInviteEmail } from '@/lib/auth/email'
import { z } from 'zod'

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'DEVELOPER', 'VIEWER']).default('DEVELOPER'),
  // Optional project-scoped invite (Pro+). When true, the invitee joins limited
  // to `projectIds` and never sees the org's other projects.
  restricted: z.boolean().optional(),
  projectIds: z.array(z.string().uuid()).optional(),
})

/**
 * POST /api/org/invites — invite a teammate by email (§5.3). Owner/Admin only.
 * Creates a pending invite and sends the accept link. The email send is
 * best-effort: the invite still exists (and its link is returned) if SMTP is
 * down, so the inviter can copy it manually.
 */
export const POST = withAuth(async (request: NextRequest, { user }) => {
  const body = await request.json().catch(() => ({}))
  const parsed = InviteSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 })
  }

  const orgId = await ensurePersonalOrg(user.userId)
  const role = await userRoleInOrg(orgId, user.userId)
  if (!roleAtLeast(role, 'ADMIN')) {
    return NextResponse.json({ success: false, error: 'Only owners and admins can invite members.' }, { status: 403 })
  }

  // Project-scoped invites are a paid capability.
  const wantScoped = !!parsed.data.restricted && parsed.data.role !== 'ADMIN'
  if (wantScoped && !(await orgIsPaid(orgId))) {
    return NextResponse.json(
      { success: false, error: 'Inviting someone to specific projects is a Pro feature.', code: 'PLAN_UPGRADE_REQUIRED' },
      { status: 402 },
    )
  }

  const result = await createInvite({
    orgId,
    email: parsed.data.email,
    role: parsed.data.role as OrgRole,
    invitedById: user.userId,
    restricted: wantScoped,
    scopedProjectIds: parsed.data.projectIds,
  })
  if (!result.ok || !result.invite) {
    return NextResponse.json({ success: false, error: result.error ?? 'Could not create invite' }, { status: 400 })
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com'
  const acceptUrl = `${appUrl}/app/invite/${result.invite.token}`

  const [org, inviter] = await Promise.all([
    prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
    prisma.user.findUnique({ where: { id: user.userId }, select: { name: true, email: true } }),
  ])

  await sendOrgInviteEmail(result.invite.email, {
    inviterName: inviter?.name || inviter?.email?.split('@')[0] || 'A teammate',
    orgName: org?.name ?? 'a team',
    role: result.invite.role,
    acceptUrl,
  }).catch(() => { /* non-fatal — invite still exists, link returned below */ })

  return NextResponse.json({
    success: true,
    data: { id: result.invite.id, email: result.invite.email, role: result.invite.role, acceptUrl },
  })
})
