/**
 * POST /api/cron/process-grace-periods
 *
 * Runs daily. Finds every subscription in GRACE status whose graceUntil
 * has passed and downgrades it to the FREE plan.
 *
 * Timeline for a user whose plan expires:
 *   Day 0  — subscription.canceled / past_due fires → status = GRACE, graceUntil = +7d
 *   Day 1–7 — user still has paid-plan features (GRACE is allowed by getUserSubscription)
 *   Day 8  — this cron runs, sees graceUntil < now → planId = FREE, status = FREE
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
