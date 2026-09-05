export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/growth
 *
 * Signup trend data + engagement + feature adoption for the founder Growth tab.
 *
 * Returns:
 *   daily90   — signups per day, last 90 days
 *   weekly    — signups per week, last 52 weeks (1 year)
 *   monthly   — signups per month, last 24 months
 *   dau       — users active in the last 24h (any authenticated request)
 *   wau       — users active in the last 7 days
 *   mau       — users active in the last 30 days
 *
 *   Activity = `lastActiveAt` (bumped by auth middleware on every request,
 *   debounced to ~1 write/min/user). `lastLogin` is used as a fallback for
 *   rows that pre-date the lastActiveAt rollout.
 *   featureAdoption — % of active projects using each feature
 *
 * FOUNDER-ONLY.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

interface BucketRow { period: Date; count: number }

// Monday-aligned start of the UTC week — mirrors Postgres DATE_TRUNC('week'),
// which is ISO-8601 (week starts Monday). Both sides MUST agree or every
// weekly bucket misses and the "1Y W" chart renders flat-empty.
function startOfWeekUTC(d: Date): Date {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = dt.getUTCDay() // 0=Sun … 6=Sat
  dt.setUTCDate(dt.getUTCDate() + (dow === 0 ? -6 : 1 - dow))
  return dt
}

