export const dynamic = 'force-dynamic'

/**
 * GET /api/projects/[id]/protection           → { protectedProduction }
 * PUT /api/projects/[id]/protection  Body: { protectedProduction: boolean }
 *
 * Protected production: a coding agent changes this project's schema on a
 * preview branch, and production receives it through a merge a human approved
 * (lib/branches/protection.ts).
 *
 * Changing it is administration: turning it off lets an agent change
 * production's schema directly, so it takes the same right as issuing a key,
 * and every change is audited. Backenly Cloud only; a self-hosted install has
 * no branches, so the setting does not exist there.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withProjectAccess } from '@/lib/auth/route-protection'
import { isCloudEdition } from '@/lib/edition/cloud-only'
import { canAdministerProject } from '@/lib/edition/guard'
import { prisma } from '@/lib/db/prisma'
import { forgetProtection } from '@/lib/branches/protection'

const cloudOnly404 = () =>
  NextResponse.json({ error: 'Not found', code: 'CLOUD_ONLY_FEATURE' }, { status: 404 })

export const GET = withProjectAccess(async (_req: NextRequest, { projectId }) => {
  if (!isCloudEdition()) return cloudOnly404()
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { protectedProduction: true } })
  return NextResponse.json({ success: true, protectedProduction: project?.protectedProduction === true })
})

export const PUT = withProjectAccess(async (req: NextRequest, { user, projectId }) => {
  if (!isCloudEdition()) return cloudOnly404()
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ success: false, error: 'Only a project admin can change production protection.' }, { status: 403 })
  }
  let body: { protectedProduction?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body.protectedProduction !== 'boolean') {
    return NextResponse.json({ success: false, error: 'protectedProduction must be true or false' }, { status: 400 })
  }

  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: body.protectedProduction } })
  forgetProtection(projectId)
  await prisma.auditLog.create({
    data: {
      projectId,
      userId: user.userId,
      action: body.protectedProduction ? 'PRODUCTION_PROTECTION_ON' : 'PRODUCTION_PROTECTION_OFF',
      type: 'branch',
      details: JSON.stringify({ protectedProduction: body.protectedProduction, at: new Date().toISOString() }),
      timestamp: new Date(),
    },
  }).catch(() => {})

  return NextResponse.json({ success: true, protectedProduction: body.protectedProduction })
})
