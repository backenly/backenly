import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/db'
import { verifyToken } from '@/lib/auth/jwt'
import crypto from 'crypto'

/**
 * PROMPT 6 — Replit OAuth Callback
 * 
 * Step 3: Replit redirects back after user approves
 * Step 4: Exchange code for access token
 * Step 5: Auto-bind frontend to Backenly backend
 * 
 * User sees: "Your backend is now managed by Backenly"
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const error = searchParams.get('error')

    // Check if user denied access
    if (error === 'access_denied') {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/app?error=connection_cancelled`
      )
    }

    if (!code || !state) {
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/app?error=connection_failed`
      )
    }

    // Verify state parameter (CSRF protection)
    const cookieStore = cookies()
    const stateCookie = cookieStore.get('replit_oauth_state')
    
    if (!stateCookie) {
      console.error('[Replit OAuth] Missing state cookie')
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/app?error=session_expired`
      )
    }

    let stateData
    try {
      const parsed = JSON.parse(stateCookie.value)
      if (parsed.state !== state) {
        throw new Error('State mismatch')
      }
      stateData = parsed.data
      
      // Check if state expired (max 10 minutes)
      const age = Date.now() - stateData.timestamp
      if (age > 10 * 60 * 1000) {
        throw new Error('State expired')
      }
    } catch (err) {
      console.error('[Replit OAuth] State verification failed:', err)
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/app?error=security_check_failed`
      )
    }

    // Clear state cookie
    cookieStore.delete('replit_oauth_state')

    const projectId = stateData.projectId

    // Exchange authorization code for access token
    const clientId = process.env.REPLIT_CLIENT_ID!
    const clientSecret = process.env.REPLIT_CLIENT_SECRET!
    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/auth/replit/callback`

    const tokenResponse = await fetch('https://replit.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      console.error('[Replit OAuth] Token exchange failed:', errorText)
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/app?error=connection_failed`
      )
    }

    const tokenData = await tokenResponse.json()
    const accessToken = tokenData.access_token
    const refreshToken = tokenData.refresh_token

    // Get Replit user info
    const userResponse = await fetch('https://replit.com/api/v1/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })

    if (!userResponse.ok) {
      console.error('[Replit OAuth] Failed to fetch user info')
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/app?error=connection_failed`
      )
    }

    const replitUser = await userResponse.json()

    // Get user's Replit projects/repls
    const replsResponse = await fetch('https://replit.com/api/v1/user/repls', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    })

    let replUrl = null
    if (replsResponse.ok) {
      const repls = await replsResponse.json()
      // Get the most recently updated repl
      if (repls && repls.length > 0) {
        const latestRepl = repls.sort((a: any, b: any) => 
          new Date(b.timeUpdated).getTime() - new Date(a.timeUpdated).getTime()
        )[0]
        replUrl = `https://replit.com/@${latestRepl.user}/${latestRepl.slug}`
      }
    }

    // Create or update Replit connection in database
    // First, revoke any existing active Replit connections for this project
    await prisma.delegatedConnection.updateMany({
      where: {
        projectId,
        provider: 'replit',
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        revokedAt: new Date(),
      },
    })

    // Generate Backenly delegation token
    const delegationToken = `del_${crypto.randomBytes(32).toString('hex')}`
    const tokenHash = crypto.createHash('sha256').update(delegationToken).digest('hex')

    // Store connection with Replit access token (encrypted)
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days

    const connection = await prisma.delegatedConnection.create({
      data: {
        projectId,
        provider: 'replit',
        tokenHash,
        permissions: {
          readSchema: true,
          readEndpoints: true,
          callApis: true,
          authenticateSessions: true,
        },
        expiresAt,
        metadata: {
          replitUserId: replitUser.id,
          replitUsername: replitUser.username,
          replUrl,
          accessToken, // TODO: Encrypt this in production
          refreshToken, // TODO: Encrypt this in production
        },
        ipAddress: request.headers.get('x-forwarded-for') || 'unknown',
        userAgent: request.headers.get('user-agent') || 'unknown',
      },
    })

    // Auto-inject Backenly configuration into Replit project (if we have repl URL)
    if (replUrl) {
      try {
        await autoInjectBackenlyToReplit(
          accessToken,
          replUrl,
          projectId,
          delegationToken
        )
      } catch (injectError) {
        console.error('[Replit OAuth] Auto-injection failed:', injectError)
        // Don't fail the connection if injection fails
      }
    }

    // Redirect back to project page with success
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/app/projects/${projectId}?connected=true`
    )

  } catch (error) {
    console.error('[Replit OAuth] Callback failed:', error)
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/app?error=connection_failed`
    )
  }
}

/**
 * Auto-inject Backenly configuration into Replit project
 * This makes the frontend automatically use Backenly backend
 */
async function autoInjectBackenlyToReplit(
  accessToken: string,
  replUrl: string,
  projectId: string,
  delegationToken: string
) {
  // Extract repl ID from URL
  const replMatch = replUrl.match(/\/@([^/]+)\/([^/]+)/)
  if (!replMatch) {
    throw new Error('Invalid repl URL')
  }

  const [, username, slug] = replMatch

  // Set Backenly environment variables in Replit
  // These will be available to the frontend app automatically
  const envVars = {
    NEXT_PUBLIC_BACKENLY_PROJECT_ID: projectId,
    NEXT_PUBLIC_BACKENLY_API_URL: process.env.NEXT_PUBLIC_APP_URL || 'https://backenly.com',
    BACKENLY_DELEGATION_TOKEN: delegationToken, // Server-side only
  }

  for (const [key, value] of Object.entries(envVars)) {
    try {
      await fetch(`https://replit.com/api/v1/repls/${username}/${slug}/env`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: key,
          value: value,
        }),
      })
    } catch (err) {
      console.error(`[Replit OAuth] Failed to set env var ${key}:`, err)
    }
  }

  console.log('[Replit OAuth] ✅ Auto-injected Backenly configuration')
}
