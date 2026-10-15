export const dynamic = 'force-dynamic'

/**
 * GET   /api/support/tickets/[id] — one case with its correspondence thread
 * PATCH /api/support/tickets/[id] — { action: 'resolve' | 'reopen' }
 *
 * Owner-scoped: the queries carry `userId`, so another account's case answers
 * 404 exactly like a case that does not exist.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { supportErrorResponse } from '@/lib/support/http'
import { getTicket, reopenTicket, resolveTicket } from '@/lib/support/service'

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
    return NextResponse.json({ ticket })
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
    return NextResponse.json({ error: 'action must be "resolve" or "reopen"' }, { status: 400 })
  } catch (err) {
    return supportErrorResponse(err)
  }
}
