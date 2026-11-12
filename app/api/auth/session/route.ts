export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { UnauthorizedError, userFromToken } from '@/lib/auth/server'
import { platformProfile } from '@/lib/auth/platform-profile'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * GET /api/auth/session - Who is signed in on this browser, if anyone
 *
 * The session hook (lib/hooks/useUserSession.ts) asks this rather than
 * /api/auth/me, so a signed-out browser gets an answer, not an error.
 * Production QA (2026-11-09): the signed-out login page logged a 401 from
 * /api/auth/me and another from /api/auth/refresh-token on every load.
 *
 * Always 200:
 *   { user }                    a live session (the profile /api/auth/me gives)
 *   { user: null, canRefresh }  none; canRefresh says a refresh cookie is
 *                               present, so the hook asks /api/auth/refresh-token
 *                               only when there is something to refresh
 *
 * The token is read as requireUser reads it (the auth-token cookie, else a
 * Bearer header) and checked by the same function (userFromToken).
 */
export async function GET(request: NextRequest) {
  const bearer = request.headers.get('authorization')
  const token =
    request.cookies.get('auth-token')?.value ||
    (bearer?.startsWith('Bearer ') ? bearer.slice(7).trim() : undefined)

  try {
    const { userId } = await userFromToken(token)
    const found = await platformProfile(userId)
    if (found) return NextResponse.json({ user: found.profile }, { headers: NO_STORE })
  } catch (error) {
    if (!(error instanceof UnauthorizedError)) {
      console.error('[auth/session] could not read the session:', error)
      return NextResponse.json({ error: 'The session could not be read. Try again.' }, { status: 503, headers: NO_STORE })
    }
  }

  return NextResponse.json(
    { user: null, canRefresh: Boolean(request.cookies.get('refresh-token')?.value) },
    { headers: NO_STORE },
  )
}
