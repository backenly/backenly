export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'
import {
  userRoleInOrg, roleAtLeast, orgIsPaid, listProjectAccess, grantProjectAccess, revokeProjectAccess, type OrgRole,
} from '@/lib/org'
import { z } from 'zod'

/**
 * Project-level access surface (Pro+) for Settings → Access.
 *
 *   GET    — the org roster annotated with each member's access to THIS project
 *            (`hasAccess`), plus `canManage` and `isPaid` for the UI.
 *   POST   — grant a restricted member access to this project. { userId }.
 *   DELETE — remove a restricted member's access to this project. { userId }.
 *
 * Only owners/admins of the project's organization may manage; any member may
 * read. Granting is a paid capability; revoking is always allowed. Org-wide
 * members (owner/admin/unrestricted) are managed on the Members page, not here.
 */

type Resolved = { response: NextResponse | null; orgId: string | null; role: OrgRole | null }

async function resolve(projectId: string, userId: string): Promise<Resolved> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true, organizationId: true },
  })
  if (!project) {
    return { response: NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 }), orgId: null, role: null }
  }
  const orgId = project.organizationId
  if (!orgId) {
    // Org-less (solo) project — no team to scope. Only the owner has access.
    return { response: null, orgId: null, role: project.userId === userId ? 'OWNER' : null }
  }
  return { response: null, orgId, role: await userRoleInOrg(orgId, userId) }
}

export const GET = withAuth(async (_request: NextRequest, { user, params }) => {
  const projectId = (await params)?.id
  if (!projectId) return NextResponse.json({ success: false, error: 'projectId required' }, { status: 400 })

  const r = await resolve(projectId, user.userId)
  if (r.response) return r.response
  if (!r.role) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  if (!r.orgId) {
    return NextResponse.json({ success: true, data: { hasOrg: false, canManage: r.role === 'OWNER', isPaid: false, members: [] } })
  }

  const [members, isPaid] = await Promise.all([listProjectAccess(r.orgId, projectId), orgIsPaid(r.orgId)])
  return NextResponse.json({
    success: true,
    data: { hasOrg: true, canManage: roleAtLeast(r.role, 'ADMIN'), isPaid, me: { userId: user.userId, role: r.role }, members },
  })
})

const BodySchema = z.object({ userId: z.string().uuid() })

export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  const projectId = (await params)?.id
  if (!projectId) return NextResponse.json({ success: false, error: 'projectId required' }, { status: 400 })

  const parsed = BodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ success: false, error: 'userId required' }, { status: 400 })

  const r = await resolve(projectId, user.userId)
  if (r.response) return r.response
  if (!r.orgId || !roleAtLeast(r.role, 'ADMIN')) {
    return NextResponse.json({ success: false, error: 'Only owners and admins can manage project access.' }, { status: 403 })
  }
  if (!(await orgIsPaid(r.orgId))) {
    return NextResponse.json(
      { success: false, error: 'Project-scoped access is a Pro feature.', code: 'PLAN_UPGRADE_REQUIRED' },
      { status: 402 },
    )
  }

  const result = await grantProjectAccess(r.orgId, parsed.data.userId, projectId)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true })
})

export const DELETE = withAuth(async (request: NextRequest, { user, params }) => {
  const projectId = (await params)?.id
  if (!projectId) return NextResponse.json({ success: false, error: 'projectId required' }, { status: 400 })

  // userId may come in the body or as a query param.
  const bodyUserId = (await request.json().catch(() => ({})))?.userId
  const userId = bodyUserId || new URL(request.url).searchParams.get('userId')
  const parsed = BodySchema.safeParse({ userId })
  if (!parsed.success) return NextResponse.json({ success: false, error: 'userId required' }, { status: 400 })

  const r = await resolve(projectId, user.userId)
  if (r.response) return r.response
  if (!r.orgId || !roleAtLeast(r.role, 'ADMIN')) {
    return NextResponse.json({ success: false, error: 'Only owners and admins can manage project access.' }, { status: 403 })
  }

  const result = await revokeProjectAccess(r.orgId, parsed.data.userId, projectId)
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  return NextResponse.json({ success: true })
})
