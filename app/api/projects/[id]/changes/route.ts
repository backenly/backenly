export const dynamic = 'force-dynamic'

/**
 * GET /api/projects/[id]/changes?before=<seq>&limit=<n>
 *
 * The project's change history, newest first: every governed change to
 * production with who made it (an agent's key, a person, Backenly), what it
 * did, how its lifecycle ended (verified, recovered automatically, restored),
 * and what restoring the state before it would mean.
 *
 * Readable by anyone with access to the project. Restoring is not: see
 * ./[changeId]/restore and ./[changeId]/keep, which need admin rights and a
 * person's session. `canManage` says whether this caller has them.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAccessProject, canAdministerProject } from '@/lib/edition/guard'
import { listChanges } from '@/lib/changes/history'

export const GET = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId } = (await params) as { id: string }
  // 404, not 403: the endpoint must not confirm which project ids exist.
  if (!(await canAccessProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  const url = new URL(request.url)
  const before = Number(url.searchParams.get('before'))
  const limit = Number(url.searchParams.get('limit'))
  const page = await listChanges(projectId, {
    ...(Number.isInteger(before) && before > 0 ? { beforeSeq: before } : {}),
    ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
  })
  // Whether this person may restore or keep a change, so the console offers
  // only what the server would accept. The routes check again.
  const canManage = await canAdministerProject(user.userId, projectId)
  return NextResponse.json({ success: true, ...page, canManage })
})
