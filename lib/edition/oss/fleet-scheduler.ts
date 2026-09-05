/**
 * The Cloud fleet scheduler, as resolved WITHOUT the private overlay.
 *
 * `@cloud/fleet-scheduler` resolves here only when
 * `lib/cloud/fleet-scheduler.ts` is absent, which means no Cloud overlay has
 * been applied. A real Cloud deployment cannot reach this file: it sets
 * BACKENLY_EDITION=cloud explicitly, and assertEditionCompositionOrExit refuses
 * to start without the overlay.
 *
 * ---- WHY THIS ONE IS NOT A NO-OP -----------------------------------------
 *
 * The other OSS fallbacks answer "nothing" -- no subscription, no analytics, no
 * organization -- because nothing is the correct answer for a deployment with
 * no commercial half, and because the callers already treat it as one.
 *
 * Returning no targets here would be different: it would silently switch OFF
 * every scheduled pass in CI, in local development, and in any public checkout
 * running with the edition unset. Autonomy would report itself enabled and heal
 * nothing, which is the precise failure mode that went unnoticed in production
 * for thirteen days and is why scripts/fleet/autonomy-fleet-check.ts exists. A
 * seam must not be able to disable the product by being absent.
 *
 * So the fallback enumerates the projects in ITS OWN database, which is what
 * this code has always done. What moved to the overlay is the Cloud fleet:
 * the managed estate, its tenancy and whatever policy Cloud applies on top.
 */
import { prisma } from '@/lib/db'
import { activeProjectsWhere } from '@/lib/autonomy/activity-gate'
import type { FleetTarget, FleetTargetOptions } from '@/lib/edition/fleet-types'

export async function activeTargets(options?: FleetTargetOptions): Promise<FleetTarget[]> {
  // .catch(() => []) preserved from the call sites this replaced: a scheduled
  // tick must not crash the process because the database blinked.
  return prisma.project
    .findMany({
      where: activeProjectsWhere(options?.windowDays),
      select: { id: true, userId: true },
    })
    .catch(() => [])
}

export async function maintenanceTargets(): Promise<FleetTarget[]> {
  return prisma.project
    .findMany({
      where: { expiresAt: null }, // only active (non-expired) projects
      select: { id: true, userId: true },
    })
    .catch(() => [])
}
