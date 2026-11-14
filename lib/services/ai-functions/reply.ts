/**
 * What the caller of a function is sent.
 *
 * A function's log lines are the developer's. They are kept with the run,
 * where the console shows them, and sent back only to a service-role key; an
 * app's own key, and so an end user's browser, gets the function's answer
 * without them. They used to go to every caller.
 *
 * A route module (a function written as a Next.js route handler) answers for
 * itself at /fn/{name}: its status, its body and its content type go out as it
 * wrote them. It was wrapped as { success, name, result: { status, body,
 * headers }, logs, durationMs }, so a frontend reading the handler's own
 * `error` found nothing and showed "Request failed (400)".
 *
 * A run the function runner turned away is a 503, never the function's 500
 * (runnerRefusal).
 */

/** A run the function runner turned away, as the HTTP surfaces answer it. */
export interface RunnerRefusal {
  status: 503
  code: 'FUNCTION_RUNNER_BUSY' | 'FUNCTION_RUNNER_UNAVAILABLE'
  error: string
  /** Seconds to wait before trying again, for a Retry-After header; only when busy. */
  retryAfter?: number
}

/**
 * The answer to a run the function runner turned away, or null when it ran.
 *
 * Neither refusal is the function's doing, so neither is its 500: the server
 * had no free function slot (FUNCTION_RUNNER_BUSY, with Retry-After), or this
 * deployment cannot run functions (FUNCTION_RUNNER_UNAVAILABLE). Both are 503,
 * which retry policies and monitors read as the service's state, not the
 * request's or the function's.
 */
export function runnerRefusal(result: { errorCode?: string; error?: string; retryAfterSeconds?: number }): RunnerRefusal | null {
  if (result.errorCode === 'RUNNER_BUSY') {
    return {
      status: 503,
      code: 'FUNCTION_RUNNER_BUSY',
      error: result.error || 'Too many functions are running on this server right now. Try again in a few seconds.',
      retryAfter: Math.max(1, Math.ceil(result.retryAfterSeconds ?? 5)),
    }
  }
  if (result.errorCode === 'RUNNER_UNAVAILABLE') {
    return { status: 503, code: 'FUNCTION_RUNNER_UNAVAILABLE', error: result.error || 'Functions cannot run on this server.' }
  }
  return null
}

/** The log lines this caller may be sent: all of them to a service-role key, none to anyone else. */
export function logsFor(logs: string[] | undefined, serviceRole: boolean): { logs?: string[] } {
  return serviceRole ? { logs: logs ?? [] } : {}
}

/** The headers of a route module's answer that are passed on: its content type and its caching. */
export function answerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase()
    if ((lower === 'content-type' || lower === 'cache-control') && typeof value === 'string') out[lower] = value
  }
  return out
}
