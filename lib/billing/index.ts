/**
 * Billing Library
 *
 * Canonical source for all plan entitlements and usage enforcement.
 * Every limit check in the platform routes through here.
 *
 * Tracking model: monthly (YYYY-MM key in UserAiUsage).
 * Null values on Plan fields always mean "unlimited."
 */

import { prisma } from '@/lib/db/prisma'
import { Plan, Subscription, SubscriptionStatus } from '@prisma/client'
import { getBonusCredits } from './credit-ledger'
import {
  creditsFromTokens,
  enforceAiBuildAction,
  getMonthlyUsage,
  noEntitlements,
  nextMonthStart,
  thisMonth,
  violation,
  type LimitViolation,
} from '@/lib/entitlements/policy'
import {
  invalidateUsageCache,
  readUsageCache,
  writeUsageCache,
} from '@/lib/entitlements/usage-cache'

export type PlanWithLimits = Plan
export type UserSubscription = Subscription & { plan: Plan }

// ─── Core subscription helpers ───────────────────────────────────────────────

export async function getPlans(): Promise<Plan[]> {
  return prisma.plan.findMany({ orderBy: { priceCents: 'asc' } })
}

export async function getPlanByName(name: string): Promise<Plan | null> {
  return prisma.plan.findUnique({ where: { name } })
}

export async function getUserSubscription(userId: string): Promise<UserSubscription | null> {
  return prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: ['ACTIVE', 'FREE', 'GRACE'] },
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  })
}

/**
 * The one place that answers "which Plan row is the free tier?".
 *
 * SANDBOX is the seeded name (prisma/seed-billing.ts). FREE is not seeded and
 * exists only on installations bootstrapped from scripts/add-billing-minimal.sql,
 * so the fallback is what keeps those self-hosted databases working — it is not
 * dead code, and removing it would strand them with no downgrade target.
 *
 * Throws rather than returning null on purpose. Every caller is either creating
 * a subscription or downgrading one, and there is no sane way to finish either
 * without a plan to point at. The previous code logged and moved on, which meant
 * expired subscriptions were silently never downgraded: a lapsed payer kept
 * their paid plan, the cron reported success, and nothing in the logs said so.
 * Failing loudly is the whole point of this function.
 */
export async function resolveFreePlan(): Promise<Plan> {
  const plan = await getPlanByName('SANDBOX') ?? await getPlanByName('FREE')
  if (!plan) {
    throw new Error(
      'No free plan found: neither SANDBOX nor legacy FREE exists in the plans table. ' +
      'Billing cannot create or downgrade subscriptions without one. ' +
      'Run: npx tsx prisma/seed-billing.ts',
    )
  }
  return plan
}

export async function createFreeSubscription(userId: string): Promise<Subscription> {
  const plan = await resolveFreePlan()
  return prisma.subscription.create({
    data: { userId, planId: plan.id, status: 'FREE' },
  })
}

// ─── What moved out ─────────────────────────────────────────────────────────
//
// Entitlement resolution, the plan-limit enforcement family, the usage
// trackers, the credit gate and the tier naming they share now live in
// lib/entitlements. They answer "may this happen?", which is a product
// question the public repository has to be able to answer on its own.
//
// What stays here is commercial: Plan and Subscription rows, the credit
// ledger write below, and the usage summary the billing page renders.

/**
 * Charge a completed AI turn's actual token usage against the month's credit
 * ledger. Call AFTER the turn, only when it produced a real backend change
 * (questions / clarifications are free). Fire-and-forget; never blocks.
 *
 * Overshoot is bounded to the single turn that crosses the line (same model
 * the API quota uses) — acceptable, and far simpler than reserving an unknown
 * token count up front.
 */
export async function chargeAiCredits(userId: string, tokensUsed: number): Promise<void> {
  if (!Number.isFinite(tokensUsed) || tokensUsed <= 0) return
  const month = thisMonth()
  try {
    await prisma.userAiUsage.upsert({
      where: { userId_date: { userId, date: month } },
      update: { tokenCount: { increment: tokensUsed }, intentCount: { increment: 1 } },
      create: { userId, date: month, tokenCount: tokensUsed, intentCount: 1 },
    })
    invalidateUsageCache(userId)

    const sub = await getUserSubscription(userId)
    const maxCredits = sub?.plan?.monthlyAiCredits
    if (maxCredits) {
      // Notify against the real cap, bonus included, so a user with granted
      // credits isn't warned "low" while they still have bonus to spend.
      const bonus = await getBonusCredits(userId)
      const usage = await getMonthlyUsage(userId)
      const creditsUsed = creditsFromTokens(usage.aiTokensUsed)
      const { checkAndNotifyCreditsLow } = await import('@/lib/notifications/platform')
      checkAndNotifyCreditsLow(userId, month, creditsUsed, maxCredits + bonus).catch(() => {})
    }
  } catch (err: any) {
    console.warn(`[Billing] chargeAiCredits failed for ${userId}:`, err?.message)
  }
}

