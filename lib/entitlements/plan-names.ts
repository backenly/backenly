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
}

export function planDisplayName(name: string): string {
  return PLAN_DISPLAY[name.toUpperCase()] ?? name
}
