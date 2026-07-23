import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { verify } from 'jsonwebtoken'
import crypto from 'crypto'

/**
 * API Key Authentication System
 * 
 * CRITICAL SECURITY:
 * - projectId is DERIVED from API key or JWT
 * - NEVER trust client-sent project IDs
 * - This prevents spoofing and unauthorized access
 */

export interface AuthResult {
  success: boolean
  projectId?: string
  keyId?: string
  userId?: string
  error?: string
  code?: string
  permissions?: string[]
  rateLimit?: number
}

/**
 * Extract Project ID from Authentication
 * 
 * Flow:
 * 1. Check for x-api-key header
 * 2. If not found, check for JWT token
 * 3. Lookup key/token in database
 * 4. Extract projectId from key/token
 * 5. Return projectId + metadata
 * 
 * NEVER accepts projectId from query params!
 */
export async function extractProjectIdFromAuth(
  request: NextRequest
): Promise<AuthResult> {
  // Try API Key first (preferred for public APIs)
  const apiKey = request.headers.get('x-api-key')
  
  if (apiKey) {
    return await validateApiKey(apiKey)
  }

  // Fallback to JWT (for dashboard/user APIs)
  const authHeader = request.headers.get('authorization')
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7)
    return await validateJWT(token)
  }

  // No authentication provided
  return {
    success: false,
    error: 'Authentication required',
    code: 'NO_AUTH_PROVIDED',
  }
}

/**
 * Validate API Key
 * 
 * Security:
 * - Keys are hashed (never store plaintext)
 * - Check expiration
 * - Check if key is active
 * - Extract projectId from key record
 */
async function validateApiKey(apiKey: string): Promise<AuthResult> {
  try {
    // Hash the provided key to compare with stored hash.
    // We do NOT log the raw key — only the first 16 chars of the plaintext
    // (the proj_ prefix) for traceability without exposing the secret material.
    const keyHash = hashApiKey(apiKey)

    // Lookup key in database by hash — the DB does exact equality on the index.
    // This is inherently timing-safe at the application layer because
    // the DB comparison is done server-side with no observable timing difference
    // for near-matches vs misses from the application's perspective.
    const key = await prisma.apiKey.findFirst({
      where: { keyHash },
      select: {
        id: true,
        keyHash: true,   // included so we can do timingSafeEqual as a second-factor check
        projectId: true,
        userId: true,
        permissions: true,
        rateLimit: true,
        expiresAt: true,
        lastUsed: true,
      },
    })

    if (!key) {
      // Key not found — return the same error shape as an expired/invalid key
      // to prevent enumeration attacks (all failures look identical to the caller)
      return {
        success: false,
        error: 'Invalid API key',
        code: 'INVALID_API_KEY',
      }
    }

    // Second-factor timing-safe comparison — defends against subtle timing leaks
    // if the DB ever returns a near-match due to an index scan anomaly.
    if (!timingSafeCompare(key.keyHash, keyHash)) {
      return {
        success: false,
        error: 'Invalid API key',
        code: 'INVALID_API_KEY',
      }
    }

    // Check if key is expired
    if (key.expiresAt && key.expiresAt < new Date()) {
      return {
        success: false,
        error: 'API key has expired',
        code: 'API_KEY_EXPIRED',
      }
    }

    // Check if key has project ID
    if (!key.projectId) {
      return {
        success: false,
        error: 'API key is not associated with a project',
        code: 'NO_PROJECT_ID',
      }
    }

    // Update last used timestamp (fire and forget)
    prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsed: new Date() },
    }).catch(console.error)

    return {
      success: true,
      projectId: key.projectId,
      keyId: key.id,
      userId: key.userId,
      permissions: key.permissions,
      rateLimit: key.rateLimit,
    }
  } catch (error: any) {
    console.error('API Key validation error:', error)
    return {
      success: false,
      error: 'Failed to validate API key',
      code: 'VALIDATION_ERROR',
    }
  }
}

/**
 * Validate JWT Token
 * 
 * For dashboard/user authentication
 * Extract projectId from token payload or session
 */
