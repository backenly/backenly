/**
 * v1 route parity gate — fails the build when a public runtime route exists
 * in the Next app but is unreachable in production.
 *
 * WHY THIS EXISTS
 * ---------------
 * nginx sends ALL /api/v1/* traffic to the Express runtime (server/app.ts).
 * A route that only exists as a Next handler (app/api/v1/[projectId]/…) is
 * therefore DEAD in production unless it is either:
 *   (a) served natively by an Express router in server/routes/, or
 *   (b) listed in NEXT_OWNED_SECTIONS in server/routes/next-proxy.ts so the
 *       runtime forwards it to the Next server on the same box.
 *
 * This drift has caused real outages twice (2026-07-10 audit: storage,
 * vector-search, checkout, org-invites; 2026-07-16: webhooks receiver).
 * This script makes the third time a CI failure instead of a prod incident.
 *
 * Run: npx tsx scripts/verify-v1-parity.ts   (wired into `npm run build`)
 */

import fs from 'fs'
import path from 'path'

const ROOT = path.resolve(__dirname, '..')
const NEXT_V1_DIR = path.join(ROOT, 'app', 'api', 'v1', '[projectId]')
const SERVER_ROUTES_DIR = path.join(ROOT, 'server', 'routes')
const PROXY_FILE = path.join(SERVER_ROUTES_DIR, 'next-proxy.ts')

function fail(msg: string): never {
  console.error(`\n✖ v1 parity check FAILED\n\n${msg}\n`)
  process.exit(1)
}

// ── 1. Sections the Next app exposes under /api/v1/[projectId]/ ───────────────

if (!fs.existsSync(NEXT_V1_DIR)) fail(`Next v1 dir not found: ${NEXT_V1_DIR}`)

const entries = fs.readdirSync(NEXT_V1_DIR, { withFileTypes: true })
const nextSections = entries
  .filter((e) => e.isDirectory())
  // `[...unmatched]` and `[param]` are not SECTIONS — they are catch-alls that
  // only run when no real section matched, so demanding a proxy entry for them
  // is a category error. Worse, adding one would route every unmatched
  // /api/v1/* path to Next and take the Express-native sections offline.
  .filter((e) => !e.name.startsWith('['))
  .map((e) => e.name.toLowerCase())
  .sort()
const nextHasBareRoot = entries.some((e) => e.isFile() && e.name === 'route.ts')

// Nested specials that hang off an otherwise Express-owned prefix.
const nextHasVectorSearch = fs.existsSync(
  path.join(NEXT_V1_DIR, 'db', '[tableName]', 'vector-search', 'route.ts'),
)

// ── 2. Sections served natively by the Express runtime ────────────────────────
// Any registration shaped '/:projectId/<section>…' in server/routes/*.ts
// counts as native coverage for <section>.

const native = new Set<string>()
for (const file of fs.readdirSync(SERVER_ROUTES_DIR)) {
  if (!file.endsWith('.ts') || file === 'next-proxy.ts') continue
  const src = fs.readFileSync(path.join(SERVER_ROUTES_DIR, file), 'utf8')
  for (const m of src.matchAll(/['"`]\/:projectId\/([a-z0-9_-]+)/gi)) {
    native.add(m[1].toLowerCase())
  }
}

// ── 3. Sections forwarded to Next by the reverse proxy ─────────────────────────

if (!fs.existsSync(PROXY_FILE)) fail(`Proxy file not found: ${PROXY_FILE}`)
const proxySrc = fs.readFileSync(PROXY_FILE, 'utf8')

const setBlock = proxySrc.match(/NEXT_OWNED_SECTIONS\s*=\s*new Set\(\[([\s\S]*?)\]\)/)
if (!setBlock) fail('Could not locate NEXT_OWNED_SECTIONS in next-proxy.ts — was it renamed?')

const proxied = new Set<string>()
for (const m of setBlock[1].matchAll(/['"`]([a-z0-9_-]+)['"`]/gi)) {
  proxied.add(m[1].toLowerCase())
}
const proxyHandlesBareRoot = /segments\.length\s*===\s*1/.test(proxySrc)
const proxyHandlesVectorSearch = /vector-search/.test(proxySrc)

// ── 4. Evaluate ────────────────────────────────────────────────────────────────

const uncovered: string[] = []
for (const section of nextSections) {
  if (section === 'db') {
    // Table CRUD under /db/ is Express-native (dynamic catch-all); only the
    // nested vector-search route needs the proxy.
    if (nextHasVectorSearch && !proxyHandlesVectorSearch && !native.has('db')) {
      uncovered.push('db/[tableName]/vector-search')
    }
    continue
  }
  if (!native.has(section) && !proxied.has(section)) uncovered.push(section)
}

if (nextHasBareRoot && !proxyHandlesBareRoot && !native.has('')) {
  uncovered.push('(bare GET /api/v1/:projectId project-info route)')
}

// Double coverage: the proxy is mounted BEFORE native routers, so a section in
// both places means the native Express handler is silently shadowed.
const shadowed = [...proxied].filter((s) => native.has(s))

// ── 5. Report ──────────────────────────────────────────────────────────────────

console.log('v1 route parity check')
console.log(`  Next sections under [projectId]: ${nextSections.length}`)
console.log(`  Express-native sections:         ${[...native].sort().join(', ')}`)
console.log(`  Proxied to Next:                 ${[...proxied].sort().join(', ')}`)

if (shadowed.length > 0) {
  console.warn(
    `\n⚠ Sections BOTH proxied and Express-native (proxy mounts first and wins — ` +
    `remove one): ${shadowed.join(', ')}`,
  )
}

if (uncovered.length > 0) {
  fail(
    `These v1 surfaces exist in the Next app but are UNREACHABLE in production\n` +
    `(nginx routes all /api/v1/* to Express, which neither serves nor proxies them):\n\n` +
    uncovered.map((s) => `  • ${s}`).join('\n') +
    `\n\nFix: add the section to NEXT_OWNED_SECTIONS in server/routes/next-proxy.ts\n` +
    `or implement it natively in server/routes/.`,
  )
}

console.log('\n✔ All Next v1 surfaces are reachable in production.\n')
