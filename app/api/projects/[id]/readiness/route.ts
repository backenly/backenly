export const dynamic = 'force-dynamic'

/**
 * Project Readiness API — moved from /api/deployments/readiness.
 *
 *   GET  /api/projects/:id/readiness        → ReadinessReport (read-only probe)
 *   POST /api/projects/:id/readiness        → auto-fix + re-evaluate
 *
 * Both routes require platform authentication and project ownership.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db'
import { scoreReadiness } from '@/lib/deployment/readiness-scorer'

function extractProjectId(request: NextRequest): string | null {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean)
  const i = parts.indexOf('projects')
  return i >= 0 && parts[i + 1] ? parts[i + 1] : null
}

async function assertOwner(projectId: string, userId: string): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  })
  return !!project
}

export const GET = withAuth(async (request, { user }) => {
  const projectId = extractProjectId(request)
  if (!projectId) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 })
  }
  if (!(await assertOwner(projectId, user.userId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  const report = await scoreReadiness(projectId, { autoFix: false })
  return NextResponse.json({ success: true, report })
})

export const POST = withAuth(async (request, { user }) => {
  const projectId = extractProjectId(request)
  if (!projectId) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 })
  }
  if (!(await assertOwner(projectId, user.userId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  const report = await scoreReadiness(projectId, { autoFix: true })
  return NextResponse.json({
    success: true,
    report,
    fixesApplied: report.autoFixed.length,
  })
})
