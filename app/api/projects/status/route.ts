export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getProjectLifecycle } from '@/lib/edition'
import { sanitizeDiagnostic } from '@/lib/errors/diagnostic-sanitize'
import { projectLiveStatus } from '@/lib/projects/live-status'

/**
 * GET /api/projects/status?orgId= - What each listed project is doing now
 * 🔒 Protected: Requires authentication
 *
 * The projects page renders its list from GET /api/projects first, then fills
 * in this: what waits on the person, when the self-healing loop last checked,
 * and whether their coding agent has connected (lib/projects/live-status.ts).
 *
 * Which projects is the list's own answer, asked the same way: the edition's
 * listing for this caller, narrowed by ?orgId= exactly as the list narrows it.
 * So this can never describe a project the list would not show, and a project
 * id is never taken from the request.
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const organizationId = request.nextUrl?.searchParams.get('orgId') || null
    const listed = await getProjectLifecycle().list(user.userId, { organizationId })
    const data = await projectLiveStatus(
      listed.map((project) => project.id),
      user.userId,
    )
    return NextResponse.json({ success: true, data })
  } catch (error: unknown) {
    console.error('Error reading project status:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to read project status', message: sanitizeDiagnostic(error) },
      { status: 500 },
    )
  }
})
