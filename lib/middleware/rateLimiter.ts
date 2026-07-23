/**
 * Rate Limiting Middleware
 *
 * CRITICAL FOR PRODUCTION:
 * - Prevents DOS attacks
 * - Enforces per-API rate limits
 * - Uses database-backed storage (multi-instance safe)
 *
 * Flow:
 * Request → Check rate limit → Allow/Deny → Execute
 */

import { prisma } from '@/lib/db/prisma'

// ---------------------------------------------------------------------------
// AI Route Rate Limiter (database-backed, multi-instance safe)
//
// AI endpoints hit OpenAI and are the most expensive calls in the system.
// We record each allowed request in ApiRequestLog so all Vercel instances
// share the same counter.  Limits fire before any OpenAI call.
// ---------------------------------------------------------------------------

const AI_WINDOW_MS = 60_000 // 1-minute sliding window

// Limits per user per minute
const AI_CHAT_LIMIT          = 20  // chat route   — model inference + DB reads
const AI_EXECUTE_LIMIT       = 10  // execute route — model inference + mutations
const AGENT_EXECUTION_LIMIT  = 10  // autonomous agent: schema writes + integrations
const SCHEMA_WRITE_LIMIT     = 15  // table/column mutations
const INTEGRATION_SETUP_LIMIT = 5  // integration executor calls (expensive, has side-effects)

async function dbWindowCheck(
  userId: string,
  projectId: string,
  path: string,
  limit: number,
): Promise<RateLimitResult> {
  const now = Date.now()
  const windowStart = new Date(now - AI_WINDOW_MS)
  const resetAt = now + AI_WINDOW_MS

  try {
    const count = await prisma.apiRequestLog.count({
      where: { userId, path, timestamp: { gte: windowStart } },
    })

    if (count >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfter: Math.ceil(AI_WINDOW_MS / 1000),
      }
    }

    // Record this request so other instances see it in their counts
    await prisma.apiRequestLog.create({
      data: { projectId, userId, method: 'POST', path, statusCode: 200, duration: 0 },
    })

    return { allowed: true, limit, remaining: limit - count - 1, resetAt }
  } catch (error) {
    // Fail open on DB error — never block legitimate users due to infra issues
    console.error('[AI Rate Limit] DB error, failing open:', error)
    return { allowed: true, limit, remaining: limit, resetAt }
  }
}

/**
 * Rate-limit the AI chat endpoint by userId.
 * Async — await it before any OpenAI calls.
 * DB-backed so limits are shared across all server instances.
 */
export async function enforceAiChatRateLimit(userId: string, projectId: string): Promise<RateLimitResult> {
  if (process.env.NODE_ENV === 'test' || process.env.ENGINE_MODE === 'integration') {
    return { allowed: true, limit: AI_CHAT_LIMIT, remaining: AI_CHAT_LIMIT, resetAt: Date.now() + AI_WINDOW_MS }
  }
  return dbWindowCheck(userId, projectId, '/api/ai/chat', AI_CHAT_LIMIT)
}

/**
 * Rate-limit the AI execute endpoint by userId.
 * Async — await it before any OpenAI calls.
 * DB-backed so limits are shared across all server instances.
 */
export async function enforceAiExecuteRateLimit(userId: string, projectId: string): Promise<RateLimitResult> {
  if (process.env.NODE_ENV === 'test' || process.env.ENGINE_MODE === 'integration') {
    return { allowed: true, limit: AI_EXECUTE_LIMIT, remaining: AI_EXECUTE_LIMIT, resetAt: Date.now() + AI_WINDOW_MS }
  }
  return dbWindowCheck(userId, projectId, '/api/ai/execute', AI_EXECUTE_LIMIT)
}

/**
 * Rate-limit autonomous agent execution actions (schema writes, integrations).
 * Stricter than chat — these mutate the database.
 */
export async function enforceAgentExecutionRateLimit(userId: string, projectId: string): Promise<RateLimitResult> {
  if (process.env.NODE_ENV === 'test' || process.env.ENGINE_MODE === 'integration') {
    return { allowed: true, limit: AGENT_EXECUTION_LIMIT, remaining: AGENT_EXECUTION_LIMIT, resetAt: Date.now() + AI_WINDOW_MS }
  }
  return dbWindowCheck(userId, projectId, '/api/ai/agent', AGENT_EXECUTION_LIMIT)
}

/**
 * Rate-limit integration executor calls (Stripe, auth, email, etc.).
 * Most expensive: external API calls + DB mutations.
 */
export async function enforceIntegrationRateLimit(userId: string, projectId: string): Promise<RateLimitResult> {
  if (process.env.NODE_ENV === 'test' || process.env.ENGINE_MODE === 'integration') {
    return { allowed: true, limit: INTEGRATION_SETUP_LIMIT, remaining: INTEGRATION_SETUP_LIMIT, resetAt: Date.now() + AI_WINDOW_MS }
  }
  return dbWindowCheck(userId, projectId, '/api/ai/integration', INTEGRATION_SETUP_LIMIT)
}

/**
 * Rate-limit raw schema write operations.
 */
