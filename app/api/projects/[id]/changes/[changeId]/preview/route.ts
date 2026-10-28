export const dynamic = 'force-dynamic'

/**
 * POST /api/projects/[id]/changes/[changeId]/preview
 *
 * What restoring the state before this change would do, proven before anyone
 * commits to it (lib/changes/recovery.ts): whether the restore point is intact,
 * whether a later change is in the way, what it would do to data written since
 * (and so whether it needs approval), and the recovery plan run against today's
 * data inside a transaction that is then rolled back.
 *
 * POST rather than GET because the proof takes the project's change lock and
 * briefly locks the tables it touches. Admin rights, like the restore itself.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { previewRecovery } from '@/lib/changes/recovery'
import { ChangeInProgressError } from '@/lib/changes/lock'

export const POST = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId, changeId } = (await params) as { id: string; changeId: string }
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  try {
    const preview = await previewRecovery(projectId, changeId)
    if (!preview) return NextResponse.json({ error: 'Change not found' }, { status: 404 })
    return NextResponse.json({ success: true, preview })
  } catch (err) {
    if (err instanceof ChangeInProgressError) {
      return NextResponse.json({ success: false, error: err.message, code: err.code }, { status: 409 })
    }
    throw err
  }
})