function toKey(d: Date, unit: 'day' | 'week' | 'month'): string {
  const dt = new Date(d)
  if (unit === 'month') {
    return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`
  }
  if (unit === 'week') {
    return startOfWeekUTC(dt).toISOString().slice(0, 10)
  }
  // day — UTC calendar date
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()))
    .toISOString()
    .slice(0, 10)
}

// Fill calendar gaps so the chart always has a contiguous series.
// The generated anchors use the SAME UTC/Monday alignment as toKey so
// DB-truncated periods and synthetic gap dates collide on identical keys.
function fillGaps(
  rows: BucketRow[],
  unit: 'day' | 'week' | 'month',
  count: number
): { date: string; count: number }[] {
  const map = new Map<string, number>()
  for (const r of rows) {
    map.set(toKey(r.period, unit), Number(r.count))
  }

  const result: { date: string; count: number }[] = []
  const now = new Date()

  for (let i = count - 1; i >= 0; i--) {
    let d: Date
    if (unit === 'day') {
      d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
      d.setUTCDate(d.getUTCDate() - i)
    } else if (unit === 'week') {
      d = startOfWeekUTC(now)
      d.setUTCDate(d.getUTCDate() - i * 7)
    } else {
      d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      d.setUTCMonth(d.getUTCMonth() - i)
    }
    const key = toKey(d, unit)
    result.push({ date: key, count: map.get(key) ?? 0 })
  }
  return result
}

export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const now = new Date()
  const d24h  = new Date(now.getTime() - 24 * 3600 * 1000)
  const d7d   = new Date(now.getTime() - 7  * 24 * 3600 * 1000)
  const d30d  = new Date(now.getTime() - 30 * 24 * 3600 * 1000)
  const d90d  = new Date(now.getTime() - 90 * 24 * 3600 * 1000)
  const d52w  = new Date(now.getTime() - 365 * 24 * 3600 * 1000)
  const d24mo = new Date(now); d24mo.setMonth(now.getMonth() - 24)

  const [
    rawDaily,
    rawWeekly,
    rawMonthly,
    dau,
    wau,
    mau,
    totalProjects,
    // Feature adoption — count of distinct projects using each feature
    projectsWithFunctions,
    projectsWithStorage,
    projectsWithTriggers,
    projectsWithWebhooks,
    projectsWithDeployments,
    projectsWithApiKeys,
    projectsWithExternalUsers,
    projectsWithAiGraph,
  ] = await Promise.all([

    // ── Daily signups (last 90 days) ──
    prisma.$queryRaw<BucketRow[]>`
      SELECT DATE_TRUNC('day', "createdAt") AS period, COUNT(*)::int AS count
      FROM   "public"."users"
      WHERE  "deletedAt" IS NULL
        AND  "createdAt" >= ${d90d}
      GROUP  BY 1
      ORDER  BY 1
    `,

    // ── Weekly signups (last 52 weeks) ──
    prisma.$queryRaw<BucketRow[]>`
      SELECT DATE_TRUNC('week', "createdAt") AS period, COUNT(*)::int AS count
      FROM   "public"."users"
      WHERE  "deletedAt" IS NULL
        AND  "createdAt" >= ${d52w}
      GROUP  BY 1
      ORDER  BY 1
    `,

    // ── Monthly signups (last 24 months) ──
    prisma.$queryRaw<BucketRow[]>`
      SELECT DATE_TRUNC('month', "createdAt") AS period, COUNT(*)::int AS count
      FROM   "public"."users"
      WHERE  "deletedAt" IS NULL
        AND  "createdAt" >= ${d24mo}
      GROUP  BY 1
      ORDER  BY 1
    `,

    // ── Engagement ──
    // Prefer lastActiveAt (true activity); fall back to lastLogin for users
    // whose lastActiveAt was never set (pre-rollout rows).
    prisma.user.count({
      where: {
        deletedAt: null,
        OR: [{ lastActiveAt: { gte: d24h } }, { lastActiveAt: null, lastLogin: { gte: d24h } }],
      },
    }),
    prisma.user.count({
      where: {
        deletedAt: null,
        OR: [{ lastActiveAt: { gte: d7d } }, { lastActiveAt: null, lastLogin: { gte: d7d } }],
      },
    }),
    prisma.user.count({
      where: {
        deletedAt: null,
        OR: [{ lastActiveAt: { gte: d30d } }, { lastActiveAt: null, lastLogin: { gte: d30d } }],
      },
    }),

    // ── Total non-expired projects (denominator) ──
    prisma.project.count({ where: { expiresAt: null, deletedAt: null } }),

    // ── Feature adoption (distinct project count per feature) ──
    prisma.aiFunction.findMany({ select: { projectId: true }, distinct: ['projectId'] }).then(r => r.length),
    prisma.storageBucket.findMany({ select: { projectId: true }, distinct: ['projectId'] }).then(r => r.length),
    prisma.appTrigger.findMany({ select: { projectId: true }, distinct: ['projectId'] }).then(r => r.length),
    prisma.webhook.findMany({ select: { projectId: true }, distinct: ['projectId'] }).then(r => r.length),
    prisma.deployment.findMany({ select: { projectId: true }, distinct: ['projectId'] }).then(r => r.length),
    prisma.apiKey.findMany({ select: { projectId: true }, distinct: ['projectId'] }).then(r => r.length),
    prisma.project.count({ where: { expiresAt: null, deletedAt: null, hasExternalUsers: true } }),
    prisma.project.count({ where: { expiresAt: null, deletedAt: null, isBackendGenerated: true } }),
  ])

  const total = totalProjects || 1
  const pct = (n: number) => Math.round((n / total) * 100)

  const featureAdoption = [
    { feature: 'AI Backend Generated', projectCount: projectsWithAiGraph,        pct: pct(projectsWithAiGraph),        description: 'Projects that used AI to generate a backend' },
    { feature: 'API Keys / Frontend',  projectCount: projectsWithApiKeys,         pct: pct(projectsWithApiKeys),         description: 'Projects with a connected frontend (API key issued)' },
    { feature: 'Deployments',          projectCount: projectsWithDeployments,     pct: pct(projectsWithDeployments),     description: 'Projects that have been deployed at least once' },
    { feature: 'Live End-Users',       projectCount: projectsWithExternalUsers,   pct: pct(projectsWithExternalUsers),   description: 'Projects with real users signing in / using the backend' },
    { feature: 'Storage',              projectCount: projectsWithStorage,          pct: pct(projectsWithStorage),          description: 'Projects using file storage buckets' },
    { feature: 'Event Triggers',       projectCount: projectsWithTriggers,         pct: pct(projectsWithTriggers),         description: 'Projects with insert/update/delete/webhook triggers configured' },
    { feature: 'Webhooks',             projectCount: projectsWithWebhooks,         pct: pct(projectsWithWebhooks),         description: 'Projects with outbound webhooks configured' },
    { feature: 'AI Functions',         projectCount: projectsWithFunctions,        pct: pct(projectsWithFunctions),        description: 'Projects using serverless AI functions' },
  ].sort((a, b) => b.projectCount - a.projectCount)

  return NextResponse.json({
    daily90:  fillGaps(rawDaily,   'day',   90),
    weekly:   fillGaps(rawWeekly,  'week',  52),
    monthly:  fillGaps(rawMonthly, 'month', 24),
    dau,
    wau,
    mau,
    totalProjects,
    featureAdoption,
  })
}
