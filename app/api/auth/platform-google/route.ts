export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sign } from 'jsonwebtoken'
import crypto from 'crypto'

/**
 * Platform-level Google OAuth initiation.
 * Dashboard login — not project end-user OAuth.
 *
 * SECURITY: state is a JWT signed with JWT_SECRET and pinned to HS256.
 * It carries a nonce + timestamp + a SAFE redirectTo (must start with "/").
 * The callback re-verifies signature and expiry before trusting any field.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const rawRedirect = searchParams.get('redirect') || '/app'

  // Only same-origin path-style redirects are allowed. Anything else falls
  // back to /app. This prevents `redirect=https://evil.com` and the userinfo
  // trick (`redirect=@evil.com`).
  const safeRedirect = isSafeRedirect(rawRedirect) ? rawRedirect : '/app'

  const clientId = process.env.GOOGLE_CLIENT_ID
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/auth/platform-google/callback`

  if (!clientId) {
    console.error('[Platform Google OAuth] Missing GOOGLE_CLIENT_ID')
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=oauth_not_configured`)
  }

  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) {
    console.error('[Platform Google OAuth] JWT_SECRET not configured')
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=server_error`)
  }

  // Signed state with a nonce — verified in the callback. Short-lived (5 min)
  // and HS256-pinned so a forged state with alg=none is rejected.
  const nonce = crypto.randomBytes(16).toString('hex')
  const state = sign(
    { redirectTo: safeRedirect, nonce, scope: 'platform-google' },
    jwtSecret,
    { expiresIn: '5m', algorithm: 'HS256' }
  )

  const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  googleAuthUrl.searchParams.set('client_id', clientId)
  googleAuthUrl.searchParams.set('redirect_uri', redirectUri)
  googleAuthUrl.searchParams.set('response_type', 'code')
  googleAuthUrl.searchParams.set('scope', 'openid email profile')
  googleAuthUrl.searchParams.set('state', state)
  googleAuthUrl.searchParams.set('access_type', 'offline')
  googleAuthUrl.searchParams.set('prompt', 'consent')

  return NextResponse.redirect(googleAuthUrl.toString())
}

function isSafeRedirect(target: string): boolean {
  if (typeof target !== 'string') return false
  // Must start with a single forward slash and not be a protocol-relative URL
  // or contain backslashes (Windows-style host confusion).
  if (!target.startsWith('/')) return false
  if (target.startsWith('//') || target.startsWith('/\\')) return false
  if (target.includes('\\')) return false
  return true
}
