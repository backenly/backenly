/**
 * How long a restore point is kept, and how long its vault keeps data.
 *
 * This is retention, not a promise that a change can be undone. Whether a
 * restore is possible, lossless, or needs a person is decided per change, from
 * its own record and today's data (lib/changes/recovery.ts). What the plan
 * decides is only how long the restore point and the data it kept are held:
 * the plan's log retention (7 days on Free, 30 on Pro, 90 on Enterprise, 365
 * self-hosted). Kept data outlives that by a grace week before it is purged, so
 * a restore started at the edge of the window never finds its vault emptied
 * under it.
 */

import { prisma } from '@/lib/db/prisma'

export const DEFAULT_WINDOW_DAYS = 7
export const VAULT_GRACE_DAYS = 7

export async function rollbackWindowDays(projectId: string): Promise<number> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } })
    if (!project?.userId) return DEFAULT_WINDOW_DAYS
    const { getUserEntitlements } = await import('@/lib/entitlements')
    const ent = await getUserEntitlements(project.userId)
    const days = ent?.logRetentionDays
    return typeof days === 'number' && days > 0 ? days : DEFAULT_WINDOW_DAYS
  } catch {
    return DEFAULT_WINDOW_DAYS
  }
}

export function windowEndsAt(createdAt: Date, windowDays: number): Date {
  return new Date(createdAt.getTime() + windowDays * 24 * 60 * 60 * 1000)
}
