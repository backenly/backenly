/**
 * Whether a project's plan includes webhooks.
 *
 * One answer for both doors: the routes (route-guard.ts) and the agent's
 * webhooks tool (agent-actions.ts). The plan is the one of the account the
 * project bills to, not the caller's own.
 *
 * A plan without webhooks still reads what a project has: the list says what
 * the plan is, and endpoints made before a downgrade keep receiving events, so
 * their owner must be able to see them. Only changes are refused.
 */

import { enforceWebhook } from '@/lib/entitlements/policy'
import { billingAccountOf } from '@/lib/usage/account'

export type WebhookPlanRefused = { allowed: false; currentPlan: string; requiredPlan: 'PRO' }
export type WebhookPlan = { allowed: true } | WebhookPlanRefused

export async function webhookPlan(userId: string, projectId: string): Promise<WebhookPlan> {
  const entitlement = await enforceWebhook((await billingAccountOf(projectId)) ?? userId)
  return entitlement === true ? { allowed: true } : { allowed: false, currentPlan: entitlement.currentPlan, requiredPlan: 'PRO' }
}
