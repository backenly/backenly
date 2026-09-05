/**
 * Plan policy: may this operation happen?
 *
 * Every one of these used to call getUserSubscription from @/lib/billing, which
 * meant public product enforcement read Backenly's commercial tables directly.
 * That had a consequence nobody intended: on a self-hosted install there is no
 * Subscription row, so `!sub` was true and every helper returned
 *
 *   PLAN_LIMIT_EXCEEDED "No active subscription found"
 *
 * while selfHostedEntitlements() was simultaneously reporting allowDeployment,
 * allowWebhooks and allowCustomDomain as true. Measured on a fresh single-tenant
 * database, enforceDeployment, enforceCustomDomain and enforceTriggerCreation
 * all blocked. Reading entitlements instead of subscriptions is what fixes it,
 * and it is the same change that lets lib/billing leave the public repository.
 *
 * The division of labour is one line: deciding whether something MAY happen is
 * public policy, and recording commercial consumption belongs to the Cloud
 * provider. So the credit gate is here and the credit charge is not.
 *
 * Cloud behaviour is unchanged. Entitlements resolve from the same Plan row, a
 * missing subscription still produces the same violation, and every message is
 * the one that shipped.
 */
import crypto from 'crypto'

import { bonusCredits, recordAiConsumption } from '@cloud/entitlements'
import { prisma } from '@/lib/db/prisma'
import { getUserEntitlements } from './index'
import type { UserEntitlements } from './types'
import { invalidateUsageCache } from './usage-cache'

// ─── Tier naming ─────────────────────────────────────────────────────────────
// Current tiers (v4): SANDBOX (Free $0) → BUILDER (Pro $25) → SCALE (Enterprise, custom)
// Legacy tiers (backward compat): FREE → STARTER → GROWTH → PRO
const TIER_ORDER = ['SANDBOX', 'FREE', 'STARTER', 'BUILDER', 'GROWTH', 'PRO', 'SCALE'] as const
type TierName = typeof TIER_ORDER[number]

const PLAN_DISPLAY: Record<string, string> = {
  SANDBOX: 'Free',
  BUILDER: 'Pro',
  SCALE: 'Enterprise',
  FREE: 'Free',
  STARTER: 'Starter',
  GROWTH: 'Growth',
  PRO: 'Pro',
}

export function planDisplayName(name: string): string {
  return PLAN_DISPLAY[name.toUpperCase()] ?? name
}

function nextTier(current: string): string {
  const upper = current.toUpperCase()
  const idx = TIER_ORDER.indexOf(upper as TierName)
  if (idx === -1) return 'BUILDER'
  return TIER_ORDER[Math.min(idx + 1, TIER_ORDER.length - 1)]
}

// ─── Limit violation type ────────────────────────────────────────────────────

export interface LimitViolation {
  code: 'PLAN_LIMIT_EXCEEDED'
  upgradeRequired: true
  currentPlan: string
  requiredPlan: string
  message: string
}

export function violation(currentPlan: string, message: string): LimitViolation {
  return {
    code: 'PLAN_LIMIT_EXCEEDED',
    upgradeRequired: true,
    currentPlan,
    requiredPlan: nextTier(currentPlan),
    message,
  }
}

/**
 * No entitlements at all.
 *
 * Cloud-only by construction: single-tenant always resolves entitlements from
 * the edition, so this is unreachable there. The wording is preserved from the
 * subscription-shaped original because it is a response body the dashboard
 * already parses.
 */
export function noEntitlements(): LimitViolation {
  return {
    code: 'PLAN_LIMIT_EXCEEDED',
    upgradeRequired: true,
    currentPlan: 'NONE',
    requiredPlan: 'FREE',
    message: 'No active subscription found',
  }
}

// ─── Date keys ───────────────────────────────────────────────────────────────

