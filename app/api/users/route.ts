export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireFounder } from '@/lib/admin/auth/requireFounder'
import { assessEmailTrust, SIGNUP_DENIED_MESSAGE } from '@/lib/trust/email-trust'
import { z } from 'zod'

/**
 * Platform user administration.
 *
 * Both handlers are founder/admin-only. They were previously behind
 * `requireAuth`, i.e. ANY authenticated user could call them — which made GET a
 * full email dump of every account on the platform, and made POST a complete
 * bypass of the signup pipeline: no Turnstile, no rate limit, no trust
 * assessment, and a caller-supplied `emailVerified` flag. One throwaway account
 * was enough to mint unlimited pre-verified ones.
 *
 * Nothing in the codebase calls either handler, so tightening them breaks no
 * caller; the surface is kept because it is the natural home for admin user
 * management, not deleted.
 */
const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().optional(),
  password: z.string().min(8).optional(),
  provider: z.enum(['email', 'google', 'github', 'microsoft']).default('email'),
  providerId: z.string().optional(),
  roleId: z.string().optional(),
  emailVerified: z.boolean().default(false),
  twoFactorEnabled: z.boolean().default(false),
})

export async function GET(request: NextRequest) {
  try {
    const authError = await requireFounder(request)
    if (authError) return authError

    const searchParams = request.nextUrl.searchParams
    const search = searchParams.get('search') || ''
    const page = parseInt(searchParams.get('page') || '1')
    const limit = parseInt(searchParams.get('limit') || '50')
    const skip = (page - 1) * limit
    
    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: 'insensitive' as const } },
            { name: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}
    
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip,
        take: limit,
        include: {
          role: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      }),
      prisma.user.count({ where }),
    ])
    
    return NextResponse.json({
      users: users.map(user => ({
        id: user.id,
        email: user.email,
        name: user.name,
        provider: user.provider,
        verified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt,
        role: user.role?.name,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('Get users error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch users' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const authError = await requireFounder(request)
    if (authError) return authError

    const body = await request.json()
    const data = createUserSchema.parse(body)
    const email = data.email.trim().toLowerCase()

    // Same trust engine the public signup path uses, so an admin-created
    // account cannot be a back door around it.
    const trust = await assessEmailTrust(email)
    if (trust.verdict === 'deny') {
      return NextResponse.json(
        { error: trust.reason || SIGNUP_DENIED_MESSAGE, signals: trust.signals },
        { status: trust.signals.includes('invalid_email') ? 400 : 403 }
      )
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    })
    
    if (existingUser) {
      return NextResponse.json(
        { error: 'User with this email already exists' },
        { status: 400 }
      )
    }
    
    // Hash password if provided
    let hashedPassword = null
    if (data.password) {
      const { hashPassword } = await import('@/lib/auth/password')
      hashedPassword = await hashPassword(data.password)
    }
    
    const user = await prisma.user.create({
      data: {
        email,
        name: data.name,
        password: hashedPassword,
        provider: data.provider,
        providerId: data.providerId,
        emailVerified: data.emailVerified,
        twoFactorEnabled: data.twoFactorEnabled,
        roleId: data.roleId,
        trustLevel: trust.verdict === 'challenge' ? 'untrusted' : 'trusted',
        signupScore: trust.score,
        signupSignals: trust.signals,
      },
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
    }, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.errors[0].message },
        { status: 400 }
      )
    }
    
    console.error('Create user error:', error)
    return NextResponse.json(
      { error: 'Failed to create user' },
      { status: 500 }
    )
  }
}
