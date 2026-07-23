import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db/postgres'
import { trackApiKeyUsage } from '@/lib/services/apiKeyUsage'
import crypto from 'crypto'
import { classifyKeyFailure } from './apiKeyFailureDiagnostic'

export interface ApiKeyAuthResult {
  authenticated: boolean
  apiKey?: {
    id: string
    userId: string
    permissions: string[]
    role: string
  }
  error?: string
  rateLimited?: boolean
  /**
   * Structured diagnostic for failed auth — surfaces WHY the key was rejected
   * and what the developer can do about it. Returned even on success=false so
   * downstream middleware can build a self-diagnosing 401 response.
   *
   * `sentKeyShape` is the safe-to-display rendering of what we received
   * (never the raw key — only a prefix or a placeholder marker like
   * `(none)` / `Bearer undefined`). Always safe to echo back to the caller.
   */
  failureReason?: {
    kind: 'missing' | 'placeholder' | 'malformed' | 'unknown_key' | 'expired'
    sentKeyShape: string
    hint: string
  }
}

/**
 * Authenticate request using API key.
 * Accepts key via:
 *   - Authorization: Bearer <key>
 *   - x-api-key: <key>
 * Verification uses SHA-256 hash lookup (O(1), no bcrypt needed for API keys).
 */
export async function authenticateApiKey(request: NextRequest): Promise<ApiKeyAuthResult> {
  // Accept key from Authorization: Bearer OR x-api-key header
  let providedKey: string | null = null

  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    providedKey = authHeader.substring(7).trim()
  }

  if (!providedKey) {
    const xApiKey = request.headers.get('x-api-key')
    if (xApiKey) providedKey = xApiKey.trim()
  }

  // Also accept via query parameter for EventSource / SSE connections where
  // setting custom headers is not possible (browser EventSource API limitation).
  if (!providedKey) {
    const qp = request.nextUrl.searchParams.get('apiKey') || request.nextUrl.searchParams.get('api_key')
    if (qp) providedKey = qp.trim()
  }

  if (!providedKey) {
    return {
      authenticated: false,
      error: 'API key required. Send via Authorization: Bearer <key>, x-api-key header, or ?apiKey= query param.',
      failureReason: classifyKeyFailure(null, 'missing'),
    }
  }

  // SHA-256 hash lookup — this IS the verification (no bcrypt needed for API keys)
  const keyHash = crypto.createHash('sha256').update(providedKey).digest('hex')

  const apiKey = await prisma.apiKey.findFirst({
    where: {
      keyHash,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    },
    include: {
      user: true,
    },
  })

  if (!apiKey) {
    // Distinguish "key exists but is expired" from "key doesn't exist at all"
    // so the caller sees the right hint. A second lookup ignoring expiry tells
    // us which bucket we're in.
    const expiredMatch = await prisma.apiKey.findFirst({
      where: { keyHash, expiresAt: { not: null, lte: new Date() } },
      select: { id: true },
    })
    return {
      authenticated: false,
      error: 'Invalid API key',
      failureReason: classifyKeyFailure(providedKey, expiredMatch ? 'expired' : 'unknown_key'),
    }
  }
  
  // Check rate limits
  const now = new Date()
  const resetAt = apiKey.resetAt || new Date(now.getTime() + apiKey.rateLimitWindow * 1000)

  // Reset counter if window expired
  if (resetAt < now) {
    await prisma.apiKey.update({
      where: { id: apiKey.id },
      data: {
        requestCount: 0,
        resetAt: new Date(now.getTime() + apiKey.rateLimitWindow * 1000),
      },
    })
    apiKey.requestCount = 0
  }

  // Atomic increment: only increments if requestCount is still below the limit.
  // If another concurrent request already pushed it over the limit, updated.count === 0.
  const updated = await prisma.apiKey.updateMany({
    where: { id: apiKey.id, requestCount: { lt: apiKey.rateLimit } },
    data: { requestCount: { increment: 1 }, lastUsed: now },
  })

  if (updated.count === 0) {
    return {
      authenticated: true,
      apiKey: {
        id: apiKey.id,
        userId: apiKey.userId,
        permissions: apiKey.permissions,
        role: apiKey.role,
      },
      rateLimited: true,
      error: 'Rate limit exceeded',
    }
  }
  
  return {
    authenticated: true,
    apiKey: {
      id: apiKey.id,
      userId: apiKey.userId,
      permissions: apiKey.permissions,
      role: apiKey.role,
    },
  }
}

/**
 * Check whether an API key holds a required permission.
 *
 * `required` is a set of ALTERNATIVES — holding ANY one grants access (e.g.
 * ['read','admin'] means "a read key OR an admin key"). This MUST be OR
 * (`some`), not AND (`every`): every route's list ends in 'admin', so
 * AND-semantics collapsed every endpoint to admin-only and 403'd valid keys.
 */
export function hasPermission(permissions: string[], required: string | string[]): boolean {
  const requiredPerms = Array.isArray(required) ? required : [required]

  // Admin has all permissions
  if (permissions.includes('admin')) {
    return true
  }

  return requiredPerms.some(perm => permissions.includes(perm))
}

/**
 * Middleware to require API key authentication with specific permission
 */
export async function requireApiKey(
  request: NextRequest,
  requiredPermission?: string | string[]
): Promise<{
  apiKey: { id: string; userId: string; permissions: string[]; role: string }
  response?: NextResponse
}> {
  const auth = await authenticateApiKey(request)
  
  if (!auth.authenticated || !auth.apiKey) {
    throw new Error(auth.error || 'API key authentication required')
  }
  
  if (auth.rateLimited) {
    return {
      apiKey: auth.apiKey,
      response: NextResponse.json(
        { error: 'Rate limit exceeded', retryAfter: auth.apiKey ? 60 : undefined },
        { status: 429 }
      ),
    }
  }
  
  if (requiredPermission && !hasPermission(auth.apiKey.permissions, requiredPermission)) {
    return {
      apiKey: auth.apiKey,
      response: NextResponse.json(
        { error: 'Insufficient permissions', required: requiredPermission },
        { status: 403 }
      ),
    }
  }
  
  // Track usage (async, don't wait)
  const url = new URL(request.url)
  trackApiKeyUsage(auth.apiKey.id, url.pathname, request.method).catch(console.error)
  
  return { apiKey: auth.apiKey }
}

