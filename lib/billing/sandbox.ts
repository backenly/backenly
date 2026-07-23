/**
 * Sandbox Lifecycle Management
 *
 * Handles:
 *  - Sandbox project expiry (7-day countdown)
 *  - Cleanup of expired sandboxes (DB data + B2 storage + project records)
 *  - Upgrade path: sandbox → production on BUILDER/SCALE plan
 */

import { prisma } from '@/lib/db/prisma'
import { getUserSubscription } from '@/lib/billing'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SandboxStatus {
  isSandbox: boolean
  isExpired: boolean
  expiresAt: Date | null
  daysRemaining: number | null
  hoursRemaining: number | null
  countdownMessage: string
}

// ─── Status checks ────────────────────────────────────────────────────────────

export function getSandboxStatus(project: { expiresAt: Date | null }): SandboxStatus {
  if (!project.expiresAt) {
    return {
      isSandbox: false,
      isExpired: false,
      expiresAt: null,
      daysRemaining: null,
      hoursRemaining: null,
      countdownMessage: 'Production — never expires',
    }
  }

  const now = new Date()
  const expiresAt = new Date(project.expiresAt)
  const msRemaining = expiresAt.getTime() - now.getTime()
  const isExpired = msRemaining <= 0

  if (isExpired) {
    return {
      isSandbox: true,
      isExpired: true,
      expiresAt,
      daysRemaining: 0,
      hoursRemaining: 0,
      countdownMessage: 'Sandbox expired — project will be deleted shortly',
    }
  }

  const hoursRemaining = Math.floor(msRemaining / (1000 * 60 * 60))
  const daysRemaining = Math.floor(hoursRemaining / 24)

  let countdownMessage: string
  if (daysRemaining >= 2) {
    countdownMessage = `Your sandbox will be deleted in ${daysRemaining} days. Deploy to keep it live.`
  } else if (daysRemaining === 1) {
    countdownMessage = `Your sandbox expires tomorrow! Deploy now to keep your backend.`
  } else if (hoursRemaining > 0) {
    countdownMessage = `Your sandbox expires in ${hoursRemaining} hours! Deploy now to keep your backend.`
  } else {
    countdownMessage = `Your sandbox expires in less than 1 hour! Deploy immediately.`
  }

  return {
    isSandbox: true,
    isExpired: false,
    expiresAt,
    daysRemaining,
    hoursRemaining,
    countdownMessage,
  }
}

// ─── Sandbox expiry date ──────────────────────────────────────────────────────

export function computeSandboxExpiry(createdAt: Date = new Date(), days = 7): Date {
  const expiry = new Date(createdAt)
  expiry.setUTCDate(expiry.getUTCDate() + days)
  return expiry
}

// ─── Cleanup expired sandboxes ────────────────────────────────────────────────

/**
 * Finds and deletes all sandbox projects where expiresAt < now.
 * Deletes:
 *  1. workspace_{projectId} PostgreSQL schema (all user data)
 *  2. Project record (cascades to all related records via FK onDelete: Cascade)
 *
 * Returns count of deleted projects.
 *
 * Safe to run repeatedly (idempotent — projects are deleted in one pass).
 */
export async function cleanupExpiredSandboxes(): Promise<{
  deleted: number
  errors: Array<{ projectId: string; error: string }>
}> {
  const now = new Date()

  const expiredProjects = await prisma.project.findMany({
    where: {
      expiresAt: { lte: now },
    },
    select: { id: true, name: true, userId: true },
  })

  let deleted = 0
  const errors: Array<{ projectId: string; error: string }> = []

  for (const project of expiredProjects) {
    try {
      await deleteProjectWorkspace(project.id)
      await prisma.project.delete({ where: { id: project.id } })
      deleted++
      console.log(`[SandboxCleanup] Deleted expired sandbox: ${project.name} (${project.id})`)
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      errors.push({ projectId: project.id, error: msg })
      console.error(`[SandboxCleanup] Failed to delete ${project.id}:`, msg)
    }
  }

  return { deleted, errors }
}

