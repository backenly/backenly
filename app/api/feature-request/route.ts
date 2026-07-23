export const dynamic = 'force-dynamic'

/**
 * POST /api/feature-request
 *
 * Authenticated platform user submits a feature request via the
 * Settings → "Feature requests" form. Stored as a FeatureRequest and
 * surfaced in the admin Feedback tab as the founder's roadmap signal.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/middleware'
import { prisma } from '@/lib/db/prisma'

const MAX_TITLE = 160
const MAX_BODY = 5_000

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

  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  const description = typeof body?.body === 'string' ? body.body.trim() : ''

  if (!title || title.length > MAX_TITLE) {
    return NextResponse.json(
      { error: `Title is required and must be ${MAX_TITLE} characters or less` },
      { status: 400 }
    )
  }
  if (!description || description.length < 10 || description.length > MAX_BODY) {
    return NextResponse.json(
      { error: `Description must be between 10 and ${MAX_BODY} characters` },
      { status: 400 }
    )
  }

  const fr = await prisma.featureRequest.create({
    data: {
      userId: auth.userId,
      title,
      body: description,
    },
    select: { id: true, createdAt: true },
  })

  return NextResponse.json({
    ok: true,
    id: fr.id,
    createdAt: fr.createdAt.toISOString(),
  })
}
