export const dynamic = 'force-dynamic'

/**
 * GET /api/projects/[id]/changes/[changeId]
 *
 * One change in full, for View details: what it did to each object, the SQL
 * that ran, its protected verification, the data it kept, every lifecycle
 * event with who requested, authorised and executed it, and each recovery
 * that acted on it with its own verification.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAccessProject } from '@/lib/edition/guard'
import { getChange } from '@/lib/changes/history'

export const GET = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId, changeId } = (await params) as { id: string; changeId: string }
  if (!(await canAccessProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  // Scoped by project in the query itself: a change id says nothing about
  // which project it belongs to.
  const change = await getChange(projectId, changeId)
  if (!change) return NextResponse.json({ error: 'Change not found' }, { status: 404 })
  return NextResponse.json({ success: true, change })
})
