/**
 * END-USER SIGN-UP: A LOOSE CAP ON ACCOUNTS, A TIGHT ONE ON THE ORACLE
 * ====================================================================
 *
 * The throttle on /api/v1/{projectId}/auth/signup, for both runtimes (Next
 * where Next is the ingress, Express where it is), as
 * lib/security/end-user-signin-limit.ts is for sign-in. They used to hold
 * different rules: 10 per hour per address in both, but Express gave reserved
 * test addresses a bucket of 100 on the address alone while Next exempted
 * Backenly's probe only with its signed token.
 *
 * ── Why one limit of 10 was wrong both ways ─────────────────────────────────
 *
 * Every attempt from an address spent it, so a launch where customers share
 * an address (a campus, an office, a frontend that signs users up from its own
 * server) was refused on the eleventh customer. Raising it alone would loosen
 * the one thing it really guarded: sign-up answers "An account with this email
 * already exists", which tells anyone whether an address has an account. Sign-in
 * gives nothing away (the same answer and the same cost for an unknown address
 * and a wrong password), so sign-up is where enumeration happens.
 *
 * ── The two budgets (AUTH_LIMITS.endUserSignup) ─────────────────────────────
 *
 *   ip           every attempt from one address. What one address can create.
 *   ipConflicts  "already registered" answers to one address. The oracle,
 *                spent before the lookup and refunded when the address is
 *                free, so only the answers that disclose an account count.
 *
 * An attacker learning "no account here" has to create one to hear it, which
 * spends the account budget and leaves an account behind, so the cheap side of
 * the oracle is the conflict, and that is the side kept at 10 per hour.
 */

import { consume, refund, AUTH_LIMITS, type RateLimitResult } from './auth-rate-limit'

const POLICY = AUTH_LIMITS.endUserSignup

/** The counter keys. Exported so tests exhaust the buckets the routes use. */
export const endUserSignupKeys = {
  attempts: (projectId: string, ip: string) => `v1:endUserSignup:${projectId}:${ip}`,
  conflicts: (projectId: string, ip: string) => `v1:endUserSignup:conflicts:${projectId}:${ip}`,
}

/**
 * Count one sign-up from `ip`. Needs nothing from the body, so a route runs it
 * before any lookup.
 */
export function admitSignupRequest(projectId: string, ip: string): Promise<RateLimitResult> {
  return consume(endUserSignupKeys.attempts(projectId, ip), POLICY.ip.limit, POLICY.ip.windowMs)
}

export interface ExistenceCheck {
  /** Why the lookup is refused, or null when it may run. */
  denied: RateLimitResult | null
  /** Call once the lookup found no account, which costs the budget nothing. Safe to call twice. */
  addressFree(): Promise<void>
}

/**
 * Spend one unit of the conflict budget before looking the address up, so a
 * concurrent burst cannot outrun it. Refused here, the caller answers 429
 * without looking, which is the same whether or not the address is registered.
 */
export async function admitExistenceCheck(projectId: string, ip: string): Promise<ExistenceCheck> {
  const key = endUserSignupKeys.conflicts(projectId, ip)
  const result = await consume(key, POLICY.ipConflicts.limit, POLICY.ipConflicts.windowMs)
  if (!result.allowed) return { denied: result, addressFree: async () => {} }

  let refunded = false
  return {
    denied: null,
    async addressFree() {
      if (refunded) return
      refunded = true
      await refund(key)
    },
  }
}
