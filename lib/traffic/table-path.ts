/**
 * Which table a recorded request was for
 * ======================================
 *
 * The request recorder stores paths relative to the project (see
 * `projectRelativePath`), and table traffic arrives in two shapes:
 *
 *   /db/<table>[/…]   the v1 data plane
 *   /<table>[/…]      the v2 PostgREST-native grammar
 *
 * Readers that matched only `/db/` missed every PostgREST-native client, which
 * is the surface that supports embedding — exactly how a client reads a table
 * that was split out of another one. A first segment that is one of v1's own
 * routes (`/auth`, `/storage`, `/fn` …) is not a table, even if a project has a
 * table of that name: under-counting such a table is the safe mistake, since
 * traffic is evidence of cost and must never be invented.
 *
 * A path that starts with `/api/` is the platform's own request, never an end
 * user's (`projectRelativePath` strips that prefix from every project path), so
 * only an old full-path row's `/db/<table>` counts there; `/api` itself is
 * never a table.
 */

/** v1 route segments and PostgREST's own prefixes: never a table name in a path. */
export const NON_TABLE_SEGMENTS: readonly string[] = [
  'ai', 'api', 'auth', 'bootstrap', 'broadcast', 'cart', 'checkout', 'database', 'db', 'fn', 'functions',
  'graphql', 'health', 'healthz', 'logs', 'orgs', 'presence', 'realtime', 'rpc', 'stats', 'storage',
  'stripe', 'telemetry', 'triggers', 'webhooks',
]

const NON_TABLE = new Set(NON_TABLE_SEGMENTS)

/** The table a project-relative request path names, or null. */
export function tableOfRequestPath(path: string): string | null {
  // Unanchored, as the readers before it were: older rows may carry the full
  // `/api/v1/{projectId}/db/{table}` path.
  const v1 = /\/db\/([A-Za-z0-9_]+)/.exec(path)
  if (v1) return v1[1]
  // NON_TABLE holds `api`, so a platform row is never read as v2 table traffic.
  const v2 = /^\/([A-Za-z0-9_]+)(?:\/|\?|$)/.exec(path)
  return v2 && !NON_TABLE.has(v2[1]) ? v2[1] : null
}

/**
 * The same, as a SQL expression over a `path` column, giving the same answer
 * for every path (tests/integration/table-path-sql.spec.ts holds it to that).
 * Pass the result of `nonTableSegmentsParam()` as the parameter numbered `param`.
 */
export function tableOfRequestPathSql(column: string, param: number): string {
  const v2 = `substring(${column} FROM '^/([A-Za-z0-9_]+)(?:/|[?]|$)')`
  return `COALESCE(substring(${column} FROM '/db/([A-Za-z0-9_]+)'), CASE WHEN ${v2} <> ALL($${param}::text[]) THEN ${v2} END)`
}

export const nonTableSegmentsParam = (): string[] => [...NON_TABLE_SEGMENTS]
