/**
 * UI coverage audit: which dashboard-facing API routes have no dashboard caller.
 *
 * The Supabase comparison work kept producing the same shape of finding — a
 * capability whose route, service layer and typed client are all built, with
 * nothing in the dashboard that calls them. Hand-listing those rots the moment
 * someone ships one, the way the tool catalog rotted before it was derived from
 * the PG catalog (docs/mcp-catalog-truth-architecture.md). So the list is
 * derived here rather than typed anywhere.
 *
 * Reachability is transitive: a route counts as covered when a dashboard file
 * references it directly, or references a lib/ helper that reaches it. Without
 * that, every route behind the lib/api/* typed clients reads as an orphan.
 *
 * Routes that are not supposed to have a dashboard caller (cron, the /api/v1
 * end-user runtime, OAuth callbacks, CLI, MCP) are classified out rather than
 * reported, so the remaining list is only dashboard candidates.
 *
 * Static analysis only: no network, no database, no build. Safe to run anywhere.
 *
 * Run: npx tsx scripts/audit-ui-coverage.ts [--json] [--all]
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

const ROOT = join(__dirname, '..')

const BACKSLASH = String.fromCharCode(92)
const REGEX_SPECIAL = '.*+?^${}()|[]' + BACKSLASH

function escapeRegex(s: string): string {
  return s
    .split('')
    .map((c) => (REGEX_SPECIAL.includes(c) ? BACKSLASH + c : c))
    .join('')
}

/** Route kinds that legitimately have no dashboard caller. */
type RouteKind = 'dashboard' | 'cron' | 'runtime-v1' | 'oauth-callback' | 'cli' | 'mcp' | 'webhook-ingest' | 'health'

function classify(route: string): RouteKind {
  if (route.startsWith('/api/cron/')) return 'cron'
  if (route.startsWith('/api/v1/')) return 'runtime-v1'
  if (route.startsWith('/api/cli/')) return 'cli'
  if (route.startsWith('/api/mcp/') || route.startsWith('/api/oidc/')) return 'mcp'
  if (/\/callback$/.test(route)) return 'oauth-callback'
  if (route === '/api/health' || route.endsWith('/health')) return 'health'
  if (route.startsWith('/api/webhooks/') && route.includes('/ingest')) return 'webhook-ingest'
  return 'dashboard'
}

