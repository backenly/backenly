/**
 * The headers next.config.js gives a path, worked out with Next's own code.
 *
 * Next 16 (`next start`) does this in three steps, followed here:
 *   1. lib/load-custom-routes.js checks and processes the config's header
 *      rules (loadCustomRoutes);
 *   2. server/lib/router-utils/filesystem.js builds one matcher per rule with
 *      getPathMatch: strict, unnamed params removed, a trailing slash allowed
 *      (modifyRouteRegex), case-insensitive unless
 *      experimental.caseSensitiveRoutes is set, which it is not here;
 *   3. server/lib/router-utils/resolve-routes.js goes through the rules in
 *      order and, for every one that matches, sets each of its headers, so a
 *      later rule's value replaces an earlier one's; server/lib/router-server.js
 *      then sets them on the response before the route runs.
 * What a route handler then sends is added only where no header of that name
 * is set yet (server/send-response.js), so for a header named in the config,
 * the config's value is the one the browser receives.
 *
 * next.config.js pulls in @sentry/nextjs; a test that uses this mocks it, as
 * tests/unit/cross-origin-resource-policy.spec.ts does.
 */

const loadCustomRoutes = require('next/dist/lib/load-custom-routes').default as (config: unknown) => Promise<{
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }>; has?: unknown[]; missing?: unknown[] }>
}>
const { getPathMatch } = require('next/dist/shared/lib/router/utils/path-match') as {
  getPathMatch: (path: string, options: Record<string, unknown>) => (pathname: string) => false | Record<string, string>
}
const { modifyRouteRegex } = require('next/dist/lib/redirect-status') as { modifyRouteRegex: (regex: string) => string }

export interface HeaderRule {
  match: (pathname: string) => false | Record<string, string>
  headers: Array<{ key: string; value: string }>
  conditional: boolean
}

/** Every header rule in next.config.js, in order, with the matcher the server builds for it. */
export async function nextConfigHeaderRules(): Promise<HeaderRule[]> {
  const config = require('../../next.config.js')
  const { headers } = await loadCustomRoutes(config)
  return headers.map((rule) => ({
    match: getPathMatch(rule.source, {
      strict: true,
      removeUnnamedParams: true,
      regexModifier: (regex: string) => modifyRouteRegex(regex),
      sensitive: false,
    }),
    headers: rule.headers,
    conditional: Boolean(rule.has?.length || rule.missing?.length),
  }))
}

/**
 * The headers the config sets for a request to `pathname`, as Next sets them
 * before the route runs. None of the rules that touch the paths tested here
 * has `has` or `missing` conditions; one that does is left out.
 */
export function configHeadersFor(rules: HeaderRule[], pathname: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rule of rules) {
    if (rule.conditional || !rule.match(pathname)) continue
    for (const { key, value } of rule.headers) out[key.toLowerCase()] = value
  }
  return out
}
