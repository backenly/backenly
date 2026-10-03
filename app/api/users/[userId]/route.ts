export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth, requireAdmin } from '@/lib/auth/middleware'
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
    // Self or admin, matching PUT. This also discarded requireAuth's result,
    // so any account could read any other account's record including its role.
    const caller = await requireAuth(request)
    const adminError = await requireAdmin(request)
    if (adminError !== null && caller.userId !== params.userId) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

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

/**
 * Update a platform user.
 *
 * ── This was account takeover and privilege escalation ──────────────────────
 *
 * It called `await requireAuth(request)` and DISCARDED the result, then applied
 * the request body to `where: { id: params.userId }`. The body may carry
 * `password`, `roleId`, `email`, `emailVerified` and `twoFactorEnabled`.
 *
 * So any authenticated account could set ANY other account's password and sign
 * in as them, grant itself an admin role, or switch off somebody else's second
 * factor. One request, no ownership check, and no UI calling it - which is why
 * nothing ever noticed.
 *
 * Two separate rules now, because they answer different questions:
 *
 *   WHO may touch this record   self, or an admin. Nobody else.
 *   WHICH fields may they set   a user may change their own name and password.
 *                               Role, verified state and 2FA are privilege and
 *                               belong to an admin, even on your own record -
 *                               otherwise self-service becomes self-promotion.
 */
export async function PUT(request: NextRequest, props: { params: Promise<{ userId: string }> }) {
  const params = await props.params;
  try {
    const caller = await requireAuth(request)
    const body = await request.json()
    const data = updateUserSchema.parse(body)

    const adminError = await requireAdmin(request)
    const isAdmin = adminError === null
    const isSelf = caller.userId === params.userId

    if (!isAdmin && !isSelf) {
      // 404, not 403: this endpoint must not confirm which user ids exist.
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Privilege fields. Refused rather than ignored, so a caller is never told
    // a change succeeded when it did not.
    const privileged: string[] = []
    if (data.roleId !== undefined) privileged.push('roleId')
    if (data.emailVerified !== undefined) privileged.push('emailVerified')
    if (data.twoFactorEnabled !== undefined) privileged.push('twoFactorEnabled')
    if (privileged.length > 0 && !isAdmin) {
      return NextResponse.json(
        { error: `Admin access required to change: ${privileged.join(', ')}` },
        { status: 403 },
      )
    }

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

