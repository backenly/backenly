export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireFounder } from '@/lib/auth/requireFounder'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/admin/users/[userId]/credits
 * Returns current AI credit usage for the specified user.
 *
 * POST /api/admin/users/[userId]/credits
 * Refund credits by resetting or reducing the user's AI usage count for the month.
 * Body: { action: "reset" | "reduce", amount?: number, month?: "YYYY-MM" }
 *
 * FOUNDER-ONLY.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const { userId } = params

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, tier: true, deletedAt: true },
  })

  if (!user || user.deletedAt) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const currentMonth = new Date().toISOString().slice(0, 7)

  const [currentUsage, allUsage, subscription] = await Promise.all([
    prisma.userAiUsage.findFirst({
      where: { userId, date: currentMonth },
    }),
    prisma.userAiUsage.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 12,
    }),
    prisma.subscription.findFirst({
      where: { userId },
      include: { plan: { select: { name: true, maxAiBuildActionsPerMonth: true, maxApiRequestsPerMonth: true } } },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  return NextResponse.json({
    userId,
    email: user.email,
    tier: user.tier,
    plan: subscription?.plan?.name ?? 'FREE',
    limits: {
      aiBuildActionsPerMonth: subscription?.plan?.maxAiBuildActionsPerMonth ?? null,
      apiRequestsPerMonth: subscription?.plan?.maxApiRequestsPerMonth ? Number(subscription.plan.maxApiRequestsPerMonth) : null,
    },
    currentMonth: {
      month: currentMonth,
      intentCount: currentUsage?.intentCount ?? 0,
      tokenCount: currentUsage?.tokenCount ?? 0,
      apiRequestCount: Number(currentUsage?.apiRequestCount ?? 0),
    },
    history: allUsage.map(u => ({
      month: u.date,
      intentCount: u.intentCount,
      tokenCount: u.tokenCount,
      apiRequestCount: Number(u.apiRequestCount),
    })),
  })
}

export async function POST(
  request: NextRequest,
  { params }: { params: { userId: string } }
) {
  const authError = await requireFounder(request)
  if (authError) return authError

  const { userId } = params
  const body = await request.json().catch(() => ({}))
  const { action, amount, month } = body ?? {}

  if (!['reset', 'reduce'].includes(action)) {
    return NextResponse.json({ error: 'action must be "reset" or "reduce"' }, { status: 400 })
  }

  const targetMonth = month ?? new Date().toISOString().slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) {
    return NextResponse.json({ error: 'month must be in YYYY-MM format' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, deletedAt: true },
  })
  if (!user || user.deletedAt) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const usageRecord = await prisma.userAiUsage.findFirst({
    where: { userId, date: targetMonth },
  })

  if (action === 'reset') {
    // Full reset: delete the usage record so limits refresh immediately
    if (usageRecord) {
      await prisma.userAiUsage.delete({ where: { id: usageRecord.id } })
    }
    // Audit log
    await prisma.auditLog.create({
      data: {
        action: 'CREDITS_RESET',
        type: 'admin',
        userId,
        userEmail: user.email,
        details: `AI credit usage reset for ${targetMonth} by admin`,
      },
    })
    return NextResponse.json({ success: true, action: 'reset', month: targetMonth })
  }

  // Reduce: decrease intentCount by `amount` (floor at 0)
  if (!amount || typeof amount !== 'number' || amount <= 0) {
    return NextResponse.json({ error: '"amount" (positive number) is required for reduce' }, { status: 400 })
  }

  if (!usageRecord) {
    return NextResponse.json({ error: 'No usage record found for that month' }, { status: 404 })
  }

  const newCount = Math.max(0, usageRecord.intentCount - amount)
  await prisma.userAiUsage.update({
    where: { id: usageRecord.id },
    data: { intentCount: newCount },
  })

  await prisma.auditLog.create({
    data: {
      action: 'CREDITS_REFUNDED',
      type: 'admin',
      userId,
      userEmail: user.email,
      details: `Refunded ${amount} AI build actions for ${targetMonth} (was ${usageRecord.intentCount}, now ${newCount})`,
    },
  })

  return NextResponse.json({
    success: true,
    action: 'reduce',
    month: targetMonth,
    previousCount: usageRecord.intentCount,
    newCount,
    refunded: amount,
  })
}
