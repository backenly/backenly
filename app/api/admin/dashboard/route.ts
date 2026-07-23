export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

interface RetentionRow {
  windowDays: number
  eligibleUsers: number
  retainedUsers: number
  retentionPct: number
}

/**
 * GET /api/admin/dashboard
 *
 * Returns a comprehensive platform health snapshot:
 * - Total users / weekly active users / retention / active subscriptions / revenue proxies
 * - AI credits consumed this month
 * - Stuck / failed job counts (generation_jobs across all workspaces)
 * - Recent payment events
 *
 * FOUNDER-ONLY — role-gated server-side.
 */
export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const now = new Date()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const currentMonth = now.toISOString().slice(0, 7) // YYYY-MM

  const [
    totalUsers,
    suspendedUsers,
    activeUsersWeekly,
    activeSubscriptions,
    gracePeriodSubscriptions,
    totalProjects,
    activeProjects,
    aiUsageThisMonth,
    recentPaymentEvents,
    recentAuditLogs,
    webhookEventCount,
    apiKeyCount,
    retentionRows,
  ] = await Promise.all([
    // Total non-deleted platform users
    prisma.user.count({ where: { deletedAt: null } }),

    // Suspended users
    prisma.user.count({ where: { deletedAt: null, suspendedAt: { not: null } } }),

    // Users active in the last 7 days. Prefer lastActiveAt, fall back to lastLogin
    // for rows that pre-date activity tracking.
    prisma.user.count({
      where: {
        deletedAt: null,
        OR: [{ lastActiveAt: { gte: sevenDaysAgo } }, { lastActiveAt: null, lastLogin: { gte: sevenDaysAgo } }],
      },
    }),

    // Paid active subscriptions
    prisma.subscription.count({ where: { status: 'ACTIVE' } }),

    // Subscriptions in grace period
    prisma.subscription.count({ where: { status: 'GRACE' } }),

    // Total non-expired projects
    prisma.project.count({ where: { expiresAt: null } }),

    // Projects that have been deployed or have activity
    prisma.project.count({ where: { expiresAt: null, isDeployed: true } }),

    // Sum AI usage for the current month
    prisma.userAiUsage.aggregate({
      _sum: { intentCount: true, tokenCount: true, apiRequestCount: true },
      where: { date: currentMonth },
    }),

    // Recent Paddle subscription events (last 10)
    prisma.paddleSubscription.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        userId: true,
        paddleSubscriptionId: true,
        paddlePlanId: true,
        status: true,
        nextBillDate: true,
        updatedAt: true,
        user: { select: { email: true, name: true } },
      },
    }),

    // Recent audit logs (last 20)
    prisma.auditLog.findMany({
      orderBy: { timestamp: 'desc' },
      take: 20,
      select: {
        id: true,
        action: true,
        type: true,
        timestamp: true,
        userId: true,
        userEmail: true,
        projectId: true,
        details: true,
      },
    }),

    // Count of processed webhook events (idempotency table)
    prisma.processedWebhookEvent.count(),

    // Total API keys issued
    prisma.apiKey.count({ where: { expiresAt: null } }),

    // Cohort retention: users old enough to be measured who came back at least
    // N days after signup. This uses the latest activity timestamp available.
    prisma.$queryRaw<RetentionRow[]>`
      WITH windows(days) AS (VALUES (7), (14), (30))
      SELECT
        w.days::int AS "windowDays",
        COUNT(u.id)::int AS "eligibleUsers",
        (COUNT(u.id) FILTER (
          WHERE COALESCE(u."lastActiveAt", u."lastLogin") >= u."createdAt" + (w.days * INTERVAL '1 day')
        ))::int AS "retainedUsers",
        CASE
          WHEN COUNT(u.id) = 0 THEN 0
          ELSE ROUND(
            (
              (COUNT(u.id) FILTER (
                WHERE COALESCE(u."lastActiveAt", u."lastLogin") >= u."createdAt" + (w.days * INTERVAL '1 day')
              ))::numeric / COUNT(u.id)::numeric
            ) * 100,
            1
          )::float8
        END AS "retentionPct"
      FROM windows w
      LEFT JOIN "public"."users" u
        ON u."deletedAt" IS NULL
       AND u."createdAt" <= ${now} - (w.days * INTERVAL '1 day')
      GROUP BY w.days
      ORDER BY w.days
    `,
  ])

  // Tier breakdown
  const tierBreakdown = await prisma.user.groupBy({
    by: ['tier'],
    where: { deletedAt: null },
    _count: { id: true },
  })

  // New users in last 7 days
  const newUsersThisWeek = await prisma.user.count({
    where: { deletedAt: null, createdAt: { gte: sevenDaysAgo } },
  })

  return NextResponse.json({
    users: {
      total: totalUsers,
      suspended: suspendedUsers,
      newThisWeek: newUsersThisWeek,
      activeWeekly: activeUsersWeekly,
      retention: retentionRows.map(row => ({
        days: row.windowDays,
        eligibleUsers: row.eligibleUsers,
        retainedUsers: row.retainedUsers,
        pct: Number(row.retentionPct),
      })),
      tierBreakdown: Object.fromEntries(tierBreakdown.map(t => [t.tier, t._count.id])),
    },
    subscriptions: {
      active: activeSubscriptions,
      gracePeriod: gracePeriodSubscriptions,
    },
    projects: {
      total: totalProjects,
      deployed: activeProjects,
    },
    aiUsage: {
      month: currentMonth,
      intentCount: aiUsageThisMonth._sum.intentCount ?? 0,
      tokenCount: aiUsageThisMonth._sum.tokenCount ?? 0,
      apiRequestCount: Number(aiUsageThisMonth._sum.apiRequestCount ?? 0),
    },
    webhooks: {
      processedEvents: webhookEventCount,
    },
    apiKeys: {
      total: apiKeyCount,
    },
    recentPaymentEvents,
    recentAuditLogs,
  })
}
