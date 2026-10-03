/**
 * Records safe JWT timing metadata when PostgREST reports PGRST303 ("JWT issued
 * at future"), so clock-related authentication failures can be diagnosed
 * without logging credentials.
 *
 * PGRST303 means PostgREST judged a token's `iat` to be far enough ahead of its
 * own clock to reject it. Distinguishing a genuine clock disagreement from a
 * token-construction problem needs the numbers from the failing request, which
 * are otherwise unrecoverable after the fact.
 *
 * SECURITY PROPERTIES
 *
 * - Only integers derived from a token this process minted itself are recorded.
 *   The token is decoded once at mint time and immediately discarded; this
 *   module never receives, holds, or logs a JWT, signature, or secret.
 * - Nothing here is an authorization input. The values are logged and never
 *   returned to the caller, so JWT timing stays server-side observability.
 * - Every entry point is total: malformed input yields a record with nulls, and
 *   the logger cannot throw. A diagnostic that breaks a live request would be
 *   worse than the condition it reports.
 */

/** Where the request reached this process from. Not an authorization signal. */
export type PgrstRequestSource = 'internal_loopback' | 'external'

/** The only fields carried out of a minted token. */
export interface TokenTiming {
  iat: number | null
  exp: number | null
}

export interface PgrstClockDiagnostic {
  event: 'pgrst303_clock'
  requestId: string
  table: string
  /** Server clock when the rejection came back, epoch seconds. */
  nowEpochS: number
  iat: number | null
  exp: number | null
  /** Positive means the token claims an issue time ahead of this server's clock. */
  iatMinusNowS: number | null
  /** Seconds since the token was minted, by this server's clock. */
  tokenAgeS: number | null
  /**
   * Transport origin only. `internal_loopback` means the peer address was a
   * loopback address — it identifies the network path, NOT which component
   * made the call, and must not be read as attribution to any caller.
   */
  source: PgrstRequestSource
  /** Present only when timing could not be read, so a null `iat` is never ambiguous. */
  decodeError?: string
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Read `iat`/`exp` from a JWT without verifying it.
 *
 * Call this where the token is created and keep only the result, so the token
 * itself need not stay reachable for the rest of the request. Hand-rolled
 * rather than pulling in a verifier: no signature check is wanted or implied,
 * and the output is used solely for logging.
 */
export function decodeTokenTiming(token: string): TokenTiming & { decodeError?: string } {
  try {
    const parts = String(token ?? '').split('.')
    if (parts.length !== 3) return { iat: null, exp: null, decodeError: 'malformed token' }
    const seg = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = seg.length % 4 === 0 ? seg : seg + '='.repeat(4 - (seg.length % 4))
    const parsed = JSON.parse(Buffer.from(pad, 'base64').toString('utf8'))
    if (!parsed || typeof parsed !== 'object') {
      return { iat: null, exp: null, decodeError: 'malformed token' }
    }
    return { iat: num((parsed as Record<string, unknown>).iat), exp: num((parsed as Record<string, unknown>).exp) }
  } catch (err) {
    return { iat: null, exp: null, decodeError: err instanceof Error ? err.message : 'decode failed' }
  }
}

/** Classify the transport origin. Loopback describes the network path only. */
export function classifySource(remoteAddress?: string | null): PgrstRequestSource {
  const a = remoteAddress ?? ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1' ? 'internal_loopback' : 'external'
}

/** Build the record. Pure and total. */
export function buildPgrstClockDiagnostic(input: {
  requestId: string
  table: string
  timing: (TokenTiming & { decodeError?: string }) | null
  remoteAddress?: string | null
  nowMs?: number
}): PgrstClockDiagnostic {
  const nowEpochS = Math.floor((input.nowMs ?? Date.now()) / 1000)
  const t = input.timing ?? { iat: null, exp: null, decodeError: 'timing unavailable' }
  const iat = num(t.iat)

  const out: PgrstClockDiagnostic = {
    event: 'pgrst303_clock',
    requestId: input.requestId,
    table: input.table,
    nowEpochS,
    iat,
    exp: num(t.exp),
    iatMinusNowS: iat === null ? null : iat - nowEpochS,
    tokenAgeS: iat === null ? null : nowEpochS - iat,
    source: classifySource(input.remoteAddress),
  }
  if (t.decodeError) out.decodeError = t.decodeError
  return out
}

/** True only for PostgREST's "JWT issued at future", so other 401s stay quiet. */
export function isPgrst303(upstreamCode: string | null | undefined): boolean {
  return upstreamCode === 'PGRST303'
}

/** Emit the record. Swallows its own failures: it runs inside a live request path. */
export function logPgrstClockDiagnostic(input: {
  requestId: string
  table: string
  timing: (TokenTiming & { decodeError?: string }) | null
  remoteAddress?: string | null
  nowMs?: number
  logger?: (line: string) => void
}): PgrstClockDiagnostic | null {
  try {
    const d = buildPgrstClockDiagnostic(input)
    ;(input.logger ?? console.error)(`[postgrest] PGRST303 clock diagnostic ${JSON.stringify(d)}`)
    return d
  } catch {
    return null
  }
}
