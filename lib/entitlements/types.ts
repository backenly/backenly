/**
 * What a user is entitled to, stated without reference to how it was paid for.
 *
 * This is the seam between the public product and Backenly's commercial
 * machinery. Everything that enforces a limit reads this shape; nothing that
 * enforces a limit reads a Plan or a Subscription row. That is the whole point:
 * `Plan` and `Subscription` are Cloud's billing tables, and a self-hosted
 * install has neither.
 *
 * `null` means UNLIMITED throughout, never "unknown" and never zero. Callers
 * rely on that reading, so a provider that cannot determine a limit must say so
 * by returning no entitlements at all rather than by returning null caps.
 */
export interface UserEntitlements {
  planName: string
  priceCents: number
  annualPriceCents: number | null

  maxProjects: number | null
  maxAiBuildActionsPerMonth: number | null
  monthlyAiCredits: number | null
  maxApiRequestsPerMonth: bigint | null
  /**
   * true = `maxApiRequestsPerMonth` is a lifetime total that never resets.
   *
   * Free is metered this way in Cloud, which is why the quota kernel keys its
   * counter on 'LIFETIME' rather than the month. Carried here because the
   * kernel used to read it off `Plan` directly and must not any more.
   */
  apiQuotaIsLifetime: boolean
  maxMonthlyActiveUsers: number | null
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

  allowDeployment: boolean
  isSandboxPlan: boolean
  sandboxExpiryDays: number | null
  isPayAsYouGo: boolean
}

/**
 * The Cloud half of the seam.
 *
 * Resolved through the `@cloud/*` alias, which prefers the private overlay's
 * implementation and falls back to the public one when no overlay has been
 * applied. Returning `null` means "this user has no active subscription", which
 * every caller already handles; it does not mean "unlimited".
 */
export interface CloudEntitlementsProvider {
  cloudEntitlements(userId: string): Promise<UserEntitlements | null>
}
