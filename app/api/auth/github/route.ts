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
    logger.error('[GitHub OAuth] Missing projectId parameter')
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/app?error=missing_project`)
  }

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
    return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/app?error=oauth_not_configured`)
  }

  // ✅ CRITICAL SECURITY: Generate signed state with projectId
  const state = generateOAuthState({
    projectId,
    provider: 'github',
    redirectTo,
  })
  
  const githubAuthUrl = new URL('https://github.com/login/oauth/authorize')
  githubAuthUrl.searchParams.set('client_id', oauthConfig.clientId)
  githubAuthUrl.searchParams.set('redirect_uri', oauthConfig.redirectUri || `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/auth/github/callback`)
  githubAuthUrl.searchParams.set('scope', 'read:user user:email')
  githubAuthUrl.searchParams.set('state', state)

  logger.info(`[GitHub OAuth] Initiating OAuth for project ${projectId}`)
  return NextResponse.redirect(githubAuthUrl.toString())
}
