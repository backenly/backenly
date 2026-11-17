/**
 * /api/v1/{projectId}/db is deprecated: /api/v2/{projectId}/{table} is the
 * project's REST API.
 *
 * There were two REST dialects over the same tables (production QA, #22): v1
 * /db with Backenly's own filter grammar, and v2 with PostgREST's. v2 is the
 * one REST API now; /db keeps working, unchanged, for the apps built on it,
 * and says so on every response the way RFC 9745 (Deprecation) and RFC 5829
 * (successor-version) describe:
 *
 *   Deprecation: @1794873600                      (RFC 9745 §2.1: a Structured
 *                                                  Field Date, the day it was
 *                                                  deprecated, 2026-11-17)
 *   Link: </api/v2/{projectId}/{table}>; rel="successor-version"
 *                                                 (RFC 5829; RFC 8288 allows a
 *                                                  reference relative to the
 *                                                  request's own URL)
 *
 * No Sunset header (RFC 8594): no removal date has been decided. A /db path
 * with no table gets the Deprecation header alone.
 *
 * Not every route under /db is deprecated. /db/{table}/vector-search has no
 * equivalent on /api/v2, so pointing it at a successor would send a client
 * somewhere that cannot do the same job; it is left unmarked.
 *
 * Both servers set these: the runtime (server/app.ts, and the CRUD answers in
 * server/routes/postgrest-handler.ts) and the Next ingress
 * (lib/traffic/recorded-v1.ts, middleware.ts). Neither adds them twice: a
 * response that already carries Deprecation is left as it is.
 */

/** 2026-11-17T00:00:00Z, when /api/v2 became the one REST API. */
export const V1_DB_DEPRECATED_AT = Date.UTC(2026, 10, 17) / 1000

/** The Deprecation header's value: a Structured Field Date (RFC 9651 §3.3.7). */
export const V1_DB_DEPRECATION = `@${V1_DB_DEPRECATED_AT}`

/** A path segment safe to put back into a URI as it came. */
const SEGMENT = /^[A-Za-z0-9_.~%-]{1,200}$/

/**
 * A record id, as the CRUD handler tells one from a sub-route such as
 * /search or /bulk: a uuid or an integer (server/routes/postgrest-handler.ts).
 */
const RECORD_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i

/** Routes under /db with no counterpart on /api/v2, and so not deprecated. */
const NOT_DEPRECATED = new Set(['vector-search'])

/**
 * The deprecation headers for a response to this request path, or null when
 * the path is not one of /db's deprecated routes. `pathname` may carry a query
 * string; it is ignored.
 */
export function v1DbDeprecationHeaders(pathname: string): Record<string, string> | null {
  const path = pathname.split(/[?#]/)[0]
  const m = /^\/api\/v1\/([^/]+)\/db(?:\/(.*))?$/.exec(path)
  if (!m) return null
  const projectId = m[1]
  const rest = (m[2] ?? '').split('/').filter(Boolean)
  if (rest.length >= 2 && NOT_DEPRECATED.has(rest[rest.length - 1].toLowerCase())) return null
  const [table, second] = rest
  return v1TableDeprecationHeaders(projectId, table, rest.length === 2 && RECORD_ID.test(second) ? second : undefined)
}

/**
 * The same headers for a table answered by v1's CRUD handler, whichever v1
 * path reached it. The successor is the table on /api/v2, or the record there
 * when one was named; with no usable table, the Deprecation header alone.
 */
export function v1TableDeprecationHeaders(
  projectId: string,
  table: string | undefined,
  recordId?: string,
): Record<string, string> {
  const headers: Record<string, string> = { Deprecation: V1_DB_DEPRECATION }
  if (SEGMENT.test(projectId) && table && SEGMENT.test(table)) {
    const record = recordId && SEGMENT.test(recordId) ? `/${recordId}` : ''
    headers.Link = `</api/v2/${projectId}/${table}${record}>; rel="successor-version"`
  }
  return headers
}
