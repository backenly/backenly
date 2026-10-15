export const dynamic = 'force-dynamic'

/**
 * GET  /api/support/tickets  — the caller's support cases + their support level
 * POST /api/support/tickets  — file a case; the AI first responder answers in
 *                              the thread without blocking the request
 *
 * Backenly Cloud only: off Cloud the service refuses and this answers 404
 * (lib/support/http.ts). Platform-authenticated; a case is always owned by the
 * signed-in user — there is no cross-account read or write on this surface.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { checkRateLimit } from '@/lib/middleware/rateLimiter'
import { dispatchSupportFirstResponse } from '@/lib/support/ai'
import { TICKET_CREATE_LIMIT } from '@/lib/support/constants'
import { supportErrorResponse } from '@/lib/support/http'
import { createTicket, listTickets } from '@/lib/support/service'

export async function GET(request: NextRequest) {
  let auth
  try {
    auth = await requireAuth(request)
  } catch {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const statusParam = new URL(request.url).searchParams.get('status')
  const status = statusParam === 'open' || statusParam === 'resolved' ? statusParam : 'all'

  try {
    const result = await listTickets(auth.userId, { status })
    return NextResponse.json(result)
  } catch (err) {
    return supportErrorResponse(err)
  }
}

export async function POST(request: NextRequest) {
  let auth
  try {
    auth = await requireAuth(request)
  } catch {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  const rl = await checkRateLimit(`support:create:${auth.userId}`, TICKET_CREATE_LIMIT.limit, TICKET_CREATE_LIMIT.windowMs)
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many cases filed in the last hour. Please wait a little.', code: 'RATE_LIMITED' },
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
    const ticket = await createTicket({
      userId: auth.userId,
      userEmail: auth.userEmail,
      subject: typeof body?.subject === 'string' ? body.subject : '',
      message: typeof body?.message === 'string' ? body.message : '',
      category: typeof body?.category === 'string' ? body.category : 'other',
      severity: typeof body?.severity === 'string' ? body.severity : 'normal',
      projectId: typeof body?.projectId === 'string' && body.projectId ? body.projectId : null,
    })
    dispatchSupportFirstResponse(ticket.id)
    return NextResponse.json({ ticket }, { status: 201 })
  } catch (err) {
    return supportErrorResponse(err)
  }
}
