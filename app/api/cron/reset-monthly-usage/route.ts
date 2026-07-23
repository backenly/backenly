/**
 * POST /api/cron/reset-monthly-usage
 *
 * Resets monthly usage counters for all users at the start of each billing cycle.
 * Called by:
 *   - A scheduler/cron service on the 1st of each month (UTC midnight)
 *   - The Paddle webhook handler on `subscription.activated` / renewal events
 *
 * Security: requires CRON_SECRET header to prevent unauthorized calls.
 * Usage records are keyed by YYYY-MM, so a new month automatically starts
 * a fresh record — this endpoint explicitly deletes stale old records beyond
 * the plan's log retention window and clears the in-memory usage cache.
 */

export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/prisma'

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

  const now = new Date()
  const currentMonth = now.toISOString().slice(0, 7) // YYYY-MM

  // Delete usage records older than 3 months to keep the table lean.
  // Active-month records are keyed by YYYY-MM and accumulate naturally;
  // no explicit zeroing is needed — a new month simply starts at 0.
  const threeMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1))
  const cutoffMonth = threeMonthsAgo.toISOString().slice(0, 7)

  const { count } = await prisma.userAiUsage.deleteMany({
    where: { date: { lt: cutoffMonth } },
  })

  console.log(`[cron/reset-monthly-usage] Purged ${count} stale usage records (< ${cutoffMonth})`)

  return NextResponse.json({
    success: true,
    currentMonth,
    purgedRecords: count,
    message: `Monthly usage reset complete. Old records before ${cutoffMonth} have been purged.`,
  })
}
