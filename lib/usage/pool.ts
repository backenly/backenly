/**
 * An account's usage this month, pooled across all of its projects.
 *
 * Plan quotas belong to the billing account, not to a project: a Pro owner's
 * 10 GB of database is shared by every project they own, however many that is.
 * Enforcing per project made the real cap N x 10 GB. Every quota check and
 * every usage alert reads the account's total from here.
 *
 * These are the enforcement readings, taken from the operational tables that
 * the gates already trust, so a check sees a change the moment it happens:
 *
 *   mau          project_active_users for the month, over the account's
 *                current projects
 *   fnRuns       UserAiUsage.aiFunctionInvocations for the month (already
 *                per account)
 *   dbBytes      each current project's latest measured size (project_usage)
 *   fileBytes    each current project's stored-bytes counter, which counts an
 *                upload from the moment it is signed so two uploads cannot race
 *                past the quota
 *   egressBytes  the usage ledger (usage_daily), the only record of egress,
 *                over the sources the close bills
 *
 * What is BILLED is the monthly close of the usage ledger (./close.ts). The two
 * can differ in the customer's favour (a deleted project's users stop counting
 * here, never in the ledger), never against them.
 */
import { prisma } from '@/lib/db/prisma'
import { periodBounds, utcPeriod } from '@/lib/usage/axes'
import { egressSources } from '@/lib/usage/close'

const MB = 1024 * 1024

export interface AccountUsage {
  billingAccountId: string
  period: string
  mau: number
  fnRuns: number
  egressBytes: bigint
  dbBytes: bigint
  fileBytes: bigint
}

export async function accountUsage(billingAccountId: string, at: Date = new Date()): Promise<AccountUsage> {
  const period = utcPeriod(at)
  const { start, end } = periodBounds(period)
  const sources = egressSources()

  const [mauRows, aiUsage, egressRows, dbRows, fileRows] = await Promise.all([
    prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM "project_active_users" a
      JOIN "projects" p ON p."id" = a."projectId"
      WHERE p."userId" = ${billingAccountId} AND a."month" = ${period}`,
    prisma.userAiUsage.findUnique({
      where: { userId_date: { userId: billingAccountId, date: period } },
      select: { aiFunctionInvocations: true },
    }),
    prisma.$queryRaw<Array<{ bytes: bigint | null }>>`
      SELECT COALESCE(SUM("quantity"), 0)::bigint AS bytes
      FROM "usage_daily"
      WHERE "billingAccountId" = ${billingAccountId}
        AND "axis" = 'egress_bytes'
        AND "day" >= ${start}::date AND "day" < ${end}::date
        AND "source" = ANY(${sources}::text[])`,
    prisma.$queryRaw<Array<{ mb: number | null }>>`
      SELECT COALESCE(SUM(latest."dbStorageUsedMb"), 0)::float8 AS mb
      FROM (
        SELECT DISTINCT ON (u."projectId") u."dbStorageUsedMb"
        FROM "project_usage" u
        JOIN "projects" p ON p."id" = u."projectId"
        WHERE p."userId" = ${billingAccountId}
        ORDER BY u."projectId", u."month" DESC
      ) latest`,
    prisma.$queryRaw<Array<{ bytes: bigint | null }>>`
      SELECT COALESCE(SUM(GREATEST("storageUsed", 0)), 0)::bigint AS bytes
      FROM "projects"
      WHERE "userId" = ${billingAccountId}`,
  ])

  return {
    billingAccountId,
    period,
    mau: mauRows[0]?.n ?? 0,
    fnRuns: aiUsage?.aiFunctionInvocations ?? 0,
    egressBytes: BigInt(egressRows[0]?.bytes ?? 0),
    dbBytes: BigInt(Math.round((dbRows[0]?.mb ?? 0) * MB)),
    fileBytes: BigInt(fileRows[0]?.bytes ?? 0),
  }
}

/** The project's owning billing account (its owner's user id today), or null. */
export async function billingAccountOf(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } })
  return project?.userId ?? null
}
