export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth, requireAdmin } from '@/lib/auth/middleware'
import { z } from 'zod'

const updatePolicySchema = z.object({
  enabled: z.boolean().optional(),
  warning: z.string().optional(),
  codeGenerated: z.boolean().optional(),
  description: z.string().optional(),
})

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await requireAuth(request)
    
    const policy = await prisma.authPolicy.findUnique({
      where: { id: params.id },
    })
    
    if (!policy) {
      return NextResponse.json(
        { error: 'Policy not found' },
        { status: 404 }
      )
    }
    
    return NextResponse.json({ policy })
  } catch (error) {
    console.error('Get policy error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch policy' },
      { status: 500 }
    )
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  // 🔒 Platform-wide policy mutation — founder/admin only.
  const adminError = await requireAdmin(request)
  if (adminError) return adminError

  try {
    const body = await request.json()
    const data = updatePolicySchema.parse(body)
    
    const policy = await prisma.authPolicy.update({
      where: { id: params.id },
      data: {
        ...data,
        updatedAt: new Date(),
      },
    })
    
    return NextResponse.json({ policy })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }
    
    console.error('Update policy error:', error)
    return NextResponse.json(
      { error: 'Failed to update policy' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  // 🔒 Platform-wide policy deletion — founder/admin only.
  const adminError = await requireAdmin(request)
  if (adminError) return adminError

  try {
    await prisma.authPolicy.delete({
      where: { id: params.id },
    })
    
    return NextResponse.json({ message: 'Policy deleted successfully' })
  } catch (error) {
    console.error('Delete policy error:', error)
    return NextResponse.json(
      { error: 'Failed to delete policy' },
      { status: 500 }
    )
  }
}
