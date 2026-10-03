export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth/middleware'
import { clearSessionCookies, deleteAllUserSessions, revokePresentedSessions } from '@/lib/auth/session'
import { extractTokenFromHeader } from '@/lib/auth/jwt'

/**
 * POST /api/auth/logout - Sign this browser out
 *
 * Needs no live session: it ends the sessions named by the credentials this
 * request presents (access token as cookie or Bearer, refresh token as cookie)
 * and clears both cookies. It used to sit behind withAuth, so a browser whose
 * access session had expired got a 401 and kept its refresh cookie, and the
 * login page's session check used that cookie to sign it straight back in.
 * Every credential is matched exactly, so a caller can only end sessions it
 * already holds a secret for. Calling it again, or with nothing, is harmless.
 *
 * Query params:
 * - all=true : Logout from all devices. This acts on the user's identity, not
 *   on credentials the caller holds, so it still requires a live session.
 */
export async function POST(request: NextRequest) {
  // Without a live session to require, the browser's own attestation is what
  // stops another site's page from signing this user out. Sec-Fetch-Site is
  // set by the browser and cannot be written by page script (see
  // lib/security/service-role-exposure.ts); non-browser clients send none and
  // carry no ambient cookies to abuse.
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') {
    return NextResponse.json({ error: 'Sign-out must come from this site' }, { status: 403 })
  }

  try {
    if (request.nextUrl.searchParams.get('all') === 'true') {
      const auth = await authenticateRequest(request)
      if (!auth.authenticated || !auth.userId) {
        return NextResponse.json({ error: auth.error || 'Authentication required' }, { status: 401 })
      }
      await deleteAllUserSessions(auth.userId)
      return clearSessionCookies(NextResponse.json({ message: 'Logged out from all devices' }))
    }

    // The dashboard sends its localStorage copy as a Bearer next to the cookie,
    // and the two drift apart (see authenticateRequest), so both are revoked.
    await revokePresentedSessions({
      accessTokens: Array.from(
        new Set(
          [
            extractTokenFromHeader(request.headers.get('authorization')),
            request.cookies.get('auth-token')?.value,
          ].filter((token): token is string => !!token),
        ),
      ),
      refreshToken: request.cookies.get('refresh-token')?.value,
    })
    return clearSessionCookies(NextResponse.json({ message: 'Logged out successfully' }))
  } catch (error) {
    // Name only: a Prisma error can echo its query arguments, which are tokens.
    console.error('Logout error:', (error as Error)?.name || 'Error')
    return NextResponse.json({ error: 'Failed to logout' }, { status: 500 })
  }
}
