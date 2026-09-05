export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { verify } from 'jsonwebtoken'
import { prisma } from '@/lib/db'
import { onSignupCompleted } from '@/lib/platform-signals'
import { createSession } from '@/lib/auth/session'
import { assertSignupAllowed, isBlocked } from '@/lib/platform/controls'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'

/**
 * Platform-level Google OAuth callback.
 * Dashboard login — not project end-user OAuth.
 *
 * Security pipeline (in order):
 *   1. IP rate limit.
 *   2. Verify signed state (HS256, JWT_SECRET, ≤5 min old, scope=platform-google).
 *   3. Sanitize redirectTo — must be a same-origin path.
 *   4. Exchange code → tokens with platform OAuth creds.
 *   5. Fetch Google userinfo → find/create user.
 *   6. Issue session JWT into an HttpOnly cookie ONLY. Never in URL.
 *   7. 302 to safeRedirect (no token in query).
 */
export async function GET(request: NextRequest) {
  // 1. IP rate limit — OAuth callbacks are unauthenticated.
  const ip = clientIp(request)
  const rl = consume(`oauth-cb:platform-google:${ip}`, AUTH_LIMITS.oauthCallback.ip.limit, AUTH_LIMITS.oauthCallback.ip.windowMs)
  if (!rl.allowed) {
    return NextResponse.redirect(`${appUrl()}/auth/login?error=rate_limited`)
  }

  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get('code')
  const stateParam = searchParams.get('state')
  const oauthError = searchParams.get('error')

  if (oauthError) {
    console.error('[Platform Google OAuth] Error:', oauthError)
    return NextResponse.redirect(`${appUrl()}/auth/login?error=oauth_failed`)
  }
  if (!code) {
    return NextResponse.redirect(`${appUrl()}/auth/login?error=no_code`)
  }

  // 2. Verify signed state. We use JWT_SECRET with HS256 pinned.
  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) {
    console.error('[Platform Google OAuth] JWT_SECRET not configured')
    return NextResponse.redirect(`${appUrl()}/auth/login?error=server_error`)
  }
  let state: { redirectTo?: string; nonce?: string; scope?: string }
  try {
    state = verify(stateParam || '', jwtSecret, { algorithms: ['HS256'] }) as any
  } catch {
    return NextResponse.redirect(`${appUrl()}/auth/login?error=invalid_state`)
  }
  if (state.scope !== 'platform-google' || !state.nonce) {
    return NextResponse.redirect(`${appUrl()}/auth/login?error=invalid_state`)
  }

  // 3. Sanitize redirectTo — must be a same-origin path-style redirect.
  const redirectTo = isSafeRedirect(state.redirectTo) ? state.redirectTo! : '/app'

  // 4. Exchange code → tokens with platform OAuth credentials.
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${appUrl()}/api/auth/platform-google/callback`
  if (!clientId || !clientSecret) {
    console.error('[Platform Google OAuth] Missing OAuth credentials')
    return NextResponse.redirect(`${appUrl()}/auth/login?error=oauth_not_configured`)
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  if (!tokenResponse.ok) {
    console.error('[Platform Google OAuth] Token exchange failed')
    return NextResponse.redirect(`${appUrl()}/auth/login?error=token_failed`)
  }
  const tokens = await tokenResponse.json()

  // 5. Fetch Google userinfo.
  const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  if (!userInfoResponse.ok) {
    console.error('[Platform Google OAuth] Failed to get user info')
    return NextResponse.redirect(`${appUrl()}/auth/login?error=userinfo_failed`)
  }
  const googleUser = await userInfoResponse.json()
  if (!googleUser?.email) {
    return NextResponse.redirect(`${appUrl()}/auth/login?error=userinfo_failed`)
  }
  const email = String(googleUser.email).trim().toLowerCase()

  // Founder block/abuse controls.
  const ipForBlock = ip === 'unknown' ? null : ip
  const blockHit = await isBlocked({ email, ip: ipForBlock })
  if (blockHit) {
    return NextResponse.redirect(`${appUrl()}/auth/login?error=blocked`)
  }

  // Find or create user.
  const signedInAt = new Date()
  let user = await prisma.user.findUnique({
    where: { email },
    include: { role: true },
  })
  if (!user) {
    const guard = await assertSignupAllowed(email, ipForBlock)
    if (!guard.ok) {
      return NextResponse.redirect(`${appUrl()}/auth/login?error=signup_not_allowed`)
    }
    user = await prisma.user.create({
      data: {
        email,
        name: googleUser.name,
        emailVerified: true,
        provider: 'google',
        providerId: googleUser.id,
        lastLogin: signedInAt,
        lastActiveAt: signedInAt,
        // Google already proved control of the mailbox, so an OAuth signup is
        // never held as untrusted. The score is still recorded — a challenge
        // verdict here is worth being able to see later.
        signupScore: guard.trust?.score ?? null,
        signupSignals: guard.trust?.signals ?? [],
        signupIp: ipForBlock,
      },
      include: { role: true },
    })

    // A brand-new OAuth account carries its ?ref= via the backenly_ref cookie
    // set on the signup page. Reporting the signup is a no-op in single-tenant
    // and never throws, so it cannot block sign-in.
    const refCode = request.cookies.get('backenly_ref')?.value || null
    await onSignupCompleted({ userId: user.id, email: user.email, provider: 'google', referralCode: refCode })
  } else {
    // Always stamp lastLogin + lastActiveAt on a successful OAuth sign-in;
    // link the provider on the first OAuth sign-in for an email-only account.
    const linkProvider = !user.provider || user.provider === 'email'
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLogin: signedInAt,
        lastActiveAt: signedInAt,
        ...(linkProvider
          ? { provider: 'google', providerId: googleUser.id, emailVerified: true }
          : {}),
      },
      include: { role: true },
    })
  }

  // 6. Issue session — HttpOnly cookie only. No JWT in URL.
  const { token } = await createSession(
    user.id,
    user.email,
    user.role?.name,
    user.name || undefined,
    'google'
  )

  // 7. 302 to safeRedirect (no token query param).
  const response = NextResponse.redirect(`${appUrl()}${redirectTo}`)
  response.cookies.set('auth-token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7,
    path: '/',
  })

  return response
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
}

function isSafeRedirect(target: string | undefined): target is string {
  if (typeof target !== 'string') return false
  if (!target.startsWith('/')) return false
  if (target.startsWith('//') || target.startsWith('/\\')) return false
  if (target.includes('\\')) return false
  return true
}
