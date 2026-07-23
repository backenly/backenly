export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'
import { ensurePersonalOrg } from '@/lib/org'

/**
 * GET /api/org/list — every organization the caller belongs to, for the
 * TopBar org switcher (the open Phase-6 gap: an invitee had no way to see or
 * enter the org they joined).
 *
 * Ensures the personal org exists first so a brand-new account always gets at
 * least one row. Ordered: personal org first, then joined orgs by name.
 */
export const GET = withAuth(async (_request: NextRequest, { user }) => {
  try {
    const personalOrgId = await ensurePersonalOrg(user.userId)

    const memberships = await prisma.organizationMember.findMany({
      where: { userId: user.userId },
      select: {
        role: true,
        organization: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            _count: { select: { projects: true, members: true } },
          },
        },
      },
    })

    const orgs = memberships
      .map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        role: m.role,
        personal: m.organization.id === personalOrgId,
        owned: m.organization.ownerId === user.userId,
        projectCount: m.organization._count.projects,
        memberCount: m.organization._count.members,
      }))
      .sort((a, b) => Number(b.personal) - Number(a.personal) || a.name.localeCompare(b.name))

    return NextResponse.json({ success: true, orgs })
  } catch (error: any) {
    console.error('[Org List] failed:', error?.message)
    return NextResponse.json({ success: false, error: 'Failed to load organizations' }, { status: 500 })
  }
})
