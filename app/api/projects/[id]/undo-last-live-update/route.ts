/**
 * POST /api/projects/[id]/undo-last-live-update: retired.
 *
 * This moved the project's active-graph pointer back past the last live update
 * and marked its intent log undone. The workspace schema was never touched, so
 * the update was still in effect. Undo is restoring the state before a governed
 * change now (lib/changes/recovery.ts). No UI called this route.
 *
 * Still answers only someone who administers the project, and 404 to anyone
 * else, so it is not an oracle for which project ids exist.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { movedToChanges } from '@/lib/changes/retired'

export const dynamic = 'force-dynamic'

export const POST = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId } = (await params) as { id: string }
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 })
  }
  return movedToChanges('Undoing the last live update')
})
