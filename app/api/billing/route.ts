export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getUserSubscription, getUserEntitlements, getSubscriptionStatusDisplay } from '@/lib/billing'

/**
 * GET /api/billing - Get current user subscription and entitlements
 * 🔒 Protected: Requires authentication
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const subscription = await getUserSubscription(user.userId)

    if (!subscription) {
      return NextResponse.json(
        { error: 'No subscription found — run: npx tsx prisma/seed-billing.ts' },
        { status: 404 }
      )
    }

    const entitlements = await getUserEntitlements(user.userId)

    return NextResponse.json({
      subscription: {
        id: subscription.id,
        status: subscription.status,
        statusDisplay: getSubscriptionStatusDisplay(subscription.status),
        paddleSubscriptionId: subscription.paddleSubscriptionId,
        currentPeriodEnd: subscription.currentPeriodEnd,
        graceUntil: subscription.graceUntil,
        planName: subscription.plan.name,
        priceCents: subscription.plan.priceCents,
      },
      entitlements,
    })
  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || 'Failed to get billing info' },
      { status: 500 }
    )
  }
})
