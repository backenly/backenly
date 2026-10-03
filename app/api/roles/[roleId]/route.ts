export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAdmin } from '@/lib/auth/middleware'

/**
 * Role definitions. PLATFORM ADMIN ONLY.
 *
 * Every verb called `requireAuth` and discarded the result, so any
 * authenticated account could read, edit or delete a role - including editing
 * its `permissions` array. Granting yourself an admin role was one request;
 * editing what "admin" MEANS was another, and the second is worse because it
 * changes the privilege of every account already holding that role.
 */
import { z } from 'zod'

const updateRoleSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
})

export async function GET(request: NextRequest, props: { params: Promise<{ roleId: string }> }) {
  const params = await props.params;
  try {
    const adminError = await requireAdmin(request)
    if (adminError) return adminError
    
    const role = await prisma.role.findUnique({
      where: { id: params.roleId },
      include: {
        _count: {
          select: { users: true },
        },
      },
    })
    
    if (!role) {
      return NextResponse.json(
        { error: 'Role not found' },
        { status: 404 }
      )
    }
    
    return NextResponse.json({
      role: {
        id: role.id,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        userCount: role._count.users,
      },
    })
  } catch (error) {
    console.error('Get role error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch role' },
      { status: 500 }
    )
  }
}

export async function PUT(request: NextRequest, props: { params: Promise<{ roleId: string }> }) {
  const params = await props.params;
  try {
    const adminError = await requireAdmin(request)
    if (adminError) return adminError
    const body = await request.json()
    const data = updateRoleSchema.parse(body)
    
    const role = await prisma.role.update({
      where: { id: params.roleId },
      data,
      include: {
        _count: {
          select: { users: true },
        },
      },
    })
    
    return NextResponse.json({
      role: {
        id: role.id,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        userCount: role._count.users,
      },
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }
    
    console.error('Update role error:', error)
    return NextResponse.json(
      { error: 'Failed to update role' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ roleId: string }> }) {
  const params = await props.params;
  try {
    const adminError = await requireAdmin(request)
    if (adminError) return adminError
    
    // Check if role is in use
    const role = await prisma.role.findUnique({
      where: { id: params.roleId },
      include: {
        _count: {
          select: { users: true },
        },
      },
    })
    
    if (!role) {
      return NextResponse.json(
        { error: 'Role not found' },
        { status: 404 }
      )
    }
    
    if (role._count.users > 0) {
      return NextResponse.json(
        { error: 'Cannot delete role that is assigned to users' },
        { status: 400 }
      )
    }
    
    await prisma.role.delete({
      where: { id: params.roleId },
    })
    
    return NextResponse.json({ message: 'Role deleted successfully' })
  } catch (error) {
    console.error('Delete role error:', error)
    return NextResponse.json(
      { error: 'Failed to delete role' },
      { status: 500 }
    )
  }
}

