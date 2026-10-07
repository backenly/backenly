/**
 * The framework-free half of lib/security/rate-limit-response.ts: what a
 * denial says, with which status and headers, as plain data.
 *
 * Its own module so the Express runtime can answer a throttled request with the
 * same decision as Next without importing next/server, which the runtime never
 * loads (lib/branches/next-auth-environment.ts keeps the same split). The
 * reasoning behind every choice here is in rate-limit-response.ts's header.
 */

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
 * the logic, and the two wrappers in rate-limit-response.ts are thin enough to
 * read at a glance.
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
