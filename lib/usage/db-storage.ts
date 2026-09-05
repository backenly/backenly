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
 * Fanning this out across every project is a different thing and lives
 * elsewhere: enumerating projects is control-plane work, not project-local
 * work. See lib/fleet/db-storage-sweep.ts.
 */
import { prisma } from '@/lib/db/prisma'

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

/**
 * Snapshot one project's real database footprint into ProjectUsage.
 *
 * Measures pg_total_relation_size across the project's workspace schema, so it
 * reflects what end-user inserts actually cost rather than only what the build
 * pipeline happened to create.
 *
 * Never throws: this runs on write paths and on a scheduled sweep, and a failed
 * measurement must not fail the mutation that triggered it.
 */
export async function snapshotProjectDbStorage(projectId: string): Promise<void> {
  const month = thisMonth()
  const schemaName = `workspace_${projectId}`

  try {
    // Query total size of all tables in the workspace schema
    const result = await prisma.$queryRawUnsafe<Array<{ total_bytes: bigint }>>(
      `SELECT COALESCE(SUM(pg_total_relation_size(quote_ident(schemaname) || '.' || quote_ident(tablename))), 0) AS total_bytes
       FROM pg_tables
       WHERE schemaname = $1`,
      schemaName
    )

    const totalBytes = Number(result[0]?.total_bytes ?? 0)
    const totalMb = totalBytes / (1024 * 1024)

    await prisma.projectUsage.upsert({
      where: { projectId_month: { projectId, month } },
      update: { dbStorageUsedMb: totalMb },
      create: { projectId, month, dbStorageUsedMb: totalMb },
    })
  } catch (err) {
    console.error(`[UsageTracker] DB storage snapshot failed for ${projectId}:`, err)
  }
}
