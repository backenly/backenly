export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getUserUsageSummary, getUserEntitlements, createFreeSubscription } from '@/lib/billing'

/**
 * GET /api/billing/usage
 * Returns full usage summary + entitlements for the authenticated user.
 * Cached 30s server-side. Pass x-skip-cache: true to bust.
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const skipCache = request.headers.get('x-skip-cache') === 'true'

    let [usage, entitlements] = await Promise.all([
      getUserUsageSummary(user.userId, skipCache),
      getUserEntitlements(user.userId),
    ])

    // Auto-provision FREE subscription for users who registered before billing was set up
    if (!usage || !entitlements) {
      try {
        await createFreeSubscription(user.userId)
        ;[usage, entitlements] = await Promise.all([
          getUserUsageSummary(user.userId, true),
          getUserEntitlements(user.userId),
        ])
      } catch {
        // Swallow — will fall through to 503 below
      }
    }

    if (!usage || !entitlements) {
      return NextResponse.json(
        { error: 'Billing plans not found — run: npx tsx prisma/seed-billing.ts' },
        { status: 503 }
      )
    }

    return NextResponse.json({
      // Plan identity
      planName: usage.planName,
      priceCents: entitlements.priceCents,
      annualPriceCents: entitlements.annualPriceCents,

      // Scale dimensions
      projectsUsed: usage.projectsUsed,
      maxProjects: usage.maxProjects,

      aiBuildActionsUsed: usage.aiBuildActionsUsed,
      maxAiBuildActionsPerMonth: usage.maxAiBuildActionsPerMonth,

      aiCreditsUsed: usage.aiCreditsUsed,
      monthlyAiCredits: usage.monthlyAiCredits,

      apiRequestsUsed: usage.apiRequestsUsed.toString(),          // BigInt → string for JSON
      maxApiRequestsPerMonth: usage.maxApiRequestsPerMonth?.toString() ?? null,
      apiQuotaIsLifetime: usage.apiQuotaIsLifetime,               // true = Free's total cap (no reset)

      monthlyActiveUsersUsed: usage.monthlyActiveUsersUsed,
      maxMonthlyActiveUsers: usage.maxMonthlyActiveUsers,

      maxPostgresStorageMb: usage.maxPostgresStorageMb,
      dbStorageUsedMb: usage.dbStorageUsedMb,
      maxFileStorageMb: usage.maxFileStorageMb,
      fileStorageUsedMb: usage.fileStorageUsedMb,
      maxRealtimeConnections: usage.maxRealtimeConnections,

      aiFunctionInvocationsUsed: usage.aiFunctionInvocationsUsed,
      maxAiFunctionInvocationsPerMonth: usage.maxAiFunctionInvocationsPerMonth,

      maxTeamSeats: usage.maxTeamSeats,
      maxTriggersPerProject: usage.maxTriggersPerProject,
      maxDeploymentHistory: entitlements.maxDeploymentHistory,

      resetAt: usage.resetAt.toISOString(),

      // Feature flags
      entitlements: {
        allowedAuthProviders: entitlements.allowedAuthProviders,
        logRetentionDays: entitlements.logRetentionDays,
        supportResponseHours: entitlements.supportResponseHours,
        allowCustomDomain: entitlements.allowCustomDomain,
        allowAdvancedMonitoring: entitlements.allowAdvancedMonitoring,
        allowRbac: entitlements.allowRbac,
        allowSso: entitlements.allowSso,
        allowDeploymentRollback: entitlements.allowDeploymentRollback,
        allowWebhooks: entitlements.allowWebhooks,
        prioritySupport: entitlements.prioritySupport,
      },

      // Legacy fields — kept for backward compat with older UI code
      aiUsedToday: usage.aiBuildActionsUsed,
      aiLimit: usage.maxAiBuildActionsPerMonth,
      apiRateLimitPerMin: usage.apiRateLimitPerMin,
      rowsUsedPerProject: usage.rowsUsedPerProject,
      maxRowsPerProject: usage.maxRowsPerProject,
    })
  } catch (error: any) {
    console.error('[Billing Usage]', error)
    return NextResponse.json({ error: error.message || 'Failed to get usage' }, { status: 500 })
  }
})
