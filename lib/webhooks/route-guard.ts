/**
 * THE FOUR QUESTIONS, ASKED ONCE
 * ==============================
 *
 * The webhook collection route asked them four times, once per verb, with the
 * entitlement block copied out each time. Six routes were about to become ten
 * copies, and the authorization sweep's finding was that copies are where the
 * check quietly stops matching its neighbours.
 *
 * ── Order is deliberate ─────────────────────────────────────────────────────
 *
 * AUTHORIZATION runs first, ENTITLEMENT second, and they are never merged.
 *
 * The sweep found routes where a plan check stood in for a permission check,
 * and `allowDeploymentRollback` is not permission to touch a project. Asking
 * "may this caller act on this project" first means a stranger gets the same
 * 404 whether or not they have a Pro subscription — the plan tells them
 * nothing about whether the project exists.
 *
 * Reversed, a paying attacker would get a different answer from a non-paying
 * one, which is an existence oracle bought for $25.
 *
 * ── Why 404 and not 403 ─────────────────────────────────────────────────────
 *
 * Matches every other route under app/api/projects/[id]/**. A 403 confirms the
 * project exists. `canAccessProject` collapses "not yours" and "not there" on
 * purpose and this preserves it.
 */

import { NextResponse } from 'next/server'
import { canAccessProject, canWriteProject, canAdministerProject } from '@/lib/edition/guard'
import { enforceWebhook } from '@/lib/entitlements/policy'

/**
 * VIEWER reads. DEVELOPER creates and edits. ADMIN deletes.
 *
 * Deleting a webhook drops its delivery history with it and is not undoable
 * from the dashboard, which is the line `canAdministerProject` already draws
 * for custom domains and functions.
 */
export type WebhookAccess = 'read' | 'write' | 'admin'

const GUARD = {
  read: canAccessProject,
  write: canWriteProject,
  admin: canAdministerProject,
} as const satisfies Record<WebhookAccess, (u: string, p: string) => Promise<boolean>>

/**
 * The response to return, or null when the caller may proceed.
 *
 * Returning a response rather than throwing keeps the decision visible at the
 * call site: `const denied = await guardWebhookRoute(...); if (denied) return denied`
 * reads as a gate, and a reviewer can see it was not skipped.
 */
export async function guardWebhookRoute(
  userId: string,
  projectId: string,
  access: WebhookAccess,
): Promise<NextResponse | null> {
  if (!(await GUARD[access](userId, projectId))) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }

  const entitlement = await enforceWebhook(userId)
  if (entitlement !== true) {
    return NextResponse.json(
      {
        error: 'Webhooks require the Pro plan',
        code: 'PLAN_LIMIT_EXCEEDED',
        upgradeRequired: true,
        currentPlan: entitlement.currentPlan,
        requiredPlan: 'PRO',
      },
      { status: 403 },
    )
  }

  return null
}
