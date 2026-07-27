export const dynamic = 'force-dynamic'

/**
 * GET /api/billing/current
 *
 * Returns current billing information for the authenticated user.
 * All plans (Free, Pro, Enterprise) are flat-rate — no pay-as-you-go charges.
 *
 * Response:
 *   {
 *     plan: "SANDBOX" | "BUILDER" | "SCALE",
 *     displayName: "Free" | "Pro" | "Enterprise",
 *     isPayAsYouGo: false,
 *     month: "2026-03",
 *     subscriptionStatus: "FREE" | "ACTIVE" | "GRACE",
 *     nextBillingDate: "2026-04-01T00:00:00Z",
 *     message?: string   (for Free plan only)
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getUserSubscription } from '@/lib/billing'
import { currentMonth, nextMonthStart } from '@/lib/billing/credits'

const PLAN_DISPLAY: Record<string, string> = {
  SANDBOX: 'Free',
  BUILDER: 'Pro',
  SCALE: 'Enterprise',
  FREE: 'Free',
}

export const GET = withAuth(async (request: NextRequest, { user }) => {
  try {
    const userId = user.userId
    const sub = await getUserSubscription(userId)

    const month = currentMonth()
    const nextBillingDate = nextMonthStart().toISOString()
    const planName = sub?.plan.name ?? 'SANDBOX'
    const displayName = PLAN_DISPLAY[planName] ?? planName

    return NextResponse.json({
      plan: planName,
      displayName,
      isPayAsYouGo: false,
      isSandboxPlan: sub?.plan.isSandboxPlan ?? true,
      month,
      priceCents: sub?.plan.priceCents ?? 0,
      annualPriceCents: sub?.plan.annualPriceCents ?? null,
      subscriptionStatus: sub?.status ?? 'FREE',
      nextBillingDate,
      ...(planName === 'SANDBOX' && {
        // Do NOT sell Pro on autonomy cadence: Free already self-heals every
        // minute with the full dial, and the pricing page says so. Pro's real
        // deltas are capacity, the unlimited scan budget, and 20 autonomous
        // actions per window vs 5.
        message: 'Free plan — one permanently live project, self-healing every minute. Upgrade to Pro for more capacity and unmetered autonomy.',
      }),
    })
  } catch (error: any) {
    console.error('[Billing/Current] Error:', error)
    return NextResponse.json(
      { error: 'INTERNAL_ERROR', message: error.message || 'Failed to fetch billing' },
      { status: 500 }
    )
  }
})
