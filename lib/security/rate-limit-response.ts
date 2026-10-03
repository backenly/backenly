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

/** What a genuinely throttled caller is told. Deliberately free of detail. */
export const THROTTLED_MESSAGE = 'Too many attempts. Please try again later.'

/**
 * What a caller is told when the limiter itself is down.
 *
 * It does not say "too many attempts", because they have not made too many. It
 * also does not name Redis, a host or a topology: that is the operator's
 * business, it reaches them through /api/health and the logs, and an
 * unauthenticated caller learning which backing services are down is a
 * reconnaissance gift.
 */
export const UNAVAILABLE_MESSAGE =
  'Sign-in is temporarily unavailable. Please try again in a moment.'

/**
 * Headers describing when the caller may return.
 *
 * `Retry-After` is the standard one and is what clients and proxies act on.
 * The `X-RateLimit-*` pair is conventional rather than standard, and is here
 * because an operator debugging their own integration should not have to
 * reverse-engineer the window from timing.
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'Retry-After': String(Math.max(1, result.retryAfter)),
    'X-RateLimit-Remaining': String(Math.max(0, result.remaining)),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  }
}

/**
 * The decision, as data, before any framework touches it.
 *
 * ── Why this is separated from the NextResponse helpers ─────────────────────
 *
 * The first version of this asserted on a returned NextResponse in tests, and
 * `headers.get('Retry-After')` came back null. Not because the header was
 * missing in production, but because `jest.setup.js` replaces `global.Response`
 * with a stub. `lib/security/outbound-guard.ts` hit the same wall and wrote it
 * down: a test that asserts against the ambient Response is asserting against
 * whatever the runtime happens to define, which in jest is not what ships.
 *
 * So the mapping from outcome to status, code, message and headers is a pure
 * function with no framework in it. The tests check THIS, which is the whole of
 * the logic, and the two wrappers below are thin enough to read at a glance.
 */
export interface ThrottleDecision {
  status: 429 | 503
  code: string
  message: string
  headers: Record<string, string>
}

export function throttleDecision(
  result: RateLimitResult,
  limitCode = 'RATE_LIMIT_EXCEEDED',
): ThrottleDecision {
  if (result.outcome === 'store_unavailable') {
    return {
      status: 503,
      code: 'RATE_LIMITER_UNAVAILABLE',
      message: UNAVAILABLE_MESSAGE,
      headers: {
        ...rateLimitHeaders(result),
        // Nothing about this answer should be cached by a proxy and replayed to
        // the next caller after the store has recovered.
        'Cache-Control': 'no-store',
      },
    }
  }

  return {
    status: 429,
    code: limitCode,
    message: THROTTLED_MESSAGE,
    headers: rateLimitHeaders(result),
  }
}

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
