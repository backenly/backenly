export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { prisma } from '@/lib/db/prisma'

/**
 * GET /api/billing/credit-activity
 *
 * Per-event credit history for the Billing page (§5.4), now unifying two real
 * sources:
 *   • Bonus GRANTS — CreditLedgerEntry with amount > 0 (referral, promo, admin).
 *   • AI job SPEND — CreditReservation committed (spent) / refunded (returned).
 *
 * We intentionally exclude the ledger's internal `monthly_bonus_burn`
 * reconciliation rows from the user-facing feed: the job spend is already shown
 * via reservations, so surfacing the bonus-portion burn too would read as a
 * double charge. Grants and spend are what the user actually cares about.
 */
export const GET = withAuth(async (_request: NextRequest, { user }) => {
  try {
    const [reservations, grants] = await Promise.all([
      prisma.creditReservation.findMany({
        where: { userId: user.userId, status: { in: ['committed', 'refunded'] } },
        orderBy: [{ committedAt: 'desc' }, { refundedAt: 'desc' }, { createdAt: 'desc' }],
        take: 50,
        select: {
          id: true, amount: true, status: true, date: true,
          createdAt: true, committedAt: true, refundedAt: true,
        },
      }),
      prisma.creditLedgerEntry.findMany({
        where: { userId: user.userId, amount: { gt: 0 } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, amount: true, reason: true, description: true, createdAt: true },
      }),
    ])

    const spendEntries = reservations.map((r) => ({
      id: r.id,
      amount: r.amount,
      kind: r.status === 'refunded' ? ('refund' as const) : ('burn' as const),
      label: r.status === 'refunded' ? 'Credits returned (job did not complete)' : 'AI job',
      at: (r.committedAt ?? r.refundedAt ?? r.createdAt).toISOString(),
      cycle: r.date,
    }))

    const grantEntries = grants.map((g) => ({
      id: g.id,
      amount: g.amount,
      kind: 'grant' as const,
      label: g.description || grantLabel(g.reason),
      at: g.createdAt.toISOString(),
      cycle: g.createdAt.toISOString().slice(0, 7),
    }))

    const entries = [...grantEntries, ...spendEntries]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 50)

    return NextResponse.json({ entries })
  } catch (error: any) {
    console.error('[Credit Activity]', error)
    return NextResponse.json({ error: error.message || 'Failed to load credit activity' }, { status: 500 })
  }
})

function grantLabel(reason: string): string {
  switch (reason) {
    case 'referral_signup': return 'Referral welcome bonus'
    case 'referral_paid':   return 'Referral reward'
    case 'signup_bonus':    return 'Signup bonus'
    case 'promo':           return 'Promo credit'
    case 'admin_grant':     return 'Credit grant'
    default:                return 'Bonus credits'
  }
}
