/**
 * THE AUTHORIZATION PROJECTION'S SWITCH AND ITS BOUND
 * ===================================================
 * Each region keeps a copy of what authorizes its projects' requests
 * (lib/auth-projection/deliver.ts). BACKENLY_AUTH_PROJECTION says how far it
 * is used:
 *
 *   off       the default. Nothing is delivered and nothing reads the copy:
 *             every regional request is authorized at home, as before.
 *   shadow    the home region delivers; a regional reader compares the copy
 *             with home and reports a difference, but answers from home.
 *   enforce   a reader answers from the copy while it is fresh, and from home
 *             otherwise (lib/auth-projection/read.ts).
 *
 * Fresh means the copy's watermark is younger than AUTH_MAX_STALENESS_MS. The
 * founders set 15 seconds as the most it may ever be (2026-10-16), so a larger
 * or unreadable value is 15 seconds; staging runs below it, at 10.
 */

export type AuthProjectionMode = 'off' | 'shadow' | 'enforce'

export function authProjectionMode(raw: string | undefined = process.env.BACKENLY_AUTH_PROJECTION): AuthProjectionMode {
  const value = (raw ?? '').trim().toLowerCase()
  return value === 'shadow' || value === 'enforce' ? value : 'off'
}

/** The longest a region may trust its copy: the founders' bound. */
export const AUTH_MAX_STALENESS_CEILING_MS = 15_000

export function authMaxStalenessMs(raw: string | undefined = process.env.AUTH_MAX_STALENESS_MS): number {
  const value = Number((raw ?? '').trim())
  if (!(raw ?? '').trim() || !Number.isInteger(value) || value <= 0) return AUTH_MAX_STALENESS_CEILING_MS
  return Math.min(value, AUTH_MAX_STALENESS_CEILING_MS)
}

/**
 * How often the home region delivers, which is also how often a quiet region's
 * watermark moves. A third of the bound, so two deliveries in a row can fail
 * before a region's copy goes stale.
 */
export const AUTH_PROJECTION_DELIVERY_SECONDS = 5
