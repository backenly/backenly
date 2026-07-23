/**
 * OIDC Token Revocation Endpoint
 * 
 * POST /api/oidc/revoke
 * Content-Type: application/x-www-form-urlencoded
 * 
 * token={access_token}
 * &client_id={client_id}
 * 
 * RFC 7009 - OAuth 2.0 Token Revocation
 */

import { NextRequest, NextResponse } from 'next/server'
import { revokeOIDCToken } from '@/lib/auth/oidc-delegation'

export async function POST(request: NextRequest) {
  try {
    const body = await request.text()
    const params = new URLSearchParams(body)
    
    const token = params.get('token')
    const clientId = params.get('client_id')
    
    if (!token || !clientId) {
      return NextResponse.json(
        {
          error: 'invalid_request',
          error_description: 'Missing required parameters',
        },
        { status: 400 }
      )
    }
    
    // Revoke token
    await revokeOIDCToken(token, clientId)
    
    // RFC 7009: Always return 200 OK (even if token invalid)
    return NextResponse.json({}, { status: 200 })
  } catch (error: any) {
    console.error('[OIDC Revoke] Error:', error)
    
    // RFC 7009: Always return 200 OK for security
    return NextResponse.json({}, { status: 200 })
  }
}
