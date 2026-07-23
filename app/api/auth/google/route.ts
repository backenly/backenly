export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { generateOAuthState } from '@/lib/auth/oauth-state'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const projectId = searchParams.get('projectId')
  const redirectTo = searchParams.get('redirect') || '/app'
  
  // ✅ CRITICAL SECURITY: Require projectId for OAuth initiation
  if (!projectId) {
    logger.error('[Google OAuth] Missing projectId parameter')
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/app?error=missing_project`)
  }

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
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/app?error=oauth_not_configured`)
  }

  // ✅ CRITICAL SECURITY: Generate signed state with projectId
  const state = generateOAuthState({
    projectId,
    provider: 'google',
    redirectTo,
  })
  
  const googleAuthUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  googleAuthUrl.searchParams.set('client_id', oauthConfig.clientId)
  googleAuthUrl.searchParams.set('redirect_uri', oauthConfig.redirectUri || `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/auth/google/callback`)
  googleAuthUrl.searchParams.set('response_type', 'code')
  googleAuthUrl.searchParams.set('scope', 'openid email profile')
  googleAuthUrl.searchParams.set('state', state)
  googleAuthUrl.searchParams.set('access_type', 'offline')
  googleAuthUrl.searchParams.set('prompt', 'consent')

  logger.info(`[Google OAuth] Initiating OAuth for project ${projectId}`)
  return NextResponse.redirect(googleAuthUrl.toString())
}
