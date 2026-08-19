export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { requireAuth } from '@/lib/auth/middleware'
import { hashPassword } from '@/lib/auth/password'
import crypto from 'crypto'

function generateApiKey(prefix: string): string {
  const randomBytes = crypto.randomBytes(32).toString('hex')
  return `${prefix}${randomBytes}`
}

function getKeyPrefix(role: string): string {
  const prefixes: Record<string, string> = {
    'admin': 'sk_live_',
    'read-only': 'sk_read_',
    'write': 'sk_test_',
    'ai-only': 'sk_ai_',
  }
  return prefixes[role] || 'sk_'
}

/**
 * Rotate an API key - generates a new key while keeping the same settings
 */
export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auth = await requireAuth(request)

    const apiKey = await prisma.apiKey.findFirst({
      where: {
        id: params.id,
        userId: auth.userId,
      },
    })

    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key not found' },
        { status: 404 }
      )
    }

    // Generate new key
    const keyPrefix = getKeyPrefix(apiKey.role)
    const fullKey = generateApiKey(keyPrefix)
    const hashedKey = await hashPassword(fullKey)

    // Update the key (keep all other settings)
    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: {
        key: hashedKey,
        keyPrefix,
        requestCount: 0, // Reset usage counter
        resetAt: new Date(Date.now() + apiKey.rateLimitWindow * 1000),
      },
    })

    return NextResponse.json({
      apiKey: {
        id: apiKey.id,
        key: fullKey, // Only returned on rotation
        keyPrefix,
      },
      message: 'API key rotated successfully. Save the new key - it will not be shown again.',
    })
  } catch (error) {
    console.error('Rotate API key error:', error)
    return NextResponse.json(
      { error: 'Failed to rotate API key' },
      { status: 500 }
    )
  }
}
