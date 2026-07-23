export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth } from '@/lib/auth/middleware'
import { z } from 'zod'

const createProviderSchema = z.object({
  name: z.enum(['email', 'google', 'github', 'microsoft']),
  enabled: z.boolean().default(false),
  configured: z.boolean().default(false),
  type: z.enum(['email', 'oauth']),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  redirectUri: z.string().url().optional(),
  scopes: z.array(z.string()).default([]),
  icon: z.string().optional(),
  warning: z.string().optional(),
})

export async function GET(request: NextRequest) {
  try {
    await requireAuth(request)
    
    const providers = await prisma.authProvider.findMany({
      orderBy: { name: 'asc' },
    })
    
    return NextResponse.json({ providers })
  } catch (error) {
    console.error('Get providers error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch providers' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireAuth(request)
    const body = await request.json()
    const validated = createProviderSchema.parse(body)
    
    const provider = await prisma.authProvider.create({
      data: {
        name: validated.name,
        enabled: validated.enabled,
        configured: validated.configured,
        type: validated.type,
        clientId: validated.clientId,
        clientSecret: validated.clientSecret,
        redirectUri: validated.redirectUri,
        scopes: validated.scopes,
        icon: validated.icon,
        warning: validated.warning,
      },
    })
    
    return NextResponse.json({ provider }, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }
    
    console.error('Create provider error:', error)
    return NextResponse.json(
      { error: 'Failed to create provider' },
      { status: 500 }
    )
  }
}

