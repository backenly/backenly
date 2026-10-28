export const dynamic = 'force-dynamic'

/**
 * POST /api/projects/[id]/changes/[changeId]/keep   { seq }
 *
 * Keep a change as it is after it failed its checks (lib/changes/recovery.ts
 * keepChange). For a change waiting on a decision: its recovery needs approval,
 * or automation stopped and a person has to look. The change stays in effect,
 * its failed checks stay on record, and it can still be restored later.
 *
 * A person with admin rights, like a restore: `withAuth` accepts a platform
 * session and nothing else, so no agent key reaches it. `seq` is the change
 * number the page showed, so a stale page fails loudly.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { prisma } from '@/lib/db/prisma'
import { keepChange } from '@/lib/changes/recovery'

export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId, changeId } = (await params) as { id: string; changeId: string }
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  const target = await prisma.backendChange.findFirst({ where: { id: changeId, projectId }, select: { seq: true } })
  if (!target) return NextResponse.json({ error: 'Change not found' }, { status: 404 })

  const body = (await request.json().catch(() => ({}))) as { seq?: unknown }
  if (Number(body.seq) !== target.seq) {
    return NextResponse.json(
      { success: false, code: 'STALE_PAGE', error: `This page is showing a different change than #${target.seq}. Reload and try again.` },
      { status: 409 },
    )
  }

  const outcome = await keepChange(projectId, changeId, user.userId)
  if (!outcome.ok) {
    const fail = outcome as Extract<typeof outcome, { ok: false }>
    return NextResponse.json({ success: false, ...fail }, { status: fail.code === 'NOT_FOUND' ? 404 : 409 })
  }
  return NextResponse.json({ success: true, ...outcome })
})
