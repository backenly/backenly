/**
 * Per-user limits on the AI routes.
 *
 * Each allowed request is an ApiRequestLog row under the route's path, so every
 * instance counts the same requests. Every other surface counts with
 * lib/security/auth-rate-limit `consume()`.
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
