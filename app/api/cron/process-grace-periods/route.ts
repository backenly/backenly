/**
 * POST /api/cron/process-grace-periods
 *
 * Runs daily. Finds every subscription whose failed-payment recovery window
 * has run out and downgrades it to the canonical free plan.
 *
 * Timeline for a user whose payment fails:
 *   Day 0  — subscription.past_due fires → status = GRACE, graceUntil = +7d
 *   Day 1–7 — user still has paid-plan features (GRACE is allowed by getUserSubscription)
 *   Day 8  — this cron runs, sees graceUntil < now → downgraded to the free plan
 *
 * A voluntary cancellation never appears here. It stays ACTIVE and entitled
 * until the provider's terminal subscription.canceled event, which does its own
 * downgrade — this cron is not a second cancellation clock.
 *
 * Security: requires CRON_SECRET header.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { runDailyGraceCheck } from '@/lib/billing/grace'

function verifyCronAuth(request: NextRequest): boolean {
  return request.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
}

export async function GET(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return POST(request)
}

export async function POST(request: NextRequest) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await runDailyGraceCheck()

  console.log(`[cron/process-grace-periods] Downgraded ${result.processed} users to FREE`)

  return NextResponse.json({
    success: true,
    processed: result.processed,
    errors: result.errors,
    message: `Processed ${result.processed} expired grace period(s).`,
  })
}
