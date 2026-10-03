/**
 * EVERY RUNTIME ROUTE GOES THROUGH asyncRoute, AND CI SAYS SO
 * ==========================================================
 *
 *   npx tsx scripts/audit-async-routes.ts
 *
 * Express 4 does not await the functions it calls. An `async` handler returns a
 * promise Express drops, so a rejection never reaches the global error
 * middleware — it becomes an unhandled rejection, and the process dies. That is
 * not theoretical: a PostgreSQL restart raised P1017 on the next request and
 * took the whole runtime down, with every v1 surface staying dark afterwards.
 *
 * Thirty-nine call sites were fixed mechanically. This exists so the fortieth
 * cannot be added by someone who has never heard of the problem, which is the
 * only way a mechanical fix survives contact with a codebase.
 *
 * ── The rule, and why it is "all" rather than "the async ones" ──────────────
 *
 * EVERY argument after the path in a `router.<method>(...)` registration must be
 * `asyncRoute(...)` or `asyncRoutes(...)`.
 *
 * Deciding statically whether a handler is async is not reliably possible: it
 * may be a named import, it may return a promise without the keyword, and it
 * may become async in a later edit that touches nothing here. Wrapping a
 * synchronous handler costs one function call and changes no behaviour, so the
 * rule that can actually be checked is the one that admits no exceptions.
 *
 * MIDDLEWARE IS INCLUDED. `v1AuthMiddleware` and `realtimeAuth` are async and
 * both query the database before any handler runs, so they fail in exactly the
 * same way as a handler does.
 */

import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

const ROUTES_DIR = join('server', 'routes')
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'] as const

interface Finding {
  file: string
  line: number
  registration: string
  reason: string
}

/**
 * The text of one `router.<method>( ... )` call.
 *
 * Read by counting parentheses rather than by regex, because a registration
 * spans however many lines its inline handler needs and a line-based match
 * would see only its first line.
 */
function callText(source: string, openIndex: number): { text: string; endIndex: number } {
  let depth = 0
  let inString: string | null = null
  let i = openIndex
  for (; i < source.length; i++) {
    const ch = source[i]
    const prev = source[i - 1]
    if (inString) {
      if (ch === inString && prev !== '\\') inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return { text: source.slice(openIndex, i + 1), endIndex: i }
    }
  }
  return { text: source.slice(openIndex), endIndex: source.length }
}

/** Split a call's arguments at top level, ignoring nested parens and strings. */
function topLevelArgs(call: string): string[] {
  const inner = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')'))
  const args: string[] = []
  let depth = 0
  let inString: string | null = null
  let current = ''
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    const prev = inner[i - 1]
    if (inString) {
      current += ch
      if (ch === inString && prev !== '\\') inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch
      current += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      args.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) args.push(current.trim())
  return args
}

function audit(): Finding[] {
  const findings: Finding[] = []

  for (const name of readdirSync(ROUTES_DIR).filter(f => f.endsWith('.ts'))) {
    const path = join(ROUTES_DIR, name)
    const source = readFileSync(path, 'utf8')

    for (const method of METHODS) {
      const needle = `router.${method}(`
      let from = 0
      for (;;) {
        const at = source.indexOf(needle, from)
        if (at === -1) break
        const openIndex = at + needle.length - 1
        const { text, endIndex } = callText(source, openIndex)
        from = endIndex + 1

        const line = source.slice(0, at).split('\n').length
        const args = topLevelArgs(text)

        // `router.use(middleware)` mounts a sub-router or a plain middleware and
        // has no path, so everything is a handler. With a path, the first is it.
        const handlers = args.length > 1 ? args.slice(1) : args
        if (handlers.length === 0) continue

        for (const handler of handlers) {
          const wrapped =
            handler.startsWith('asyncRoute(') || handler.startsWith('asyncRoutes(')
          if (wrapped) continue

          // A sub-router mounted with use() is not a handler and cannot reject
          // in the way this guards against; its own routes are audited here too.
          if (method === 'use' && /^[A-Za-z_$][\w$]*Routes?$/.test(handler)) continue

          findings.push({
            file: path,
            line,
            registration: text.split('\n')[0].trim().slice(0, 100),
            reason: `handler \`${handler.split('\n')[0].slice(0, 60)}\` is not wrapped`,
          })
        }
      }
    }
  }

  return findings
}

const findings = audit()

console.log('')
console.log('  Runtime route registrations must go through asyncRoute')
console.log('')

if (findings.length === 0) {
  const files = readdirSync(ROUTES_DIR).filter(f => f.endsWith('.ts')).length
  console.log(`  every registration in ${files} route file(s) is wrapped`)
  console.log('')
  process.exit(0)
}

for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`)
  console.error(`    ${f.registration}`)
  console.error(`    ${f.reason}`)
  console.error('')
}

console.error(
  `  ${findings.length} unwrapped registration(s). Express 4 does not await its\n` +
    `  handlers, so an async one that rejects never reaches the error middleware:\n` +
    `  it becomes an unhandled rejection and the runtime process EXITS. A\n` +
    `  PostgreSQL restart did exactly that and every /api/v1/* surface stayed\n` +
    `  down. Wrap it: router.get('/x', asyncRoute(handler)).\n`,
)
process.exit(1)