// ─── Usage summary (cached 30s) ──────────────────────────────────────────────

export interface UserUsageSummary {
  planName: string
  projectsUsed: number
  maxProjects: number | null
  maxPostgresStorageMb: number | null
  maxFileStorageMb: number | null
  maxRealtimeConnections: number | null
  aiBuildActionsUsed: number
  maxAiBuildActionsPerMonth: number | null
  aiCreditsUsed: number
  monthlyAiCredits: number | null
  aiFunctionInvocationsUsed: number
  maxAiFunctionInvocationsPerMonth: number | null
  apiRequestsUsed: bigint
  maxApiRequestsPerMonth: bigint | null
  apiQuotaIsLifetime: boolean
  monthlyActiveUsersUsed: number
  maxMonthlyActiveUsers: number | null
  dbStorageUsedMb: number
  fileStorageUsedMb: number
  maxTeamSeats: number
  maxTriggersPerProject: number | null
  resetAt: Date

  // Legacy aliases
  aiUsedToday: number
  aiLimit: number | null
  apiRateLimitPerMin: number
  rowsUsedPerProject: Array<{ projectId: string; projectName: string; rowCount: number; maxRows: number | null }>
  maxRowsPerProject: number | null
}

export async function getUserUsageSummary(
  userId: string,
  skipCache = false
): Promise<UserUsageSummary | null> {
  if (!skipCache) {
    const cached = readUsageCache<UserUsageSummary>(userId)
    if (cached) return cached
  }

  const sub = await getUserSubscription(userId)
  if (!sub) return null

  const p = sub.plan
  const month = thisMonth()
  const [projects, monthlyUsage, lifetimeRow] = await Promise.all([
    prisma.project.findMany({ where: { userId }, select: { id: true, name: true, rowCount: true, storageUsed: true } }),
    getMonthlyUsage(userId),
    p.apiQuotaIsLifetime
      ? prisma.userAiUsage.findUnique({ where: { userId_date: { userId, date: 'LIFETIME' } }, select: { apiRequestCount: true } })
      : Promise.resolve(null),
  ])
  const projectIds = projects.map((pr) => pr.id)

  // MAU + measured DB storage across the account's projects for this month.
  const [mauUsed, dbUsageAgg] = await Promise.all([
    projectIds.length
      ? prisma.projectActiveUser.count({ where: { projectId: { in: projectIds }, month } })
      : Promise.resolve(0),
    projectIds.length
      ? prisma.projectUsage.aggregate({
          where: { projectId: { in: projectIds }, month },
          _sum: { dbStorageUsedMb: true },
        })
      : Promise.resolve({ _sum: { dbStorageUsedMb: 0 } } as any),
  ])

  const apiRequestsUsed = p.apiQuotaIsLifetime
    ? (lifetimeRow?.apiRequestCount ?? BigInt(0))
    : monthlyUsage.apiRequests
  const fileStorageUsedMb =
    projects.reduce((s, pr) => s + Number(pr.storageUsed ?? BigInt(0)), 0) / (1024 * 1024)

  const summary: UserUsageSummary = {
    planName: p.name,
    projectsUsed: projects.length,
    maxProjects: p.maxProjects ?? null,
    maxPostgresStorageMb: p.maxPostgresStorageMb ?? null,
    maxFileStorageMb: p.maxFileStorageMb ?? null,
    maxRealtimeConnections: p.maxRealtimeConnections ?? null,
    aiBuildActionsUsed: monthlyUsage.aiBuildActions,
    maxAiBuildActionsPerMonth: p.maxAiBuildActionsPerMonth ?? null,
    aiCreditsUsed: creditsFromTokens(monthlyUsage.aiTokensUsed),
    monthlyAiCredits: p.monthlyAiCredits ?? null,
    aiFunctionInvocationsUsed: monthlyUsage.aiFunctionInvocations,
    maxAiFunctionInvocationsPerMonth: p.maxAiFunctionInvocationsPerMonth ?? null,
    apiRequestsUsed,
    maxApiRequestsPerMonth: p.maxApiRequestsPerMonth ?? null,
    apiQuotaIsLifetime: p.apiQuotaIsLifetime,
    monthlyActiveUsersUsed: mauUsed,
    maxMonthlyActiveUsers: p.maxMonthlyActiveUsers ?? null,
    dbStorageUsedMb: Math.round(dbUsageAgg?._sum?.dbStorageUsedMb ?? 0),
    fileStorageUsedMb: Math.round(fileStorageUsedMb),
    maxTeamSeats: p.maxTeamSeats,
    maxTriggersPerProject: p.maxTriggersPerProject ?? null,
    resetAt: nextMonthStart(),

    // Legacy aliases consumed by older UI code
    aiUsedToday: monthlyUsage.aiBuildActions,
    aiLimit: p.maxAiBuildActionsPerMonth ?? null,
    apiRateLimitPerMin: p.apiRateLimitPerMin,
    rowsUsedPerProject: projects.map((pr) => ({
      projectId: pr.id,
      projectName: pr.name,
      rowCount: pr.rowCount,
      maxRows: p.maxRowsPerProject ?? null,
    })),
    maxRowsPerProject: p.maxRowsPerProject ?? null,
  }

  writeUsageCache(userId, summary)
  return summary
}

