/**
 * Whether a project's plan includes webhooks.
 *
 * One answer for both doors: the routes (route-guard.ts) and the agent's
 * webhooks tool (agent-actions.ts). The plan is the one of the account the
 * project bills to, not the caller's own.
 *
 * A plan without webhooks still reads and stops what a project has. Delivery
 * doesn't check the plan, so endpoints made before a downgrade keep receiving
 * events, and their owner must be able to see them and to disable or delete
 * them. Every other change needs a plan that includes webhooks: adding one,
 * editing it, testing it, rotating its secret, sending a delivery again, or
 * turning it back on.
 */

import { enforceWebhook } from '@/lib/entitlements/policy'
import { billingAccountOf } from '@/lib/usage/account'

export type WebhookPlanRefused = { allowed: false; currentPlan: string; requiredPlan: 'PRO' }
export type WebhookPlan = { allowed: true } | WebhookPlanRefused

export async function webhookPlan(userId: string, projectId: string): Promise<WebhookPlan> {
  const entitlement = await enforceWebhook((await billingAccountOf(projectId)) ?? userId)
  return entitlement === true ? { allowed: true } : { allowed: false, currentPlan: entitlement.currentPlan, requiredPlan: 'PRO' }
}

/** What a request does to an endpoint, for the plan check: stopping one never needs the plan. */
export type WebhookUse = 'change' | 'stop'

/** Whether an update only turns an endpoint off, the one edit every plan may make. */
export function onlyTurnsOff(update: { targetUrl?: unknown; eventType?: unknown; active?: unknown }): boolean {
  return update.active === false && update.targetUrl === undefined && update.eventType === undefined
}
