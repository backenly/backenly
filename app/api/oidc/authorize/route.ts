/**
 * OIDC Authorization Endpoint
 * 
 * GET /api/oidc/authorize?
 *   response_type=code
 *   &client_id=replit
 *   &project_id={projectId}
 *   &scope=read:schema+read:endpoints
 *   &redirect_uri={frontendUrl}
 *   &state={csrf_token}
 *   &code_challenge={pkce_challenge}  // Optional PKCE
 * 
 * RFC 6749 Section 3.1 - Authorization Endpoint
 * OpenID Connect Core 1.0 - Authentication Request
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth/jwt'
import { handleAuthorizationRequest, OIDCError } from '@/lib/auth/oidc-delegation'

export async function GET(request: NextRequest) {
  try {
    // Extract user from session (platform authentication)
    const authHeader = request.headers.get('authorization')
    const cookieToken = request.cookies.get('auth-token')?.value
    const token = authHeader?.substring(7) || cookieToken
    
    if (!token) {
      // Redirect to login with return URL
      const loginUrl = new URL('/auth/login', request.url)
      loginUrl.searchParams.set('return_to', request.url)
      return NextResponse.redirect(loginUrl)
    }
    
    const payload = verifyToken(token)
    
    if (!payload || !payload.userId) {
      const loginUrl = new URL('/auth/login', request.url)
      loginUrl.searchParams.set('return_to', request.url)
      return NextResponse.redirect(loginUrl)
    }
    
    // Handle authorization request
    const { redirectUrl } = await handleAuthorizationRequest(request, payload.userId)
    
    // Redirect back to frontend with authorization code
    return NextResponse.redirect(redirectUrl)
  } catch (error: any) {
    console.error('[OIDC Authorize] Error:', error)
    
    if (error instanceof OIDCError) {
      // Build error redirect (RFC 6749 Section 4.1.2.1)
      const { searchParams } = new URL(request.url)
      const redirectUri = searchParams.get('redirect_uri')
      const state = searchParams.get('state')
      
      if (redirectUri) {
        const errorUrl = new URL(redirectUri)
        errorUrl.searchParams.set('error', error.error)
        errorUrl.searchParams.set('error_description', error.error_description)
        if (state) {
          errorUrl.searchParams.set('state', state)
        }
        return NextResponse.redirect(errorUrl.toString())
      }
    }
    
    return NextResponse.json(
      { 
        error: 'server_error',
        error_description: 'Authorization failed',
      },
      { status: 500 }
    )
  }
}