// ─── Row count helpers (legacy, still used by older routes) ─────────────────

export async function incrementProjectRowCount(projectId: string, count = 1): Promise<void> {
  await prisma.project.update({ where: { id: projectId }, data: { rowCount: { increment: count } } })
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } })
  if (project?.userId) invalidateUsageCache(project.userId)
}

export async function decrementProjectRowCount(projectId: string, count = 1): Promise<void> {
  await prisma.project.update({ where: { id: projectId }, data: { rowCount: { decrement: count } } })
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } })
  if (project?.userId) invalidateUsageCache(project.userId)
}

export async function enforceRowInsertion(projectId: string, currentRowCount: number): Promise<true | LimitViolation> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      user: { include: { subscriptions: { include: { plan: true }, orderBy: { createdAt: 'desc' }, take: 1 } } },
    },
  })
  if (!project?.user) return noEntitlements()

  const sub = project.user.subscriptions[0]
  if (!sub) return noEntitlements()

  const max = sub.plan.maxRowsPerProject
  if (max !== null && currentRowCount >= max) {
    return violation(sub.plan.name, `Row limit of ${max.toLocaleString()} reached for this project on the ${sub.plan.name} plan.`)
  }
  return true
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

export function formatPrice(cents: number): string {
  if (cents === 0) return 'Free'
  return `$${(cents / 100).toFixed(0)}`
}

export function formatLimit(limit: number | bigint | null): string {
  if (limit === null) return 'Unlimited'
  if (typeof limit === 'bigint') {
    const n = Number(limit)
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
    return n.toString()
  }
  if (limit >= 1_000_000) return `${(limit / 1_000_000).toFixed(0)}M`
  if (limit >= 1_000) return `${(limit / 1_000).toFixed(0)}k`
  return limit.toLocaleString()
}

export function formatStorage(mb: number | null): string {
  if (mb === null) return 'Unlimited'
  if (mb >= 1_024) return `${(mb / 1_024).toFixed(0)} GB`
  return `${mb} MB`
}

export function getSubscriptionStatusDisplay(status: SubscriptionStatus): string {
  const map: Record<SubscriptionStatus, string> = {
    ACTIVE: 'Active',
    FREE: 'Free',
    GRACE: 'Grace Period',
    CANCELED: 'Canceled',
    PAST_DUE: 'Past Due',
  }
  return map[status] ?? status
}

/** @deprecated use getUserEntitlements */
export function getTokenCap(planName: string): number {
  switch (planName) {
    case 'FREE': return 3_000
    case 'STARTER': return 6_000
    case 'GROWTH': return 16_000
    case 'PRO': return 32_000
    default: return 3_000
  }
}

/** @deprecated use enforceAiBuildAction */
export async function canUseAiIntent(userId: string, _dailyCount: number): Promise<boolean> {
  const result = await enforceAiBuildAction(userId)
  return result === true
}

/** @deprecated use getUserEntitlements */
export async function getUserRateLimit(userId: string): Promise<number> {
  const sub = await getUserSubscription(userId)
  return sub?.plan.apiRateLimitPerMin ?? 60
}

/** @deprecated use getUserEntitlements */
export async function hasFeatureAccess(
  userId: string,
  feature: 'webhooks' | 'customDomain' | 'prioritySupport'
): Promise<boolean> {
  const sub = await getUserSubscription(userId)
  if (!sub) return false
  switch (feature) {
    case 'webhooks': return sub.plan.allowWebhooks
    case 'customDomain': return sub.plan.allowCustomDomain
    case 'prioritySupport': return sub.plan.prioritySupport
    default: return false
  }
}

// Legacy: kept for routes that still call getTodayAiUsage
export async function getTodayAiUsage(userId: string) {
  const usage = await getMonthlyUsage(userId)
  return { count: usage.aiBuildActions, tokens: 0 }
}
