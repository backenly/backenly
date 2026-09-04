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
import crypto from 'crypto'
import { getBonusCredits } from './credit-ledger'
import { currentEdition } from '@/lib/edition'

/**
 * Derive a stable 32-bit advisory lock key from a (userId, month) tuple.
 * pg_advisory_xact_lock takes a bigint but we use two int4s via the overload
 * pg_advisory_xact_lock(key1 int4, key2 int4) to stay within safe integer range.
 */
function advisoryLockKeys(userId: string, month: string): [number, number] {
  const hash = crypto.createHash('sha256').update(`${userId}:${month}`).digest()
  // Read two signed 32-bit ints from the hash bytes (big-endian)
  const k1 = hash.readInt32BE(0)
  const k2 = hash.readInt32BE(4)
  return [k1, k2]
}

export type PlanWithLimits = Plan
export type UserSubscription = Subscription & { plan: Plan }

// ─── Next-tier lookup ────────────────────────────────────────────────────────
// Current tiers (v4): SANDBOX (Free $0) → BUILDER (Pro $25) → SCALE (Enterprise, custom)
// Legacy tiers (backward compat): FREE → STARTER → GROWTH → PRO
const TIER_ORDER = ['SANDBOX', 'FREE', 'STARTER', 'BUILDER', 'GROWTH', 'PRO', 'SCALE'] as const
type TierName = typeof TIER_ORDER[number]

// Human-readable display names for plan codes
const PLAN_DISPLAY: Record<string, string> = {
  SANDBOX: 'Free',
  BUILDER: 'Pro',
  SCALE: 'Enterprise',
  FREE: 'Free',
  STARTER: 'Starter',
  GROWTH: 'Growth',
  PRO: 'Pro',
}

function planDisplayName(name: string): string {
  return PLAN_DISPLAY[name.toUpperCase()] ?? name
}

function nextTier(current: string): string {
  const upper = current.toUpperCase()
  const idx = TIER_ORDER.indexOf(upper as TierName)
  if (idx === -1) return 'BUILDER'
  return TIER_ORDER[Math.min(idx + 1, TIER_ORDER.length - 1)]
}

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

// ─── Entitlements resolver ───────────────────────────────────────────────────

export interface UserEntitlements {
  planName: string
  priceCents: number
  annualPriceCents: number | null

  maxProjects: number | null
  maxAiBuildActionsPerMonth: number | null
  monthlyAiCredits: number | null
  maxApiRequestsPerMonth: bigint | null
  maxPostgresStorageMb: number | null
  maxFileStorageMb: number | null
  maxRealtimeConnections: number | null
  maxAiFunctionInvocationsPerMonth: number | null
  maxTriggersPerProject: number | null
  maxTeamSeats: number
  maxDeploymentHistory: number | null

  logRetentionDays: number
  supportResponseHours: number | null
  allowedAuthProviders: string[]

  allowCustomDomain: boolean
  allowAdvancedMonitoring: boolean
  allowRbac: boolean
  allowSso: boolean
  allowDeploymentRollback: boolean
  allowWebhooks: boolean
  prioritySupport: boolean

  // New: sandbox & billing flags
  allowDeployment: boolean
  isSandboxPlan: boolean
  sandboxExpiryDays: number | null
  isPayAsYouGo: boolean
}

/**
 * Self-hosted entitlements: everything, metered by nothing.
 *
 * A self-hoster is already paying for their own hardware, their own Postgres
 * and their own model tokens. There is nobody to bill and no plan to resolve,
 * so quotas here would only be an artificial ceiling on infrastructure the
 * operator owns.
 *
 * Returned WITHOUT touching the plans or subscriptions tables, which is the
 * point rather than an optimisation. `resolveFreePlan()` throws when neither
 * SANDBOX nor FREE exists, so an unseeded database used to break signup and
 * checkout on a fresh self-host install. Single-tenant now needs no seed at
 * all: `npm run bootstrap` provisions a working project and never creates a
 * Plan or a Subscription row.
 *
 * `null` means unlimited throughout this module, so this is the same shape the
 * quota kernel already understands. Nothing downstream needs an edition check.
 */
