export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sign } from 'jsonwebtoken'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyOAuthState, validateStateProvider } from '@/lib/auth/oauth-state'
import { assertSignupAllowed } from '@/lib/platform-controls'

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const code = searchParams.get('code')
    const stateParam = searchParams.get('state')
    const error = searchParams.get('error')

    if (error) {
      logger.error('Google OAuth error:', error)
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=oauth_failed`)
    }

    if (!code) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=no_code`)
    }

    // ✅ CRITICAL SECURITY: Verify and extract projectId from state BEFORE any user operations
    const state = verifyOAuthState(stateParam)
    if (!state) {
      logger.error('[Google OAuth] Invalid or expired state parameter')
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=invalid_state`)
    }

    // Validate this is actually a Google OAuth request
    if (!validateStateProvider(state, 'google')) {
      logger.error('[Google OAuth] State provider mismatch')
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=provider_mismatch`)
    }

    const { projectId, redirectTo } = state

    // ✅ SECURITY: Load project-specific OAuth config
    const oauthConfig = await prisma.workspaceOAuthConfig.findUnique({
      where: {
        projectId_provider: {
          projectId,
          provider: 'google',
        },
      },
    })

    if (!oauthConfig || !oauthConfig.enabled) {
      logger.error(`[Google OAuth] No config found for project ${projectId}`)
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=oauth_not_configured`)
    }

    // Exchange code for tokens using project-specific credentials
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        code,
        client_id: oauthConfig.clientId,
        client_secret: oauthConfig.clientSecret,
        redirect_uri: oauthConfig.redirectUri || `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text()
      logger.error('Token exchange failed:', errorData)
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=token_failed`)
    }

    const tokens = await tokenResponse.json()

    // Get user info from Google
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    })

    if (!userInfoResponse.ok) {
      logger.error('Failed to get user info')
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=userinfo_failed`)
    }

    const googleUser = await userInfoResponse.json()
    if (!googleUser?.email) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=no_email`)
    }
    const email = String(googleUser.email).trim().toLowerCase()

    // ✅ SECURITY: Find or create user within PROJECT SCOPE
    // Note: User model is global, but session/JWT will be project-scoped
    const signedInAt = new Date()
    let user = await prisma.user.findUnique({
      where: { email },
    })

    if (!user) {
      const signupIp =
        request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        request.headers.get('x-real-ip') ||
        null
      const guard = await assertSignupAllowed(email, signupIp)
      if (!guard.ok) {
        return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=signup_not_allowed`)
      }

      // Create new user (globally unique by email)
      user = await prisma.user.create({
        data: {
          email,
          name: googleUser.name,
          emailVerified: true, // Google emails are verified
          provider: 'google',
          providerId: googleUser.id,
          lastLogin: signedInAt,
          lastActiveAt: signedInAt,
        },
      })

      logger.info(`[Google OAuth] New user created: ${user.email} for project ${projectId}`)
    } else {
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
      })
    }

    // ✅ SECURITY: Create session with projectId for audit trail
    const session = await prisma.session.create({
      data: {
        userId: user.id,
        projectId: projectId, // 🔒 AUDIT: Track which project this session belongs to
        token: `temp-${Date.now()}`, // Will be replaced by JWT
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      },
    })

    // ✅ SECURITY: Create JWT with projectId in payload
    const JWT_SECRET = process.env.JWT_SECRET
    if (!JWT_SECRET) {
      logger.error('[Google OAuth] JWT_SECRET is not configured')
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=server_error`)
    }
    const token = sign(
      {
        userId: user.id,
        email: user.email,
        name: user.name,
        projectId: projectId, // 🔒 PROJECT CONTEXT IN JWT!
        provider: 'google',
      },
      JWT_SECRET,
      { expiresIn: '7d', algorithm: 'HS256' }
    )

    // Update session with actual JWT
    await prisma.session.update({
      where: { id: session.id },
      data: { token: token },
    })

    // Set cookie and redirect
    const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}${redirectTo}`)
    response.cookies.set('auth-token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    })

    logger.info(`[Google OAuth] Successful login: ${user.email} → project ${projectId}`)
    return response
  } catch (error) {
    logger.error('Google OAuth callback error:', error)
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=server_error`)
  }
}
