/**
 * Measure how much database a project is actually using.
 *
 * This is product functionality, not billing. Knowing the size of a project's
 * workspace schema is how the backend reports storage in the dashboard and how
 * the quota kernel decides whether a metered plan has run out of room. Cloud
 * charges for the number; measuring it is the product's own job, and a
 * self-hoster is entitled to see it on infrastructure they own.
 *
 * It lived under lib/billing because billing was its first consumer. That is
 * not what it is.
 *
 * Fanning it out is a different thing. Measuring ONE project is product;
 * deciding WHICH projects to measure is control plane, so the scheduled sweep
 * below asks FleetScheduler for its targets and does not know how to find them
 * itself. Single-tenant answers with THE project, Cloud with its estate.
 */
import { prisma } from '@/lib/db/prisma'
import { projectSchemaPrefix, workspaceSchemaName } from '@/lib/security/workspace-schema'
import { recordUsage } from '@/lib/usage/ledger'
import { workspaceRawClient } from '@/lib/data-plane/regional'

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

/**
 * On-disk bytes of every schema a project owns: its workspace schema and each
 * branch (or staging) schema of the same project. Tables, indexes and TOAST.
 *
 * The schemas are read from pg_namespace, matched as the canonical name or with
 * `left(nspname, length(prefix)) = prefix`, the same rule project deletion uses:
 * `_` is a LIKE wildcard and `workspace_` is full of them, so a LIKE here would
 * be one escaping mistake away from measuring another tenant.
 *
 * Measured on the database in the project's region. Asked of another region's
 * database, the schemas are simply absent and the answer is 0 bytes, which would
 * be recorded as the project's size for the quota check and for billing. A
 * region this process cannot reach throws instead, and nothing is recorded.
 */
export async function measureProjectDbBytes(projectId: string): Promise<bigint> {
  const canonical = workspaceSchemaName(projectId)
  const prefix = projectSchemaPrefix(projectId)
  const db = await workspaceRawClient(projectId)
  const rows = await db.$queryRaw<Array<{ total_bytes: bigint | null }>>`
    SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::bigint AS total_bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE (n.nspname = ${canonical} OR left(n.nspname, length(${prefix})) = ${prefix})
      AND c.relkind IN ('r', 'm', 'p')`
  return BigInt(rows[0]?.total_bytes ?? 0)
}

/**
 * Snapshot one project's real database footprint.
 *
 * Writes two things from ONE measurement: ProjectUsage (the current month's
 * last reading, which the quota check reads) and a `db_bytes` gauge in the
 * usage ledger, which keeps each day's maximum for billing.
 *
 * Never throws: this runs on write paths and on a scheduled sweep, and a failed
 * measurement must not fail the mutation that triggered it.
 */
export async function snapshotProjectDbStorage(projectId: string, billingAccountId?: string | null): Promise<void> {
  const month = thisMonth()

  try {
    const totalBytes = await measureProjectDbBytes(projectId)
    const totalMb = Number(totalBytes) / (1024 * 1024)

    await prisma.projectUsage.upsert({
      where: { projectId_month: { projectId, month } },
      update: { dbStorageUsedMb: totalMb },
      create: { projectId, month, dbStorageUsedMb: totalMb },
    })
    recordUsage({ projectId, axis: 'db_bytes', quantity: totalBytes, source: 'pg', billingAccountId })
  } catch (err) {
    console.error(`[UsageTracker] DB storage snapshot failed for ${projectId}:`, err)
  }
}

/**
 * Snapshot every project a maintenance pass covers.
 *
 * The set comes from FleetScheduler; the measurement is the per-project
 * primitive above. This function therefore contains no enumeration at all,
 * which is the point: it used to live in lib/fleet/db-storage-sweep.ts and open
 * with `prisma.project.findMany`, and that query is the whole of what made it
 * control-plane code.
 *
 * allSettled rather than all: one project schema being mid-migration, locked or
 * already dropped must not abandon the rest of the sweep.
 */
export async function snapshotScheduledDbStorage(): Promise<void> {
  const { getFleetScheduler } = await import('@/lib/edition')
  const targets = await getFleetScheduler().maintenanceTargets()
  // The ledger resolves each project's billing account (its organization on
  // Cloud) when it applies the batch; the target's owner is not that account.
  await Promise.allSettled(targets.map(t => snapshotProjectDbStorage(t.id)))
}