function selfHostedEntitlements(): UserEntitlements {
  return {
    planName: 'SELF_HOSTED',
    priceCents: 0,
    annualPriceCents: null,

    maxProjects: 1, // one deployment is one project
    maxAiBuildActionsPerMonth: null,
    monthlyAiCredits: null,
    maxApiRequestsPerMonth: null,
    maxPostgresStorageMb: null,
    maxFileStorageMb: null,
    maxRealtimeConnections: null,
    maxAiFunctionInvocationsPerMonth: null,
    maxTriggersPerProject: null,
    maxTeamSeats: 1,
    maxDeploymentHistory: null,

    logRetentionDays: 365,
    supportResponseHours: null,
    allowedAuthProviders: ['email', 'google', 'github'],

    allowCustomDomain: true,
    allowAdvancedMonitoring: true,
    // RBAC and SSO are false because they are not withheld, they do not exist
    // here: organizations, roles and invites are the Cloud control plane.
    allowRbac: false,
    allowSso: false,
    allowDeploymentRollback: true,
    allowWebhooks: true,
    prioritySupport: false,

    allowDeployment: true,
    isSandboxPlan: false,
    sandboxExpiryDays: null,
    isPayAsYouGo: false,
  }
}

export async function getUserEntitlements(userId: string): Promise<UserEntitlements | null> {
  if (currentEdition() === 'single-tenant') return selfHostedEntitlements()

  const sub = await getUserSubscription(userId)
  if (!sub) return null
  const p = sub.plan
  return {
    planName: p.name,
    priceCents: p.priceCents,
    annualPriceCents: p.annualPriceCents ?? null,

    maxProjects: p.maxProjects ?? null,
    maxAiBuildActionsPerMonth: p.maxAiBuildActionsPerMonth ?? null,
    monthlyAiCredits: p.monthlyAiCredits ?? null,
    maxApiRequestsPerMonth: p.maxApiRequestsPerMonth ?? null,
    maxPostgresStorageMb: p.maxPostgresStorageMb ?? null,
    maxFileStorageMb: p.maxFileStorageMb ?? null,
    maxRealtimeConnections: p.maxRealtimeConnections ?? null,
    maxAiFunctionInvocationsPerMonth: p.maxAiFunctionInvocationsPerMonth ?? null,
    maxTriggersPerProject: p.maxTriggersPerProject ?? null,
    maxTeamSeats: p.maxTeamSeats,
    maxDeploymentHistory: p.maxDeploymentHistory ?? null,

    logRetentionDays: p.logRetentionDays,
    supportResponseHours: p.supportResponseHours ?? null,
    allowedAuthProviders: p.allowedAuthProviders,

    allowCustomDomain: p.allowCustomDomain,
    allowAdvancedMonitoring: p.allowAdvancedMonitoring,
    allowRbac: p.allowRbac,
    allowSso: p.allowSso,
    allowDeploymentRollback: p.allowDeploymentRollback,
    allowWebhooks: p.allowWebhooks,
    prioritySupport: p.prioritySupport,

    allowDeployment: p.allowDeployment,
    isSandboxPlan: p.isSandboxPlan,
    sandboxExpiryDays: p.sandboxExpiryDays ?? null,
    isPayAsYouGo: p.isPayAsYouGo,
  }
}

// ─── Limit violation type ────────────────────────────────────────────────────

export interface LimitViolation {
  code: 'PLAN_LIMIT_EXCEEDED'
  upgradeRequired: true
  currentPlan: string
  requiredPlan: string
  message: string
}

function violation(currentPlan: string, message: string): LimitViolation {
  return {
    code: 'PLAN_LIMIT_EXCEEDED',
    upgradeRequired: true,
    currentPlan,
    requiredPlan: nextTier(currentPlan),
    message,
  }
}

function noSubscription(): LimitViolation {
  return {
    code: 'PLAN_LIMIT_EXCEEDED',
    upgradeRequired: true,
    currentPlan: 'NONE',
    requiredPlan: 'FREE',
    message: 'No active subscription found',
  }
}

// ─── Monthly date key ────────────────────────────────────────────────────────

