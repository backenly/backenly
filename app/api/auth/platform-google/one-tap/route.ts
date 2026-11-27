export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createSession } from '@/lib/auth/session'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'
import { verifyGoogleIdToken } from '@/lib/auth/oauth/google-id-token'
import { signInGoogleIdentity } from '@/lib/auth/oauth/google-sign-in'
import { returnPathFrom } from '@/lib/auth/return-path'

/**
 * Google One Tap for the platform: the Google prompt a signed-out visitor
 * sees in the corner of the site. Dashboard login, not project end-user OAuth.
 *
 * The browser posts the ID token Google gave it. Security pipeline (in order):
 *   1. IP rate limit.
 *   2. Same-origin JSON only. A session cookie is set here, so a page on
 *      another site must not be able to post a token of its own choosing and
 *      sign this browser into somebody else's account.
 *   3. Verify the ID token: Google's signature, issued for OUR client id, not
 *      expired (lib/auth/oauth/google-id-token.ts).
 *   4. Find or create the account on the same path the redirect callback
 *      takes (lib/auth/oauth/google-sign-in.ts): verified address only, block
 *      list, no sign-in for an account with two-factor authentication, setup
 *      token and signup guard for a new account.
 *   5. Issue the session into an HttpOnly cookie ONLY. The body carries where
 *      to go next, never a token.
 *
 * A refusal answers `{ error }` with the same code the callback puts in
 * `/auth/login?error=`, so the login page explains both the same way.
 *
 * The account's photo is not recorded here: telling a photo the person chose
 * from the letter Google draws takes the People API and an access token
 * (lib/auth/oauth/google-photo.ts), and One Tap grants none. Whatever is
 * recorded stays as it is.
 */
export async function POST(request: NextRequest) {
  const ip = clientIp(request)
  const rl = await consume(
    `oauth-cb:platform-google-one-tap:${ip}`,
    AUTH_LIMITS.oauthCallback.ip.limit,
    AUTH_LIMITS.oauthCallback.ip.windowMs,
  )
  if (!rl.allowed) return refuse('rate_limited', 429)

  if (!isSameOriginJson(request)) return refuse('invalid_request', 403)

  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) return refuse('oauth_not_configured', 503)

  let body: { credential?: unknown; redirect?: unknown }
  try {
    body = await request.json()
  } catch {
    return refuse('invalid_request', 400)
  }

  const claims = await verifyGoogleIdToken(body?.credential, clientId)
  if (!claims) return refuse('oauth_failed', 401)

  const signIn = await signInGoogleIdentity(
    { subject: claims.sub, profile: claims, name: typeof claims.name === 'string' ? claims.name : null },
    { ip, referralCode: request.cookies.get('backenly_ref')?.value || null },
  )
  if ('error' in signIn) return refuse(signIn.error, 403)
  const user = signIn.user

  const { token } = await createSession(
    user.id,
    user.email,
    user.role?.name,
    user.name || undefined,
    'google',
  )

  const redirectTo = returnPathFrom(typeof body.redirect === 'string' ? body.redirect : null)
  const response = NextResponse.json({ ok: true, created: signIn.created, redirectTo })
  response.cookies.set('auth-token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  })
  return response
}

function refuse(error: string, status: number) {
  return NextResponse.json({ error }, { status })
}

/**
 * A JSON body cannot be sent across sites without a preflight this route never
 * answers, and a browser always names the page's origin on a POST. Both are
 * required: the Origin must be this deployment's own, by its configured
 * address or by the Host the request arrived on.
 */
function isSameOriginJson(request: NextRequest): boolean {
  const contentType = request.headers.get('content-type') || ''
  if (!contentType.toLowerCase().startsWith('application/json')) return false

  const origin = request.headers.get('origin')
  if (!origin) return false
  let originUrl: URL
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }

  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (configured) {
    try {
      if (new URL(configured).origin === originUrl.origin) return true
    } catch {
      // A malformed configured address decides nothing; the Host still can.
    }
  }
  const host = request.headers.get('host')
  return !!host && originUrl.host === host.toLowerCase()
}
