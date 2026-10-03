/**
 * Hard Quota Enforcement
 * 
 * PHILOSOPHY: BLOCK, DON'T TRACK
 * 
 * Backenly is a system that says "no" more than it says "yes."
 * 
 * PRINCIPLES:
 * - Execution blocked if credits exceeded (no grace period)
 * - Paddle is source of truth (not self-reported usage)
 * - Idempotent webhook handling (replay-safe)
 * - No reliance on self-reported metrics
 * - No billing UI (invisible enforcement)
 * - No quota dashboards (just block)
 * 
 * SUCCESS: No revenue leakage
 * 
 * NOTE: Can be disabled for development with DISABLE_QUOTA_ENFORCEMENT=true
 *       (Useful in regions where Paddle setup is delayed)
 */

import { prisma } from '@/lib/db'

// ⚠️ ROGUE ENGINE — PERMANENTLY DISABLED.
//
// This module used a free/pro/enterprise Paddle taxonomy with hardcoded
// numbers (10k API/mo, 1 GB, 10k rows…) that did NOT match the displayed
// Plan (SANDBOX/BUILDER/SCALE). It is superseded by the single Plan-driven
// kernel: `lib/quota/kernel.ts` (API + MAU + realtime + DB storage)
// plus `lib/services/storageQuota.ts` (Plan-driven file storage). Every
// check below now short-circuits to "allowed" so this engine can never
// apply a contradictory limit again. Exports are kept so existing importers
// (serverlessApiExecutor, s3Storage) keep compiling — they are now no-ops.
const QUOTA_ENFORCEMENT_DISABLED = true

/**
 * Quota limits by tier
 * Hard limits enforced at execution time
 */
export const QUOTA_LIMITS = {
  free: {
    apiCallsPerMonth: 10000,
    storageGB: 1,
    databaseRows: 10000,
    deploymentsPerMonth: 10,
  },
  pro: {
    apiCallsPerMonth: 1000000,
    storageGB: 100,
    databaseRows: 1000000,
    deploymentsPerMonth: 1000,
  },
  enterprise: {
    apiCallsPerMonth: Infinity,
    storageGB: Infinity,
    databaseRows: Infinity,
    deploymentsPerMonth: Infinity,
  },
} as const

export type SubscriptionTier = keyof typeof QUOTA_LIMITS

/**
 * Quota enforcement result
 */
interface QuotaCheckResult {
  allowed: boolean
  reason?: string
  currentUsage?: number
  limit?: number
  tier?: SubscriptionTier
}

/**
 * Get user's subscription tier from Paddle (source of truth)
 */
async function getUserSubscriptionTier(userId: string): Promise<SubscriptionTier> {
  // Query Paddle subscription status
  const subscription = await prisma.paddleSubscription.findFirst({
    where: {
      userId,
      status: 'active', // Only active subscriptions count
    },
    orderBy: {
      createdAt: 'desc',
    },
  })

  if (!subscription) {
    return 'free' // Default to free tier
  }

  // Map Paddle plan ID to tier
  const planIdToTier: Record<string, SubscriptionTier> = {
    [process.env.PADDLE_PLAN_ID_PRO || '']: 'pro',
    [process.env.PADDLE_PLAN_ID_ENTERPRISE || '']: 'enterprise',
  }

  return planIdToTier[subscription.paddlePlanId] || 'free'
}

/**
 * Check API call quota
 * Blocks execution if limit exceeded
 */
