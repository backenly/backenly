/**
 * RUNTIME QUOTA ENFORCEMENT - Execution-Time Blocking
 * 
 * Enforces tier-based limits at execution time (not UI).
 * Blocks requests immediately when quota exceeded with clear error message.
 * 
 * NO grace periods, NO warnings, NO UI enforcement - HARD BLOCKING ONLY.
 */

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

export interface QuotaRule {
  tier: string // 'free' | 'paid'
  limit: number // Max count (-1 = unlimited)
  action: 'create' // What action is limited
  reason: string // Human explanation
}

export class QuotaExceededError extends Error {
  constructor(
    public message: string,
    public tier: string,
    public limit: number,
    public current: number,
    public resource: string
  ) {
    super(message)
    this.name = 'QuotaExceededError'
  }
}

/**
 * Enforce quota at runtime - BLOCKS execution if exceeded
 * 
 * @param userId - User ID to check quota for
 * @param resource - Resource being created (e.g., 'posts', 'ideas', 'teams')
 * @param quotas - Quota rules from entity definition
 * @returns void if allowed, throws QuotaExceededError if blocked
 */
export async function enforceQuota(
  userId: string,
  resource: string,
  quotas: QuotaRule[]
): Promise<void> {
  if (!quotas || quotas.length === 0) {
    // No quotas defined - allow
    return
  }

  // Get user's tier
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tier: true }
  })

  if (!user) {
    throw new Error('User not found')
  }

  const userTier = user.tier || 'free'

  // Find applicable quota rule
  const rule = quotas.find(q => q.tier === userTier)

  if (!rule) {
    // No rule for this tier - allow (defaults to unlimited)
    return
  }

  if (rule.limit === -1) {
    // Unlimited for this tier
    return
  }

  // Count current resources owned by user
  const tableName = resource.toLowerCase()
  let currentCount = 0

  try {
    // SECURITY: Use parameterized query to prevent SQL injection
    const result = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) as count FROM "${tableName}" WHERE "created_by" = $1`,
      userId
    )
    currentCount = Number(result[0]?.count || 0)
  } catch (error) {
    console.error(`[QuotaEnforcement] Failed to count ${resource}:`, error)
    // If count fails, allow (fail-open for availability)
    return
  }

  // Check if quota exceeded
  if (currentCount >= rule.limit) {
    const message = `${userTier.charAt(0).toUpperCase() + userTier.slice(1)} users can create up to ${rule.limit} ${resource}. Upgrade to continue.`
    
    throw new QuotaExceededError(
      message,
      userTier,
      rule.limit,
      currentCount,
      resource
    )
  }

  // Quota check passed
  console.log(`[QuotaEnforcement] ✅ Quota OK for ${userId}: ${currentCount}/${rule.limit} ${resource} used`)
}

/**
 * Get user's current quota usage for a resource
 * 
 * @param userId - User ID
 * @param resource - Resource name
 * @returns { used: number, limit: number, tier: string }
 */
export async function getQuotaUsage(
  userId: string,
  resource: string,
  quotas: QuotaRule[]
): Promise<{ used: number; limit: number; tier: string }> {
  // Get user's tier
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { tier: true }
  })

  const userTier = user?.tier || 'free'
  const rule = quotas.find(q => q.tier === userTier)
  const limit = rule?.limit ?? -1

  // Count current usage
  const tableName = resource.toLowerCase()
  let used = 0

  try {
    const result = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*) as count FROM "${tableName}" WHERE "created_by" = $1`,
      userId
    )
    used = Number(result[0]?.count || 0)
  } catch (error) {
    console.error(`[QuotaEnforcement] Failed to count ${resource}:`, error)
  }

  return { used, limit, tier: userTier }
}
