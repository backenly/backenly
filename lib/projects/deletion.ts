/**
 * DELETING A PROJECT KEEPS IT FOR SEVEN DAYS
 * ==========================================
 * Deleting a project used to drop its schemas, backups and files in the same
 * request, so a mistake (the wrong project, the wrong team) was permanent the
 * moment it was made. Now a deletion is asked for, and carried out a week later:
 *
 *   asked     `deletedAt` and `purgeAfter` (seven days on) are set. Every
 *             listing, count and background pass already skips a project with
 *             `deletedAt`: the Projects page, the plan's project limit, the
 *             autonomy loop, the observer, backups.
 *   stopped   the project is paused with reason 'deleted', through the pause
 *             columns every runtime door already refuses on, in its own region
 *             too (they are in the authorization projection). Its webhooks
 *             stop, and its allowed addresses leave its region's network
 *             allowlist. Nothing is dropped.
 *   restored  until then, an admin restores it from the Projects page
 *             (restoreDeletedProject): both dates cleared, the deletion pause
 *             lifted, back in the list and serving, if the plan has room for it.
 *   purged    the daily purge (instrumentation.ts) runs the full deletion,
 *             deleteProjectCompletely, for every project past `purgeAfter`.
 *
 * Its direct Postgres logins stop when the deletion is asked for and come back
 * with their passwords when the project is restored, as for a pause
 * (lib/projects/paused-logins.ts).
 *
 * Neon keeps a deleted project restorable for 7 days the same way. A project an
 * import made and never finished is purged at once, as before: nothing in it was
 * ever the person's own work.
 *
 * The deletion pause is the owner's own act, not the inactivity pause (Backenly
 * Cloud's policy, lib/projects/pause-lifecycle.ts, which this module never
 * calls); it shares the columns and the lock so the two can never interleave.
 */
import { prisma } from '@/lib/db/prisma'
import { restoreDirectLogins, stopDirectLogins } from './paused-logins'
import { discardOutbox } from '@/lib/webhooks/capture'
import { confirmPropagation, type Propagation } from '@/lib/auth-projection/confirm'
import { ensureSchemaRegistered } from '@/lib/postgrest/registration'
import { cancelPendingDeliveries, withProjectLifecycleLock, type LifecycleActor } from './pause-lifecycle'
import { DELETED_PAUSE_REASON, invalidateProjectServingState } from './serving-state'
import { syncAllowlistForProject } from '@/lib/services/direct-access-allowlist'
import { deleteProjectCompletely } from './delete'

/** How long a deleted project is kept before it is removed for good. */
export const DELETION_GRACE_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

export interface DeletionRequested {
  /** False when the project was already asked to be deleted: nothing changed. */
  requested: boolean
  purgeAfter: Date
  propagation: Propagation | null
}

/**
 * Mark a project deleted: hidden, refused everywhere, removed for good at
 * `purgeAfter`. Idempotent: asking twice keeps the first date.
 */
export async function requestProjectDeletion(projectId: string, actor: LifecycleActor, now: Date = new Date()): Promise<DeletionRequested> {
  const purgeAfter = new Date(now.getTime() + DELETION_GRACE_DAYS * DAY_MS)

  const marked = await withProjectLifecycleLock(projectId, async (tx) => {
    const row = await tx.project.findUnique({ where: { id: projectId }, select: { deletedAt: true, purgeAfter: true, pausedAt: true } })
    if (!row) throw new Error(`Project ${projectId} does not exist`)
    if (row.deletedAt) return { requested: false, purgeAfter: row.purgeAfter ?? purgeAfter }

    await tx.project.update({
      where: { id: projectId },
      data: {
        deletedAt: now,
        purgeAfter,
        // A project already paused for inactivity keeps that pause, and its
        // reason, so restoring it returns it to how it was.
        ...(row.pausedAt ? {} : { pausedAt: now, pauseReason: DELETED_PAUSE_REASON }),
      },
    })
    await cancelPendingDeliveries(tx, projectId)
    return { requested: true, purgeAfter }
  })
  if (!marked.requested) return { ...marked, propagation: null }
  // Its direct Postgres logins stop, as a pause stops them; restoring it brings
  // them back with the same passwords (lib/projects/paused-logins.ts). Never throws.
  await stopDirectLogins(projectId, 'deletion requested')

  // This process's gates refuse it now; the runtime within its cache's bound,
  // and a project kept in another region once its region has the change.
  invalidateProjectServingState(projectId)
  const propagation = await confirmPropagation({ entity: 'project', entityId: projectId })
  await discardOutbox(projectId)
  // Its allowed addresses stop counting toward its region's network allowlist
  // (lib/services/direct-access-allowlist.ts), unless another project allows
  // the same one; restoring it brings them back. Never throws.
  await syncAllowlistForProject(projectId)

  await prisma.auditLog.create({
    data: {
      action: 'PROJECT_DELETION_REQUESTED',
      type: 'project',
      projectId,
      userId: actor.kind === 'user' ? actor.userId : null,
      userEmail: actor.kind === 'user' ? actor.email ?? null : null,
      details: `Project deleted; it is removed for good on ${marked.purgeAfter.toISOString().slice(0, 10)}`,
      metadata: { purgeAfter: marked.purgeAfter.toISOString(), propagation, actor: actor.kind === 'system' ? `system:${actor.label}` : 'user' } as object,
    },
  })
  return { ...marked, propagation }
}

