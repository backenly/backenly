export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { verify } from 'jsonwebtoken'
import { createSession } from '@/lib/auth/session'
import { prisma } from '@/lib/db'
import { assertSignupAllowed, isBlocked } from '@/lib/platform/controls'
import { consume, AUTH_LIMITS, clientIp } from '@/lib/security/auth-rate-limit'

function isSafeRedirect(target: unknown): target is string {
  if (typeof target !== 'string') return false
  if (!target.startsWith('/')) return false
  if (target.startsWith('//') || target.startsWith('/\\')) return false
  if (target.includes('\\')) return false
  return true
}

/**
 * Platform-level GitHub OAuth callback.
 * Verifies the signed state JWT before any other work.
 */
export async function GET(request: NextRequest) {
  try {
    // IP rate limit — unauthenticated surface.
    const ip = clientIp(request)
    const rl = consume(`oauth-cb:platform-github:${ip}`, AUTH_LIMITS.oauthCallback.ip.limit, AUTH_LIMITS.oauthCallback.ip.windowMs)
    if (!rl.allowed) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=rate_limited`)
    }

    const searchParams = request.nextUrl.searchParams
    const code = searchParams.get('code')
    const stateParam = searchParams.get('state')
    const error = searchParams.get('error')

    if (error) {
      console.error('[Platform GitHub OAuth] Error:', error)
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=oauth_failed`)
    }

    if (!code) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=no_code`)
    }

    // Verify signed state (HS256 pinned, 5-min expiry).
    const jwtSecret = process.env.JWT_SECRET
    if (!jwtSecret) {
      console.error('[Platform GitHub OAuth] JWT_SECRET not configured')
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=server_error`)
    }
    let state: { redirectTo?: string; nonce?: string; scope?: string }
    try {
      state = verify(stateParam || '', jwtSecret, { algorithms: ['HS256'] }) as any
    } catch {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=invalid_state`)
    }
    if (state.scope !== 'platform-github' || !state.nonce) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=invalid_state`)
    }
    const redirectTo = isSafeRedirect(state.redirectTo) ? state.redirectTo : '/app'

    // Exchange code for tokens using platform credentials
    const clientId = process.env.GITHUB_CLIENT_ID
    const clientSecret = process.env.GITHUB_CLIENT_SECRET
    const redirectUri = process.env.GITHUB_REDIRECT_URI || `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/auth/platform-github/callback`

    if (!clientId || !clientSecret) {
      console.error('[Platform GitHub OAuth] Missing OAuth credentials')
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=oauth_not_configured`)
    }

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    })

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text()
      console.error('[Platform GitHub OAuth] Token exchange failed:', errorData)
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=token_failed`)
    }

    const tokens = await tokenResponse.json()

    if (tokens.error) {
      console.error('[Platform GitHub OAuth] Token error:', tokens.error)
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=token_failed`)
    }

    // Get user info from GitHub
    const userInfoResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    })

    if (!userInfoResponse.ok) {
      console.error('[Platform GitHub OAuth] Failed to get user info')
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=userinfo_failed`)
    }

    const githubUser = await userInfoResponse.json()

    // Get user emails from GitHub
    const emailsResponse = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    })

    let email = githubUser.email
    if (!email && emailsResponse.ok) {
      const emails = await emailsResponse.json()
      const primaryEmail = emails.find((e: any) => e.primary && e.verified)
      email = primaryEmail?.email || emails[0]?.email
    }

    if (!email) {
      console.error('[Platform GitHub OAuth] No email found')
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=no_email`)
    }
    email = String(email).trim().toLowerCase()

    // Founder blocklist — gates both new signups and existing logins.
    const oauthIp =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      null
    const blockHit = await isBlocked({ email, ip: oauthIp })
    if (blockHit) {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=blocked`,
      )
    }

    // Find or create user
    const signedInAt = new Date()
    let user = await prisma.user.findUnique({
      where: { email },
      include: { role: true },
    })

    if (!user) {
      // Founder kill switches gate NEW signups via OAuth too.
      const guard = await assertSignupAllowed(email, oauthIp)
      if (!guard.ok) {
        return NextResponse.redirect(
          `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=signup_not_allowed`,
        )
      }
      // Create new user
      user = await prisma.user.create({
        data: {
          email,
          name: githubUser.name || githubUser.login,
          emailVerified: true,
          provider: 'github',
          providerId: String(githubUser.id),
          lastLogin: signedInAt,
          lastActiveAt: signedInAt,
          // GitHub already proved control of the mailbox, so an OAuth signup is
          // never held as untrusted. The score is still recorded — a challenge
          // verdict here is worth being able to see later.
          signupScore: guard.trust?.score ?? null,
          signupSignals: guard.trust?.signals ?? [],
          signupIp: oauthIp,
        },
        include: { role: true },
      })

      // Referral: a brand-new OAuth account carries its ?ref= via the
      // backenly_ref cookie set on the signup page. Non-fatal.
      const refCode = request.cookies.get('backenly_ref')?.value || null
      if (refCode) {
        const { applyReferralOnSignup } = await import('@/lib/billing/referral')
        await applyReferralOnSignup(user.id, user.email, refCode).catch(() => {})
      }
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
            ? {
                provider: 'github',
                providerId: String(githubUser.id),
                emailVerified: true,
              }
            : {}),
        },
        include: { role: true },
      })
    }

    // Create session using the same method as email login
    // This ensures JWT compatibility with middleware
    const { token } = await createSession(
      user.id, 
      user.email, 
      user.role?.name, 
      user.name || undefined, 
      'github'
    )

    // Session is delivered via HttpOnly cookie ONLY. Never put the JWT in the
    // URL — tokens land in browser history, proxy logs, and Referer headers.
    const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}${redirectTo}`)
    response.cookies.set('auth-token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    })

    return response
  } catch (error) {
    console.error('[Platform GitHub OAuth] Callback error:', error)
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=server_error`)
  }
}
