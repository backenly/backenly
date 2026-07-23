export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth } from '@/lib/auth/middleware'
import { z } from 'zod'

const updateRoleSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  permissions: z.array(z.string()).optional(),
})

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAuth(request)
    
    const role = await prisma.role.findUnique({
      where: { id: params.id },
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

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAuth(request)
    const body = await request.json()
    const data = updateRoleSchema.parse(body)
    
    const role = await prisma.role.update({
      where: { id: params.id },
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

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAuth(request)
    
    // Check if role is in use
    const role = await prisma.role.findUnique({
      where: { id: params.id },
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
      where: { id: params.id },
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