function getThisMonth(): string {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

function getNextMonthStart(): Date {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
}

// ─── Monthly usage fetch ─────────────────────────────────────────────────────

export interface MonthlyUsage {
  aiBuildActions: number
  /** Raw AI tokens consumed this month (the credit ledger). */
  aiTokensUsed: number
  apiRequests: bigint
  aiFunctionInvocations: number
}

export async function getMonthlyUsage(userId: string): Promise<MonthlyUsage> {
  const month = getThisMonth()
  const record = await prisma.userAiUsage.findUnique({
    where: { userId_date: { userId, date: month } },
  })
  return {
    aiBuildActions: record?.intentCount ?? 0,
    aiTokensUsed: record?.tokenCount ?? 0,
    apiRequests: record?.apiRequestCount ?? BigInt(0),
    aiFunctionInvocations: record?.aiFunctionInvocations ?? 0,
  }
}

// ─── Token-backed AI credits ─────────────────────────────────────────────────
//
// WHY CREDITS, NOT ACTION COUNTS
// ------------------------------
// An "AI build action" was one chat message. One message can be "add a field"
// or a 4,000-word spec that builds an entire backend — both cost 1 action, so
// a user could extract ~the whole product on their first message. Credits are
// token-backed: a turn costs credits proportional to the tokens the model
// actually processed, so the cost tracks real work and the exploit is gone.
//
// The ratio is published and STABLE. Silently re-ratioing credits→tokens is
// exactly what broke trust at other vendors — never change this without a
// deliberate, announced pricing update.
//
// Autonomy (the always-on monitor/self-repair loop) NEVER deducts credits.
// That cost is funded by the platform — see lib/autonomy/* and background-monitor.
export const TOKENS_PER_CREDIT = 1_000

/** Whole credits consumed for a given raw token count (rounded up). */
export function creditsFromTokens(tokens: number): number {
  if (tokens <= 0) return 0
  return Math.ceil(tokens / TOKENS_PER_CREDIT)
}

/**
 * Pre-gate: may this user start an AI build turn? Blocks once the month's
 * credit budget is spent. Read-only — does NOT consume credits (a turn is
 * charged afterwards by chargeAiCredits, and only when it mutated state).
 *
 * FAIL-OPEN: a billing infra hiccup must never block a paying customer's
 * build. Only a real, measured budget breach blocks.
 */
/**
 * The month enforcement went live. Usage recorded before this point accrued
 * under a contract that did not meter it — `chargeAiCredits` had no callers, so
 * every token spent through the brain was free by construction. Enforcing that
 * history retroactively locks people out for activity that cost them nothing at
 * the time, which is exactly what happened on the cutover: one SANDBOX user was
 * sitting at 245 credits against a 200 cap and was refused the moment the gate
 * shipped.
 *
 * `UserAiUsage` aggregates by month, so the cutover month has no per-event
 * timestamps to split on — there is no way to charge only the post-cutover
 * portion of it. Skipping the month entirely is the honest resolution: it costs
 * at most one month of enforcement, applies uniformly rather than to whoever
 * happened to be over, and needs no retroactive edit to anyone's billing rows.
 *
 * This is self-expiring. From the following month the meter is real for
 * everyone, and this branch is dead code that can be deleted.
 */
const ENFORCEMENT_EPOCH_MONTH = '2026-07'

export async function enforceAiCredits(userId: string): Promise<true | LimitViolation> {
  try {
    if (getThisMonth() === ENFORCEMENT_EPOCH_MONTH) return true

    const sub = await getUserSubscription(userId)
    if (!sub) return noSubscription()

    const maxCredits = sub.plan.monthlyAiCredits
    if (maxCredits === null || maxCredits === undefined) return true // unlimited (fair-use)

    // Bonus credits (referral / promo grants) genuinely extend the monthly cap.
    const bonus = await getBonusCredits(userId)
    const effectiveMax = maxCredits + bonus

    const usage = await getMonthlyUsage(userId)
    const creditsUsed = creditsFromTokens(usage.aiTokensUsed)
    if (creditsUsed >= effectiveMax) {
      return violation(
        sub.plan.name,
        bonus > 0
          ? `You've used all ${effectiveMax.toLocaleString()} AI credits available this month (${maxCredits.toLocaleString()} plan + ${bonus.toLocaleString()} bonus) on the ${planDisplayName(sub.plan.name)} plan. Credits reset on the 1st — or upgrade for more.`
          : `You've used all ${maxCredits.toLocaleString()} AI credits this month on the ${planDisplayName(sub.plan.name)} plan. Credits reset on the 1st — or upgrade for more.`,
      )
    }
    return true
  } catch {
    return true // never break a build because billing had a hiccup
  }
}

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
  const month = getThisMonth()
  try {
    await prisma.userAiUsage.upsert({
      where: { userId_date: { userId, date: month } },
      update: { tokenCount: { increment: tokensUsed }, intentCount: { increment: 1 } },
      create: { userId, date: month, tokenCount: tokensUsed, intentCount: 1 },
    })
    usageCache.delete(`usage_${userId}`)

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

// ─── Usage tracking ──────────────────────────────────────────────────────────

export async function trackAiBuildAction(userId: string, tokenCount = 0): Promise<void> {
  const month = getThisMonth()
  await prisma.userAiUsage.upsert({
    where: { userId_date: { userId, date: month } },
    update: {
      intentCount: { increment: 1 },
      tokenCount: { increment: tokenCount },
    },
    create: { userId, date: month, intentCount: 1, tokenCount },
  })
  usageCache.delete(`usage_${userId}`)

  // Fire credits-low notification when usage crosses 80% threshold
  // Run asynchronously — never block the main execution path
  try {
    const sub = await getUserSubscription(userId)
    const max = sub?.plan?.maxAiBuildActionsPerMonth
    if (max) {
      const usage = await getMonthlyUsage(userId)
      const { checkAndNotifyCreditsLow } = await import('@/lib/notifications/platform')
      checkAndNotifyCreditsLow(userId, month, usage.aiBuildActions, max).catch(() => {})
    }
  } catch { /* non-fatal */ }
}

/**
 * Atomically enforce the AI build action limit AND increment the counter
 * in a single database transaction protected by a PostgreSQL advisory lock.
 *
 * Why: A naive read-check-then-increment approach has a race condition — two
 * concurrent requests both read count=N, both pass the limit check, and both
 * increment, overshooting the limit by one or more.  The advisory lock on
 * (userId, month) serialises concurrent enforce+track calls for the same user
 * without blocking unrelated users.
 *
 * Returns true when the action is allowed and the counter has been incremented.
 * Returns a LimitViolation when the limit is already reached (counter NOT incremented).
 */
export async function enforceAndTrackAiBuildAction(
  userId: string,
  tokenCount = 0
): Promise<true | LimitViolation> {
  const sub = await getUserSubscription(userId)
  if (!sub) return noSubscription()

  const max = sub.plan.maxAiBuildActionsPerMonth
  if (max === null) {
    // Unlimited plan — track asynchronously and immediately allow
    trackAiBuildAction(userId, tokenCount).catch(() => {})
    return true
  }

  const month = getThisMonth()
  const [k1, k2] = advisoryLockKeys(userId, month)

  const result = await prisma.$transaction(async (tx) => {
    // Acquire a transaction-scoped advisory lock keyed to (userId, month).
    // This blocks any other transaction attempting to take the same lock
    // until this transaction commits or rolls back — no deadlock risk because
    // each user+month pair maps to a unique key and we only ever lock one at a time.
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock($1::int4, $2::int4)`,
      k1, k2
    )

    // Read the current count inside the lock so the read is serialised
    const record = await tx.userAiUsage.findUnique({
      where: { userId_date: { userId, date: month } },
      select: { intentCount: true },
    })
    const currentCount = record?.intentCount ?? 0

    if (currentCount >= max) {
      return { allowed: false as const, count: currentCount }
    }

    // Increment inside the lock — guaranteed to be the only writer right now
    await tx.userAiUsage.upsert({
      where: { userId_date: { userId, date: month } },
      update: {
        intentCount: { increment: 1 },
        tokenCount: { increment: tokenCount },
      },
      create: { userId, date: month, intentCount: 1, tokenCount },
    })

    return { allowed: true as const, count: currentCount + 1 }
  })

  if (!result.allowed) {
    return violation(
      sub.plan.name,
      `You've used all ${max.toLocaleString()} AI build actions this month on the ${planDisplayName(sub.plan.name)} plan. Resets on the 1st.`
    )
  }

  usageCache.delete(`usage_${userId}`)

  // Fire low-credit notification asynchronously — never block the response
  try {
    if (max) {
      const { checkAndNotifyCreditsLow } = await import('@/lib/notifications/platform')
      checkAndNotifyCreditsLow(userId, month, result.count, max).catch(() => {})
    }
  } catch { /* non-fatal */ }

  return true
}

/** Track AI intent — alias for backward compatibility */
export const trackAiIntent = trackAiBuildAction

// Note: the real API-request tracker is enforceAndTrackApiRequest in
// lib/billing/quota-kernel.ts (called by lib/api/v1/middleware.ts). The
// previous standalone trackApiRequest() here was dead code and was removed.

export async function trackAiFunctionInvocation(userId: string, count = 1): Promise<void> {
  const month = getThisMonth()
  await prisma.userAiUsage.upsert({
    where: { userId_date: { userId, date: month } },
    update: { aiFunctionInvocations: { increment: count } },
    create: { userId, date: month, aiFunctionInvocations: count },
  })
  usageCache.delete(`usage_${userId}`)
}

// ─── Enforcement helpers ─────────────────────────────────────────────────────

export async function enforceProjectCreation(
  userId: string,
  currentProjectCount: number
): Promise<true | LimitViolation> {
  const sub = await getUserSubscription(userId)
  if (!sub) return noSubscription()

  const max = sub.plan.maxProjects
  if (max !== null && currentProjectCount >= max) {
    return violation(
      sub.plan.name,
      `You've reached the ${max}-project limit on the ${planDisplayName(sub.plan.name)} plan. Upgrade to add more projects.`
    )
  }
  return true
}

export async function enforceAiBuildAction(userId: string): Promise<true | LimitViolation> {
  const sub = await getUserSubscription(userId)
  if (!sub) return noSubscription()

  const max = sub.plan.maxAiBuildActionsPerMonth
  if (max === null) return true

  const usage = await getMonthlyUsage(userId)
  if (usage.aiBuildActions >= max) {
    return violation(
      sub.plan.name,
      `You've used all ${max.toLocaleString()} AI build actions this month on the ${planDisplayName(sub.plan.name)} plan. Resets on the 1st.`
    )
  }
  return true
}

/** Alias for backward compatibility */
export const checkAiIntentLimit = async (userId: string) => {
  const sub = await getUserSubscription(userId)
  if (!sub) return { allowed: false, code: 'AI_LIMIT_EXCEEDED' as const, remaining: 0, limit: 0, resetAt: getNextMonthStart(), usedToday: 0 }

  const max = sub.plan.maxAiBuildActionsPerMonth
  if (max === null) return { allowed: true, remaining: 999_999, limit: null, resetAt: getNextMonthStart(), usedToday: 0 }

  const usage = await getMonthlyUsage(userId)
  const remaining = Math.max(0, max - usage.aiBuildActions)
  if (usage.aiBuildActions >= max) {
    return { allowed: false, code: 'AI_LIMIT_EXCEEDED' as const, remaining: 0, limit: max, resetAt: getNextMonthStart(), usedToday: usage.aiBuildActions }
  }
  return { allowed: true, remaining, limit: max, resetAt: getNextMonthStart(), usedToday: usage.aiBuildActions }
}

export async function enforceAiFunctionInvocation(userId: string): Promise<true | LimitViolation> {
  const sub = await getUserSubscription(userId)
  if (!sub) return noSubscription()

  const max = sub.plan.maxAiFunctionInvocationsPerMonth
  if (max === null) return true

  const usage = await getMonthlyUsage(userId)
  if (usage.aiFunctionInvocations >= max) {
    return violation(
      sub.plan.name,
      `You've used all ${max.toLocaleString()} AI Function invocations this month on the ${planDisplayName(sub.plan.name)} plan.`
    )
  }
  return true
}

/**
 * @deprecated Realtime connection caps are enforced by the ListenerHub
 * (lib/realtime/listener-hub.ts) via lib/billing/quota-kernel.ts
 * enforceRealtimeConnection. This wrapper delegates so any legacy caller
 * stays on the single kernel path.
 */
export async function enforceRealtimeConnection(
  projectId: string,
  currentConnections: number
): Promise<true | LimitViolation> {
  const { enforceRealtimeConnection: kernelEnforce } = await import('./quota-kernel')
  const decision = await kernelEnforce(projectId, currentConnections)
  if (decision.allowed) return true
  return violation(decision.plan ?? 'UNKNOWN', decision.message ?? 'Realtime connection limit reached')
}

export async function enforceTriggerCreation(
  userId: string,
  projectId: string,
  currentTriggerCount: number
): Promise<true | LimitViolation> {
  const sub = await getUserSubscription(userId)
  if (!sub) return noSubscription()

  const max = sub.plan.maxTriggersPerProject
  if (max === 0) {
    return violation(sub.plan.name, `Event triggers are not available on the ${planDisplayName(sub.plan.name)} plan. Upgrade to Pro to use them.`)
  }
  if (max !== null && currentTriggerCount >= max) {
    return violation(
      sub.plan.name,
      `You've reached the limit of ${max} triggers per project on the ${planDisplayName(sub.plan.name)} plan.`
    )
  }
  return true
}

export async function enforceTeamSeat(
  userId: string,
  currentSeatCount: number
): Promise<true | LimitViolation> {
  const sub = await getUserSubscription(userId)
  if (!sub) return noSubscription()

  const max = sub.plan.maxTeamSeats
  if (currentSeatCount >= max) {
    return violation(
      sub.plan.name,
      `You've reached the ${max}-seat limit on the ${planDisplayName(sub.plan.name)} plan. Upgrade to add team members.`
    )
  }
  return true
}

export async function enforceCustomDomain(userId: string): Promise<true | LimitViolation> {
  const sub = await getUserSubscription(userId)
  if (!sub) return noSubscription()

  if (!sub.plan.allowCustomDomain) {
    return violation(sub.plan.name, `Custom domains are available on the Pro plan ($25/mo) and above.`)
  }
  return true
}

export async function enforceWebhook(userId: string): Promise<true | LimitViolation> {
  const sub = await getUserSubscription(userId)
  if (!sub) return noSubscription()

  if (!sub.plan.allowWebhooks) {
    return violation(sub.plan.name, `Webhooks are available on the Pro plan ($25/mo) and above.`)
  }
  return true
}

export async function enforceRbac(userId: string): Promise<true | LimitViolation> {
  const sub = await getUserSubscription(userId)
  if (!sub) return noSubscription()

  if (!sub.plan.allowRbac) {
    return violation(sub.plan.name, `Role-based access control is available on the Pro plan ($25/mo) and above.`)
  }
  return true
}

export async function enforceDeployment(userId: string): Promise<true | LimitViolation> {
  const sub = await getUserSubscription(userId)
  if (!sub) return noSubscription()

  if (!sub.plan.allowDeployment) {
    return {
      code: 'PLAN_LIMIT_EXCEEDED',
      upgradeRequired: true,
      currentPlan: sub.plan.name,
      requiredPlan: 'BUILDER',
      message: 'Deployment to production requires the Pro plan ($25/mo). Upgrade to keep your backend live.',
    }
  }
  return true
}

export async function enforceAuthProvider(userId: string, provider: string): Promise<true | LimitViolation> {
  const sub = await getUserSubscription(userId)
  if (!sub) return noSubscription()

  if (!sub.plan.allowedAuthProviders.includes(provider)) {
    const requiredPlan = provider === 'oidc' ? 'SCALE' : 'BUILDER'
    const displayName = provider === 'oidc' ? 'Enterprise (contact sales)' : 'Pro ($25/mo)'
    return {
      code: 'PLAN_LIMIT_EXCEEDED',
      upgradeRequired: true,
      currentPlan: sub.plan.name,
      requiredPlan,
      message: `The ${provider} auth provider requires the ${displayName} plan.`,
    }
  }
  return true
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

const usageCache = new Map<string, { data: UserUsageSummary; expiresAt: number }>()

export async function getUserUsageSummary(
  userId: string,
  skipCache = false
): Promise<UserUsageSummary | null> {
  const cacheKey = `usage_${userId}`
  const now = Date.now()

  if (!skipCache) {
    const cached = usageCache.get(cacheKey)
    if (cached && cached.expiresAt > now) return cached.data
  }

  const sub = await getUserSubscription(userId)
  if (!sub) return null

  const p = sub.plan
  const month = getThisMonth()
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
    resetAt: getNextMonthStart(),

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

  usageCache.set(cacheKey, { data: summary, expiresAt: now + 30_000 })
  return summary
}

// ─── Row count helpers (legacy, still used by older routes) ─────────────────

export async function incrementProjectRowCount(projectId: string, count = 1): Promise<void> {
  await prisma.project.update({ where: { id: projectId }, data: { rowCount: { increment: count } } })
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } })
  if (project?.userId) usageCache.delete(`usage_${project.userId}`)
}

export async function decrementProjectRowCount(projectId: string, count = 1): Promise<void> {
  await prisma.project.update({ where: { id: projectId }, data: { rowCount: { decrement: count } } })
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } })
  if (project?.userId) usageCache.delete(`usage_${project.userId}`)
}

export async function enforceRowInsertion(projectId: string, currentRowCount: number): Promise<true | LimitViolation> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      user: { include: { subscriptions: { include: { plan: true }, orderBy: { createdAt: 'desc' }, take: 1 } } },
    },
  })
  if (!project?.user) return noSubscription()

  const sub = project.user.subscriptions[0]
  if (!sub) return noSubscription()

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
