/**
 * ONE SHAPE FOR EVERY THROTTLED ANSWER, AND TWO DIFFERENT TRUTHS
 * =============================================================
 *
 * `lib/security/auth-rate-limit.ts` has said this since it was written:
 *
 *     Routes should 429 on `allowed === false` and include the `retryAfter`
 *     in the `Retry-After` header.
 *
 * Not one route did. Every one computed `retryAfter`, discarded it, and
 * returned a bare 429 — so a legitimate client that tripped a limit had no way
 * to know whether to come back in one second or fifteen minutes, and retried
 * blindly into the same wall. The contract was written down and held nowhere,
 * which is the argument for a helper rather than a review note.
 *
 * ── 429 and 503 are not the same event ──────────────────────────────────────
 *
 * A denial can mean two unrelated things:
 *
 *   limit_exceeded      you have made too many attempts. 429. Your fault, and
 *                       the window is real, so `Retry-After` is real.
 *
 *   store_unavailable   we cannot currently tell how many attempts you have
 *                       made. 503. OUR fault. Nothing was counted, so there is
 *                       no window, and a `Retry-After` describing one would
 *                       keep a well-behaved client away far longer than the
 *                       outage lasts.
 *
 * Collapsing them into one 429 accuses an innocent caller of abuse and hides an
 * infrastructure outage inside a metric operators read as "users hitting
 * limits". The request is denied either way — the limiter fails closed — but
 * the report has to be true.
 *
 * ── The message never varies with what the server knows ─────────────────────
 *
 * Within a 429, the same text and headers go back whether the limit that
 * tripped was keyed on an address that exists or one that does not. A 429 that
 * only appears for real accounts tells an attacker which addresses are real,
 * and the recovery routes went to some trouble to avoid exactly that.
 *
 * So callers pass a result, not a reason.
 */

import { NextResponse } from 'next/server'
import type { RateLimitResult } from './rate-limit-backend'
import { throttleDecision } from './rate-limit-decision'

// The decision itself lives in rate-limit-decision.ts, which has no framework
// in it, so the Express runtime can use it too. Re-exported so every existing
// caller and test keeps importing it from here.
export {
  THROTTLED_MESSAGE,
  UNAVAILABLE_MESSAGE,
  rateLimitHeaders,
  throttleDecision,
  type ThrottleDecision,
} from './rate-limit-decision'

/**
 * The v1 end-user envelope for a denial, with the status the denial deserves.
 *
 * One function rather than two, so a route cannot hold the distinction in one
 * place and forget it in another: every caller passes the result and gets the
 * correct status without deciding anything.
 */
export function throttledV1Response(
  result: RateLimitResult,
  limitCode = 'RATE_LIMIT_EXCEEDED',
): NextResponse {
  const d = throttleDecision(result, limitCode)
  return NextResponse.json(
    { error: { code: d.code, message: d.message } },
    { status: d.status, headers: d.headers },
  )
}

/** The platform envelope, same distinction. */
export function throttledPlatformResponse(result: RateLimitResult): NextResponse {
  const d = throttleDecision(result)
  return NextResponse.json(
    { error: d.message, code: d.code },
    { status: d.status, headers: d.headers },
  )
}
