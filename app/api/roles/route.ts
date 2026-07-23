export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth } from '@/lib/auth/middleware'
import { z } from 'zod'

const createRoleSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  permissions: z.array(z.string()).min(1, 'At least one permission is required'),
})

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request)
    
    const roles = await prisma.role.findMany({
      include: {
        _count: {
          select: { users: true },
        },
      },
      orderBy: { name: 'asc' },
    })
    
    return NextResponse.json({
      roles: roles.map(role => ({
        id: role.id,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        userCount: role._count.users,
      })),
    })
  } catch (error) {
    console.error('Get roles error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch roles' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request)
    const body = await request.json()
    const data = createRoleSchema.parse(body)
    
    // Check if role already exists
    const existingRole = await prisma.role.findFirst({
      where: { 
        name: data.name,
        projectId: null, // Global role
      },
    })
    
    if (existingRole) {
      return NextResponse.json(
        { error: 'Role with this name already exists' },
        { status: 400 }
      )
    }
    
    const role = await prisma.role.create({
      data: {
        name: data.name,
        description: data.description,
        permissions: data.permissions,
      },
    })
    
    return NextResponse.json({ role }, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }
    
    console.error('Create role error:', error)
    return NextResponse.json(
      { error: 'Failed to create role' },
      { status: 500 }
    )
  }
}

