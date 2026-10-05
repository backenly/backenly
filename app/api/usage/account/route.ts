export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { accountForCaller } from '@/lib/entitlements'
import { describeAccountUsage } from '@/lib/usage/describe'

/**
 * GET /api/usage/account?orgId=
 *
 * A billing account's usage this month, pooled across its projects: used,
 * included, the cap, the month-end projection, the estimated cost of usage past
 * the plan, the spend limit, and any grace or restriction in force
 * (lib/usage/describe.ts). Read-only; the same description the MCP usage read
 * returns.
 *
 * The account is the caller's own, or (on Cloud) an organization the caller
 * belongs to, named by ?orgId=. Nothing else: an account the caller may not
 * read is answered as not found.
 */
export const GET = withAuth(async (request: NextRequest, { user }) => {
  const account = await accountForCaller(user.userId, request.nextUrl?.searchParams.get('orgId'))
  if (!account) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const description = await describeAccountUsage(account)
  if (!description) {
    return NextResponse.json({ error: 'No plan is attached to this account.' }, { status: 404 })
  }
  return NextResponse.json(description)
})
