/**
 * Database storage measured when someone reads it.
 *
 * Storage is measured, not counted (./db-storage.ts measures one project). The
 * scheduled sweep measures every project on the hour, and nothing else
 * measured rows an app wrote, so the Usage page showed a bulk load up to an
 * hour late. This is the account-level read the Usage page and the agent's
 * usage read take first. Which projects belong to an account is the same
 * question the pooled quotas answer (./pool.ts); which projects a scheduled
 * sweep covers stays the scheduler's.
 */
import { prisma } from '@/lib/db/prisma'
import { accountProjectsWhere } from '@/lib/usage/account'
import { snapshotProjectDbStorage } from '@/lib/usage/db-storage'

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

/** How old a project's measured size may be when someone reads the account's usage. */
export const STORAGE_READ_MAX_AGE_MS = 5 * 60_000

/** The most projects one read measures, the stalest first; the rest keep their last reading. */
const STORAGE_READ_MEASURE_LIMIT = 20

/**
 * Before an account's usage is read, measure each of its projects whose last
 * reading is more than five minutes old, and say when the total was measured.
 *
 * The scheduled sweep measures every project on the hour, and nothing else
 * measures rows an app writes, so the Usage page showed a bulk load up to an
 * hour late: production QA (2026-11-09, report 108) read "Database storage
 * 2 MB of 512 MB" more than 30 minutes after loading about 300 MB. A reading is
 * one catalog query per project, so a person or an agent reading usage pays
 * for at most twenty of them.
 *
 * Returns when the oldest reading the account's total rests on was taken, or
 * null when no project of the account has been measured. Never throws: a read
 * that cannot measure shows the last reading, and says how old it is.
 */
export async function measureAccountDbStorage(billingAccountId: string, now: Date = new Date()): Promise<Date | null> {
  try {
    const projects = await prisma.project.findMany({
      where: accountProjectsWhere(billingAccountId),
      select: { id: true },
    })
    if (projects.length === 0) return null
    const lastReading = async () => {
      const rows = await prisma.projectUsage.findMany({
        where: { projectId: { in: projects.map((p) => p.id) } },
        orderBy: { month: 'desc' },
        distinct: ['projectId'],
        select: { projectId: true, month: true, updatedAt: true },
      })
      return new Map(rows.map((r) => [r.projectId, r]))
    }
    const month = thisMonth()
    const before = await lastReading()
    const stale = projects
      .map((p) => ({ id: p.id, at: before.get(p.id)?.month === month ? before.get(p.id)!.updatedAt.getTime() : 0 }))
      .filter((p) => now.getTime() - p.at > STORAGE_READ_MAX_AGE_MS)
      .sort((a, b) => a.at - b.at)
      .slice(0, STORAGE_READ_MEASURE_LIMIT)
    // One at a time: each holds a connection to the project's own database.
    for (const p of stale) await snapshotProjectDbStorage(p.id, billingAccountId)
    const after = stale.length > 0 ? await lastReading() : before
    const times = [...after.values()].map((r) => r.updatedAt.getTime())
    return times.length > 0 ? new Date(Math.min(...times)) : null
  } catch (err) {
    console.error(`[UsageTracker] measuring storage for account ${billingAccountId} failed:`, err instanceof Error ? err.message : err)
    return null
  }
}
