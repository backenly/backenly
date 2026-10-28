/**
 * GET and POST /api/projects/[id]/rollback/archives: retired.
 *
 * GET listed table archives and point-in-time snapshots that nothing writes any
 * more, and POST asked for a point-in-time restore that always threw. Data a
 * change removes is kept in that change's vault now, and comes back by
 * restoring the state before the change (lib/changes/recovery.ts). No UI
 * called this route.
 *
 * Still answers only someone who administers the project, and 404 to anyone
 * else, so it is not an oracle for which project ids exist.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { movedToChanges } from '@/lib/changes/retired'

export const dynamic = 'force-dynamic'

const retired = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId } = (await params) as { id: string }
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 })
  }
  return movedToChanges('Restoring archived tables and point-in-time snapshots')
})

export const GET = retired
export const POST = retired