export async function checkApiCallQuota(
  projectId: string
): Promise<QuotaCheckResult> {
  // DEVELOPMENT MODE: Bypass quota checks
  if (QUOTA_ENFORCEMENT_DISABLED) {
    return { allowed: true, tier: 'free' }
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })

  if (!project) {
    return {
      allowed: false,
      reason: 'Project not found',
    }
  }

  // Get tier from Stripe (source of truth)
  const tier = await getUserSubscriptionTier(project.userId)
  const limit = QUOTA_LIMITS[tier].apiCallsPerMonth

  // Infinite quota for enterprise
  if (limit === Infinity) {
    return { allowed: true, tier }
  }

  // Count actual API calls this month (from audit log)
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const currentUsage = await prisma.apiRequestLog.count({
    where: {
      projectId,
      timestamp: {
        gte: startOfMonth,
      },
    },
  })

  // Hard block if exceeded
  if (currentUsage >= limit) {
    return {
      allowed: false,
      reason: 'API call quota exceeded',
      currentUsage,
      limit,
      tier,
    }
  }

  return {
    allowed: true,
    currentUsage,
    limit,
    tier,
  }
}

/**
 * Check storage quota
 * Blocks upload if limit exceeded
 */
export async function checkStorageQuota(
  projectId: string,
  additionalBytes: number = 0
): Promise<QuotaCheckResult> {
  // DEVELOPMENT MODE: Bypass quota checks
  if (QUOTA_ENFORCEMENT_DISABLED) {
    return { allowed: true, tier: 'free' }
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })

  if (!project) {
    return {
      allowed: false,
      reason: 'Project not found',
    }
  }

  // Get tier from Stripe (source of truth)
  const tier = await getUserSubscriptionTier(project.userId)
  const limitGB = QUOTA_LIMITS[tier].storageGB

  // Infinite quota for enterprise
  if (limitGB === Infinity) {
    return { allowed: true, tier }
  }

  const limitBytes = limitGB * 1024 * 1024 * 1024

  // Count actual storage usage (from StorageFile table)
  const storageFiles = await prisma.storageFile.aggregate({
    where: {
      projectId,
      deletedAt: null, // Only count active files
    },
    _sum: {
      size: true,
    },
  })

  const currentUsageBytes = Number(storageFiles._sum.size || 0)
  const projectedUsage = currentUsageBytes + additionalBytes

  // Hard block if exceeded
  if (projectedUsage > limitBytes) {
    return {
      allowed: false,
      reason: 'Storage quota exceeded',
      currentUsage: Math.round(currentUsageBytes / 1024 / 1024), // MB
      limit: limitGB * 1024, // MB
      tier,
    }
  }

  return {
    allowed: true,
    currentUsage: Math.round(currentUsageBytes / 1024 / 1024),
    limit: limitGB * 1024,
    tier,
  }
}

/**
 * Check database row quota
 * Blocks insert if limit exceeded
 */
