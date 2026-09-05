import type { UserEntitlements } from './types'

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
 * checkout on a fresh self-host install. Single-tenant needs no seed at all:
 * `npm run bootstrap` provisions a working project and never creates a Plan or
 * a Subscription row.
 *
 * `null` means unlimited throughout, so this is the same shape the quota kernel
 * already understands. Nothing downstream needs an edition check.
 */
export function selfHostedEntitlements(): UserEntitlements {
  return {
    planName: 'SELF_HOSTED',
    priceCents: 0,
    annualPriceCents: null,

    maxProjects: 1, // one deployment is one project
    maxAiBuildActionsPerMonth: null,
    monthlyAiCredits: null,
    maxApiRequestsPerMonth: null,
    // Irrelevant while the cap is null, but false is the honest value: nothing
    // here is metered against a lifetime total.
    apiQuotaIsLifetime: false,
    maxMonthlyActiveUsers: null,
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
