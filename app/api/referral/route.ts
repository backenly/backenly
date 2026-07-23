export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { getReferralStats } from '@/lib/billing/referral'

/**
 * GET /api/referral — the current user's referral code, link and real stats
 * (IA restructure §5.5). Mints a stable code on first call.
 * Powers the org-level Referral page. All numbers are real ReferralGrant data.
 */
export const GET = withAuth(async (_request: NextRequest, { user }) => {
  try {
    const stats = await getReferralStats(user.userId)
    return NextResponse.json({ success: true, data: stats })
  } catch (error: any) {
    console.error('[Referral] stats failed:', error?.message)
    return NextResponse.json({ success: false, error: 'Failed to load referral data' }, { status: 500 })
  }
})
