/**
 * Measure how much file storage a project holds, from the storage metadata.
 *
 * The number is SUM(storage_files.size) over files that are not deleted: the
 * record the storage service itself keeps of every object it stored. It is not
 * Project.storageUsed, a running counter that drifts (an unconfirmed signed
 * upload is counted at signing, a soft delete subtracts before the object is
 * purged) and was client-writable until #151.
 *
 * Deleted-but-not-yet-purged objects are not counted: that storage is
 * Backenly's cost, not the customer's.
 *
 * The scheduled sweep asks FleetScheduler which projects to measure, like the
 * database sweep (./db-storage.ts): measuring one project is product, deciding
 * which projects is control plane.
 */
import { prisma } from '@/lib/db/prisma'
import { recordUsage } from '@/lib/usage/ledger'

export async function measureFileBytes(projectIds: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  if (projectIds.length === 0) return out
  for (const id of projectIds) out.set(id, BigInt(0))
  const rows = await prisma.$queryRaw<Array<{ projectId: string; bytes: bigint | null }>>`
    SELECT "projectId", COALESCE(SUM("size"), 0)::bigint AS bytes
    FROM "storage_files"
    WHERE "deletedAt" IS NULL AND "projectId" = ANY(${projectIds}::text[])
    GROUP BY "projectId"`
  for (const r of rows) out.set(r.projectId, BigInt(r.bytes ?? 0))
  return out
}

/**
 * Record a `file_bytes` gauge for each target. A project with no files records
 * zero, which is a real reading (the gauge keeps the day's maximum, so a zero
 * never hides a larger sample from earlier in the day).
 */
export async function reconcileFileStorage(targets: Array<{ id: string; userId: string | null }>): Promise<number> {
  const sizes = await measureFileBytes(targets.map((t) => t.id))
  for (const t of targets) {
    recordUsage({
      projectId: t.id,
      axis: 'file_bytes',
      quantity: sizes.get(t.id) ?? BigInt(0),
      source: 'metadata',
      billingAccountId: t.userId,
    })
  }
  return targets.length
}

export async function reconcileScheduledFileStorage(): Promise<number> {
  const { getFleetScheduler } = await import('@/lib/edition')
  const targets = await getFleetScheduler().maintenanceTargets()
  return reconcileFileStorage(targets)
}
