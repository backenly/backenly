import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'

/**
 * PROMPT 6 — Replit OAuth Initiation
 * 
 * Step 1: User clicks "Connect Replit"
 * Step 2: Redirect to Replit OAuth with state parameter
 * 
 * NO SDKs, NO keys shown, NO technical exposure
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const projectId = searchParams.get('projectId')
    
    if (!projectId) {
      return NextResponse.json(
        { error: 'Something didn\'t work. Please try again.' },
        { status: 400 }
      )
    }

    // Verify Replit OAuth is configured
    const clientId = process.env.REPLIT_CLIENT_ID
    const clientSecret = process.env.REPLIT_CLIENT_SECRET
    
    if (!clientId || !clientSecret) {
      console.error('[Replit OAuth] Missing REPLIT_CLIENT_ID or REPLIT_CLIENT_SECRET')
      return NextResponse.json(
        { error: 'Connection not available right now. Please try again later.' },
        { status: 503 }
      )
    }

    // Generate secure state parameter (CSRF protection)
    const state = crypto.randomBytes(32).toString('hex')
    const stateData = {
      projectId,
      nonce: crypto.randomBytes(16).toString('hex'),
      timestamp: Date.now(),
    }

    // Store state in secure HTTP-only cookie (expires in 10 minutes)
    const cookieStore = await cookies()
    cookieStore.set('replit_oauth_state', JSON.stringify({ state, data: stateData }), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 600, // 10 minutes
      path: '/',
    })

    // Build Replit OAuth URL
    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/auth/replit/callback`
    const scope = 'identity repl.read repl.write'
    
    const oauthUrl = new URL('https://replit.com/oauth/authorize')
    oauthUrl.searchParams.set('client_id', clientId)
    oauthUrl.searchParams.set('redirect_uri', redirectUri)
    oauthUrl.searchParams.set('response_type', 'code')
    oauthUrl.searchParams.set('scope', scope)
    oauthUrl.searchParams.set('state', state)

    // Redirect to Replit (user will approve once)
    return NextResponse.redirect(oauthUrl.toString())

  } catch (error) {
    console.error('[Replit OAuth] Initiation failed:', error)
    return NextResponse.json(
      { error: 'Something didn\'t work. Please try again.' },
      { status: 500 }
    )
  }
}
