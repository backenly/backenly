/**
 * Internal-call shared secret.
 *
 * Previously the same `AI_EXECUTION_TOKEN` was reused for two unrelated jobs:
 *   (1) Edge middleware → /api/internal/project-origins
 *   (2) Server → AI execution authorization
 *
 * Sharing one secret means a leak in either subsystem compromises the other.
 * This module exposes a dedicated INTERNAL_API_TOKEN for middleware-internal
 * calls. We fall back to AI_EXECUTION_TOKEN for one deployment cycle so
 * production doesn't break before the new env var is rolled out.
 */

let warned = false

export function getInternalToken(): string {
  const dedicated = process.env.INTERNAL_API_TOKEN
  if (dedicated && dedicated.length >= 16) return dedicated

  // Backwards compat — emit one warning per process lifetime.
  const legacy = process.env.AI_EXECUTION_TOKEN
  if (legacy) {
    if (!warned) {
      console.warn('[security] INTERNAL_API_TOKEN not set — falling back to AI_EXECUTION_TOKEN. Set INTERNAL_API_TOKEN to a separate value in production.')
      warned = true
    }
    return legacy
  }

  // No secret configured at all — return empty so callers reject every request.
  // Better to 403 every internal call than to silently disable the check.
  return ''
}

/**
 * Constant-time string compare. crypto.timingSafeEqual would require equal
 * lengths; this is the safe shape callers usually want.
 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length === 0 || b.length === 0) return false
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}