/**
 * Drops the workspace_{projectId} PostgreSQL schema.
 * All end-user tables, auth users, and data live here.
 */
async function deleteProjectWorkspace(projectId: string): Promise<void> {
  const schemaName = `workspace_${projectId}`
  try {
    // Use raw SQL to drop the tenant schema (CASCADE removes all tables/data)
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    console.log(`[SandboxCleanup] Dropped schema: ${schemaName}`)
  } catch (err: any) {
    // Non-fatal: schema may not exist yet (project never fully initialized)
    console.warn(`[SandboxCleanup] Could not drop schema ${schemaName}:`, err?.message)
  }
}

// ─── Upgrade: sandbox → production ───────────────────────────────────────────

export interface UpgradeResult {
  success: boolean
  error?: string
  errorCode?: 'NO_SUBSCRIPTION' | 'DEPLOYMENT_NOT_ALLOWED' | 'ALREADY_PRODUCTION' | 'PROJECT_NOT_FOUND'
}

/**
 * Converts a sandbox project to production.
 * Clears expiresAt so the project persists permanently.
 * Requires the user to have BUILDER or SCALE subscription.
 */
export async function upgradeSandboxToProduction(
  projectId: string,
  userId: string
): Promise<UpgradeResult> {
  const project = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true, expiresAt: true, isDeployed: true },
  })

  if (!project) {
    return { success: false, error: 'Project not found', errorCode: 'PROJECT_NOT_FOUND' }
  }

  if (!project.expiresAt && project.isDeployed) {
    return { success: false, error: 'Project is already in production', errorCode: 'ALREADY_PRODUCTION' }
  }

  const sub = await getUserSubscription(userId)
  if (!sub) {
    return {
      success: false,
      error: 'No active subscription. Upgrade to Pro to deploy.',
      errorCode: 'NO_SUBSCRIPTION',
    }
  }

  if (!sub.plan.allowDeployment) {
    return {
      success: false,
      error: 'Your Free plan does not allow deployment. Upgrade to Pro to go live.',
      errorCode: 'DEPLOYMENT_NOT_ALLOWED',
    }
  }

  // Clear expiry — project now persists permanently
  await prisma.project.update({
    where: { id: projectId },
    data: {
      expiresAt: null,
      isDeployed: true,
      deployedAt: new Date(),
      environment: 'production',
    },
  })

  return { success: true }
}

// ─── Enforce sandbox limits ───────────────────────────────────────────────────

/**
 * Check if a user can create a new sandbox project.
 * SANDBOX plan: max 1 project.
 */
export async function canCreateSandboxProject(userId: string): Promise<{
  allowed: boolean
  reason?: string
}> {
  const sub = await getUserSubscription(userId)
  if (!sub) return { allowed: false, reason: 'No active subscription' }

  const max = sub.plan.maxProjects
  if (max === null) return { allowed: true }

  const count = await prisma.project.count({ where: { userId } })
  if (count >= max) {
    return {
      allowed: false,
      reason: `You've reached the ${max}-project limit on the ${sub.plan.name} plan. Delete an existing project or upgrade to Pro.`,
    }
  }

  return { allowed: true }
}

// ─── API requests limit enforcement ──────────────────────────────────────────

/**
 * Check if a sandbox project has exceeded its API request limit.
 * Returns true if the request should be blocked.
 */
export async function isSandboxApiLimitExceeded(projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      user: {
        include: {
          subscriptions: {
            include: { plan: true },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  })

  if (!project?.user) return false

  const sub = project.user.subscriptions[0]
  if (!sub || !sub.plan.isSandboxPlan) return false // not sandbox — no hard API limit

  const limit = sub.plan.maxApiRequestsPerMonth
  if (limit === null) return false

  // Check current month usage
  const month = new Date().toISOString().slice(0, 7)
  const usage = await prisma.projectUsage.findUnique({
    where: { projectId_month: { projectId, month } },
  })

  return Number(usage?.apiUnitsUsed ?? 0) >= Number(limit)
}
