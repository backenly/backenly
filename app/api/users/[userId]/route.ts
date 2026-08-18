export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth } from '@/lib/auth/middleware'
import { z } from 'zod'

const updateUserSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  roleId: z.string().optional(),
  emailVerified: z.boolean().optional(),
  twoFactorEnabled: z.boolean().optional(),
  password: z.string().min(8).optional(),
})

export async function GET(request: NextRequest, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  try {
    await requireAuth(request)
    
    const user = await prisma.user.findUnique({
      where: { id: params.userId },
      include: {
        role: true,
      },
    })
    
    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }
    
    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        provider: user.provider,
        verified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt,
        role: user.role,
      },
    })
  } catch (error) {
    console.error('Get user error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch user' },
      { status: 500 }
    )
  }
}

export async function PUT(request: NextRequest, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  try {
    await requireAuth(request)
    const body = await request.json()
    const data = updateUserSchema.parse(body)
    
    const updateData: any = {}
    if (data.name !== undefined) updateData.name = data.name
    if (data.email !== undefined) updateData.email = data.email
    if (data.roleId !== undefined) updateData.roleId = data.roleId
    if (data.emailVerified !== undefined) updateData.emailVerified = data.emailVerified
    if (data.twoFactorEnabled !== undefined) updateData.twoFactorEnabled = data.twoFactorEnabled
    
    if (data.password) {
      const { hashPassword } = await import('@/lib/auth/password')
      updateData.password = await hashPassword(data.password)
    }
    
    const user = await prisma.user.update({
      where: { id: params.userId },
      data: updateData,
      include: {
        role: true,
      },
    })
    
    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        provider: user.provider,
        verified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        role: user.role?.name,
      },
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }
    
    console.error('Update user error:', error)
    return NextResponse.json(
      { error: 'Failed to update user' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  try {
    await requireAuth(request)
    
    await prisma.user.delete({
      where: { id: params.userId },
    })
    
    return NextResponse.json({ message: 'User deleted successfully' })
  } catch (error) {
    console.error('Delete user error:', error)
    return NextResponse.json(
      { error: 'Failed to delete user' },
      { status: 500 }
    )
  }
}

