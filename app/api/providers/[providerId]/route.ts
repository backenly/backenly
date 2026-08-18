export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth } from '@/lib/auth/middleware'
import { z } from 'zod'

const updateProviderSchema = z.object({
  enabled: z.boolean().optional(),
  configured: z.boolean().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  redirectUri: z.string().url().optional(),
  scopes: z.array(z.string()).optional(),
  warning: z.string().optional(),
  codeGenerated: z.boolean().optional(),
  modifiedBy: z.enum(['ui', 'code']).optional(),
})

export async function GET(request: NextRequest, props: { params: Promise<{ providerId: string }> }) {
  const params = await props.params;
  try {
    await requireAuth(request)
    
    const provider = await prisma.authProvider.findUnique({
      where: { id: params.providerId },
    })
    
    if (!provider) {
      return NextResponse.json(
        { error: 'Provider not found' },
        { status: 404 }
      )
    }
    
    return NextResponse.json({ provider })
  } catch (error) {
    console.error('Get provider error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch provider' },
      { status: 500 }
    )
  }
}

export async function PUT(request: NextRequest, props: { params: Promise<{ providerId: string }> }) {
  const params = await props.params;
  try {
    await requireAuth(request)
    const body = await request.json()
    const data = updateProviderSchema.parse(body)
    
    const provider = await prisma.authProvider.update({
      where: { id: params.providerId },
      data: {
        ...data,
        lastModified: new Date(),
      },
    })
    
    return NextResponse.json({ provider })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }
    
    console.error('Update provider error:', error)
    return NextResponse.json(
      { error: 'Failed to update provider' },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest, props: { params: Promise<{ providerId: string }> }) {
  const params = await props.params;
  try {
    await requireAuth(request)
    
    await prisma.authProvider.delete({
      where: { id: params.providerId },
    })
    
    return NextResponse.json({ message: 'Provider deleted successfully' })
  } catch (error) {
    console.error('Delete provider error:', error)
    return NextResponse.json(
      { error: 'Failed to delete provider' },
      { status: 500 }
    )
  }
}

