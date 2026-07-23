import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { withAuth } from '@/lib/auth/route-protection'

export const PATCH = withAuth(async (request: NextRequest, { user }) => {
  try {
    const { name } = await request.json()

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.userId },
      data: { name: name.trim() },
    })

    return NextResponse.json({ 
      success: true,
      user: {
        id: updatedUser.id,
        email: updatedUser.email,
        name: updatedUser.name,
      }
    })
  } catch (error) {
    console.error('Update profile error:', error)
    return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 })
  }
})
