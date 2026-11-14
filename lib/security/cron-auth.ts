/**
 * WHO MAY CALL A /api/cron ROUTE
 * ==============================
 * Only a caller holding this server's CRON_SECRET. middleware.ts lets every
 * /api/cron/ path through without a session, so this check is the whole of a
 * cron route's authorization.
 *
 * With CRON_SECRET unset or empty, no request is a cron request. A self-host
 * runs its schedules in-process (instrumentation.ts) and needs no secret
 * (README, "CRON_SECRET"), so the routes stay shut there. Ten routes used to
 * compare against the unset value instead: four let in any caller, one any
 * caller who sent no secret, and five any caller who sent the literal
 * `Authorization: Bearer undefined`. The placeholder in .env.example counts as
 * unset too: a value printed in a public file proves nothing.
 *
 * The secret is read from every form the routes have accepted:
 * `Authorization: Bearer <secret>` (what Vercel Cron sends), the
 * `x-cron-secret` header and, for the routes that documented it, the `secret`
 * query parameter. Compared in constant time.
 */
import { createHash, timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'

/** The CRON_SECRET value .env.example ships with. */
export const CRON_SECRET_PLACEHOLDER = 'your-secure-cron-secret-here'

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()

/** The configured secret, or null when there is none a caller could prove. */
function configuredSecret(): string | null {
  const secret = process.env.CRON_SECRET
  if (!secret || secret === CRON_SECRET_PLACEHOLDER) return null
  return secret
}

/** True when `candidate` is the configured CRON_SECRET; false when either is missing. */
export function cronSecretMatches(candidate: string | null | undefined): boolean {
  const secret = configuredSecret()
  if (!secret || !candidate) return false
  return timingSafeEqual(digest(candidate), digest(secret))
}

/**
 * Whether `request` carries this server's CRON_SECRET, as a bearer token or an
 * `x-cron-secret` header, or (with `query`) a `secret` query parameter.
 */
export function isCronRequest(request: NextRequest, opts: { query?: boolean } = {}): boolean {
  if (!configuredSecret()) return false
  const authorization = request.headers.get('authorization') ?? ''
  const candidates = [
    authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : null,
    request.headers.get('x-cron-secret'),
    opts.query ? request.nextUrl.searchParams.get('secret') : null,
  ]
  let matched = false
  for (const candidate of candidates) {
    if (cronSecretMatches(candidate)) matched = true
  }
  return matched
}
