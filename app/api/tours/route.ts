export const dynamic = 'force-dynamic'

/**
 * One-time console tours.
 *
 *   GET  /api/tours                   { available, seen: TourId[] }
 *   POST /api/tours  { tourId }       mark a tour seen (finished or skipped)
 *
 * Platform-authenticated and scoped to the caller. Takes no project or key id.
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { isTourId, markTourSeen, readToursSeen } from '@/lib/tours/seen'

const NO_STORE = { 'cache-control': 'no-store' }

export const GET = withAuth(async (_request: NextRequest, { user }) => {
  return NextResponse.json(await readToursSeen(user.userId), { headers: NO_STORE })
})

export const POST = withAuth(async (request: NextRequest, { user }) => {
  const body = await request.json().catch(() => null)
  if (!isTourId(body?.tourId)) {
    return NextResponse.json({ error: 'Unknown tour' }, { status: 400 })
  }
  const saved = await markTourSeen(user.userId, body.tourId)
  return NextResponse.json({ saved }, { status: saved ? 200 : 503, headers: NO_STORE })
})
