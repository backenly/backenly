export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'
import { ensurePersonalOrg, listMembers, listInvites, userRoleInOrg, orgIsPaid } from '@/lib/org'

/**
 * GET /api/org/members — the current user's personal organization, its members,
 * pending invites, the caller's role, and the org's plan (PLATFORM_RESTRUCTURE
 * _REPORT §5.3). Ensures the personal org exists (lazy, idempotent) so a solo
 * account sees itself as a one-person org — no migration required.
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    // ?orgId= lets a member view ANY org they belong to (org switcher) —
    // membership-checked; without it, behavior is unchanged (personal org).
    // This closes the Phase-6 gap where an invitee could only ever see their
    // own org's members page.
    const requestedOrgId = request.nextUrl.searchParams.get('orgId')
    let orgId: string
    if (requestedOrgId) {
      const membership = await prisma.organizationMember.findFirst({
        where: { orgId: requestedOrgId, userId: user.userId },
        select: { id: true },
      })
      if (!membership) {
        return NextResponse.json(
          { success: false, error: 'You are not a member of that organization' },
          { status: 403 },
        )
      }
      orgId = requestedOrgId
    } else {
      orgId = await ensurePersonalOrg(user.userId)
    }

    const [org, members, invites, myRole, sub, isPaid, projects] = await Promise.all([
      prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true, ownerId: true } }),
      listMembers(orgId),
      listInvites(orgId),
      userRoleInOrg(orgId, user.userId),
      prisma.subscription.findFirst({
        where: { organizationId: orgId, status: { in: ['ACTIVE', 'FREE', 'GRACE'] } },
        include: { plan: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      orgIsPaid(orgId),
      // The org's projects — powers the project picker when scoping a member.
      prisma.project.findMany({
        where: { organizationId: orgId, deletedAt: null },
        select: { id: true, name: true },
        orderBy: { updatedAt: 'desc' },
      }),
    ])

    return NextResponse.json({
      success: true,
      data: {
        org: { id: org?.id, name: org?.name, plan: sub?.plan?.name ?? 'FREE', isPaid },
        me: { userId: user.userId, role: myRole ?? 'OWNER' },
        members,
        invites,
        projects,
      },
    })
  } catch (error: any) {
    console.error('[Org Members] failed:', error?.message)
    return NextResponse.json({ success: false, error: 'Failed to load members' }, { status: 500 })
  }
})
