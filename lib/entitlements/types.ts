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
  // No API request field, deliberately: API requests are unlimited on every
  // plan and in every edition, so there is nothing to entitle.
  maxMonthlyActiveUsers: number | null
  maxPostgresStorageMb: number | null
  maxFileStorageMb: number | null
  maxRealtimeConnections: number | null
  maxAiFunctionInvocationsPerMonth: number | null
  /**
   * Egress included per month, in MB. `null` means unmetered. Like every usage
   * quota it is pooled: all of the account's projects share it.
   */
  includedEgressMb: number | null
  /**
   * The fair-use ceiling on requests per minute for any one API key. `null`
   * means no ceiling beyond the key's own setting. API requests are never
   * capped or billed; this only bounds what one key may be configured to send.
   */
  apiRateLimitPerMin: number | null
  maxTriggersPerProject: number | null
  maxTeamSeats: number
  maxDeploymentHistory: number | null
  /**
   * Minimum minutes between autonomy reconcile passes. `null` means the
   * caller picks, and every seeded plan uses 1 (every minute, on every plan).
   * Carried here because autonomy is public and ungated, so its cadence must
   * not require a commercial lookup.
   */
  autonomyScanIntervalMin: number | null
  /**
   * Days without real use before a project owned under this plan is paused.
   * `null` means never paused, which is what every self-hosted deployment and
   * every paid plan answers. Only Backenly Cloud's idle sweep reads it.
   */
  inactivityPauseDays: number | null
  /**
   * Days after pausing that resuming stays free. `null` means resuming is
   * always free. After the window a paused project can still be exported.
   */
  pausedFreeResumeDays: number | null

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
 * Whether, and how far, an account may use more than its plan includes.
 *
 * Both facts are commercial, so only Cloud answers them; a deployment with no
 * commercial half answers `null`, which means every quota is a hard cap.
 *
 *   mode             off      nothing past the quota, nothing estimated
 *                    shadow   quotas stay hard caps; overage is estimated and
 *                             recorded, never charged
 *                    enforce  usage may pass the quota until the estimated
 *                             overage reaches the spend limit, and is charged
 *   spendLimitCents  the most usage beyond the plan may cost this month. Cloud
 *                    answers the owner's limit, up to what they have paid in
 *                    advance. 0 (the default) keeps every quota a hard cap.
 */
export interface OveragePolicy {
  mode: 'off' | 'shadow' | 'enforce'
  spendLimitCents: number
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
  cloudEntitlements(billingAccountId: string): Promise<UserEntitlements | null>
}
