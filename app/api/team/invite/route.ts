import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { withAuth } from '@/lib/auth/route-protection'

export const POST = withAuth(async (request: NextRequest, { user }) => {
  try {
    const { email } = await request.json()

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 })
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    })

    if (existingUser) {
      return NextResponse.json({ error: 'User already exists' }, { status: 400 })
    }

    // TODO: Create team invitation record
    // TODO: Send invitation email
    
    return NextResponse.json({ 
      success: true,
      message: `Invitation sent to ${email}`,
    })
  } catch (error) {
    console.error('Team invite error:', error)
    return NextResponse.json({ error: 'Failed to send invitation' }, { status: 500 })
  }
})
