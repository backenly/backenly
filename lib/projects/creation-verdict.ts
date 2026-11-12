/**
 * Whether this caller may create a project here, answered the way creating one
 * answers it.
 *
 * POST /api/projects asks before it creates anything, and
 * GET /api/projects/can-create asks before the console opens the form, so a
 * refusal reads the same in both places. Production QA (2026-11-09): on Free,
 * "New project" opened the form, and the limit was said only after the name
 * and region were filled in.
 *
 * The order is the route's: who the project would belong to (the edition's
 * answer, which can refuse), then that account's plan limit.
 */

import { prisma } from '@/lib/db'
import { getProjectLifecycle } from '@/lib/edition'
import { initializeAccountEntitlements } from '@/lib/entitlements'
import { enforceProjectCreation } from '@/lib/entitlements/policy'
import { accountProjectsWhere } from '@/lib/usage/account'

export interface CreationRefusal {
  status: number
  error: string
  code?: string
  upgradeRequired?: boolean
  currentPlan?: string
  requiredPlan?: string
}

export type CreationVerdict =
  | { allowed: true; ownerId: string; organizationId: string | null }
  | ({ allowed: false } & CreationRefusal)

export async function projectCreationVerdict(
  userId: string,
  organizationId: string | null,
  /**
   * Creating gives a first-time account its entitlements before the limit is
   * read (initializeAccountEntitlements). A question about creating does not
   * write; it is asked with `initialize: false`, and the caller decides what
   * an account with no entitlements yet means.
   */
  opts: { initialize: boolean },
): Promise<CreationVerdict> {
  const account = await getProjectLifecycle().creationAccount(userId, organizationId)
  if (account.ok === false) {
    return { allowed: false, status: account.status, error: account.error, code: account.code }
  }

  // The plan the project counts against: inside an organization, the
  // organization's; elsewhere, the caller's.
  const billingAccount = account.organizationId ?? account.ownerId
  const existingCount = await prisma.project.count({ where: accountProjectsWhere(billingAccount) })
  if (opts.initialize) await initializeAccountEntitlements(userId)

  const limit = await enforceProjectCreation(billingAccount, existingCount)
  if (limit !== true) {
    return {
      allowed: false,
      status: 403,
      error: limit.message,
      code: limit.code,
      upgradeRequired: limit.upgradeRequired,
      currentPlan: limit.currentPlan,
      requiredPlan: limit.requiredPlan,
    }
  }
  return { allowed: true, ownerId: account.ownerId, organizationId: account.organizationId }
}
