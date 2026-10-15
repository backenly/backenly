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
import { checkRateLimit } from '@/lib/middleware/rateLimiter'
import { TICKET_REPLY_LIMIT } from '@/lib/support/constants'
import { supportErrorResponse } from '@/lib/support/http'
import { addCustomerReply } from '@/lib/support/service'

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  let auth
  try {
    auth = await requireAuth(request)
  } catch {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const rl = await checkRateLimit(`support:reply:${auth.userId}`, TICKET_REPLY_LIMIT.limit, TICKET_REPLY_LIMIT.windowMs)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many replies in the last hour. Please wait a little.', code: 'RATE_LIMITED' },
      { status: 429 }
    )
  }

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
