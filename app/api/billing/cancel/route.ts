export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { Paddle, Environment } from '@paddle/paddle-node-sdk'
import { getUserSubscription } from '@/lib/billing'
import { initiateGracePeriod } from '@/lib/billing/grace'

/**
 * POST /api/billing/cancel
 * Cancel the user's active Paddle subscription
 * Grants a 7-day grace period before reverting to FREE
 * 🔒 Protected: Requires authentication
 */
export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    const subscription = await getUserSubscription(user.userId)

    if (!subscription) {
      return NextResponse.json(
        { error: 'No active subscription found' },
        { status: 404 }
      )
    }

    if (subscription.status === 'FREE') {
      return NextResponse.json(
        { error: 'Cannot cancel a free subscription' },
        { status: 400 }
      )
    }

    if (!subscription.paddleSubscriptionId) {
      return NextResponse.json(
        { error: 'No Paddle subscription ID found' },
        { status: 400 }
      )
    }

    if (!process.env.PADDLE_API_KEY) {
      return NextResponse.json(
        { error: 'Paddle not configured' },
        { status: 500 }
      )
    }

    const paddle = new Paddle(process.env.PADDLE_API_KEY, {
      environment: (process.env.PADDLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox') as Environment
    })

    // Cancel at end of billing period
    await paddle.subscriptions.cancel(subscription.paddleSubscriptionId, {
      effectiveFrom: 'next_billing_period'
    })

    // Initiate grace period locally (webhook will also fire, but this is immediate feedback)
    await initiateGracePeriod(user.userId)

    return NextResponse.json({
      success: true,
      message: 'Subscription canceled. You have 7 days of grace period before reverting to the FREE plan.',
      graceUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    })

  } catch (error: any) {
    console.error('[Billing Cancel] Error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to cancel subscription' },
      { status: 500 }
    )
  }
})
