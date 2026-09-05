/**
 * Per-project lockdown.
 *
 * Project-local: it writes two columns on one Project and the runtime
 * middleware reads them. Nothing about it is commercial, so it sits on the
 * public side of the cut line even though the console that drives it is
 * Backenly's.
 */
import { prisma } from '@/lib/db/prisma'
import { recordSecurityEvent } from './security-events'

// ─── Per-project lockdown ────────────────────────────────────────────────────

export async function setProjectLockdown(
  projectId: string,
  locked: boolean,
  reason: string | null,
  actor: { userId: string; userEmail: string },
): Promise<void> {
  const proj = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, userId: true },
  })
  if (!proj) throw new Error('Project not found')

  // Lockdown is enforced in lib/api/v1/middleware.ts by checking
  // Project.lockedDownAt — single source of truth, so we don't need to mutate
  // every ApiKey row (and risk losing their original expiresAt). Lifting the
  // lockdown is therefore reversible with no side effects.
  await prisma.project.update({
    where: { id: projectId },
    data: {
      lockedDownAt: locked ? new Date() : null,
      lockedDownReason: locked ? reason : null,
    },
  })

  await prisma.auditLog.create({
    data: {
      action: locked ? 'PROJECT_LOCKED_DOWN' : 'PROJECT_LOCKDOWN_LIFTED',
      type: 'admin',
      userId: actor.userId,
      userEmail: actor.userEmail,
      projectId,
      details: reason ?? (locked ? 'Project locked via admin dashboard' : 'Lockdown lifted via admin dashboard'),
    },
  })

  await recordSecurityEvent({
    kind: 'lockdown',
    severity: locked ? 'high' : 'info',
    userId: actor.userId,
    userEmail: actor.userEmail,
    projectId,
    summary: locked
      ? `Project "${proj.name}" locked down: ${reason ?? 'no reason given'}`
      : `Project "${proj.name}" lockdown lifted`,
    detail: { projectId, ownerUserId: proj.userId, reason },
  })
}

/** Cheap predicate used inside the public runtime middleware. */
export async function isProjectLockedDown(projectId: string): Promise<boolean> {
  try {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { lockedDownAt: true },
    })
    return !!p?.lockedDownAt
  } catch {
    return false
  }
}
