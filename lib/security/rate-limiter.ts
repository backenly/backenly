/**
 * 🔒 RATE LIMITING & ABUSE PROTECTION
 * 
 * Enterprise-grade rate limiting for:
 * - AI endpoints
 * - API keys
 * - Per-project quotas
 * - Per-user limits
 */

import { prisma } from '@/lib/db/postgres'
import { SecurityAudit } from './audit-logger'

interface RateLimitConfig {
  maxRequests: number
  windowMs: number
  identifier: string
  type: 'user' | 'project' | 'apiKey' | 'ip'
}

interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: Date
  total: number
}

// In-memory rate limit store (use Redis in production)
const rateLimitStore = new Map<string, { count: number; resetAt: number }>()

/**
 * Check if request is within rate limit
 */
export async function checkRateLimit(
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const key = `${config.type}:${config.identifier}`
  const now = Date.now()
  
  // Get or create rate limit entry
  let entry = rateLimitStore.get(key)
  
  if (!entry || entry.resetAt < now) {
    // Create new window
    entry = {
      count: 0,
      resetAt: now + config.windowMs,
    }
    rateLimitStore.set(key, entry)
  }

  // Increment count
  entry.count++

  const allowed = entry.count <= config.maxRequests
  const remaining = Math.max(0, config.maxRequests - entry.count)
  const resetAt = new Date(entry.resetAt)

  return {
    allowed,
    remaining,
    resetAt,
    total: config.maxRequests,
  }
}

/**
 * Rate limit configurations
 */
export const RateLimits = {
  /**
   * AI Chat endpoint
   * 50 requests per hour per user
   */
  aiChat: async (userId: string): Promise<RateLimitResult> => {
    return checkRateLimit({
      maxRequests: 50,
      windowMs: 60 * 60 * 1000, // 1 hour
      identifier: userId,
      type: 'user',
    })
  },

  /**
   * AI Execution (more strict)
   * 20 executions per hour per project
   */
  aiExecution: async (projectId: string): Promise<RateLimitResult> => {
    return checkRateLimit({
      maxRequests: 20,
      windowMs: 60 * 60 * 1000, // 1 hour
      identifier: projectId,
      type: 'project',
    })
  },

  /**
   * API Key usage
   * 1000 requests per hour per key
   */
  apiKey: async (apiKey: string): Promise<RateLimitResult> => {
    return checkRateLimit({
      maxRequests: 1000,
      windowMs: 60 * 60 * 1000, // 1 hour
      identifier: apiKey,
      type: 'apiKey',
    })
  },

  /**
   * Database operations
   * 500 per hour per project
   */
  databaseOps: async (projectId: string): Promise<RateLimitResult> => {
    return checkRateLimit({
      maxRequests: 500,
      windowMs: 60 * 60 * 1000, // 1 hour
      identifier: projectId,
      type: 'project',
    })
  },

  /**
   * Login attempts
   * 5 failed attempts per 15 minutes per IP
   */
  loginAttempts: async (ipAddress: string): Promise<RateLimitResult> => {
    return checkRateLimit({
      maxRequests: 5,
      windowMs: 15 * 60 * 1000, // 15 minutes
      identifier: ipAddress,
      type: 'ip',
    })
  },

  /**
   * Generic API rate limit
   * 100 requests per minute per user
   */
  api: async (userId: string): Promise<RateLimitResult> => {
    return checkRateLimit({
      maxRequests: 100,
      windowMs: 60 * 1000, // 1 minute
      identifier: userId,
      type: 'user',
    })
  },
}

/**
 * Middleware helper: Check and enforce rate limit
 */
export async function enforceRateLimit(
  limiter: () => Promise<RateLimitResult>,
  userId?: string,
  projectId?: string
): Promise<{ allowed: boolean; result: RateLimitResult }> {
  const result = await limiter()

  if (!result.allowed) {
    // Log rate limit exceeded
    await SecurityAudit.rateLimitExceeded(
      userId || 'unknown',
      projectId || 'none',
      'rate-limited-endpoint',
      result.total
    )
  }

  return { allowed: result.allowed, result }
}

/**
 * Get rate limit headers for HTTP responses
 */
export function getRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': result.total.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': result.resetAt.toISOString(),
  }
}

/**
 * Clean up expired rate limit entries (run periodically)
 */
export function cleanupRateLimits() {
  const now = Date.now()
  let cleaned = 0

  const keysToDelete: string[] = []
  rateLimitStore.forEach((entry, key) => {
    if (entry.resetAt < now) {
      keysToDelete.push(key)
    }
  })

  keysToDelete.forEach(key => {
    rateLimitStore.delete(key)
    cleaned++
  })

  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} expired rate limit entries`)
  }
}

// Auto-cleanup every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(cleanupRateLimits, 5 * 60 * 1000)
}

/**
 * Usage tracking for quotas
 */
export class UsageTracker {
  /**
   * Track AI usage for project
   */
  static async trackAIUsage(projectId: string, totalTokens: number, cost: number, model: string = 'gpt-4o-mini') {
    await prisma.aiUsage.create({
      data: {
        projectId,
        model,
        totalTokens,
        promptTokens: 0,
        completionTokens: 0,
        cost,
        createdAt: new Date(),
      },
    })
  }

  /**
   * Get AI usage for current billing period
   */
  static async getAIUsage(projectId: string, days: number = 30) {
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days)

    const usage = await prisma.aiUsage.aggregate({
      where: {
        projectId,
        createdAt: {
          gte: startDate,
        },
      },
      _sum: {
        totalTokens: true,
        cost: true,
      },
      _count: {
        _all: true,
      },
    })

    return {
      totalTokens: usage._sum.totalTokens || 0,
      totalCost: usage._sum.cost || 0,
      totalRequests: usage._count._all,
      period: `${days} days`,
    }
  }

  /**
   * Check if project is within quota
   */
  static async checkQuota(
    projectId: string,
    limits: { maxTokens: number; maxCost: number }
  ): Promise<{ withinQuota: boolean; usage: any }> {
    const usage = await this.getAIUsage(projectId, 30)

    const withinQuota =
      usage.totalTokens <= limits.maxTokens &&
      usage.totalCost <= limits.maxCost

    return { withinQuota, usage }
  }
}
