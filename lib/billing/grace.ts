/**
 * Grace Period & Downgrade Logic
 * 
 * Handles subscription expiration, grace periods, and account freezing.
 */

import { prisma } from '@/lib/db/prisma'

// ============================================================================
// TYPES
// ============================================================================

export interface GraceCheckResult {
  frozen: boolean
  reason?: 'GRACE_EXPIRED' | 'OVER_LIMIT'
  graceEndsAt?: Date
  message?: string
}

// ============================================================================
// GRACE PERIOD MANAGEMENT
// ============================================================================

/**
 * Set subscription to GRACE status
 * Called when subscription is canceled or expires
 */
export async function initiateGracePeriod(userId: string): Promise<void> {
  const graceUntil = new Date()
  graceUntil.setDate(graceUntil.getDate() + 7) // 7 days grace

  await prisma.subscription.updateMany({
    where: {
      userId,
      status: { in: ['ACTIVE', 'PAST_DUE'] }
    },
    data: {
      status: 'GRACE',
      graceUntil
    }
  })

  // Log the event
  await logDowngradeEvent(userId, 'GRACE_INITIATED', {
    graceUntil: graceUntil.toISOString(),
    reason: 'Subscription canceled or expired'
  })
}

/**
 * Process expired grace periods
 * Called by daily cron job
 * Returns number of accounts processed
 */
export async function processExpiredGracePeriods(): Promise<number> {
  const now = new Date()

  // Find subscriptions where grace has expired
  const expiredGraces = await prisma.subscription.findMany({
    where: {
      status: 'GRACE',
      graceUntil: { lt: now }
    },
    include: { plan: true }
  })

  let processed = 0

  for (const subscription of expiredGraces) {
    try {
      // Get FREE plan
      const freePlan = await prisma.plan.findUnique({
        where: { name: 'FREE' }
      })

      if (!freePlan) {
        console.error('[Grace] FREE plan not found')
        continue
      }

      // Revert to FREE plan
      await prisma.subscription.update({
        where: { id: subscription.id },
        data: {
          planId: freePlan.id,
          status: 'FREE',
          graceUntil: null,
          currentPeriodEnd: null
        }
      })

      // Log downgrade
      await logDowngradeEvent(subscription.userId, 'DOWNGRADED_TO_FREE', {
        previousPlan: subscription.plan.name,
        previousStatus: subscription.status,
        graceExpiredAt: now.toISOString()
      })

      processed++
    } catch (error) {
      console.error(`[Grace] Failed to process grace for user ${subscription.userId}:`, error)
    }
  }

  return processed
}

// ============================================================================
// ACCOUNT FREEZE CHECK
// ============================================================================

/**
 * Check if user account is frozen
 * Returns freeze status and reason
 */
export async function isAccountFrozen(userId: string): Promise<GraceCheckResult> {
  const subscription = await prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: ['ACTIVE', 'FREE', 'GRACE', 'PAST_DUE'] }
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' }
  })

  if (!subscription) {
    return {
      frozen: true,
      reason: 'OVER_LIMIT',
      message: 'No active subscription'
    }
  }

  // Check if in grace period
  if (subscription.status === 'GRACE') {
    if (subscription.graceUntil && subscription.graceUntil < new Date()) {
      // Grace expired - account should be frozen
      return {
        frozen: true,
        reason: 'GRACE_EXPIRED',
        graceEndsAt: subscription.graceUntil,
        message: 'Grace period expired. Please renew your subscription.'
      }
    }
    // Still in grace period - not frozen
    return {
      frozen: false,
      graceEndsAt: subscription.graceUntil || undefined
    }
  }

  // FREE tier: Check if over limits
  if (subscription.status === 'FREE') {
    const overLimit = await checkFreeTierLimits(userId)
    if (overLimit) {
      return {
        frozen: true,
        reason: 'OVER_LIMIT',
        message: 'FREE tier limits exceeded. Upgrade to continue.'
      }
    }
  }

  return { frozen: false }
}

/**
 * Check if FREE tier user is over limits
 */
async function checkFreeTierLimits(userId: string): Promise<boolean> {
  const freePlan = await prisma.plan.findUnique({
    where: { name: 'FREE' }
  })

  if (!freePlan) return false

  // Count projects
  const projectCount = await prisma.project.count({
    where: { userId }
  })

  if (projectCount > freePlan.maxProjects) {
    return true
  }

  // Check rows per project (skip for now - will be checked at insert time)
  // TODO: Implement row count check after Prisma client regeneration

  return false
}

// ============================================================================
// INSERT FREEZE ENFORCEMENT
// ============================================================================

/**
 * Enforce freeze on insert operations
 * Call this before any insert operation
 * Can accept either userId or projectId
 */
export async function enforceInsertFreeze(
  userIdOrProjectId: string
): Promise<true | { frozen: true; message: string }> {
  // Try to get userId from project if projectId is passed
  let userId = userIdOrProjectId
  
  // Check if it looks like a project ID (UUID format)
  if (userIdOrProjectId.includes('-')) {
    const project = await prisma.project.findUnique({
      where: { id: userIdOrProjectId },
      select: { userId: true }
    })
    if (project?.userId) {
      userId = project.userId
    }
  }
  
  const freezeCheck = await isAccountFrozen(userId)
  
  if (freezeCheck.frozen) {
    return {
      frozen: true,
      message: freezeCheck.message || 'Account frozen. Please upgrade your plan.'
    }
  }

  return true
}

// ============================================================================
// AUDIT LOGGING
// ============================================================================

/**
 * Log downgrade events
 */
export async function logDowngradeEvent(
  userId: string,
  event: 'GRACE_INITIATED' | 'DOWNGRADED_TO_FREE' | 'FREEZE_TRIGGERED',
  metadata: Record<string, any>
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: event,
        type: 'BILLING_DOWNGRADE',
        userId,
        details: JSON.stringify(metadata),
        metadata: {
          event,
          timestamp: new Date().toISOString(),
          ...metadata
        }
      }
    })
  } catch (error) {
    console.error('[Grace] Failed to log downgrade event:', error)
  }
}

// ============================================================================
// CRON JOB HANDLER
// ============================================================================

/**
 * Daily cron job handler
 * Process expired grace periods
 */
export async function runDailyGraceCheck(): Promise<{ processed: number; errors: number }> {
  console.log('[Cron] Running daily grace period check...')
  
  try {
    const processed = await processExpiredGracePeriods()
    console.log(`[Cron] Processed ${processed} expired grace periods`)
    return { processed, errors: 0 }
  } catch (error) {
    console.error('[Cron] Grace check failed:', error)
    return { processed: 0, errors: 1 }
  }
}
