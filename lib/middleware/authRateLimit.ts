/**
 * Rate Limiting for Auth Endpoints
 * 
 * SECURITY: Prevent brute-force attacks on auth endpoints
 * Follows industry standard auth rate-limiting practice
 * 
 * NOTE: Uses database-backed storage for multi-instance safety
 */

import { prisma } from '@/lib/db/prisma'

/**
 * Rate limit configuration
 */
export const RATE_LIMITS = {
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 10, // 10 requests per window
  },
  authPerIP: {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 30, // 30 requests per hour per IP
  }
};

/**
 * Check if a request should be rate limited
 * Uses database-backed storage for horizontal scalability
 * 
 * @param key - Unique identifier (email, IP, etc.)
 * @param limit - Max requests allowed
 * @param windowMs - Time window in milliseconds
 * @returns { allowed: boolean, remaining: number, resetAt: number }
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number; retryAfter?: number }> {
  // Skip rate limiting in test/integration mode
  if (process.env.NODE_ENV === 'test' || process.env.ENGINE_MODE === 'integration') {
    return {
      allowed: true,
      remaining: limit,
      resetAt: Date.now() + windowMs,
    }
  }

  const now = Date.now();
  const windowStart = new Date(now - (now % windowMs));
  const resetAt = now + windowMs;
  
  try {
    // Use intentLog to track auth attempts (lightweight tracking)
    const attemptCount = await prisma.intentLog.count({
      where: {
        executionId: { startsWith: `auth:${key}:` },
        timestamp: { gte: windowStart },
      },
    });
    
    if (attemptCount >= limit) {
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfter: Math.ceil((resetAt - now) / 1000),
      };
    }
    
    return {
      allowed: true,
      remaining: limit - attemptCount - 1,
      resetAt,
    };
  } catch (error) {
    // Fail open on database error
    console.error('[Auth Rate Limit] Database error, failing open:', error);
    return {
      allowed: true,
      remaining: limit,
      resetAt,
    };
  }
}

/**
 * Clean up expired entries (call periodically)
 * 
 * NOTE: With database-backed rate limiting, no manual cleanup needed.
 * Time-windowed queries automatically exclude expired entries.
 * This function is kept for API compatibility but is now a no-op.
 */
export function cleanupRateLimits(): void {
  // No-op: Database-backed rate limiting uses time-windowed queries
  // No in-memory store to clean up
}

// Auto-cleanup every 5 minutes (kept for compatibility, but now no-op)
setInterval(cleanupRateLimits, 5 * 60 * 1000);

/**
 * Get rate limit key for email-based limiting
 */
export function getEmailRateLimitKey(email: string, endpoint: string): string {
  return `auth:${endpoint}:${email.toLowerCase()}`;
}

/**
 * Get rate limit key for IP-based limiting
 */
export function getIPRateLimitKey(ip: string, endpoint: string): string {
  return `auth:${endpoint}:ip:${ip}`;
}
