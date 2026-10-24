export const dynamic = 'force-dynamic'

/**
 * GET  /api/projects/[id]/changes/restore-to?after=<seq> | ?version=<n>
 * POST /api/projects/[id]/changes/restore-to   { after | version, steps }
 *
 * Restore to a point: the backend as it was right after change #after, by
 * undoing everything made since, newest first, each step an ordinary restore
 * held to its own rules (lib/changes/range.ts). A published version stands for
 * the point it was published at: the last change before it. GET says what it
 * would undo and where it would stop, without proving or changing anything;
 * POST runs it and stops at the first step that needs a person.
 *
 * Who can is who can restore (./[changeId]/restore): a person's session with
 * admin rights on the project. `steps` is the list the person saw, by record
 * id, so a change that landed since they opened it is not undone unseen.
 *
 * When a version's point is reached in full, that version is also recorded as
 * the current one (lib/deployment/rollback.ts markVersionCurrent), since the
 * backend is again what was published then. Not before: a version marked
 * current over a backend that is not is the bookkeeping that used to pass for
 * a rollback.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { planRestoreTo, publishedPoint, restoreTo, restoreToVersion } from '@/lib/changes/range'

/** The point, from `after` or a published `version`; null when neither names one. */
async function pointOf(projectId: string, after: unknown, version: unknown): Promise<{ after: number; version: number | null } | null> {
  if (version !== undefined && version !== null && version !== '') {
    const point = await publishedPoint(projectId, { version })
    return point ? { after: point.after, version: point.version } : null
  }
  const n = Number(after)
  return Number.isInteger(n) && n >= 0 ? { after: n, version: null } : null
}

export const GET = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId } = (await params) as { id: string }
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  const q = new URL(request.url).searchParams
  const point = await pointOf(projectId, q.get('after'), q.get('version'))
  if (!point) return NextResponse.json({ error: 'Name a change number or a published version.' }, { status: 400 })
  return NextResponse.json({ success: true, version: point.version, plan: await planRestoreTo(projectId, point.after) })
})

export const POST = withAuth(async (request: NextRequest, { user, params }) => {
  const { id: projectId } = (await params) as { id: string }
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  const body = (await request.json().catch(() => ({}))) as { after?: unknown; version?: unknown; steps?: unknown }
  const point = await pointOf(projectId, body.after, body.version)
  if (!point || !Array.isArray(body.steps)) {
    return NextResponse.json({ error: 'Name a change number or a published version, and the steps you reviewed.' }, { status: 400 })
  }
  const plan = await planRestoreTo(projectId, point.after)
  const seen = body.steps.map(String)
  if (plan.steps.length !== seen.length || plan.steps.some((s, i) => s.recordId !== seen[i])) {
    return NextResponse.json(
      { success: false, code: 'STALE_PAGE', error: 'The history changed since you opened this. Review what it would undo again.', plan },
      { status: 409 },
    )
  }
  if (point.version === null) {
    return NextResponse.json({ success: true, outcome: await restoreTo(projectId, point.after, { actorUserId: user.userId }), version: null, versionCurrent: false })
  }
  const done = await restoreToVersion(projectId, { version: point.version }, { actorUserId: user.userId, via: 'UI' })
  if (!done.ok) {
    const failed = done as Extract<typeof done, { ok: false }>
    return NextResponse.json({ success: false, code: failed.code, error: failed.error }, { status: 404 })
  }
  const ok = done as Extract<typeof done, { ok: true }>
  return NextResponse.json({ success: true, outcome: ok.outcome, version: ok.version, versionCurrent: ok.versionCurrent })
})