type RouteInfo = {
  route: string
  file: string
  kind: RouteKind
  verbs: string[]
  directCallers: string[]
  viaHelpers: string[]
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const rel = (f: string) => relative(ROOT, f).split(sep).join('/')

/** app/api/projects/[id]/backup/route.ts -> /api/projects/[id]/backup */
function routePathFromFile(file: string): string {
  return '/' + rel(file).replace(/^app\//, '').replace(/\/route\.ts$/, '')
}

const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

function extractVerbs(text: string): string[] {
  const found = new Set<string>()
  for (const v of VERBS) {
    // `export async function GET(`, `export const GET =`, `export { x as GET }`
    const fn = new RegExp('export' + BACKSLASH + 's+(?:async' + BACKSLASH + 's+)?function' + BACKSLASH + 's+' + v + BACKSLASH + 'b')
    const cn = new RegExp('export' + BACKSLASH + 's+const' + BACKSLASH + 's+' + v + BACKSLASH + 's*=')
    const as = new RegExp('as' + BACKSLASH + 's+' + v + BACKSLASH + 'b')
    if (fn.test(text) || cn.test(text) || as.test(text)) found.add(v)
  }
  return [...found]
}

/**
 * A route is referenced if source contains its literal static segments in order.
 * Dynamic segments become a non-greedy non-slash run, because callers write
 * `/api/projects/${projectId}/backup` where the route says `[id]`.
 */
function routeMatcher(route: string): RegExp {
  const body = route
    .split('/')
    .filter(Boolean)
    .map((p) => (/^\[.*\]$/.test(p) ? '[^/]*?' : escapeRegex(p)))
    .join('/')
  return new RegExp('/' + body + '(?![A-Za-z0-9_-])')
}

/**
 * Callers routinely hold the prefix in a constant and append the suffix —
 * lib/api/monitoring.ts does exactly this with `const API_BASE = '/api/monitoring'`
 * — so the full path never appears as one contiguous string. Treat a file as a
 * caller when it names the parent path AND the final segment.
 */
function splitMatcher(route: string): { parent: RegExp; leaf: RegExp } | null {
  const parts = route.split('/').filter(Boolean)
  if (parts.length < 3) return null
  const leaf = parts[parts.length - 1]
  if (/^\[.*\]$/.test(leaf)) return null
  // Only when the prefix is fully static. With a dynamic parent such as
  // /api/projects/[id], the parent matches almost every dashboard file and the
  // leaf is an ordinary English word, so the pair proves nothing.
  const head = parts.slice(0, -1)
  if (head.some((p) => /^\[.*\]$/.test(p))) return null
  const parentPath = '/' + head.map(escapeRegex).join('/')
  return {
    parent: new RegExp(parentPath + '(?![A-Za-z0-9_-])'),
    leaf: new RegExp('[\'"`/]' + escapeRegex(leaf) + '(?![A-Za-z0-9_-])'),
  }
}

function main() {
  const asJson = process.argv.includes('--json')
  const showAll = process.argv.includes('--all')

  const appFiles = walk(join(ROOT, 'app'))
  const componentFiles = walk(join(ROOT, 'components'))
  const libFiles = walk(join(ROOT, 'lib'))

  const isSource = (f: string) => /\.(tsx|ts)$/.test(f) && !f.endsWith('.d.ts')

  // The dashboard: everything under app/ that is not an API route, plus components/.
  const uiFiles = appFiles
    .filter((f) => isSource(f) && !rel(f).startsWith('app/api/'))
    .concat(componentFiles.filter(isSource))

  // Intermediate layer: lib/ modules a dashboard file may call through.
  const helperFiles = libFiles.filter(isSource)

  const read = (f: string) => ({ file: rel(f), text: readFileSync(f, 'utf8') })
  const uiSources = uiFiles.map(read)
  const helperSources = helperFiles.map(read)

  // Reachability is per exported function, not per module. lib/api/database.ts
  // is imported by the table editor, but addConstraint inside it is called by
  // nothing — module granularity would score its route as covered and hide the
  // exact class of gap this audit exists to find.
  type Span = { file: string; name: string; text: string }

  function exportedSpans(file: string, text: string): { spans: Span[]; header: string } {
    const marks: { name: string; idx: number }[] = []
    for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)) {
      marks.push({ name: m[1], idx: m.index ?? 0 })
    }
    for (const m of text.matchAll(/export\s+const\s+([A-Za-z0-9_]+)\s*[:=]/g)) {
      marks.push({ name: m[1], idx: m.index ?? 0 })
    }
    marks.sort((a, b) => a.idx - b.idx)
    const spans = marks.map((m, i) => ({
      file,
      name: m.name,
      text: text.slice(m.idx, i + 1 < marks.length ? marks[i + 1].idx : text.length),
    }))
    // Module-level text (imports, `const API_BASE = '/api/monitoring'`) is
    // prepended to each span so prefix-constant call sites still resolve.
    return { spans, header: marks.length ? text.slice(0, marks[0].idx) : text }
  }

  const spanIndex = helperSources.map((h) => ({ file: h.file, ...exportedSpans(h.file, h.text) }))
  const allSpans = spanIndex.flatMap((s) => s.spans)
  const headerOf = new Map(spanIndex.map((s) => [s.file, s.header]))

  const callRe = (name: string) => new RegExp('\\b' + escapeRegex(name) + '\\s*\\(')
  const uiText = uiSources.map((s) => s.text).join('\n')

  const liveNames = new Set<string>()
  for (const s of allSpans) {
    if (callRe(s.name).test(uiText)) liveNames.add(s.name)
  }
  let grew = true
  while (grew) {
    grew = false
    const liveText = allSpans
      .filter((s) => liveNames.has(s.name))
      .map((s) => s.text)
      .join('\n')
    for (const s of allSpans) {
      if (liveNames.has(s.name)) continue
      if (callRe(s.name).test(liveText)) {
        liveNames.add(s.name)
        grew = true
      }
    }
  }
  const liveSpans = allSpans.filter((s) => liveNames.has(s.name))

  const routeFiles = appFiles.filter((f) => f.endsWith(`${sep}route.ts`) && rel(f).startsWith('app/api/'))

  const routes: RouteInfo[] = routeFiles.map((file) => {
    const text = readFileSync(file, 'utf8')
    const route = routePathFromFile(file)
    const re = routeMatcher(route)
    const split = splitMatcher(route)
    const hits = (s: { text: string }) =>
      re.test(s.text) || (split !== null && split.parent.test(s.text) && split.leaf.test(s.text))
    const directCallers = uiSources.filter(hits).map((s) => s.file)
    const viaHelpers = liveSpans
      .filter((s) => hits({ text: (headerOf.get(s.file) ?? '') + '\n' + s.text }))
      .map((s) => s.file + '#' + s.name)
    return { route, file: rel(file), kind: classify(route), verbs: extractVerbs(text), directCallers, viaHelpers }
  })

  const dashboardRoutes = routes.filter((r) => r.kind === 'dashboard')
  const orphans = dashboardRoutes.filter((r) => r.directCallers.length === 0 && r.viaHelpers.length === 0)

  const byKind: Record<string, number> = {}
  for (const r of routes) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          generatedFrom: 'scripts/audit-ui-coverage.ts',
          totals: {
            routes: routes.length,
            dashboardRoutes: dashboardRoutes.length,
            orphans: orphans.length,
            uiFiles: uiFiles.length,
            liveHelperFunctions: liveNames.size,
            byKind,
          },
          orphans: orphans.map((o) => ({ route: o.route, file: o.file, verbs: o.verbs })),
          ...(showAll ? { routes } : {}),
        },
        null,
        2
      )
    )
    return
  }

  console.log(`Scanned ${routes.length} API routes against ${uiFiles.length} dashboard files`)
  console.log(`and ${liveNames.size} dashboard-reachable lib/ functions.\n`)
  console.log(`Route kinds: ${Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join('  ')}\n`)
  console.log(`=== Dashboard-facing routes with NO dashboard caller (${orphans.length}/${dashboardRoutes.length}) ===`)
  for (const r of orphans.sort((a, b) => a.route.localeCompare(b.route))) {
    console.log(`  ${r.route}  [${r.verbs.join(',') || '?'}]`)
  }
}

main()
