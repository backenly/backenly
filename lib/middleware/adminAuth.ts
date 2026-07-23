import { NextRequest, NextResponse } from 'next/server'
import { authenticateApiKey } from './apiKeyAuth'
import { prisma } from '@/lib/db'

/**
 * Middleware for admin/dashboard routes
 * Only allows dashboard keys, blocks public keys
 */
export async function requireDashboardKey(
  request: NextRequest
): Promise<{
  apiKey: { id: string; userId: string; permissions: string[]; role: string }
  response?: NextResponse
}> {
  const auth = await authenticateApiKey(request)
  
  if (!auth.authenticated || !auth.apiKey) {
    return {
      apiKey: {} as any,
      response: NextResponse.json(
        { error: 'API key authentication required' },
        { status: 401 }
      ),
    }
  }

  if (auth.rateLimited) {
    return {
      apiKey: auth.apiKey,
      response: NextResponse.json(
        { error: 'Rate limit exceeded', retryAfter: 60 },
        { status: 429 }
      ),
    }
  }

  // Get full API key record to check keyType
  const apiKeyRecord = await prisma.apiKey.findUnique({
    where: { id: auth.apiKey.id },
  })

  if (!apiKeyRecord) {
    return {
      apiKey: auth.apiKey,
      response: NextResponse.json(
        { error: 'API key not found' },
        { status: 401 }
      ),
    }
  }

  // Only dashboard keys can access admin routes
  if (apiKeyRecord.keyType !== 'dashboard') {
    return {
      apiKey: auth.apiKey,
      response: NextResponse.json(
        { error: 'Public API keys cannot access admin endpoints. Use a dashboard key instead.' },
        { status: 403 }
      ),
    }
  }

  return { apiKey: auth.apiKey }
}