export async function checkDatabaseRowQuota(
  projectId: string,
  tableName: string,
  additionalRows: number = 1
): Promise<QuotaCheckResult> {
  // DEVELOPMENT MODE: Bypass quota checks
  if (QUOTA_ENFORCEMENT_DISABLED) {
    return { allowed: true, tier: 'free' }
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })

  if (!project) {
    return {
      allowed: false,
      reason: 'Project not found',
    }
  }

  // Get tier from Stripe (source of truth)
  const tier = await getUserSubscriptionTier(project.userId)
  const limit = QUOTA_LIMITS[tier].databaseRows

  // Infinite quota for enterprise
  if (limit === Infinity) {
    return { allowed: true, tier }
  }

  // Count actual rows in project workspace
  const tables = await prisma.table.findMany({
    where: { projectId },
    select: { name: true, schema: true },
  })

  let totalRows = 0
  for (const table of tables) {
    const schema = table.schema || 'public'
    try {
      const result = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT COUNT(*) as count FROM "${schema}"."${table.name}"`
      )
      totalRows += Number(result[0]?.count || 0)
    } catch (error) {
      // Table might not exist yet, skip
      console.warn(`Could not count rows for table ${schema}.${table.name}`)
    }
  }

  const projectedRows = totalRows + additionalRows

  // Hard block if exceeded
  if (projectedRows > limit) {
    return {
      allowed: false,
      reason: 'Database row quota exceeded',
      currentUsage: totalRows,
      limit,
      tier,
    }
  }

  return {
    allowed: true,
    currentUsage: totalRows,
    limit,
    tier,
  }
}

/**
 * Check deployment quota
 * Blocks deployment if limit exceeded
 */
export async function checkDeploymentQuota(
  projectId: string
): Promise<QuotaCheckResult> {
  // DEVELOPMENT MODE: Bypass quota checks
  if (QUOTA_ENFORCEMENT_DISABLED) {
    return { allowed: true, tier: 'free' }
  }
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })

  if (!project) {
    return {
      allowed: false,
      reason: 'Project not found',
    }
  }

  // Get tier from Stripe (source of truth)
  const tier = await getUserSubscriptionTier(project.userId)
  const limit = QUOTA_LIMITS[tier].deploymentsPerMonth

  // Infinite quota for enterprise
  if (limit === Infinity) {
    return { allowed: true, tier }
  }

  // Count actual deployments this month
  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  const currentUsage = await prisma.deployment.count({
    where: {
      projectId,
      createdAt: {
        gte: startOfMonth,
      },
    },
  })

  // Hard block if exceeded
  if (currentUsage >= limit) {
    return {
      allowed: false,
      reason: 'Deployment quota exceeded',
      currentUsage,
      limit,
      tier,
    }
  }

  return {
    allowed: true,
    currentUsage,
    limit,
    tier,
  }
}

/**
 * Quota exceeded error
 */
export class QuotaExceededError extends Error {
  code = 'QUOTA_EXCEEDED'
  statusCode = 429 // Too Many Requests
  quotaType: string
  currentUsage?: number
  limit?: number
  tier?: SubscriptionTier

  constructor(
    quotaType: string,
    currentUsage?: number,
    limit?: number,
    tier?: SubscriptionTier
  ) {
    super(`${quotaType} quota exceeded`)
    this.name = 'QuotaExceededError'
    this.quotaType = quotaType
    this.currentUsage = currentUsage
    this.limit = limit
    this.tier = tier
  }

  toJSON() {
    return {
      error: this.message,
      code: this.code,
      quotaType: this.quotaType,
      currentUsage: this.currentUsage,
      limit: this.limit,
      tier: this.tier,
      hint: 'Upgrade your subscription to increase quota limits',
      upgradeUrl: '/pricing',
    }
  }
}

/**
 * Enforce API call quota
 * Throws if exceeded (blocks execution)
 */
export async function enforceApiCallQuota(projectId: string): Promise<void> {
  const result = await checkApiCallQuota(projectId)

  if (!result.allowed) {
    throw new QuotaExceededError(
      'API call',
      result.currentUsage,
      result.limit,
      result.tier
    )
  }
}

/**
 * Enforce storage quota
 * Throws if exceeded (blocks upload)
 */
export async function enforceStorageQuota(
  projectId: string,
  additionalBytes: number = 0
): Promise<void> {
  const result = await checkStorageQuota(projectId, additionalBytes)

  if (!result.allowed) {
    throw new QuotaExceededError(
      'Storage',
      result.currentUsage,
      result.limit,
      result.tier
    )
  }
}

/**
 * Enforce database row quota
 * Throws if exceeded (blocks insert)
 */
export async function enforceDatabaseRowQuota(
  projectId: string,
  tableName: string,
  additionalRows: number = 1
): Promise<void> {
  const result = await checkDatabaseRowQuota(projectId, tableName, additionalRows)

  if (!result.allowed) {
    throw new QuotaExceededError(
      'Database row',
      result.currentUsage,
      result.limit,
      result.tier
    )
  }
}

/**
 * Enforce deployment quota
 * Throws if exceeded (blocks deployment)
 */
export async function enforceDeploymentQuota(projectId: string): Promise<void> {
  const result = await checkDeploymentQuota(projectId)

  if (!result.allowed) {
    throw new QuotaExceededError(
      'Deployment',
      result.currentUsage,
      result.limit,
      result.tier
    )
  }
}