export function thisMonth(): string {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

export function nextMonthStart(): Date {
  const d = new Date()
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
}

/**
 * Derive a stable 32-bit advisory lock key from a (userId, month) tuple.
 * pg_advisory_xact_lock takes a bigint but we use two int4s via the overload
 * pg_advisory_xact_lock(key1 int4, key2 int4) to stay within safe integer range.
 */
function advisoryLockKeys(userId: string, month: string): [number, number] {
  const hash = crypto.createHash('sha256').update(`${userId}:${month}`).digest()
  const k1 = hash.readInt32BE(0)
  const k2 = hash.readInt32BE(4)
  return [k1, k2]
}

// ─── Monthly usage ───────────────────────────────────────────────────────────

export interface MonthlyUsage {
  aiBuildActions: number
  /** Raw AI tokens consumed this month (the credit ledger). */
  aiTokensUsed: number
  apiRequests: bigint
  aiFunctionInvocations: number
}

export async function getMonthlyUsage(userId: string): Promise<MonthlyUsage> {
  const month = thisMonth()
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
// or a 4,000-word spec that builds an entire backend, and both cost 1 action,
// so a user could extract ~the whole product on their first message. Credits
// are token-backed: a turn costs credits proportional to the tokens the model
// actually processed, so the cost tracks real work and the exploit is gone.
//
// The ratio is published and STABLE. Silently re-ratioing credits to tokens is
// exactly what broke trust at other vendors. Never change this without a
// deliberate, announced pricing update.
//
// Autonomy (the always-on monitor/self-repair loop) NEVER deducts credits.
// That cost is funded by the platform. See lib/autonomy/* and background-monitor.
export const TOKENS_PER_CREDIT = 1_000

/** Whole credits consumed for a given raw token count (rounded up). */
export function creditsFromTokens(tokens: number): number {
  if (tokens <= 0) return 0
  return Math.ceil(tokens / TOKENS_PER_CREDIT)
}

/**
 * The month enforcement went live. Usage recorded before this point accrued
 * under a contract that did not meter it: the charge path had no callers, so
 * every token spent through the brain was free by construction. Enforcing that
 * history retroactively locks people out for activity that cost them nothing at
 * the time, which is exactly what happened on the cutover. One SANDBOX user was
 * sitting at 245 credits against a 200 cap and was refused the moment the gate
 * shipped.
 *
 * `UserAiUsage` aggregates by month, so the cutover month has no per-event
 * timestamps to split on, and there is no way to charge only the post-cutover
 * portion of it. Skipping the month entirely is the honest resolution: it costs
 * at most one month of enforcement, applies uniformly rather than to whoever
 * happened to be over, and needs no retroactive edit to anyone's billing rows.
 *
 * This is self-expiring. From the following month the meter is real for
 * everyone, and this branch is dead code that can be deleted.
 */
const ENFORCEMENT_EPOCH_MONTH = '2026-07'

/**
 * Pre-gate: may this user start an AI build turn? Blocks once the month's
 * credit budget is spent. Read-only, and does NOT consume credits (a turn is
 * charged afterwards by chargeAiCredits, and only when it mutated state).
 *
 * FAIL-OPEN: a billing infra hiccup must never block a paying customer's
 * build. Only a real, measured budget breach blocks.
 */
export async function enforceAiCredits(userId: string): Promise<true | LimitViolation> {
  try {
    if (thisMonth() === ENFORCEMENT_EPOCH_MONTH) return true

    const ent = await getUserEntitlements(userId)
    if (!ent) return noEntitlements()

    const maxCredits = ent.monthlyAiCredits
    if (maxCredits === null || maxCredits === undefined) return true // unlimited (fair-use)

    // Bonus credits (referral / promo grants) genuinely extend the monthly cap.
    const bonus = await bonusCredits(userId)
    const effectiveMax = maxCredits + bonus

    const usage = await getMonthlyUsage(userId)
    const creditsUsed = creditsFromTokens(usage.aiTokensUsed)
    if (creditsUsed >= effectiveMax) {
      return violation(
        ent.planName,
        bonus > 0
          ? `You've used all ${effectiveMax.toLocaleString()} AI credits available this month (${maxCredits.toLocaleString()} plan + ${bonus.toLocaleString()} bonus) on the ${planDisplayName(ent.planName)} plan. Credits reset on the 1st — or upgrade for more.`
          : `You've used all ${maxCredits.toLocaleString()} AI credits this month on the ${planDisplayName(ent.planName)} plan. Credits reset on the 1st — or upgrade for more.`,
      )
    }
    return true
  } catch {
    return true // never break a build because billing had a hiccup
  }
}

/**
 * Charge a completed AI turn's actual token usage.
 *
 * The ledger this writes to is commercial, so the write itself belongs to the
 * Cloud provider; this is the public entry point the product calls. In
 * single-tenant it records nothing, because there is nobody to bill.
 *
 * Call AFTER the turn, only when it produced a real backend change (questions
 * and clarifications are free). Fire-and-forget; never blocks.
 */
export async function chargeAiCredits(userId: string, tokensUsed: number): Promise<void> {
  if (!Number.isFinite(tokensUsed) || tokensUsed <= 0) return
  await recordAiConsumption(userId, tokensUsed)
  invalidateUsageCache(userId)
}

// ─── Usage tracking ──────────────────────────────────────────────────────────

export async function trackAiBuildAction(userId: string, tokenCount = 0): Promise<void> {
  const month = thisMonth()
  await prisma.userAiUsage.upsert({
    where: { userId_date: { userId, date: month } },
    update: {
      intentCount: { increment: 1 },
      tokenCount: { increment: tokenCount },
    },
    create: { userId, date: month, intentCount: 1, tokenCount },
  })
  invalidateUsageCache(userId)

  // Fire credits-low notification when usage crosses the 80% threshold.
  // Run asynchronously, and never block the main execution path.
  try {
    const ent = await getUserEntitlements(userId)
    const max = ent?.maxAiBuildActionsPerMonth
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
 * Why: a naive read-check-then-increment approach has a race condition. Two
 * concurrent requests both read count=N, both pass the limit check, and both
 * increment, overshooting the limit by one or more. The advisory lock on
 * (userId, month) serialises concurrent enforce+track calls for the same user
 * without blocking unrelated users.
 *
 * Returns true when the action is allowed and the counter has been incremented.
 * Returns a LimitViolation when the limit is already reached (counter NOT
 * incremented).
 */
export async function enforceAndTrackAiBuildAction(
  userId: string,
  tokenCount = 0
): Promise<true | LimitViolation> {
  const ent = await getUserEntitlements(userId)
  if (!ent) return noEntitlements()

  const max = ent.maxAiBuildActionsPerMonth
  if (max === null) {
    // Unlimited plan. Track asynchronously and immediately allow.
    trackAiBuildAction(userId, tokenCount).catch(() => {})
    return true
  }

  const month = thisMonth()
  const [k1, k2] = advisoryLockKeys(userId, month)

  const result = await prisma.$transaction(async (tx) => {
    // Acquire a transaction-scoped advisory lock keyed to (userId, month).
    // This blocks any other transaction attempting to take the same lock
    // until this transaction commits or rolls back. No deadlock risk, because
    // each user+month pair maps to a unique key and we only ever lock one.
    await tx.$executeRawUnsafe(
      `SELECT pg_advisory_xact_lock($1::int4, $2::int4)`,
      k1, k2
    )

    // Read the current count inside the lock so the read is serialised.
    const record = await tx.userAiUsage.findUnique({
      where: { userId_date: { userId, date: month } },
      select: { intentCount: true },
    })
    const currentCount = record?.intentCount ?? 0

    if (currentCount >= max) {
      return { allowed: false as const, count: currentCount }
    }

    // Increment inside the lock, guaranteed to be the only writer right now.
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
      ent.planName,
      `You've used all ${max.toLocaleString()} AI build actions this month on the ${planDisplayName(ent.planName)} plan. Resets on the 1st.`
    )
  }

  invalidateUsageCache(userId)

  // Fire the low-credit notification asynchronously, never blocking the response.
  try {
    if (max) {
      const { checkAndNotifyCreditsLow } = await import('@/lib/notifications/platform')
      checkAndNotifyCreditsLow(userId, month, result.count, max).catch(() => {})
    }
  } catch { /* non-fatal */ }

  return true
}

/** Track AI intent. Alias for backward compatibility. */
export const trackAiIntent = trackAiBuildAction

export async function trackAiFunctionInvocation(userId: string, count = 1): Promise<void> {
  const month = thisMonth()
  await prisma.userAiUsage.upsert({
    where: { userId_date: { userId, date: month } },
    update: { aiFunctionInvocations: { increment: count } },
    create: { userId, date: month, aiFunctionInvocations: count },
  })
  invalidateUsageCache(userId)
}

// ─── Enforcement helpers ─────────────────────────────────────────────────────

export async function enforceProjectCreation(
  userId: string,
  currentProjectCount: number
): Promise<true | LimitViolation> {
  const ent = await getUserEntitlements(userId)
  if (!ent) return noEntitlements()

  const max = ent.maxProjects
  if (max !== null && currentProjectCount >= max) {
    return violation(
      ent.planName,
      `You've reached the ${max}-project limit on the ${planDisplayName(ent.planName)} plan. Upgrade to add more projects.`
    )
  }
  return true
}

export async function enforceAiBuildAction(userId: string): Promise<true | LimitViolation> {
  const ent = await getUserEntitlements(userId)
  if (!ent) return noEntitlements()

  const max = ent.maxAiBuildActionsPerMonth
  if (max === null) return true

  const usage = await getMonthlyUsage(userId)
  if (usage.aiBuildActions >= max) {
    return violation(
      ent.planName,
      `You've used all ${max.toLocaleString()} AI build actions this month on the ${planDisplayName(ent.planName)} plan. Resets on the 1st.`
    )
  }
  return true
}

/** Alias for backward compatibility. */
export const checkAiIntentLimit = async (userId: string) => {
  const ent = await getUserEntitlements(userId)
  if (!ent) return { allowed: false, code: 'AI_LIMIT_EXCEEDED' as const, remaining: 0, limit: 0, resetAt: nextMonthStart(), usedToday: 0 }

  const max = ent.maxAiBuildActionsPerMonth
  if (max === null) return { allowed: true, remaining: 999_999, limit: null, resetAt: nextMonthStart(), usedToday: 0 }

  const usage = await getMonthlyUsage(userId)
  const remaining = Math.max(0, max - usage.aiBuildActions)
  if (usage.aiBuildActions >= max) {
    return { allowed: false, code: 'AI_LIMIT_EXCEEDED' as const, remaining: 0, limit: max, resetAt: nextMonthStart(), usedToday: usage.aiBuildActions }
  }
  return { allowed: true, remaining, limit: max, resetAt: nextMonthStart(), usedToday: usage.aiBuildActions }
}

export async function enforceAiFunctionInvocation(userId: string): Promise<true | LimitViolation> {
  const ent = await getUserEntitlements(userId)
  if (!ent) return noEntitlements()

  const max = ent.maxAiFunctionInvocationsPerMonth
  if (max === null) return true

  const usage = await getMonthlyUsage(userId)
  if (usage.aiFunctionInvocations >= max) {
    return violation(
      ent.planName,
      `You've used all ${max.toLocaleString()} AI Function invocations this month on the ${planDisplayName(ent.planName)} plan.`
    )
  }
  return true
}

/**
 * @deprecated Realtime connection caps are enforced by the ListenerHub
 * (lib/realtime/listener-hub.ts) via lib/quota/kernel.ts
 * enforceRealtimeConnection. This wrapper delegates so any legacy caller
 * stays on the single kernel path.
 */
export async function enforceRealtimeConnection(
  projectId: string,
  currentConnections: number
): Promise<true | LimitViolation> {
  const { enforceRealtimeConnection: kernelEnforce } = await import('@/lib/quota/kernel')
  const decision = await kernelEnforce(projectId, currentConnections)
  if (decision.allowed) return true
  return violation(decision.plan ?? 'UNKNOWN', decision.message ?? 'Realtime connection limit reached')
}

export async function enforceTriggerCreation(
  userId: string,
  projectId: string,
  currentTriggerCount: number
): Promise<true | LimitViolation> {
  const ent = await getUserEntitlements(userId)
  if (!ent) return noEntitlements()

  const max = ent.maxTriggersPerProject
  if (max === 0) {
    return violation(ent.planName, `Event triggers are not available on the ${planDisplayName(ent.planName)} plan. Upgrade to Pro to use them.`)
  }
  if (max !== null && currentTriggerCount >= max) {
    return violation(
      ent.planName,
      `You've reached the limit of ${max} triggers per project on the ${planDisplayName(ent.planName)} plan.`
    )
  }
  return true
}

export async function enforceTeamSeat(
  userId: string,
  currentSeatCount: number
): Promise<true | LimitViolation> {
  const ent = await getUserEntitlements(userId)
  if (!ent) return noEntitlements()

  const max = ent.maxTeamSeats
  if (currentSeatCount >= max) {
    return violation(
      ent.planName,
      `You've reached the ${max}-seat limit on the ${planDisplayName(ent.planName)} plan. Upgrade to add team members.`
    )
  }
  return true
}

export async function enforceCustomDomain(userId: string): Promise<true | LimitViolation> {
  const ent = await getUserEntitlements(userId)
  if (!ent) return noEntitlements()

  if (!ent.allowCustomDomain) {
    return violation(ent.planName, `Custom domains are available on the Pro plan ($25/mo) and above.`)
  }
  return true
}

export async function enforceWebhook(userId: string): Promise<true | LimitViolation> {
  const ent = await getUserEntitlements(userId)
  if (!ent) return noEntitlements()

  if (!ent.allowWebhooks) {
    return violation(ent.planName, `Webhooks are available on the Pro plan ($25/mo) and above.`)
  }
  return true
}

export async function enforceRbac(userId: string): Promise<true | LimitViolation> {
  const ent = await getUserEntitlements(userId)
  if (!ent) return noEntitlements()

  if (!ent.allowRbac) {
    return violation(ent.planName, `Role-based access control is available on the Pro plan ($25/mo) and above.`)
  }
  return true
}

export async function enforceDeployment(userId: string): Promise<true | LimitViolation> {
  const ent = await getUserEntitlements(userId)
  if (!ent) return noEntitlements()

  if (!ent.allowDeployment) {
    return {
      code: 'PLAN_LIMIT_EXCEEDED',
      upgradeRequired: true,
      currentPlan: ent.planName,
      requiredPlan: 'BUILDER',
      message: 'Deployment to production requires the Pro plan ($25/mo). Upgrade to keep your backend live.',
    }
  }
  return true
}

export async function enforceAuthProvider(userId: string, provider: string): Promise<true | LimitViolation> {
  const ent = await getUserEntitlements(userId)
  if (!ent) return noEntitlements()

  if (!ent.allowedAuthProviders.includes(provider)) {
    const requiredPlan = provider === 'oidc' ? 'SCALE' : 'BUILDER'
    const displayName = provider === 'oidc' ? 'Enterprise (contact sales)' : 'Pro ($25/mo)'
    return {
      code: 'PLAN_LIMIT_EXCEEDED',
      upgradeRequired: true,
      currentPlan: ent.planName,
      requiredPlan,
      message: `The ${provider} auth provider requires the ${displayName} plan.`,
    }
  }
  return true
}

export type { UserEntitlements }
