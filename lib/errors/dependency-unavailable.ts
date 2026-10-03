/**
 * "I CANNOT REACH THE DATABASE" IS NOT "YOU ARE NOT LOGGED IN"
 * ===========================================================
 *
 * Every authorization wrapper in `lib/auth/route-protection.ts` ended with a
 * catch-all that answered 401 or 403. So when the database went away, an
 * operator with a perfectly valid session was told their credentials were
 * rejected.
 *
 * That is not a cosmetic difference. A 401 is ACTIONABLE, and the action it
 * invites is the worst available one: sign out and sign in again. The sign-in
 * also fails, because it is the same database — and the session cookie is now
 * gone, so recovery needs a fresh login the deployment cannot serve. Meanwhile
 * the dashboard renders "signed out" instead of "the backend is unavailable",
 * and whoever is debugging the incident starts on authentication, which is the
 * one subsystem that was working.
 *
 * It is the same family as a storage outage answering `404 File not found`: a
 * definite claim about the world, made by code whose only evidence is that
 * something threw.
 *
 * ── Failing closed is preserved ─────────────────────────────────────────────
 *
 * Nothing here grants access. The handler still never runs and the request is
 * still refused; only the REASON GIVEN changes, from a fabricated authorization
 * decision to the truth. An unclassified error becomes 500 rather than 401 for
 * the same reason — it is a bug, not a credential problem, and labelling bugs
 * as auth failures is how they stay unfound.
 *
 * ── The codes are measured, not guessed ─────────────────────────────────────
 *
 * Observed on Prisma 5.7 against a severed TCP transport:
 *
 *   prisma.session.findUnique()  ->  PrismaClientKnownRequestError  P1017
 *   prisma.$queryRawUnsafe()     ->  PrismaClientKnownRequestError  P1001
 *
 * P1xxx is Prisma's connection-and-engine family, but NOT all of it means the
 * server is unreachable: P1012 is a schema error, P1013 an invalid connection
 * string and P1016 a malformed raw query. Those are programming faults and must
 * keep surfacing as 500, so the set below is enumerated rather than matched
 * with a pattern.
 *
 * `pg` is listed too, because the workspace pools bypass Prisma entirely.
 */

/** Prisma codes that mean: the database could not be used for this request. */
const PRISMA_UNAVAILABLE = new Set([
  'P1000', // authentication against the database server failed
  'P1001', // can't reach database server
  'P1002', // database server reached but timed out
  'P1008', // operation timed out
  'P1010', // user was denied access
  'P1011', // error opening a TLS connection
  'P1017', // server has closed the connection
])

/** node-postgres / libpq transport failures, for the workspace pools. */
const PG_UNAVAILABLE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now — server is starting up
  '08006', // connection_failure
  '08003', // connection_does_not_exist
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '53300', // too_many_connections
])

/**
 * Did this error mean the DATABASE was unavailable, rather than that the
 * request was wrong?
 */
export function isDatabaseUnavailable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false

  const name = (err as { name?: string }).name ?? (err as object).constructor?.name

  // The client could not be created or could not reach the server at all.
  // Every instance of this class is a connection problem.
  if (name === 'PrismaClientInitializationError') return true

  const code = (err as { code?: unknown }).code
  if (typeof code === 'string') {
    if (PRISMA_UNAVAILABLE.has(code)) return true
    if (PG_UNAVAILABLE.has(code)) return true
  }

  // `pg` reports a pool whose socket died mid-query with no code at all.
  const message = (err as { message?: unknown }).message
  if (typeof message === 'string') {
    if (message.includes('Connection terminated')) return true
    if (message.includes('Client has encountered a connection error')) return true
  }

  return false
}

/** The body every surface returns for a dependency outage. */
export const DATABASE_UNAVAILABLE_BODY = {
  code: 'SERVICE_UNAVAILABLE',
  error: 'The service is temporarily unavailable. Please retry.',
} as const
