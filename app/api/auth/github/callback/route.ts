export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sign } from 'jsonwebtoken'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { verifyOAuthState, validateStateProvider } from '@/lib/auth/oauth-state'
import { assertSignupAllowed } from '@/lib/platform/controls'

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const code = searchParams.get('code')
    const stateParam = searchParams.get('state')
    const error = searchParams.get('error')

    if (error) {
      logger.error('GitHub OAuth error:', error)
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=oauth_failed`)
    }

    if (!code) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=no_code`)
    }

    // ✅ CRITICAL SECURITY: Verify and extract projectId from state BEFORE any user operations
    const state = verifyOAuthState(stateParam)
    if (!state) {
      logger.error('[GitHub OAuth] Invalid or expired state parameter')
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=invalid_state`)
    }

    // Validate this is actually a GitHub OAuth request
    if (!validateStateProvider(state, 'github')) {
      logger.error('[GitHub OAuth] State provider mismatch')
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=provider_mismatch`)
    }

    const { projectId, redirectTo } = state

    // ✅ SECURITY: Load project-specific OAuth config
    const oauthConfig = await prisma.workspaceOAuthConfig.findUnique({
      where: {
        projectId_provider: {
          projectId,
          provider: 'github',
        },
      },
    })

    if (!oauthConfig || !oauthConfig.enabled) {
      logger.error(`[GitHub OAuth] No config found for project ${projectId}`)
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=oauth_not_configured`)
    }

    // Exchange code for tokens using project-specific credentials
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: oauthConfig.clientId,
        client_secret: oauthConfig.clientSecret,
        code,
        redirect_uri: oauthConfig.redirectUri || `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/auth/github/callback`,
      }),
    })

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text()
      logger.error('Token exchange failed:', errorData)
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=token_failed`)
    }

    const tokens = await tokenResponse.json()

    if (tokens.error) {
      logger.error('GitHub token error:', tokens.error_description)
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=${tokens.error}`)
    }

    // Get user info
    const userInfoResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    })

    if (!userInfoResponse.ok) {
      logger.error('Failed to get user info')
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=userinfo_failed`)
    }

    const githubUser = await userInfoResponse.json()

    // Get user email if not public
    let email = githubUser.email
    if (!email) {
      const emailsResponse = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      })

      if (emailsResponse.ok) {
        const emails = await emailsResponse.json()
        const primaryEmail = emails.find((e: any) => e.primary && e.verified)
        if (primaryEmail) {
          email = primaryEmail.email
        }
      }
    }

    if (!email) {
      return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=no_email`)
    }
    email = String(email).trim().toLowerCase()

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
          name: githubUser.name || githubUser.login,
          emailVerified: true, // GitHub emails are verified
          provider: 'github',
          providerId: githubUser.id.toString(),
          lastLogin: signedInAt,
          lastActiveAt: signedInAt,
        },
      })

      logger.info(`[GitHub OAuth] New user created: ${user.email} for project ${projectId}`)
    } else {
      const linkProvider = !user.provider || user.provider === 'email'
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          lastLogin: signedInAt,
          lastActiveAt: signedInAt,
          ...(linkProvider
            ? {
                provider: 'github',
                providerId: githubUser.id.toString(),
                emailVerified: true,
              }
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
    const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production'
    const token = sign(
      {
        userId: user.id,
        email: user.email,
        name: user.name,
        projectId: projectId, // 🔒 PROJECT CONTEXT IN JWT!
        provider: 'github',
      },
      JWT_SECRET,
      { expiresIn: '7d' }
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

    logger.info(`[GitHub OAuth] Successful login: ${user.email} → project ${projectId}`)
    return response
  } catch (error) {
    logger.error('GitHub OAuth callback error:', error)
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=server_error`)
  }
}
