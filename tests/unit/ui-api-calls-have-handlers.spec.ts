/**
 * Every API path the dashboard calls has a handler.
 *
 * app/app/deploy/page.tsx listed and started deployments through
 * /api/deployments, a route that did not exist, and nothing linked to the page,
 * so it failed for anyone who found it and no check noticed. This fails when
 * UI code fetches an /api/ path that no route under app/api handles.
 *
 * Paths the Cloud overlay serves are listed by name: the public repository
 * cannot see that repository, and they are live in Cloud by design.
 */

import fs from 'fs'
import path from 'path'

/** Served by backenly-cloud's overlay, not by this repository. */
const CLOUD_OVERLAY_ROUTES = ['/api/projects/[id]/access', '/api/billing/usage']

/** Calls whose path is built at runtime, so no literal can be checked. */
const DYNAMIC_CALLS: Record<string, string> = {
  // `/api/projects/${projectId}/${route}`, where route is one of several real handlers.
  'components/workspace/WorkspaceHome.tsx': '/api/projects/X/X',
}

const norm = (p: string) => p.split(path.sep).join('/')

function walk(dir: string, match: (name: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!['node_modules', '.next'].includes(e.name)) walk(p, match, out) }
    else if (match(e.name)) out.push(p)
  }
  return out
}

function routePattern(route: string): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|]/g, (c) => `\\${c}`)
  return new RegExp(
    '^' + route.split('/').map((s) =>
      /^\[\[?\.\.\./.test(s) ? '.*' : /^\[.*\]$/.test(s) ? '[^/]+' : esc(s)).join('/') + '$',
  )
}

const routes = [
  ...walk('app/api', (n) => n === 'route.ts').map((f) => norm(path.dirname(f)).replace(/^app/, '')),
  ...CLOUD_OVERLAY_ROUTES,
].map(routePattern)

it('calls no /api/ path that has no handler', () => {
  const dead: string[] = []
  for (const file of ['app/app', 'components', 'lib/api'].flatMap((d) => walk(d, (n) => /\.(tsx?|jsx?)$/.test(n)))) {
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(/(?:fetch|apiFetch)\(\s*[`'"](\/api\/[^`'"?]*)/g)) {
      const called = m[1].replace(/\$\{[^}]*\}/g, 'X').replace(/\/$/, '')
      if (DYNAMIC_CALLS[norm(file)] === called) continue
      if (!routes.some((r) => r.test(called))) dead.push(`${called} (${norm(file)})`)
    }
  }
  expect(dead).toEqual([])
})
