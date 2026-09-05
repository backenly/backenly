export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/revenue
 *
 * Revenue movement + dunning for the founder Revenue tab:
 *   - mrr            current MRR by plan + this-month movement (new / churned / net)
 *   - conversion     total users, paid users, free→paid %
 *   - economics      ARPU + a clearly-labelled rough LTV estimate
 *   - dunning        GRACE / PAST_DUE subs that need attention, with the Paddle id
 *
 * FOUNDER-ONLY. All figures are derived from Subscription + Plan — no
 * fabricated numbers; LTV is explicitly marked as an estimate.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const [activeSubs, plans, totalUsers, paidUserIds, newThisMonth, churnedThisMonth, dunningSubs] =
    await Promise.all([
      prisma.subscription.findMany({
        where: { status: { in: ['ACTIVE', 'GRACE'] } },
        select: { id: true, planId: true, status: true, userId: true, createdAt: true },
      }),
      prisma.plan.findMany({ select: { id: true, name: true, priceCents: true } }),
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.subscription.findMany({
        where: { status: { in: ['ACTIVE', 'GRACE'] }, plan: { priceCents: { gt: 0 } } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      prisma.subscription.count({
        where: { status: 'ACTIVE', createdAt: { gte: monthStart }, plan: { priceCents: { gt: 0 } } },
      }),
      prisma.subscription.count({
        where: { status: { in: ['CANCELED', 'PAST_DUE'] }, updatedAt: { gte: monthStart } },
      }),
      prisma.subscription.findMany({
        where: { status: { in: ['GRACE', 'PAST_DUE'] } },
        orderBy: { graceUntil: 'asc' },
        take: 50,
        include: {
          user: { select: { id: true, email: true, name: true } },
          plan: { select: { name: true, priceCents: true } },
        },
      }),
    ])

  const planMap = new Map(plans.map(p => [p.id, p]))

  // MRR by plan
  const byPlan: Record<string, { plan: string; priceCents: number; count: number; mrrCents: number }> = {}
  let mrrCents = 0
  for (const s of activeSubs) {
    const p = planMap.get(s.planId)
    const price = p?.priceCents ?? 0
    if (price <= 0) continue
    const key = p?.name ?? s.planId
    byPlan[key] ??= { plan: key, priceCents: price, count: 0, mrrCents: 0 }
    byPlan[key].count++
    byPlan[key].mrrCents += price
    mrrCents += price
  }

  const paidUsers = paidUserIds.length
  const conversionPct = totalUsers > 0 ? Math.round((paidUsers / totalUsers) * 1000) / 10 : 0
  const arpuCents = paidUsers > 0 ? Math.round(mrrCents / paidUsers) : 0

  // Rough LTV: ARPU / monthly churn rate. Honest estimate, flagged as such.
  const churnRate = paidUsers + churnedThisMonth > 0
    ? churnedThisMonth / (paidUsers + churnedThisMonth)
    : 0
  const ltvCents = churnRate > 0 ? Math.round(arpuCents / churnRate) : 0

  const dunning = dunningSubs.map(s => ({
    userId: s.user.id,
    userEmail: s.user.email,
    userName: s.user.name,
    plan: s.plan?.name ?? '—',
    priceCents: s.plan?.priceCents ?? 0,
    status: s.status,
    graceUntil: s.graceUntil?.toISOString() ?? null,
    paddleSubscriptionId: s.paddleSubscriptionId ?? null,
    updatedAt: s.updatedAt.toISOString(),
  }))

  return NextResponse.json({
    mrr: {
      totalCents: mrrCents,
      byPlan: Object.values(byPlan).sort((a, b) => b.mrrCents - a.mrrCents),
      movement: {
        newThisMonth,
        churnedThisMonth,
        net: newThisMonth - churnedThisMonth,
      },
    },
    conversion: { totalUsers, paidUsers, conversionPct },
    economics: {
      arpuCents,
      ltvCents,
      ltvNote: 'LTV ≈ ARPU ÷ monthly churn rate — a rough estimate, not accrual accounting.',
    },
    dunning,
  })
}
