export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sign } from 'jsonwebtoken'
import crypto from 'crypto'

/**
 * Platform-level GitHub OAuth initiation.
 * Dashboard login — not project end-user OAuth.
 *
 * SECURITY: state is a JWT signed with JWT_SECRET (HS256) carrying a nonce
 * and a safe redirectTo. Callback verifies signature + scope + expiry.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const rawRedirect = searchParams.get('redirect') || '/app'
  const safeRedirect = isSafeRedirect(rawRedirect) ? rawRedirect : '/app'

  const clientId = process.env.GITHUB_CLIENT_ID
  const redirectUri = process.env.GITHUB_REDIRECT_URI || `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/auth/platform-github/callback`

  if (!clientId) {
    console.error('[Platform GitHub OAuth] Missing GITHUB_CLIENT_ID')
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=oauth_not_configured`)
  }

  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) {
    console.error('[Platform GitHub OAuth] JWT_SECRET not configured')
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/auth/login?error=server_error`)
  }

  const nonce = crypto.randomBytes(16).toString('hex')
  const state = sign(
    { redirectTo: safeRedirect, nonce, scope: 'platform-github' },
    jwtSecret,
    { expiresIn: '5m', algorithm: 'HS256' }
  )

  const githubAuthUrl = new URL('https://github.com/login/oauth/authorize')
  githubAuthUrl.searchParams.set('client_id', clientId)
  githubAuthUrl.searchParams.set('redirect_uri', redirectUri)
  githubAuthUrl.searchParams.set('scope', 'read:user user:email')
  githubAuthUrl.searchParams.set('state', state)

  return NextResponse.redirect(githubAuthUrl.toString())
}

function isSafeRedirect(target: string): boolean {
  if (typeof target !== 'string') return false
  if (!target.startsWith('/')) return false
  if (target.startsWith('//') || target.startsWith('/\\')) return false
  if (target.includes('\\')) return false
  return true
}
