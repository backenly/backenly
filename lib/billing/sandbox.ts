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
import { canWriteProject } from '@/lib/edition/guard'

// ─── Status checks ────────────────────────────────────────────────────────────
//
// Moved to lib/projects/sandbox-lifecycle.ts. Reading a countdown off a
// column on Project is project-local work, not commercial machinery.

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
//
// Moved to lib/projects/sandbox-lifecycle.ts as promoteSandboxToProduction.
// The transition itself is project-local; deciding whether a plan permits it
// is enforceDeployment's job and the route already calls it.

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
