export const dynamic = 'force-dynamic'

/**
 * POST /api/auth/refresh-token
 *
 * Exchanges a valid refresh token for a new access JWT without re-login (#67).
 *
 * The refresh token is read from either:
 *   1. The `refresh-token` httpOnly cookie (browser clients)
 *   2. The `refreshToken` field in the JSON request body (mobile / API clients)
 *
 * On success, the old refresh token is immediately invalidated (rotation) and
 * new auth-token + refresh-token cookies are set.
 *
 * Errors:
 *   401 INVALID_REFRESH_TOKEN  — token not found or already rotated
 *   401 REFRESH_TOKEN_EXPIRED  — token past its 30-day window
 *   401 USER_UNAVAILABLE       — user deleted or suspended
 */

import { NextRequest, NextResponse } from 'next/server'
import { refreshAccessToken } from '@/lib/auth/session'

export async function POST(request: NextRequest) {
  try {
    // Read refresh token from cookie first, then body
    const cookieToken = request.cookies.get('refresh-token')?.value

    let bodyToken: string | undefined
    try {
      const body = await request.json()
      bodyToken = body?.refreshToken
    } catch {
      // Body is optional
    }

    const refreshToken = cookieToken || bodyToken

    if (!refreshToken) {
      return NextResponse.json(
        { error: 'Refresh token required', code: 'MISSING_REFRESH_TOKEN' },
        { status: 401 }
      )
    }

    const { token, refreshToken: newRefreshToken, expiresAt } = await refreshAccessToken(refreshToken)

    const response = NextResponse.json({
      token,
      refreshToken: newRefreshToken,
      expiresAt: expiresAt.toISOString(),
    })

    // Rotate both cookies
    response.cookies.set('auth-token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    })

    response.cookies.set('refresh-token', newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: '/',
    })

    return response
  } catch (error: unknown) {
    const code = error instanceof Error ? error.message : 'REFRESH_FAILED'

    if (code === 'INVALID_REFRESH_TOKEN') {
      return NextResponse.json(
        { error: 'Refresh token is invalid or has already been used.', code },
        { status: 401 }
      )
    }

    if (code === 'REFRESH_TOKEN_EXPIRED') {
      const response = NextResponse.json(
        { error: 'Refresh token has expired. Please log in again.', code },
        { status: 401 }
      )
      // Clear stale cookies
      response.cookies.delete('auth-token')
      response.cookies.delete('refresh-token')
      return response
    }

    if (code === 'USER_UNAVAILABLE') {
      const response = NextResponse.json(
        { error: 'Account is unavailable. Please contact support.', code },
        { status: 401 }
      )
      response.cookies.delete('auth-token')
      response.cookies.delete('refresh-token')
      return response
    }

    console.error('Refresh token error:', error)
    return NextResponse.json(
      { error: 'Failed to refresh session', code: 'REFRESH_FAILED' },
      { status: 500 }
    )
  }
}
