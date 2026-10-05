/**
 * The billing account: whose plan, quotas, usage and credits a project uses.
 *
 * On Backenly Cloud that is the project's ORGANIZATION. Each organization has
 * its own plan, its own pooled quotas and usage, its own AI credits and its own
 * spend limit, the way Supabase bills per organization. Where there are no
 * organizations (a self-hosted deployment, or a project from before they
 * existed) it is the project's OWNER.
 *
 * Organization ids and user ids share one string space, which is why every
 * account-keyed table (usage_daily, account_ai_usage, account_credits,
 * usage_spend_limits, ...) keys on a plain string rather than a foreign key.
 * SQL that needs the same answer uses `COALESCE(p."organizationId", p."userId")`.
 */
import { prisma } from '@/lib/db/prisma'

/** The billing account of a project row already in hand. */
export function accountOf(project: { organizationId?: string | null; userId?: string | null }): string | null {
  return project.organizationId ?? project.userId ?? null
}

/**
 * The projects that bill to an account, as a Prisma filter: the account's
 * organization's projects, or the account's own org-less projects.
 */
export function accountProjectsWhere(billingAccountId: string) {
  return {
    OR: [{ organizationId: billingAccountId }, { organizationId: null, userId: billingAccountId }],
  }
}

/** The billing account of a project, or null when it does not exist. */
export async function billingAccountOf(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { organizationId: true, userId: true },
  })
  return project ? accountOf(project) : null
}

/**
 * Delete an account's own counters and balances (account_ai_usage,
 * account_credits). These used to live on, or hang off, the User row and were
 * deleted with it; keyed by a plain string they no longer are, so whatever
 * deletes the account deletes them. The usage ledger and closed billing periods
 * are left alone, as they always were.
 */
export async function purgeAccountState(
  db: Pick<typeof prisma, 'accountAiUsage' | 'accountCredits'>,
  billingAccountId: string,
): Promise<void> {
  await db.accountAiUsage.deleteMany({ where: { billingAccountId } })
  await db.accountCredits.deleteMany({ where: { billingAccountId } })
}
