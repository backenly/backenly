/**
 * POST /api/projects/[id]/undelete: restore a project asked to be deleted.
 *
 * Deleting keeps a project for seven days (lib/projects/deletion.ts). Until the
 * daily purge removes it, an owner or admin of the project brings it back here:
 * listed, counted and serving again. The plan's project limit is asked first, as
 * creating a project asks it, since a deleted project no longer counts.
 *
 * (Not /restore: that path is the retired restore-points route,
 * app/api/projects/[id]/restore.)
 */
import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { canAdministerProject } from '@/lib/edition/guard'
import { prisma } from '@/lib/db'
import { projectCreationVerdict } from '@/lib/projects/creation-verdict'
import { restoreDeletedProject } from '@/lib/projects/deletion'
import { LifecycleBusyError } from '@/lib/projects/pause-lifecycle'

export const dynamic = 'force-dynamic'

export const POST = withAuth(async (_request: NextRequest, { user, params }) => {
  const { id: projectId } = (await params) as { id: string }

  // ADMIN, the floor deleting takes. A refusal is the same 404 as a miss.
  if (!(await canAdministerProject(user.userId, projectId))) {
    return NextResponse.json({ success: false, error: 'Project not found or access denied' }, { status: 404 })
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, organizationId: true, deletedAt: true },
  })
  if (!project) {
    return NextResponse.json({ success: false, error: 'Project not found or access denied' }, { status: 404 })
  }
  if (!project.deletedAt) {
    return NextResponse.json(
      { success: false, error: `${project.name} is not deleted, so there is nothing to restore.`, code: 'PROJECT_NOT_DELETED' },
      { status: 409 },
    )
  }

  // Restoring takes back a place on the plan, so it is refused where creating
  // a project would be, with the reason in the plan's words.
  const verdict = await projectCreationVerdict(user.userId, project.organizationId, { initialize: false })
  if (verdict.allowed === false) {
    return NextResponse.json(
      {
        success: false,
        error:
          verdict.code === 'PLAN_LIMIT_EXCEEDED'
            ? `${project.name} cannot be restored: the plan's project limit is reached. Delete another project or upgrade, then restore it.`
            : verdict.error,
        code: verdict.code ?? 'RESTORE_REFUSED',
        ...(verdict.upgradeRequired ? { upgradeRequired: true, currentPlan: verdict.currentPlan, requiredPlan: verdict.requiredPlan } : {}),
      },
      { status: verdict.status },
    )
  }

  try {
    await restoreDeletedProject(projectId, { kind: 'user', userId: user.userId, email: user.email })
  } catch (error) {
    if (error instanceof LifecycleBusyError) {
      return NextResponse.json(
        { success: false, error: 'The project is being paused or resumed right now. Try again in a moment.', code: error.code },
        { status: 409 },
      )
    }
    throw error
  }
  return NextResponse.json({ success: true, message: `${project.name} is restored.` })
})
