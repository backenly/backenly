export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/admin/payments
 *
 * Paginated list of Paddle subscription records and their status.
 * Acts as a payment log for the admin dashboard.
 *
 * Query params:
 *   status  - filter: active | canceled | past_due | grace (default: all)
 *   limit   - rows per page (default 50, max 200)
 *   offset  - pagination offset (default 0)
 *   userId  - filter by specific user
 *
 * FOUNDER-ONLY.
 */
export async function GET(request: NextRequest) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const { searchParams } = request.nextUrl
  const statusFilter = searchParams.get('status')
  const userIdFilter = searchParams.get('userId')
  const limit  = Math.min(parseInt(searchParams.get('limit')  ?? '50'), 200)
  const offset = parseInt(searchParams.get('offset') ?? '0')

  const where: any = {}
  if (statusFilter) where.status = statusFilter.toUpperCase()
  if (userIdFilter) where.userId = userIdFilter

  const [total, subscriptions] = await Promise.all([
    prisma.subscription.count({ where }),
    prisma.subscription.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: limit,
      skip: offset,
      include: {
        user: { select: { id: true, email: true, name: true, tier: true } },
        plan: { select: { name: true, priceCents: true } },
      },
    }),
  ])

  // Paddle-specific subscription records (has Paddle customer/plan IDs)
  const paddleWhere: any = {}
  if (statusFilter) paddleWhere.status = statusFilter
  if (userIdFilter) paddleWhere.userId = userIdFilter

  const paddleRecords = await prisma.paddleSubscription.findMany({
    where: paddleWhere,
    orderBy: { updatedAt: 'desc' },
    take: limit,
    skip: offset,
    include: {
      user: { select: { id: true, email: true, name: true } },
    },
  })

  // Revenue summary — count of active subscriptions by plan
  const revenueSummary = await prisma.subscription.groupBy({
    by: ['planId', 'status'],
    _count: { id: true },
    where: { status: { in: ['ACTIVE', 'GRACE'] } },
  })

  const planNames = await prisma.plan.findMany({ select: { id: true, name: true, priceCents: true } })
  const planMap = new Map(planNames.map(p => [p.id, p]))

  const revenueBreakdown = revenueSummary.map(row => ({
    plan: planMap.get(row.planId)?.name ?? row.planId,
    priceCents: planMap.get(row.planId)?.priceCents ?? 0,
    status: row.status,
    count: row._count.id,
    estimatedMRRCents: (planMap.get(row.planId)?.priceCents ?? 0) * row._count.id,
  }))

  return NextResponse.json({
    subscriptions: subscriptions.map(s => ({
      id: s.id,
      userId: s.userId,
      user: s.user,
      plan: s.plan?.name,
      priceCents: s.plan?.priceCents,
      status: s.status,
      paddleSubscriptionId: s.paddleSubscriptionId,
      currentPeriodEnd: s.currentPeriodEnd,
      graceUntil: s.graceUntil,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    })),
    paddleRecords,
    revenueBreakdown,
    total,
    limit,
    offset,
    hasMore: offset + subscriptions.length < total,
  })
}
