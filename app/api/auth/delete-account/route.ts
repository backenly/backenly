import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { withAuth } from '@/lib/auth/route-protection'

export const DELETE = withAuth(async (request: NextRequest, { user }) => {
  try {
    // Delete all user projects first (cascade)
    await prisma.project.deleteMany({
      where: { userId: user.userId },
    })

    // Delete user account
    await prisma.user.delete({
      where: { id: user.userId },
    })

    // Clear auth cookie
    const response = NextResponse.json({ success: true })
    response.cookies.set('token', '', { maxAge: 0 })
    
    return response
  } catch (error) {
    console.error('Delete account error:', error)
    return NextResponse.json({ error: 'Failed to delete account' }, { status: 500 })
  }
})
