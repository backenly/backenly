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
import { scoreReadiness } from '@/lib/deployment/readiness-scorer'
import { canAccessProject, canWriteProject } from '@/lib/edition/guard'

function extractProjectId(request: NextRequest): string | null {
  const parts = new URL(request.url).pathname.split('/').filter(Boolean)
  const i = parts.indexOf('projects')
  return i >= 0 && parts[i + 1] ? parts[i + 1] : null
}


export const GET = withAuth(async (request, { user }) => {
  const projectId = extractProjectId(request)
  if (!projectId) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 })
  }
  if (!(await canAccessProject(user.userId, projectId))) {
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
  if (!(await canWriteProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found or access denied' }, { status: 404 })
  }

  const report = await scoreReadiness(projectId, { autoFix: true })
  return NextResponse.json({
    success: true,
    report,
    fixesApplied: report.autoFixed.length,
  })
})
