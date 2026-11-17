/**
 * WHERE THE SITE-WIDE SAME-SITE RESOURCE POLICY APPLIES, AND WHERE IT DOES NOT
 * ============================================================================
 *
 * next.config.js answered every path with `Cross-Origin-Resource-Policy:
 * same-site`. Browsers apply that to no-cors loads, an <img> or a classic
 * <script src>, so two things made to be embedded by other sites failed on all
 * of them (production QA re-test, 2026-11-16, N3):
 *
 *   - a stored file's URL, /api/storage/files/<id>/download, which the SDK hands
 *     out for <img src> (packages/sdk/src/storage.ts getUrl);
 *   - the SDK bundles, /backenly-sdk.js and /backenly-sdk.esm.js, documented as
 *     <script src="https://backenly.com/backenly-sdk.js">.
 *
 * The file route sets its own policy by who may read the file
 * (tests/integration/stored-files-load-on-other-sites.spec.ts), and a header
 * next.config.js sets wins over one a route handler sets, so the config leaves
 * that path alone. Every other page and API keeps `same-site`. Matched with
 * Next's own route builder, as the server matches them.
 */

jest.mock('@sentry/nextjs', () => ({ withSentryConfig: (config: unknown) => config }))

const { buildCustomRoute } = require('next/dist/lib/build-custom-route') as {
  buildCustomRoute: (type: 'header', rule: unknown) => { regex: string }
}
const config = require('../../next.config.js') as { headers: () => Promise<Array<{ source: string; headers: Array<{ key: string; value: string }> }>> }

let rules: Awaited<ReturnType<typeof config.headers>>

beforeAll(async () => {
  rules = await config.headers()
})

/** The resource policy the server sends for `path`, as Next applies every matching rule in order. */
function policyFor(path: string): string | undefined {
  let value: string | undefined
  for (const rule of rules) {
    if (!new RegExp(buildCustomRoute('header', rule).regex).test(path)) continue
    for (const header of rule.headers) if (header.key === 'Cross-Origin-Resource-Policy') value = header.value
  }
  return value
}

it('leaves a stored file’s download URL to its route', () => {
  expect(policyFor('/api/storage/files/0b6f3c1e-1d2a-4c55-9a1e-7f2d3b4c5d6e/download')).toBeUndefined()
})

it.each(['/backenly-sdk.js', '/backenly-sdk.esm.js'])('lets any site load %s', (path) => {
  expect(policyFor(path)).toBe('cross-origin')
})

it.each([
  '/',
  '/app/projects/p1/storage',
  '/api/storage/files/0b6f3c1e-1d2a-4c55-9a1e-7f2d3b4c5d6e',
  '/api/storage/files/0b6f3c1e-1d2a-4c55-9a1e-7f2d3b4c5d6e/download/more',
  '/api/storage/upload',
  '/api/v1/p1/db/orders',
  '/api/projects/p1/export/database',
  '/backenly-sdk.js.map',
  '/media/hero.mp4',
])('keeps %s to the same site', (path) => {
  expect(policyFor(path)).toBe('same-site')
})
