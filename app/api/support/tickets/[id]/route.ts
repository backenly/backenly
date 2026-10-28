export const dynamic = 'force-dynamic'

/**
 * GET   /api/support/tickets/[id] — one case with its correspondence thread
 * PATCH /api/support/tickets/[id] — { action: 'resolve' | 'reopen' | 'retry_ai' }
 *
 * Owner-scoped: the queries carry `userId`, so another account's case answers
 * 404 exactly like a case that does not exist.
 *
 * Reading a case also picks up an AI first response whose attempt was lost (a
 * restart between filing and answering), so the case page never waits on a
 * timer that no longer exists. `retry_ai` asks the responder again after it
 * gave up on a failure a later attempt can get past (lib/support/constants.ts).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { checkRateLimit } from '@/lib/middleware/rateLimiter'
import { dispatchSupportFirstResponse, resumeSupportFirstResponse } from '@/lib/support/ai'
import { TICKET_AI_RETRY_LIMIT } from '@/lib/support/constants'
import { supportErrorResponse } from '@/lib/support/http'
import { getSupportLevel, getTicket, reopenTicket, resolveTicket, retryAiAnswer } from '@/lib/support/service'

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  let auth
  try {
    auth = await requireAuth(request)
  } catch {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  try {
    const ticket = await getTicket(auth.userId, params.id)
    if (!ticket) return NextResponse.json({ error: 'Case not found', code: 'CASE_NOT_FOUND' }, { status: 404 })
    resumeSupportFirstResponse(ticket)
    // The level only labels the page (the team's reply target); a case still
    // reads when entitlements cannot be had.
    const level = await getSupportLevel(auth.userId).catch(() => null)
    return NextResponse.json({ ticket, level })
  } catch (err) {
    return supportErrorResponse(err)
  }
}

export async function PATCH(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  let auth
  try {
    auth = await requireAuth(request)
  } catch {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  try {
    if (body?.action === 'resolve') {
      return NextResponse.json({ ticket: await resolveTicket(auth.userId, params.id) })
    }
    if (body?.action === 'reopen') {
      return NextResponse.json({ ticket: await reopenTicket(auth.userId, params.id) })
    }
    if (body?.action === 'retry_ai') {
      const rl = await checkRateLimit(`support:ai-retry:${auth.userId}`, TICKET_AI_RETRY_LIMIT.limit, TICKET_AI_RETRY_LIMIT.windowMs)
      if (!rl.allowed) {
        return NextResponse.json(
          { error: 'Too many retries in the last hour. The team has your cases and replies directly.', code: 'RATE_LIMITED' },
          { status: 429 }
        )
      }
      const ticket = await retryAiAnswer(auth.userId, params.id)
      dispatchSupportFirstResponse(ticket.id)
      return NextResponse.json({ ticket })
    }
    return NextResponse.json({ error: 'action must be "resolve", "reopen" or "retry_ai"' }, { status: 400 })
  } catch (err) {
    return supportErrorResponse(err)
  }
}
