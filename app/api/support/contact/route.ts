export const dynamic = 'force-dynamic'

/**
 * POST /api/support/contact
 *
 * Authenticated platform user submits a support request via the
 * Settings → "Contact support" form. Stored as a SupportTicket and
 * surfaced in the admin Feedback tab.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db/prisma'

const MAX_SUBJECT = 160
const MAX_MESSAGE = 5_000

export async function POST(request: NextRequest) {
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

  const subject = typeof body?.subject === 'string' ? body.subject.trim() : ''
  const message = typeof body?.message === 'string' ? body.message.trim() : ''

  if (!subject || subject.length > MAX_SUBJECT) {
    return NextResponse.json(
      { error: `Subject is required and must be ${MAX_SUBJECT} characters or less` },
      { status: 400 }
    )
  }
  if (!message || message.length < 10 || message.length > MAX_MESSAGE) {
    return NextResponse.json(
      { error: `Message must be between 10 and ${MAX_MESSAGE} characters` },
      { status: 400 }
    )
  }

  const ticket = await prisma.supportTicket.create({
    data: {
      userId: auth.userId,
      subject,
      message,
    },
    select: { id: true, createdAt: true },
  })

  return NextResponse.json({
    ok: true,
    id: ticket.id,
    createdAt: ticket.createdAt.toISOString(),
  })
}