async function validateJWT(token: string): Promise<AuthResult> {
  try {
    const jwtSecret = process.env.JWT_SECRET
    if (!jwtSecret) throw new Error('JWT_SECRET environment variable is not set')
    
    // Verify and decode token
    const decoded: any = verify(token, jwtSecret)

    if (!decoded || !decoded.userId) {
      return {
        success: false,
        error: 'Invalid token',
        code: 'INVALID_TOKEN',
      }
    }

    // For JWT, we need to get projectId from context
    // Option 1: Token includes projectId (best for API calls)
    if (decoded.projectId) {
      return {
        success: true,
        projectId: decoded.projectId,
        userId: decoded.userId,
      }
    }

    // Option 2: Lookup user's default/current project
    // This is less secure for public APIs but OK for dashboard
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        projects: {
          take: 1,
          select: { id: true },
        },
      },
    })

    if (!user || user.projects.length === 0) {
      return {
        success: false,
        error: 'No project found for user',
        code: 'NO_PROJECT',
      }
    }

    return {
      success: true,
      projectId: user.projects[0].id,
      userId: user.id,
    }
  } catch (error: any) {
    console.error('JWT validation error:', error)
    return {
      success: false,
      error: 'Invalid or expired token',
      code: 'INVALID_TOKEN',
    }
  }
}

/**
 * Hash API Key for secure storage.
 * We use SHA-256 (not bcrypt) because API keys are long random strings —
 * no need for work-factor stretching; the entropy of the key itself is the defense.
 * Exported so tests and key-creation routes can hash consistently.
 */
export function hashApiKey(key: string): string {
  return crypto
    .createHash('sha256')
    .update(key)
    .digest('hex')
}

/**
 * Timing-safe string comparison for hashed API keys.
 * Uses crypto.timingSafeEqual to prevent timing attacks that could leak
 * information about hash prefixes through response-time differences.
 *
 * Length check is on the HEX STRING (64 chars for SHA-256), not the decoded
 * buffer (which is 32 bytes). A previous version of this guard compared
 * `Buffer.length !== 64` which made the function always return false —
 * latent because the main v1 API path goes through lib/middleware/apiKeyAuth
 * which doesn't call this, but it broke /api/mcp/* on first use.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  // SHA-256 hex is always 64 chars. Reject anything else immediately so the
  // crypto.timingSafeEqual call always gets equal-length buffers.
  if (a.length !== 64 || b.length !== 64) return false

  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== bufB.length) return false

  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Generate a new API Key
 * 
 * Format: proj_live_xxxxxxxxxxxxxxxxxxxxxxxxxx
 * - proj: indicates it's a project key
 * - live/test: environment
 * - random: cryptographically secure random string
 */
export function generateApiKey(environment: 'live' | 'test' = 'live'): string {
  const randomBytes = crypto.randomBytes(24).toString('hex')
  return `proj_${environment}_${randomBytes}`
}

export interface CreateApiKeyResult {
  /**
   * The raw plaintext key — show this to the user EXACTLY ONCE at creation time.
   * It is NEVER stored and CANNOT be recovered after this response.
   * If lost, the user must delete and create a new key.
   */
  rawKey: string
  /** The DB record (keyHash, keyPrefix, id, etc. — safe to persist/return) */
  record: Awaited<ReturnType<typeof prisma.apiKey.create>>
}

/**
 * Create API Key for Project.
 *
 * SECURITY CONTRACT:
 *   - rawKey is returned ONLY in the response from this function
 *   - rawKey must be shown to the user immediately and NEVER stored server-side
 *   - If the user loses rawKey they must delete this key and create a new one
 *   - The DB only stores the SHA-256 hash (keyHash) — plaintext is irrecoverable
 */
export async function createApiKey(
  projectId: string,
  userId: string,
  options: {
    name?: string
    permissions?: string[]
    rateLimit?: number
    expiresAt?: Date
  } = {}
): Promise<CreateApiKeyResult> {
  const rawKey = generateApiKey('live')
  const keyPrefix = rawKey.substring(0, 16) // Safe prefix for display — no secret material
  const keyHash = hashApiKey(rawKey)         // SHA-256 hash — only this is persisted

  const record = await prisma.apiKey.create({
    data: {
      name: options.name || 'API Key',
      keyHash,    // SECURE: SHA-256 hash for validation — plaintext never stored
      keyPrefix,  // Safe for UI display (shows proj_live_... with dots for the rest)
      projectId,
      userId,
      permissions: options.permissions || ['read', 'write'],
      rateLimit: options.rateLimit || 100,
      expiresAt: options.expiresAt,
      keyType: 'public',
      serviceRole: false,
    },
  })

  // Return both — callers MUST surface rawKey to the user immediately
  return { rawKey, record }
}
