/**
 * END-USER SIGN-IN COUNTS FAILURES, NOT SIGN-INS
 * ==============================================
 *
 * The throttle on /api/v1/{projectId}/auth/signin, for both runtimes: Next
 * serves it where Next is the ingress (AWS, compose), the Express runtime where
 * it is (single box). They used to carry two different policies, 10 per 15
 * minutes in Next and 30 in Express, both counting every request.
 *
 * ── What counting every request did ─────────────────────────────────────────
 *
 * A successful sign-in spent the same budget as a wrong password, per address
 * and per account, and nothing ever gave it back. So the limit was not on
 * guessing, it was on signing in:
 *
 *   - shoppers behind one office, campus or mobile-carrier NAT shared ten
 *     sign-ins per 15 minutes between all of them;
 *   - a frontend that calls sign-in from its own server put every one of its
 *     users behind that server's single address, ten sign-ins for the app;
 *   - a developer testing their own login hit "Too many attempts" on the
 *     eleventh try, every time, with nothing wrong.
 *
 * A credential-stuffing run is almost entirely failures and a real user's
 * sign-ins almost entirely successes, so failures are what tell them apart.
 *
 * ── The three budgets (AUTH_LIMITS.endUserSignin) ───────────────────────────
 *
 *   ip               every attempt from one address. A ceiling on how much
 *                    password hashing one address can buy, set well above any
 *                    real traffic from one address.
 *   ipFailures       failed attempts from one address: stuffing from a source.
 *   accountFailures  failed attempts against one account from anywhere:
 *                    guessing one person's password, from however many sources.
 *
 * All are keyed per project, so an attack on one tenant cannot spend another's.
 *
 * ── Spent first, refunded on success ────────────────────────────────────────
 *
 * The failure budgets are consumed BEFORE the password is checked and the unit
 * is handed back once it proves correct. Checking first and counting after
 * would let a burst of concurrent guesses all pass the check before any of them
 * was counted. And it is a refund of this attempt's own unit, not a reset: a
 * reset would let anyone with one valid password wipe the failures in the
 * window by signing in between guesses.
 *
 * A request that is refused here never reaches the password check, so it is
 * never refunded. That includes the account holder, whose correct password
 * cannot get through a budget someone else has exhausted: that is what an
 * account lockout is.
 */

import { consume, refund, AUTH_LIMITS, type RateLimitResult } from './auth-rate-limit'

const POLICY = AUTH_LIMITS.endUserSignin

/** One budget per address however the email is cased or padded. */
function normaliseEmail(email: string): string {
  return String(email).trim().toLowerCase()
}

/** The counter keys. Exported so tests exhaust the buckets the routes use. */
export const endUserSigninKeys = {
  attempts: (projectId: string, ip: string) =>
    `v1:endUserSignin:ip:${projectId}:${ip}`,
  ipFailures: (projectId: string, ip: string) =>
    `v1:endUserSignin:ipFailures:${projectId}:${ip}`,
  accountFailures: (projectId: string, email: string) =>
    `v1:endUserSignin:accountFailures:${projectId}:${normaliseEmail(email)}`,
}

/**
 * Count one request from `ip` against the all-attempts ceiling. Needs nothing
 * from the body, so a route runs it before any lookup.
 */
export function admitSigninRequest(projectId: string, ip: string): Promise<RateLimitResult> {
  return consume(endUserSigninKeys.attempts(projectId, ip), POLICY.ip.limit, POLICY.ip.windowMs)
}

export interface SigninAttempt {
  /** Why this attempt is refused, or null when it may check the password. */
  denied: RateLimitResult | null
  /**
   * Call once the password has been verified as correct, before anything else
   * can refuse the request (a suspended account, an unverified email). Whoever
   * gets that far knows the password and is not guessing. Safe to call twice.
   */
  credentialsVerified(): Promise<void>
}

/**
 * Spend one unit of each failure budget for this attempt, the address's first.
 *
 * When the account budget refuses, the address's unit stays spent: a source
 * still hammering a locked account is still failing.
 */
export async function admitSigninAttempt(
  projectId: string,
  ip: string,
  email: string,
): Promise<SigninAttempt> {
  const ipKey = endUserSigninKeys.ipFailures(projectId, ip)
  const ipResult = await consume(ipKey, POLICY.ipFailures.limit, POLICY.ipFailures.windowMs)
  if (!ipResult.allowed) return refused(ipResult)

  const accountKey = endUserSigninKeys.accountFailures(projectId, email)
  const accountResult = await consume(
    accountKey,
    POLICY.accountFailures.limit,
    POLICY.accountFailures.windowMs,
  )
  if (!accountResult.allowed) return refused(accountResult)

  let refunded = false
  return {
    denied: null,
    async credentialsVerified() {
      if (refunded) return
      refunded = true
      await Promise.all([refund(ipKey), refund(accountKey)])
    },
  }
}

function refused(result: RateLimitResult): SigninAttempt {
  return { denied: result, credentialsVerified: async () => {} }
}
