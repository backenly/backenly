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
    
    const authHeader = request.headers.get('authorization')
    const token = extractTokenFromHeader(authHeader) || (await cookies()).get('auth-token')?.value
    
    if (logoutAll) {
      // Logout from all devices
      await deleteAllUserSessions(user.userId)
    } else if (token) {
      // Logout from current device only
      await deleteSession(token)
    }
    
    // Clear cookie
    const cookieStore = await cookies()
    cookieStore.delete('auth-token')
    
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

