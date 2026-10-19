/**
 * POST /api/projects/[id]/restore: retired.
 *
 * "Restore points" on the Autonomy page called this. It moved the active-graph
 * pointer to an earlier version, then re-created whatever that version named
 * and the workspace lacked, as new forward changes recorded to nobody in
 * particular. It removed nothing added since, so the backend was not put back
 * to that version. Restoring is per governed change now: Database → Changes,
 * the change's ⋯ menu, Restore previous state (lib/changes/recovery.ts).
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
  return movedToChanges('Restoring the backend to a saved version')
})
