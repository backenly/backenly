/**
 * Cloud entitlements, as resolved WITHOUT the private overlay.
 *
 * `@cloud/entitlements` resolves here only when `lib/cloud/entitlements.ts` is
 * absent, which means no Cloud overlay has been applied. Today that is every
 * public checkout, so this file still carries the real billing-backed mapping
 * and Cloud behaviour is unchanged by the seam that now sits in front of it.
 *
 * Phase 6 moves the implementation into the private overlay. When it does, this
 * file stops mapping Plan rows and becomes the honest answer for a public
 * checkout that has no commercial implementation to consult. It is deliberately
 * the ONLY place the Plan -> UserEntitlements mapping exists, so that move is a
 * relocation rather than a second copy.
 *
 * `lib/billing` is imported here and nowhere else in public product code. That
 * is the point of the seam: this file is the single remaining edge, and it is
 * one the overlay replaces wholesale.
 */
import { getUserSubscription } from '@/lib/billing'
import type { UserEntitlements } from '@/lib/entitlements/types'

/**
 * `null` means the user has no active subscription, which every caller already
 * treats as a block. It does not mean unlimited, and it does not mean the
 * lookup failed.
 */
export async function cloudEntitlements(userId: string): Promise<UserEntitlements | null> {
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