/**
 * Undo a deletion that has not been carried out yet: clear `deletedAt` and
 * `purgeAfter`, and lift the deletion pause. A project that was paused for
 * inactivity before it was deleted stays paused, as it was. Restoring counts as
 * use, like resuming. Idempotent: a project not deleted is left as it is.
 *
 * The caller checks the plan's project limit first (the restore route asks
 * projectCreationVerdict, which no longer counts this project while deleted).
 *
 * Once `purgeAfter` has passed the project is the daily purge's, and is not
 * restored (`due`): the purge lists every project past its date and then removes
 * them one by one, so a restore in between would be reported done and then
 * undone by the purge, part of it already dropped. Decided under the same lock
 * the purge re-checks under (purgeDeletedProjects).
 */
export async function restoreDeletedProject(
  projectId: string,
  actor: LifecycleActor,
  now: Date = new Date(),
): Promise<{ restored: boolean; due?: boolean }> {
  const outcome = await withProjectLifecycleLock(projectId, async (tx) => {
    const row = await tx.project.findUnique({ where: { id: projectId }, select: { deletedAt: true, purgeAfter: true, pauseReason: true } })
    if (!row?.deletedAt) return 'not-deleted' as const
    if (row.purgeAfter && row.purgeAfter.getTime() <= now.getTime()) return 'due' as const
    await tx.project.update({
      where: { id: projectId },
      data: {
        deletedAt: null,
        purgeAfter: null,
        ...(row.pauseReason === DELETED_PAUSE_REASON
          ? { pausedAt: null, pauseReason: null, pauseWarnedAt: null, lastActivityAt: now }
          : {}),
      },
    })
    return 'restored' as const
  })
  if (outcome === 'due') return { restored: false, due: true }
  if (outcome !== 'restored') return { restored: false }
  // The logins the deletion stopped, back with their passwords, unless the
  // project is still paused for another reason. Never throws.
  await restoreDirectLogins(projectId, 'restored')

  // As after a resume: this process's gates serve it now, the runtime within its
  // cache's bound, its region once the region has the change. Registration was
  // never removed; ensuring it repairs anything that drifted meanwhile.
  invalidateProjectServingState(projectId)
  const propagation = await confirmPropagation({ entity: 'project', entityId: projectId })
  await ensureSchemaRegistered(projectId)
  // Its allowed addresses count toward its region's network allowlist again.
  await syncAllowlistForProject(projectId)
  await prisma.auditLog.create({
    data: {
      action: 'PROJECT_RESTORED',
      type: 'project',
      projectId,
      userId: actor.kind === 'user' ? actor.userId : null,
      userEmail: actor.kind === 'user' ? actor.email ?? null : null,
      details: 'Project restored',
      metadata: { propagation, actor: actor.kind === 'system' ? `system:${actor.label}` : 'user' } as object,
    },
  })
  return { restored: true }
}

/**
 * Whether a project is an import's that never finished: the import flow's own
 * scratch project, which a deletion removes at once, as it always did. An import
 * that finished records where the project came from (`importedFrom`), and from
 * then on it is a project like any other.
 */
export async function isUnfinishedImport(projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { importedFrom: true } })
  if (!project || project.importedFrom !== null) return false
  // 'import' is IMPORT_JOB_TYPE (lib/import/jobs.ts), named here so a deletion
  // does not load the import machinery.
  const job = await prisma.backgroundJob.findFirst({ where: { projectId, type: 'import' }, select: { id: true } })
  return job !== null
}

/**
 * Remove for good every project asked to be deleted whose `purgeAfter` has
 * passed. Run daily, from the home region (the deletion reaches every region,
 * as deleting did from a request). One project failing never stops the rest;
 * it is tried again the next day.
 *
 * Each project is checked again, under its lifecycle lock, just before it is
 * removed: still deleted and still past its date. The list is read once and
 * removing a project takes a while, so without the re-check a project restored
 * meanwhile would be removed anyway (restoreDeletedProject also refuses once a
 * project is past its date).
 */
export async function purgeDeletedProjects(now: Date = new Date(), limit = 50): Promise<{ purged: string[]; failed: string[] }> {
  const due = await prisma.project.findMany({
    where: { deletedAt: { not: null }, purgeAfter: { lte: now } },
    select: { id: true },
    orderBy: { purgeAfter: 'asc' },
    take: limit,
  })
  const purged: string[] = []
  const failed: string[] = []
  for (const { id } of due) {
    try {
      const stillDue = await withProjectLifecycleLock(id, async (tx) => {
        const row = await tx.project.findUnique({ where: { id }, select: { deletedAt: true, purgeAfter: true } })
        return !!row?.deletedAt && !!row.purgeAfter && row.purgeAfter.getTime() <= now.getTime()
      })
      if (!stillDue) continue
      await deleteProjectCompletely(id)
      purged.push(id)
    } catch (err: any) {
      failed.push(id)
      // Category only: the message can name a schema or a path.
      console.error(`[ProjectPurge] project=${id} not purged, tried again tomorrow: ${err?.name || 'Error'}`)
    }
  }
  if (purged.length || failed.length) {
    console.log(`[ProjectPurge] purged=${purged.length} failed=${failed.length}`)
  }
  return { purged, failed }
}
