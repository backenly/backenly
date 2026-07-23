/**
 * OIDC Token Endpoint
 * 
 * POST /api/oidc/token
 * Content-Type: application/x-www-form-urlencoded
 * 
 * grant_type=authorization_code
 * &code={authorization_code}
 * &redirect_uri={redirect_uri}
 * &client_id={client_id}
 * &code_verifier={code_verifier}  // PKCE
 * 
 * RFC 6749 Section 3.2 - Token Endpoint
 * OpenID Connect Core 1.0 - Token Endpoint
 */

import { NextRequest, NextResponse } from 'next/server'
import { handleTokenExchange, OIDCError } from '@/lib/auth/oidc-delegation'

export async function POST(request: NextRequest) {
  try {
    // Exchange authorization code for access token
    const tokenResponse = await handleTokenExchange(request)
    
    // Return OIDC-compliant token response (RFC 6749 Section 5.1)
    return NextResponse.json(tokenResponse, {
      headers: {
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache',
      },
    })
  } catch (error: any) {
    console.error('[OIDC Token] Error:', error)
    
    if (error instanceof OIDCError) {
      // Return OIDC error response (RFC 6749 Section 5.2)
      return NextResponse.json(
        {
          error: error.error,
          error_description: error.error_description,
        },
        { 
          status: 400,
          headers: {
            'Cache-Control': 'no-store',
            'Pragma': 'no-cache',
          },
        }
      )
    }
    
    return NextResponse.json(
      {
        error: 'server_error',
        error_description: 'Token exchange failed',
      },
      { 
        status: 500,
        headers: {
          'Cache-Control': 'no-store',
          'Pragma': 'no-cache',
        },
      }
    )
  }
}
