export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth/route-protection'
import { deleteSession, deleteAllUserSessions } from '@/lib/auth/session'
import { extractTokenFromHeader } from '@/lib/auth/jwt'
import { cookies } from 'next/headers'

/**
 * POST /api/auth/logout - Logout user
 * 
 * Query params:
 * - all=true : Logout from all devices (revoke all sessions)
 */
export const POST = withAuth(async (request, { user }) => {
  try {
    const searchParams = request.nextUrl.searchParams
    const logoutAll = searchParams.get('all') === 'true'
    const cookieStore = await cookies()

    if (logoutAll) {
      // Logout from all devices
      await deleteAllUserSessions(user.userId)
    } else {
      // Logout from current device only. Revoke every token the request
      // presented: the dashboard sends its localStorage copy as a Bearer next
      // to the cookie, and the two drift apart (see authenticateRequest), so
      // revoking only the Bearer could leave the browser's real session alive.
      const presented = new Set(
        [
          extractTokenFromHeader(request.headers.get('authorization')),
          cookieStore.get('auth-token')?.value,
        ].filter((token): token is string => !!token),
      )
      for (const token of presented) {
        await deleteSession(token)
      }
    }

    // Clear both cookies. A refresh-token cookie left behind is a credential
    // that outlives the sign-out: if its session row survived, the login
    // page's session check would refresh with it and sign the browser back in.
    cookieStore.delete('auth-token')
    cookieStore.delete('refresh-token')
    
    return NextResponse.json({ 
      message: logoutAll ? 'Logged out from all devices' : 'Logged out successfully' 
    })
  } catch (error) {
    console.error('Logout error:', error)
    return NextResponse.json(
      { error: 'Failed to logout' },
      { status: 500 }
    )
  }
})

