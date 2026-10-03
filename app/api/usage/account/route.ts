export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { describeAccountUsage } from '@/lib/usage/describe'

/**
 * GET /api/usage/account
 *
 * The signed-in account's usage this month, pooled across its projects: used,
 * included, the cap, the month-end projection, the estimated cost of usage past
 * the plan, the spend limit, and any grace or restriction in force
 * (lib/usage/describe.ts). Read-only; the same description the MCP usage read
 * returns.
 *
 * The account is always the caller's own: there is no parameter that names
 * another one.
 */
export const GET = withAuth(async (_request: NextRequest, { user }) => {
  const description = await describeAccountUsage(user.userId)
  if (!description) {
    return NextResponse.json({ error: 'No plan is attached to this account.' }, { status: 404 })
  }
  return NextResponse.json(description)
})