export async function enforceSchemaWriteRateLimit(userId: string, projectId: string): Promise<RateLimitResult> {
  if (process.env.NODE_ENV === 'test' || process.env.ENGINE_MODE === 'integration') {
    return { allowed: true, limit: SCHEMA_WRITE_LIMIT, remaining: SCHEMA_WRITE_LIMIT, resetAt: Date.now() + AI_WINDOW_MS }
  }
  return dbWindowCheck(userId, projectId, '/api/ai/schema', SCHEMA_WRITE_LIMIT)
}

interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: number
  retryAfter?: number
}

/**
 * Check Rate Limit using database-backed storage
 * Multi-instance safe: all servers share same rate limit state via database
 * 
 * @param key - Unique identifier (e.g., "apiKey:xxx" or "ip:xxx")
 * @param limit - Max requests per window
 * @param windowMs - Time window in milliseconds (default: 60000 = 1 minute)
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number = 60000
): Promise<RateLimitResult> {
  // Skip rate limiting in test/integration mode
  if (process.env.NODE_ENV === 'test' || process.env.ENGINE_MODE === 'integration') {
    return {
      allowed: true,
      limit,
      remaining: limit,
      resetAt: Date.now() + windowMs,
    }
  }

  const now = Date.now()
  const windowStart = new Date(now - (now % windowMs))
  const resetAt = now + windowMs

  try {
    // Use intentLog as distributed rate limit counter
    // Count API requests in current window
    const requestCount = await prisma.intentLog.count({
      where: {
        // Use executionId to track rate limit keys
        executionId: { startsWith: `ratelimit:${key}:` },
        timestamp: { gte: windowStart },
      },
    })

    if (requestCount >= limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt,
        retryAfter: Math.ceil((resetAt - now) / 1000),
      }
    }

    return {
      allowed: true,
      limit,
      remaining: limit - requestCount - 1,
      resetAt,
    }
  } catch (error) {
    // Fail open on database error
    console.error('[Rate Limit Middleware] Database error, failing open:', error)
    return {
      allowed: true,
      limit,
      remaining: limit,
      resetAt,
    }
  }
}

/**
 * Enforce Rate Limit for API Key
 * 
 * Called BEFORE executing API request
 */
export async function enforceApiKeyRateLimit(
  keyId: string,
  rateLimit: number
): Promise<RateLimitResult> {
  const key = `apiKey:${keyId}`
  return checkRateLimit(key, rateLimit, 60000) // 1 minute window
}

/**
 * Enforce Rate Limit for IP Address
 * 
 * Fallback rate limiting for unauthenticated requests
 */
export async function enforceIpRateLimit(
  ipAddress: string,
  limit: number = 10 // Much stricter for unauthenticated
): Promise<RateLimitResult> {
  const key = `ip:${ipAddress}`
  return checkRateLimit(key, limit, 60000)
}

// enforceApiDefinitionRateLimit was removed on 2026-07-21. It had zero callers
// for its entire life. Rate limiting is enforced per API KEY
// (enforceRateLimitByKeyId in server/lib/auth.ts) on both /api/v1 and /api/v2 —
// there is no per-ApiDefinition enforcement point, and under PostgREST there
// cannot be one, because the API is the schema and no per-endpoint record sits
// in the request path. Keeping the function alive made a whole detector look
// legitimate: see the note on the deleted detectMissingRateLimits.

/**
 * Get Rate Limit Headers
 * 
 * Standard headers for rate limit info
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.floor(result.resetAt / 1000)),
  }

  if (result.retryAfter) {
    headers['Retry-After'] = String(result.retryAfter)
  }

  return headers
}

/**
 * Clean up expired entries
 * 
 * NOTE: With database-backed rate limiting, no manual cleanup needed.
 * Time-windowed queries automatically exclude expired entries.
 * This function is kept for API compatibility but is now a no-op.
 */
export function cleanupRateLimitStore() {
  // No-op: Database-backed rate limiting uses time-windowed queries
  // No in-memory store to clean up
}

// Auto-cleanup every 5 minutes (kept for compatibility, but now no-op)
setInterval(cleanupRateLimitStore, 5 * 60 * 1000)

/**
 * Redis-based Rate Limiter (for production multi-server setup)
 * 
 * Uncomment and configure when scaling to multiple servers
 */
/*
import { Redis } from 'ioredis'

const redis = new Redis(process.env.REDIS_URL!)

export async function checkRateLimitRedis(
  key: string,
  limit: number,
  windowMs: number = 60000
): Promise<RateLimitResult> {
  const now = Date.now()
  const windowKey = `ratelimit:${key}:${Math.floor(now / windowMs)}`
  
  const count = await redis.incr(windowKey)
  
  if (count === 1) {
    await redis.expire(windowKey, Math.ceil(windowMs / 1000))
  }
  
  const ttl = await redis.ttl(windowKey)
  const resetAt = now + (ttl * 1000)
  
  if (count > limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt,
      retryAfter: ttl,
    }
  }
  
  return {
    allowed: true,
    limit,
    remaining: limit - count,
    resetAt,
  }
}
*/
