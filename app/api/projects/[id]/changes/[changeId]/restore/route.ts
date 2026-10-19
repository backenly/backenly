export const dynamic = 'force-dynamic'

/**
 * POST /api/projects/[id]/changes/[changeId]/restore   { seq, acknowledged? }
 *
 * Restore the state before one change (lib/changes/recovery.ts). Used for
 * "Restore previous state" and, on the recovery record that restored a change,
 * for "Reapply this change".
 *
 * ── Who can ─────────────────────────────────────────────────────────────────
 *
 * A person: `withAuth` accepts a platform session and nothing else, so a coding
 * agent's key or MCP token cannot reach this route. An agent asks for a restore
 * with deploy { action: "revert_change" }, which waits for a person in the
 * approvals inbox. Admin rights on the project, not just access: a restore
 * rewrites production.
 *
 * ── What they confirm ───────────────────────────────────────────────────────
 *
 * `seq` is the change number the page showed, so a stale page fails loudly
 * instead of restoring something else. A restore that is not lossless runs only
 * with `acknowledged`: the impact the person saw in the preview. It is measured
 * again under lock, and the restore is refused, with nothing changed, if it
 * would now affect more than they approved.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { prisma } from '@/lib/db/prisma'
import { recoverChange } from '@/lib/changes/recovery'

const STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  NOT_AVAILABLE: 409,
  IN_PROGRESS: 409,
  CONFLICT: 409,
  NEEDS_APPROVAL: 409,
  IMPACT_CHANGED: 409,
  BLOCKED: 409,
  INTEGRITY: 409,
  CHANGE_IN_PROGRESS: 409,
  RECOVERY_FAILED: 422,
}

export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId, changeId } = (await params) as { id: string; changeId: string }
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  const target = await prisma.backendChange.findFirst({ where: { id: changeId, projectId }, select: { seq: true } })
  if (!target) return NextResponse.json({ error: 'Change not found' }, { status: 404 })

  const body = (await request.json().catch(() => ({}))) as { seq?: unknown; acknowledged?: unknown }
  if (Number(body.seq) !== target.seq) {
    return NextResponse.json(
      { success: false, code: 'STALE_PAGE', error: `This page is showing a different change than #${target.seq}. Reload and try again.` },
      { status: 409 },
    )
  }
  const acknowledged =
    body.acknowledged && typeof body.acknowledged === 'object' && !Array.isArray(body.acknowledged)
      ? Object.fromEntries(
          Object.entries(body.acknowledged as Record<string, unknown>).filter(([, v]) => Number.isInteger(v) && (v as number) >= 0),
        ) as Record<string, number>
      : null

  const outcome = await recoverChange(projectId, changeId, { mode: 'manual', actorUserId: user.userId, acknowledged })
  if (!outcome.ok) {
    // This tsconfig does not narrow on a boolean discriminant.
    const fail = outcome as Extract<typeof outcome, { ok: false }>
    return NextResponse.json({ success: false, ...fail }, { status: STATUS[fail.code] ?? 500 })
  }
  return NextResponse.json({ success: true, ...outcome })
})
