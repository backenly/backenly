export const dynamic = 'force-dynamic'

/**
 * POST /api/support/tickets/[id]/messages — reply on a case the caller owns.
 *
 * A reply puts the case back in the team's queue (and reopens a resolved one);
 * the AI responder never answers replies, so correspondence after the first
 * answer is always with people.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { TICKET_REPLY_LIMIT } from '@/lib/support/constants'
import { spendSupportBudget, supportErrorResponse } from '@/lib/support/http'
import { addCustomerReply } from '@/lib/support/service'

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  let auth
  try {
    auth = await requireAuth(request)
  } catch {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const refused = await spendSupportBudget('reply', auth.userId, TICKET_REPLY_LIMIT, 'Too many replies in the last hour. Please wait a little.')
  if (refused) return refused

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    const message = await addCustomerReply(
      auth.userId,
      auth.userEmail,
      params.id,
      typeof body?.body === 'string' ? body.body : ''
    )
    return NextResponse.json({ message }, { status: 201 })
  } catch (err) {
    return supportErrorResponse(err)
  }
}
