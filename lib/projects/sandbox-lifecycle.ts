/**
 * Sandbox project lifecycle: the countdown, and the transition out of it.
 *
 * A sandbox project is one with an `expiresAt`. That is a plain column on
 * Project, and reading it or clearing it is project-local work, so it belongs
 * to the public product regardless of the fact that this code used to live
 * under lib/billing. What DECIDES whether someone may leave the sandbox is a
 * commercial question, and that stays on the other side of the entitlements
 * seam.
 *
 * Deleting expired sandboxes is not here either. Finding every expired trial
 * project and destroying it is Backenly's trial machinery, and it stays with
 * the commercial code.
 *
 * In single-tenant `expiresAt` is never set, so a self-hosted project reports
 * as production and the transition below is a no-op it never needs.
 */
import { prisma } from '@/lib/db/prisma'
import { canWriteProject } from '@/lib/edition/guard'

export interface SandboxStatus {
  isSandbox: boolean
  isExpired: boolean
  expiresAt: Date | null
  daysRemaining: number | null
  hoursRemaining: number | null
  countdownMessage: string
}

/**
 * Describe where a project sits in its sandbox countdown.
 *
 * Pure: it reads one column off the object it is handed and touches nothing
 * else. No plan, no subscription, no database.
 */
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

export interface PromotionResult {
  success: boolean
  error?: string
  errorCode?: 'ALREADY_PRODUCTION' | 'PROJECT_NOT_FOUND'
}

/**
 * Promote an already-authorized project out of the sandbox.
 *
 * ── The caller enforces, this performs ──────────────────────────────────────
 *
 * AUTHORIZATION AND ENTITLEMENT ARE THE CALLER'S JOB. This function performs a
 * transition that has already been decided; it does not re-decide it. Callers
 * must have established, in order:
 *
 *   1. that the plan permits deployment (enforceDeployment)
 *
 * Write authorization is NOT delegated. It is re-checked below, because a
 * library that performs a privileged action should not depend on every future
 * caller remembering to ask. That check is about who may touch the project,
 * which is a question this module can answer; what a plan permits is not.
 *
 * app/api/project/deploy is the only caller and does that immediately before
 * calling this. __tests__/edition/sandbox-lifecycle.test.ts pins that ordering
 * and fails if another ungated caller appears.
 *
 * ── Why the commercial check was removed ────────────────────────────────────
 *
 * This used to call getUserSubscription itself and refuse with NO_SUBSCRIPTION.
 * That was a duplicate of the enforceDeployment call twelve lines above it in
 * the route, and on a self-hosted install it was the second reason deploying
 * failed: there is no Subscription row, so the check refused with "No active
 * subscription. Upgrade to Pro to deploy." even after the entitlements seam had
 * already allowed it. A project-local primitive re-deriving commercial policy
 * is what produced that, so it does not.
 */
export async function promoteSandboxToProduction(
  projectId: string,
  userId: string,
): Promise<PromotionResult> {
  if (!(await canWriteProject(userId, projectId))) {
    return { success: false, error: 'Project not found', errorCode: 'PROJECT_NOT_FOUND' }
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, expiresAt: true, isDeployed: true },
  })

  if (!project) {
    return { success: false, error: 'Project not found', errorCode: 'PROJECT_NOT_FOUND' }
  }

  if (!project.expiresAt && project.isDeployed) {
    return { success: false, error: 'Project is already in production', errorCode: 'ALREADY_PRODUCTION' }
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
