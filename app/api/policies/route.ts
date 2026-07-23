export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth, requireAdmin } from '@/lib/auth/middleware'
import { z } from 'zod'

const createPolicySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  enabled: z.boolean().default(false),
  warning: z.string().optional(),
  codeGenerated: z.boolean().default(false),
})

// GET is read-only — any authed user can SEE the platform-wide auth-policy
// defaults (they're not secret). Mutating endpoints (POST/PUT/DELETE) are
// admin-only because these policies affect every project on the platform.
export async function GET(request: NextRequest) {
  try {
    await requireAuth(request)

    const policies = await prisma.authPolicy.findMany({
      orderBy: { name: 'asc' },
    })

    return NextResponse.json({ policies })
  } catch (error) {
    console.error('Get policies error:', error?.toString())
    return NextResponse.json(
      { error: 'Failed to fetch policies' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  // 🔒 Platform-wide config mutation — founder/admin only. Previously any
  // authed user could create platform-wide auth policies that affected
  // every tenant's auth surface.
  const adminError = await requireAdmin(request)
  if (adminError) return adminError

  try {
    const body = await request.json()
    const validated = createPolicySchema.parse(body)
    
    const policy = await prisma.authPolicy.create({
      data: {
        name: validated.name,
        description: validated.description,
        enabled: validated.enabled,
        warning: validated.warning,
        codeGenerated: validated.codeGenerated,
      },
    })
    
    return NextResponse.json({ policy }, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }
    
    console.error('Create policy error:', error)
    return NextResponse.json(
      { error: 'Failed to create policy' },
      { status: 500 }
    )
  }
}
