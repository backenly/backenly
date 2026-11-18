/**
 * ANSWERS THAT ARE DATA, NEVER A PAGE OF THE PLATFORM'S ORIGIN
 * ============================================================
 *
 * Three surfaces answer from Backenly's own origin with content a project
 * chose: a function's answer at /api/v1/{projectId}/fn/{name}, and the two
 * REST APIs, /api/v1/{projectId}/db/… and /api/v2/{projectId}/…, where
 * PostgREST answers in the media type the request asked for and the project's
 * schema can define. Each answer is data for the app that called it, so,
 * whichever server sends it (the runtime: server/app.ts, server/routes/dynamic.ts,
 * server/routes/v2.ts; the web server in front of it:
 * lib/runtime/forward-to-runtime.ts and next.config.js):
 *
 *   - a type a browser shows as a page or runs as script goes out as
 *     text/plain, with its charset (dataAnswerType);
 *   - every answer on these paths carries DATA_ANSWER_HEADERS: browsers take
 *     the type as sent, and a document made from an answer is sandboxed with
 *     nothing allowed, so it has no script, no style and no access to the
 *     origin.
 *
 * JSON, text and every other type, PostgREST's own among them (geo+json,
 * the vnd.pgrst types, CSV, octet-stream), go out as written.
 */

/** The headers every answer on a data path carries. next.config.js sends the same two. */
export const DATA_ANSWER_HEADERS: Readonly<Record<string, string>> = Object.freeze({
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
 * XHTML and SVG among them, and text/xsl, which Chrome and Safari show as XML),
 * the JavaScript types, and multipart/x-mixed-replace, whose parts are shown as
 * documents.
 */
function showsAsPage(essence: string): boolean {
  const subtype = essence.slice(essence.indexOf('/') + 1)
  return (
    essence === 'text/html' ||
    subtype === 'xml' ||
    essence === 'text/xsl' ||
    subtype.endsWith('+xml') ||
    SCRIPT_TYPES.has(essence) ||
    essence === 'multipart/x-mixed-replace'
  )
}

/**
 * The content type an answer on a data path is sent with. One a browser would
 * show as a page or run as script is sent as text/plain, keeping its charset,
 * and so is anything that is not one well-formed type (a list of two types is
 * read by browsers as the last of them). Every other type is sent exactly as
 * written.
 */
export function dataAnswerType(type: string): string {
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

/** Repeated slashes taken as one, as the runtime splits a path. */
const collapse = (pathname: string) => pathname.replace(/\/{2,}/g, '/')

/**
 * Whether a path, as sent (before percent-decoding), is one a function answers
 * on: /api/v1/[{projectId}/][db/]fn/{name}[/…], with fn and db in any case.
 * The runtime calls a function only on these paths (server/routes/dynamic.ts).
 */
export function isFunctionAnswerPath(pathname: string): boolean {
  return /^\/api\/v1\/(?:[^/]+\/)?(?:db\/)?fn\/[^/]+/i.test(collapse(pathname))
}

/**
 * Whether a path, as sent (before percent-decoding), is the v1 REST API's:
 * /api/v1/[{projectId}/]db[/…], with db in any case. The runtime serves a
 * table there only on these paths (server/routes/dynamic.ts).
 */
export function isTableAnswerPath(pathname: string): boolean {
  return /^\/api\/v1\/(?:[^/]+\/)?db(?:\/|$)/i.test(collapse(pathname))
}

/**
 * Whether every answer on this path is data: a function's path, the v1 REST
 * API's (/api/v1/[{projectId}/]db…) or the v2 REST API's (/api/v2/…).
 * next.config.js gives exactly these paths DATA_ANSWER_HEADERS
 * (tests/unit/answers-are-data.spec.ts holds the two to the same paths).
 */
export function isDataAnswerPath(pathname: string): boolean {
  return isFunctionAnswerPath(pathname) || isTableAnswerPath(pathname) || /^\/api\/v2(?:\/|$)/i.test(collapse(pathname))
}
