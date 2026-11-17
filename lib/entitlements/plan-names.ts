/**
 * What each plan is called where a customer reads it.
 *
 * Plan rows are named by code (BUILDER), and the product sells them by name
 * (Pro). Anything a person reads says the name: a receipt that said "your
 * BUILDER subscription" named a plan nobody bought.
 *
 * A leaf module, so mail and notification code can name a plan without
 * loading plan policy and the entitlements provider behind it.
 */

// Current tiers (v4): SANDBOX (Free $0) → BUILDER (Pro $25) → SCALE (Enterprise, custom)
// Legacy tiers (backward compat): FREE → STARTER → GROWTH → PRO
const PLAN_DISPLAY: Record<string, string> = {
  SANDBOX: 'Free',
  BUILDER: 'Pro',
  SCALE: 'Enterprise',
  FREE: 'Free',
  STARTER: 'Starter',
  GROWTH: 'Growth',
  PRO: 'Pro',
  // A self-hosted install has one plan, its own (lib/entitlements/self-hosted.ts).
  SELF_HOSTED: 'Self-hosted',
}

export function planDisplayName(name: string): string {
  return PLAN_DISPLAY[name.toUpperCase()] ?? name
}

/**
 * The names to put beside a refusal's plan codes. A refusal body keeps
 * `currentPlan` and `requiredPlan` as codes, which callers decide on; whoever
 * reads it to a person (an agent, a page) gets `currentPlanName` and
 * `requiredPlanName`, the plans as they are sold.
 */
export function planNamesOf(refusal: { currentPlan: string; requiredPlan: string }): {
  currentPlanName: string
  requiredPlanName: string
} {
  return { currentPlanName: planDisplayName(refusal.currentPlan), requiredPlanName: planDisplayName(refusal.requiredPlan) }
}
