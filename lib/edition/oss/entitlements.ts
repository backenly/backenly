/**
 * The Cloud entitlements provider, as resolved WITHOUT the private overlay.
 *
 * `@cloud/entitlements` resolves here only when `lib/cloud/entitlements.ts` is
 * absent, which means no Cloud overlay has been applied. Today that is every
 * public checkout, so this file still delegates to the real implementation in
 * lib/billing and Cloud behaviour is unchanged by the seam in front of it.
 *
 * Phase 6 moves that implementation into the private overlay. When it does,
 * this file becomes the honest answer for a public checkout with no commercial
 * half, and the delegation below is what disappears. Nothing else has to move,
 * because the public product already calls the seam rather than lib/billing.
 *
 * ── Why every import here is dynamic ────────────────────────────────────────
 *
 * lib/billing imports the public policy layer (for getMonthlyUsage and the
 * shared violation helpers), and the policy layer imports this provider. A
 * static import in either direction would close that loop at module-evaluation
 * time, and the usual symptom is an undefined binding in whichever module the
 * bundler happens to initialise second. Deferring to call time breaks the cycle
 * without either side having to know about the other's ordering.
 */
import type { UserEntitlements } from '@/lib/entitlements/types'

/**
 * `null` means the user has no active subscription, which every caller already
 * treats as a block. It does not mean unlimited, and it does not mean the
 * lookup failed.
 */
export async function cloudEntitlements(userId: string): Promise<UserEntitlements | null> {
  const { getUserSubscription } = await import('@/lib/billing')
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
    apiQuotaIsLifetime: p.apiQuotaIsLifetime,
    maxMonthlyActiveUsers: p.maxMonthlyActiveUsers ?? null,
    maxPostgresStorageMb: p.maxPostgresStorageMb ?? null,
    maxFileStorageMb: p.maxFileStorageMb ?? null,
    maxRealtimeConnections: p.maxRealtimeConnections ?? null,
    maxAiFunctionInvocationsPerMonth: p.maxAiFunctionInvocationsPerMonth ?? null,
    maxTriggersPerProject: p.maxTriggersPerProject ?? null,
    maxTeamSeats: p.maxTeamSeats,
    maxDeploymentHistory: p.maxDeploymentHistory ?? null,
    autonomyScanIntervalMin: p.autonomyScanIntervalMin ?? null,

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

/** Granted credits (referral or promo) that extend the monthly cap. */
export async function bonusCredits(userId: string): Promise<number> {
  const { getBonusCredits } = await import('@/lib/billing/credit-ledger')
  return getBonusCredits(userId)
}

/**
 * Charge a completed AI turn to the commercial usage ledger.
 *
 * Never throws: the public policy layer calls this after it has already decided
 * the turn was allowed, so a ledger failure must not surface as a build error.
 */
export async function recordAiConsumption(userId: string, tokensUsed: number): Promise<void> {
  const { chargeAiCredits } = await import('@/lib/billing')
  return chargeAiCredits(userId, tokensUsed)
}

/**
 * Give a new account a free subscription.
 *
 * Only ever reached in cloud: lib/entitlements short-circuits single-tenant
 * before the provider is consulted, which is what keeps a self-host install
 * free of Plan and Subscription rows.
 */
export async function initializeAccountEntitlements(userId: string): Promise<void> {
  const { getUserSubscription, createFreeSubscription } = await import('@/lib/billing')
  // Idempotent: the callers used to guard this themselves, and a second
  // Subscription row for the same account would make getUserSubscription's
  // orderBy the only thing deciding which plan a user is on.
  const existing = await getUserSubscription(userId)
  if (existing) return
  await createFreeSubscription(userId)
}
