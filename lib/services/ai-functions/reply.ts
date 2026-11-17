/**
 * What the caller of a function is sent.
 *
 * A function's log lines are the developer's. They are kept with the run,
 * where the console shows them, and sent back only to a service-role key; an
 * app's own key, and so an end user's browser, gets the function's answer
 * without them. They used to go to every caller.
 *
 * A route module (an http function) answers for itself at /fn/{name}: its
 * status, its body and its content type go out as it wrote them, except a type
 * a browser would show as a page or run as script, which goes out as
 * text/plain (see "A function's answer is data" below). It was wrapped as
 * { success, name, result: { status, body, headers }, logs, durationMs }, so a
 * frontend reading the handler's own `error` found nothing and showed "Request
 * failed (400)".
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

/**
 * The status a completed run is answered with on POST /functions and
 * /functions/invoke: the one its handler chose, as at /fn/{name}, or 200 for a
 * plain function, which chooses none. They answered 200 whatever the handler
 * said, so a function that answered 401 or 503 reached its caller as a
 * success (#604). A status a response can't have is a 200.
 */
export function completedRunStatus(httpStatus: number | undefined): number {
  return typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 200 && httpStatus <= 599
    ? httpStatus
    : 200
}

/** Whether a response with this status may have a body: 204, 205 and 304 may not. */
export function statusHasBody(status: number): boolean {
  return status !== 204 && status !== 205 && status !== 304
}

/** The log lines this caller may be sent: all of them to a service-role key, none to anyone else. */
export function logsFor(logs: string[] | undefined, serviceRole: boolean): { logs?: string[] } {
  return serviceRole ? { logs: logs ?? [] } : {}
}

/**
 * The headers of a route module's answer that are passed on: its content type,
 * as functionAnswerType sends it, and its caching.
 */
export function answerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase()
    if (typeof value !== 'string') continue
    if (lower === 'content-type') out[lower] = functionAnswerType(value)
    else if (lower === 'cache-control') out[lower] = value
  }
  return out
}

// ─── A function's answer is data ─────────────────────────────────────────────
//
// /api/v1/{projectId}/fn/{name} is served from the platform's own origin, and
// what a function answers is data for the app that called it, never a page of
// that origin. So, whichever server sends it (the runtime: server/app.ts and
// server/routes/dynamic.ts; the web server in front of it:
// lib/runtime/forward-to-runtime.ts and next.config.js):
//   - a type a browser shows as a page or runs as script goes out as
//     text/plain, with its charset (functionAnswerType);
//   - every answer carries FUNCTION_ANSWER_HEADERS: browsers take the type as
//     sent, and a document made from an answer is sandboxed with nothing
//     allowed, so it has no script, no style and no access to the origin.
// JSON, text and every other type go out as the function wrote them.

/** The headers every answer on a function's path carries. next.config.js sends the same two. */
export const FUNCTION_ANSWER_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': "sandbox; default-src 'none'",
  'X-Content-Type-Options': 'nosniff',
})

/** The JavaScript MIME types (WHATWG MIME Sniffing, "JavaScript MIME type"). */
const SCRIPT_TYPES = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript', 'application/x-javascript',
  'text/ecmascript', 'text/javascript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5', 'text/jscript', 'text/livescript',
  'text/x-ecmascript', 'text/x-javascript',
])

const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/

/**
 * Whether a browser shows a document of this type as a page or runs it as
 * script: HTML, the XML types (text/xml, application/xml and every +xml type,
 * XHTML and SVG among them), the JavaScript types, and multipart/x-mixed-replace,
 * whose parts are shown as documents.
 */
function showsAsPage(essence: string): boolean {
  const subtype = essence.slice(essence.indexOf('/') + 1)
  return (
    essence === 'text/html' ||
    subtype === 'xml' ||
    subtype.endsWith('+xml') ||
    SCRIPT_TYPES.has(essence) ||
    essence === 'multipart/x-mixed-replace'
  )
}

/**
 * The content type a function's answer is sent with. One a browser would show
 * as a page or run as script is sent as text/plain, keeping its charset, and
 * so is anything that is not one well-formed type (a list of two types is read
 * by browsers as the last of them). Every other type is sent exactly as the
 * function wrote it.
 */
export function functionAnswerType(type: string): string {
  const [essencePart, ...params] = type.split(';')
  const essence = essencePart.trim().toLowerCase()
  const [top, sub, ...more] = essence.split('/')
  const wellFormed = more.length === 0 && TOKEN.test(top ?? '') && TOKEN.test(sub ?? '')
  if (wellFormed && !showsAsPage(essence)) return type
  const charset = params
    .map((p) => p.trim().match(/^charset\s*=\s*"?([!#$%&'*+.^_`|~0-9A-Za-z-]+)"?$/i)?.[1])
    .find(Boolean)
  return charset ? `text/plain; charset=${charset}` : 'text/plain'
}

/**
 * Whether a path, as sent (before percent-decoding, repeated slashes taken as
 * one), is one a function answers on: /api/v1/[{projectId}/][db/]fn/{name}[/…],
 * with fn and db in any case. The runtime calls a function only on these paths
 * (server/routes/dynamic.ts), and next.config.js gives these paths
 * FUNCTION_ANSWER_HEADERS (tests/unit/function-answers-are-data.spec.ts holds
 * the two to the same paths).
 */
export function isFunctionAnswerPath(pathname: string): boolean {
  return /^\/api\/v1\/(?:[^/]+\/)?(?:db\/)?fn\/[^/]+/i.test(pathname.replace(/\/{2,}/g, '/'))
}
