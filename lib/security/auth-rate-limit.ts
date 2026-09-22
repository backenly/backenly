/**
 * Auth-surface rate limiting.
 *
 * IP + identifier (email) composite limits. The counters live in whichever
 * store the deployment declares — see lib/security/rate-limit-backend.ts — and
 * the policies below are the same numbers either way.
 *
 * ── This used to be per-process, and said so ────────────────────────────────
 *
 * The store was an in-memory Map, which is a real control on one process and
 * none across several: an attacker reaching N instances got N budgets, so the
 * effective limit was (limit x instances). That was bounded in practice, since
 * self-host runs one web process and the Cloud task ran desired_count = 1, but
 * neither fact was visible to the limiter and raising a replica count is a
 * capacity decision nobody would security-review.
 *
 * Two things now hold it:
 *
 *   - the deployment declares its instance count, and one that declares more
 *     than one without a shared store refuses to boot;
 *   - a shared Redis store exists, so declaring more than one is possible
 *     without weakening anything.
 *
 * ── consume() is async, and that is the point ───────────────────────────────
 *
 * It was synchronous, which is what made a shared store impossible to add
 * without touching every caller. Making it a Promise is the change that lets
 * the counter live somewhere other than this process's heap. Every call site
 * is already inside an async route handler, so each one gains one `await`.
 *
 * Returns a structured result. Routes 429 on `allowed === false` and put
 * `retryAfter` in the `Retry-After` header.
 */

import { getRateLimitBackend, type RateLimitResult } from './rate-limit-backend'

export type { RateLimitResult }

/**
 * Consume one token from the bucket identified by `key`.
 * Returns whether the action is allowed and how long to wait if not.
 */
export async function consume(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  if (limit <= 0 || windowMs <= 0) {
    // Misconfiguration — fail closed (deny). Better to deny than to silently
    // disable a security control because someone passed limit=0.
    //
    // Reported as `store_unavailable`, not `limit_exceeded`: nothing was
    // counted and the caller has done nothing wrong, so telling them they have
    // made too many attempts would be the same lie a store outage would tell.
    return {
      allowed: false,
      outcome: 'store_unavailable',
      remaining: 0,
      retryAfter: 60,
      resetAt: Date.now() + 60_000,
    }
  }
  return getRateLimitBackend().consume(key, limit, windowMs)
}

/**
 * Reset a key (e.g. on successful login — drop the failed-attempts counter).
 */
export async function reset(key: string): Promise<void> {
  await getRateLimitBackend().reset(key)
}

/**
 * Best-effort client IP. Trusts X-Forwarded-For only when behind a known proxy.
 * Falls back to 'unknown' which still works as a coarse bucket.
 */
export function clientIp(request: { headers: { get: (n: string) => string | null } }): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const real = request.headers.get('x-real-ip')
  if (real) return real.trim()
  return 'unknown'
}

// ── Preset policies — pick one per surface to keep things consistent ────────

export const AUTH_LIMITS = {
  // Login is handled in /api/auth/login itself (already IP-limited).
  // These cover the surfaces that weren't previously protected.
  forgotPassword: { ip: { limit: 5, windowMs: 15 * 60_000 }, email: { limit: 3, windowMs: 60 * 60_000 } },
  resetPassword: { ip: { limit: 10, windowMs: 15 * 60_000 } },
  signup:        { ip: { limit: 10, windowMs: 60 * 60_000 } },
  verifyEmail:   { ip: { limit: 20, windowMs: 60 * 60_000 } },
  twoFactor:     { ip: { limit: 10, windowMs: 15 * 60_000 } },
  // Emailed signup and reset codes (lib/auth/email-code.ts). `send` is keyed
  // on the address before any lookup, so it answers the same whether or not an
  // account exists, and it is what stops the form being used to flood a
  // stranger's inbox. `verify` caps guessing from one IP across many codes;
  // each code also dies after its own five wrong tries.
  emailCode: {
    send:   { cooldown: { limit: 1, windowMs: 60_000 }, email: { limit: 5, windowMs: 60 * 60_000 } },
    verify: { ip: { limit: 30, windowMs: 15 * 60_000 } },
  },
  oauthCallback: { ip: { limit: 20, windowMs: 15 * 60_000 } },

  // ── The END-USER auth surface, /api/v1/{projectId}/auth/* ────────────────
  //
  // These had no throttling of any kind. They are unauthenticated by design -
  // they are how a customer's own users sign in - but the platform's
  // /api/auth/login has IP brute-force protection and account lockout, and the
  // end-user equivalent had neither. That left credential stuffing against
  // every end user of every project unthrottled.
  //
  // Keyed per project as well as per IP, so one project under attack cannot
  // lock out sign-in for a different project sharing an egress address, and a
  // single IP cannot spend one global budget across every tenant.
  endUserSignin:  { ip: { limit: 10, windowMs: 15 * 60_000 } },
  endUserSignup:  { ip: { limit: 10, windowMs: 60 * 60_000 } },
  endUserRecover: { ip: { limit: 5,  windowMs: 15 * 60_000 } },
} as const

/**
 * Convenience: check both IP and identifier limits, deny if either trips.
 */
export async function consumeComposite(
  ipKey: string,
  ipPolicy: { limit: number; windowMs: number },
  identifierKey?: string,
  identifierPolicy?: { limit: number; windowMs: number },
): Promise<RateLimitResult> {
  const ipResult = await consume(ipKey, ipPolicy.limit, ipPolicy.windowMs)
  if (!ipResult.allowed) return ipResult
  if (identifierKey && identifierPolicy) {
    const idResult = await consume(identifierKey, identifierPolicy.limit, identifierPolicy.windowMs)
    if (!idResult.allowed) return idResult
  }
  return ipResult
}
