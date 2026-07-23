export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getPlanByName, getUserSubscription } from '@/lib/billing'

// Current architecture (v4): BUILDER (Pro $25/mo) is the ONLY self-serve paid
// plan. SCALE (Enterprise) is sales-led — no checkout, contact sales.
// Legacy: STARTER, GROWTH, PRO (kept for backward compat with old Paddle subscriptions)
const PADDLE_PRICE_IDS: Record<string, string | undefined> = {
  // Current plans
  BUILDER: process.env.PADDLE_BUILDER_PRICE_ID,   // Pro — $25/mo
  // Legacy plans (backward compat)
  STARTER: process.env.PADDLE_STARTER_PRICE_ID,
  GROWTH: process.env.PADDLE_GROWTH_PRICE_ID,
  PRO: process.env.PADDLE_PRO_PRICE_ID,
}

const PADDLE_ANNUAL_PRICE_IDS: Record<string, string | undefined> = {
  BUILDER: process.env.PADDLE_BUILDER_ANNUAL_PRICE_ID,  // Pro annual — $240/yr ($20/mo)
}

const VALID_PLANS = ['BUILDER', 'STARTER', 'GROWTH', 'PRO']

const PLAN_DISPLAY: Record<string, string> = {
  BUILDER: 'Pro',
  STARTER: 'Starter',
  GROWTH: 'Growth',
  PRO: 'Pro',
}

/**
 * POST /api/billing/create-checkout
 * Return Paddle checkout configuration for client-side checkout.
 * Supports the BUILDER (Pro $25/mo) plan. SCALE (Enterprise) is sales-led and
 * deliberately rejected here — enterprise deals never go through self-serve.
 * 🔒 Protected: Requires authentication
 */
export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    const body = await request.json()
    const { plan: planName, billing } = body
    const isAnnual = billing === 'annual'

    if (planName === 'SCALE') {
      return NextResponse.json(
        {
          error: 'Enterprise is sales-led — email sales@backenly.com and we will scope it around your product.',
          code: 'ENTERPRISE_SALES_LED',
        },
        { status: 400 }
      )
    }

    if (!planName || !VALID_PLANS.includes(planName)) {
      return NextResponse.json(
        { error: `Invalid plan. Must be one of: ${VALID_PLANS.join(', ')}` },
        { status: 400 }
      )
    }

    const plan = await getPlanByName(planName)
    if (!plan) {
      return NextResponse.json(
        { error: 'Plan not found — run: npx tsx prisma/seed-billing.ts' },
        { status: 404 }
      )
    }

    // ── Duplicate subscription guard ─────────────────────────────────────────
    // A Paddle subscription is an access state, not a cart item.
    // Block checkout if the user already has an active paid subscription.
    // This prevents double-billing and duplicate records.
    const existingSub = await getUserSubscription(user.userId)
    const isPaidPlan = (name: string) => name !== 'SANDBOX' && name !== 'FREE'
    if (existingSub && isPaidPlan(existingSub.plan.name) && existingSub.status === 'ACTIVE') {
      if (existingSub.plan.name === planName) {
        return NextResponse.json(
          { error: `You are already on the ${existingSub.plan.name} plan. No action needed.`, code: 'ALREADY_SUBSCRIBED' },
          { status: 409 }
        )
      }
      // Trying to switch to a different paid plan — they must cancel first (or we handle via Paddle subscription update)
      return NextResponse.json(
        {
          error: `You already have an active ${existingSub.plan.name} subscription. Cancel your current plan before switching, or contact support to upgrade.`,
          code: 'ACTIVE_SUBSCRIPTION_EXISTS',
          currentPlan: existingSub.plan.name,
        },
        { status: 409 }
      )
    }

    // Pick annual or monthly price ID
    const priceId = isAnnual
      ? (PADDLE_ANNUAL_PRICE_IDS[planName] ?? PADDLE_PRICE_IDS[planName])
      : PADDLE_PRICE_IDS[planName]

    if (!priceId) {
      return NextResponse.json(
        { error: `Paddle price ID not configured for ${planName}${isAnnual ? ' (annual)' : ''}` },
        { status: 500 }
      )
    }

    const displayName = PLAN_DISPLAY[planName] ?? planName

    console.log('[Checkout] priceId:', JSON.stringify(priceId), '| email:', user.email, '| plan:', planName)

    return NextResponse.json({
      priceId: priceId.trim(),
      customerEmail: user.email,
      customerName: user.email,
      customData: {
        userId: user.userId,
        planName,
        displayName,
        billing: isAnnual ? 'annual' : 'monthly',
      },
      successUrl: `${process.env.NEXT_PUBLIC_APP_URL}/app/settings?section=billing&success=true`,
      cancelUrl: `${process.env.NEXT_PUBLIC_APP_URL}/app/settings?section=billing&canceled=true`,
    })
  } catch (error: any) {
    console.error('[Paddle Checkout] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to create checkout' },
      { status: 500 }
    )
  }
})
