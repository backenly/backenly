/**
 * Ride out a PostgREST schema-cache reload instead of answering 503.
 *
 * When PostgREST fails to reload its schema cache it empties the cache and
 * refuses requests with
 *
 *   503  {"code":"PGRST002","message":"Could not query the database for the
 *         schema cache. Retrying."}
 *
 * until a reload succeeds. It tries again by itself: 1 s after the failure,
 * then doubling up to every 32 s (PostgREST v14.15,
 * src/PostgREST/AppState.hs retryingSchemaCacheLoad, with
 * db-pool-automatic-recovery on, the default). During a merge in production
 * the REST API briefly answered 503 this way, for about 1.2 s (production QA
 * re-test, 2026-11-16).
 *
 * Sending the request again is safe for every method, writes included.
 * PostgREST raises PGRST002 before it reads the request body or opens a
 * transaction (src/PostgREST/App.hs postgrestResponse), so a refused request
 * never ran. Only PGRST002 is retried. Any other error, a 503 without a
 * database connection (PGRST000, PGRST001) included, is answered as it came:
 * it may not clear within a second, and a write refused for another reason is
 * not known to be unrun.
 */

/**
 * Waits before each new attempt. About 1.75 s in all, which outlasts
 * PostgREST's own retry 1 s after a failed reload plus the reload itself.
 */
export const SCHEMA_CACHE_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000]

/**
 * The most time spent waiting for one request, whatever the jitter. A wait
 * that would run past it is shortened to end on it.
 */
export const SCHEMA_CACHE_RETRY_BUDGET_MS = 2_000

/**
 * Sent as Retry-After when the refusal outlasts the budget: PostgREST's next
 * reload is at least a second away by then.
 */
export const SCHEMA_CACHE_RETRY_AFTER_SECONDS = 1

/** One answer from PostgREST, its body already read. */
export interface UpstreamReply {
  upstream: { status: number }
  text: string
}

/** Is this PostgREST's "schema cache is empty" refusal? Matched on status and code. */
export function isSchemaCacheRefusal(reply: UpstreamReply): boolean {
  if (reply.upstream.status !== 503 || !reply.text) return false
  try {
    const parsed = JSON.parse(reply.text) as { code?: unknown } | null
    return parsed !== null && typeof parsed === 'object' && parsed.code === 'PGRST002'
  } catch {
    return false
  }
}

/** Each wait varies by ±20% so the requests a reload refused do not all return at once. */
function jittered(ms: number): number {
  return Math.round(ms * (0.8 + 0.4 * Math.random()))
}

/**
 * Send the request again while PostgREST answers PGRST002.
 *
 * Returns the first reply that is anything else, or the last refusal once the
 * waits are used up or a resend could not reach PostgREST at all. The caller
 * answers whatever comes back exactly as it would have answered `first`.
 * `resend` must send the same request: the same URL, method, headers and the
 * same body bytes.
 */
export async function retrySchemaCacheRefusals<R extends UpstreamReply>(
  first: R,
  resend: () => Promise<R>,
  label: string,
): Promise<R> {
  if (!isSchemaCacheRefusal(first)) return first

  const started = Date.now()
  const deadline = started + SCHEMA_CACHE_RETRY_BUDGET_MS
  let reply = first
  let retries = 0
  for (const delay of SCHEMA_CACHE_RETRY_DELAYS_MS) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise(resolve => setTimeout(resolve, Math.min(remaining, jittered(delay))))
    try {
      reply = await resend()
    } catch (err) {
      console.error(
        `[postgrest] ${label}: resend after PGRST002 failed:`,
        err instanceof Error ? err.message : err,
      )
      break
    }
    retries += 1
    if (!isSchemaCacheRefusal(reply)) break
  }

  const outcome = isSchemaCacheRefusal(reply) ? 'still refused' : `answered ${reply.upstream.status}`
  console.warn(
    `[postgrest] ${label}: schema cache empty (PGRST002); ${outcome} after ` +
      `${retries} ${retries === 1 ? 'retry' : 'retries'} in ${Date.now() - started} ms`,
  )
  return reply
}
