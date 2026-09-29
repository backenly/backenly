/**
 * Whether an end-user auth request is Backenly's own contract probe.
 *
 * The contract sweep (lib/services/contract-verifier.ts) signs up and signs in
 * a synthetic account on every project, every minute, from the platform's own
 * egress address. Counted like a customer, it spent the end-user budgets (10
 * sign-ups an hour and 10 sign-ins per 15 minutes, per project and address)
 * within minutes, then reported its own 429s as a fleet-wide auth outage: the
 * platform fault that production showed on almost every sweep.
 *
 * A request is the probe only when BOTH hold:
 *   - it carries the platform's internal-traffic token, an HMAC of the platform
 *     secret that no client can produce (lib/traffic/request-recorder.ts), and
 *   - the account is a reserved synthetic address (isReservedTestEmail).
 * The token on any other address is counted as usual, and a reserved address
 * without the token is counted as usual, so the exemption can reach nothing but
 * Backenly's own throwaway accounts. The customer limits are unchanged.
 */
import { isReservedTestEmail } from '@/lib/services/end-user-auth-table'
import { INTERNAL_TRAFFIC_HEADER, isInternalTraffic } from '@/lib/traffic/request-recorder'

type HasHeaders = { headers: { get: (name: string) => string | null } }

/** The request carries a valid internal-traffic token (it MAY be the probe). */
export function carriesInternalToken(request: HasHeaders): boolean {
  return isInternalTraffic(request.headers.get(INTERNAL_TRAFFIC_HEADER))
}

/** The request is the platform's contract probe: valid token AND a reserved address. */
export function isPlatformProbe(request: HasHeaders, email: unknown): boolean {
  return typeof email === 'string' && isReservedTestEmail(email) && carriesInternalToken(request)
}
