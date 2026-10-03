#!/usr/bin/env node
/**
 * @backenly/cli — the terminal door into a Backenly backend.
 *
 * Zero dependencies, no build step: coding agents shell out to this from
 * Claude Code / Cursor / CI, so cold-start time and installability matter
 * more than framework niceties.
 *
 * Commands:
 *   backenly link --project <id> --key <scoped-key>   save credentials for this repo
 *   backenly status                                   project overview
 *   backenly schema                                   tables + columns (+ FK graph)
 *   backenly types [--client] [--out <file>]          generate backenly.types.ts (+ typed client)
 *   backenly openapi [--out <file>]                   download OpenAPI 3.0 spec
 *   backenly diff                                     exit 1 if local types drifted from live schema
 *   backenly logs [--limit n] [--status 4xx] [--path /posts] [--follow]
 *   backenly query "select …"                         read-only SQL (SELECT/WITH/EXPLAIN)
 *   backenly tools                                    the MCP tools, as the server advertises them
 *   backenly call <tool> [key=value … | '<json>']     run any MCP tool
 *   backenly chat "<request>"                         backend_chat: plain-English build request
 *
 * Auth resolution order: --key flag → BACKENLY_API_KEY env → .backenly/config.json
 * Keys are the same scoped, revocable keys the dashboard's Connect → Agents
 * page issues for MCP. Never commit them: `link` gitignores .backenly/.
 *
 * `tools` / `call` / `chat` exist for the session that just installed the MCP
 * server. A host reads its MCP config when a conversation starts, so the tools
 * registered mid-conversation are absent until the next one. These commands
 * post to the same /api/mcp/* handlers with the same key, so the agent can keep
 * working now, under the same governance, instead of stopping for a restart.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const VERSION = '0.2.0'
const CONFIG_DIR = '.backenly'
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const DEFAULT_URL = 'https://backenly.com'

// ── tiny arg parser ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        args.flags[key] = next
        i++
      } else {
        args.flags[key] = true
      }
    } else {
      args._.push(a)
    }
  }
  return args
}

// ── config ─────────────────────────────────────────────────────────────────────

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function resolveAuth(flags) {
  const cfg = readConfig()
  const key = flags.key || process.env.BACKENLY_API_KEY || cfg.key
  const url = (flags.url || process.env.BACKENLY_API_URL || cfg.url || DEFAULT_URL).replace(/\/$/, '')
  if (!key) {
    die(
      'No API key found.\n' +
      '  Run: backenly link --project <id> --key <scoped-key>\n' +
      '  (generate a scoped key at backenly.com → your project → Connect → Agents)',
    )
  }
  return { key, url }
}

// ── http ───────────────────────────────────────────────────────────────────────

async function api(pathname, { key, url }, opts = {}) {
  let res
  try {
    res = await fetch(url + pathname, {
      ...opts,
      headers: { 'x-api-key': key, accept: 'application/json, text/plain', ...(opts.headers ?? {}) },
    })
  } catch (e) {
    die(`Network error calling ${url}${pathname}: ${e?.message ?? e}`)
  }
  const text = await res.text()
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = JSON.parse(text)
      msg = body.error ?? msg
      if (body.code === 'RATE_LIMITED') msg += ` (retry after ${res.headers.get('retry-after')}s)`
    } catch { /* not json */ }
    die(`${pathname} failed: ${msg}`)
  }
  return { text, headers: res.headers }
}

async function apiJson(pathname, auth) {
  const { text } = await api(pathname, auth)
  return JSON.parse(text)
}

// ── output helpers ─────────────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY
const dim = (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s)
const bold = (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s)
const red = (s) => (isTTY ? `\x1b[31m${s}\x1b[0m` : s)
const green = (s) => (isTTY ? `\x1b[32m${s}\x1b[0m` : s)

// Thrown to unwind to the top-level handler without another console dump.
// We set exitCode and let Node exit naturally after the event loop drains —
// calling process.exit() while a fetch socket / stdout write is still open
// aborts libuv on Windows (UV_HANDLE_CLOSING assertion) and can truncate output.
class SilentExit extends Error {}

function die(msg) {
  console.error(red('✖ ') + msg)
  process.exitCode = 1
  throw new SilentExit()
}

// ── commands ───────────────────────────────────────────────────────────────────

async function cmdLink(flags) {
  const projectId = flags.project
  const key = flags.key
  if (!projectId || !key) die('Usage: backenly link --project <id> --key <scoped-key> [--url <apiUrl>]')
  const url = (flags.url || DEFAULT_URL).replace(/\/$/, '')

  // Validate before persisting anything.
  const overview = await apiJson('/api/cli/overview', { key, url })
  if (overview.project.id !== projectId) {
    die(
      `Key belongs to project ${overview.project.id} ("${overview.project.name}"), ` +
      `not ${projectId}. Generate the key from the project you want to link.`,
    )
  }

  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ projectId, key, url }, null, 2) + '\n')

  // Keep the key out of git. Only touch .gitignore if one already exists.
  if (fs.existsSync('.gitignore')) {
    const gi = fs.readFileSync('.gitignore', 'utf8')
    if (!gi.split(/\r?\n/).some((l) => l.trim() === `${CONFIG_DIR}/` || l.trim() === CONFIG_DIR)) {
      fs.appendFileSync('.gitignore', `\n# Backenly CLI credentials (scoped key)\n${CONFIG_DIR}/\n`)
      console.log(dim(`  added ${CONFIG_DIR}/ to .gitignore`))
    }
  } else {
    console.log(dim(`  note: no .gitignore here — make sure ${CONFIG_DIR}/ never gets committed`))
  }

  console.log(green('✔') + ` Linked to ${bold(overview.project.name)} (${projectId})`)
  console.log(`  ${overview.schema.tableCount} tables · ${overview.counts.endpoints} endpoints · ${overview.counts.functions} functions`)
}

async function cmdStatus(flags) {
  const auth = resolveAuth(flags)
  const o = await apiJson('/api/cli/overview', auth)
  console.log(`${bold(o.project.name)}  ${dim(o.project.id)}`)
  console.log(`  environment  ${o.project.environment ?? 'production'}`)
  console.log(`  status       ${o.project.status ?? 'active'}${o.project.deployed ? ' · deployed' : ''}`)
  console.log(`  api base     ${o.apiBase}`)
  console.log(`  tables       ${o.schema.tableCount}`)
  console.log(`  endpoints    ${o.counts.endpoints}`)
  console.log(`  functions    ${o.counts.functions}`)
  console.log(dim(`  schema read  ${o.schema.generatedAt}`))
}

async function cmdSchema(flags) {
  const auth = resolveAuth(flags)
  const o = await apiJson('/api/cli/overview', auth)
  for (const t of o.schema.tables) {
    console.log(bold(t.name))
    for (const c of t.columns) {
      const marks = [
        c.primaryKey ? 'pk' : null,
        c.references ? `→ ${c.references}` : null,
        c.nullable ? null : 'not null',
      ].filter(Boolean).join(', ')
      console.log(`  ${c.name.padEnd(24)} ${c.type}${marks ? dim('  ' + marks) : ''}`)
    }
  }
  console.log(dim(`\n${o.schema.tableCount} tables · schema read ${o.schema.generatedAt}`))
}

async function cmdTypes(flags) {
  const auth = resolveAuth(flags)
  const out = typeof flags.out === 'string' ? flags.out : 'backenly.types.ts'
  const { text, headers } = await api('/api/cli/types?format=dts', auth)
  fs.writeFileSync(out, text)
  console.log(green('✔') + ` ${out} ${dim(`(schema hash ${headers.get('x-backenly-schema-hash')})`)}`)
  if (flags.client) {
    const clientOut = 'backenly.client.ts'
    const client = await api('/api/cli/types?format=client', auth)
    fs.writeFileSync(clientOut, client.text)
    console.log(green('✔') + ` ${clientOut}`)
  }
}

async function cmdOpenapi(flags) {
  const auth = resolveAuth(flags)
  const out = typeof flags.out === 'string' ? flags.out : 'backenly.openapi.json'
  const { text } = await api('/api/cli/types?format=openapi', auth)
  // Pretty-print for diffable specs in git.
  fs.writeFileSync(out, JSON.stringify(JSON.parse(text), null, 2) + '\n')
  console.log(green('✔') + ` ${out}`)
}

async function cmdDiff(flags) {
  const auth = resolveAuth(flags)
  const local = typeof flags.against === 'string' ? flags.against : 'backenly.types.ts'
  if (!fs.existsSync(local)) {
    die(`${local} not found — run \`backenly types\` first, commit it, then use \`backenly diff\` in CI.`)
  }
  const { text: remote } = await api('/api/cli/types?format=dts', auth)
  const localSrc = fs.readFileSync(local, 'utf8')

  if (normalize(localSrc) === normalize(remote)) {
    console.log(green('✔') + ' No drift — local types match the live schema.')
    return
  }

  const localLines = new Set(normalize(localSrc).split('\n'))
  const remoteLines = new Set(normalize(remote).split('\n'))
  const added = [...remoteLines].filter((l) => !localLines.has(l) && l.trim())
  const removed = [...localLines].filter((l) => !remoteLines.has(l) && l.trim())

  console.error(red('✖ Contract drift detected') + ` — ${local} no longer matches the live schema.\n`)
  for (const l of removed.slice(0, 25)) console.error(red(`  - ${l}`))
  for (const l of added.slice(0, 25)) console.error(green(`  + ${l}`))
  const hidden = Math.max(0, added.length + removed.length - 50)
  if (hidden > 0) console.error(dim(`  … ${hidden} more changed lines`))
  console.error(`\nFix: run \`backenly types\` to regenerate, review the changes, and update your frontend calls.`)
  process.exitCode = 1
}

function normalize(src) {
  // Ignore the generated-at banner lines so a regeneration with zero schema
  // change never reads as drift.
  return src
    .split('\n')
    .filter((l) => !/generated|@backenly|^\s*\/\//i.test(l))
    .join('\n')
    .trim()
}

async function cmdLogs(flags) {
  const auth = resolveAuth(flags)
  const qs = new URLSearchParams()
  if (flags.limit) qs.set('limit', String(flags.limit))
  if (flags.status) qs.set('status', String(flags.status))
  if (flags.path) qs.set('path', String(flags.path))

  const render = (logs) => {
    for (const l of [...logs].reverse()) {
      const status = l.status >= 500 ? red(l.status) : l.status >= 400 ? bold(l.status) : green(l.status)
      console.log(`${dim(l.at)}  ${status}  ${l.method.padEnd(6)} ${l.path}  ${dim(l.ms + 'ms')}`)
    }
  }

  const first = await apiJson(`/api/cli/logs?${qs}`, auth)
  render(first.logs)

  if (flags.follow) {
    let cursor = first.logs[0]?.at ?? new Date().toISOString()
    console.log(dim('… following (ctrl-c to stop)'))
    // Poll politely — the per-key rate limit budget belongs to the user.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((r) => setTimeout(r, 5000))
      const next = await apiJson(`/api/cli/logs?${qs}&since=${encodeURIComponent(cursor)}`, auth)
      if (next.logs.length > 0) {
        render(next.logs)
        cursor = next.logs[0].at
      }
    }
  }
}

async function cmdQuery(flags, positional) {
  const auth = resolveAuth(flags)
  const sql = positional.join(' ').trim()
  if (!sql) die('Usage: backenly query "select * from posts limit 10"')

  let res
  try {
    res = await fetch(auth.url + '/api/cli/query', {
      method: 'POST',
      headers: { 'x-api-key': auth.key, 'content-type': 'application/json' },
      body: JSON.stringify({ sql }),
    })
  } catch (e) {
    die(`Network error: ${e?.message ?? e}`)
  }
  const j = await res.json().catch(() => ({}))

  if (j.refused) {
    console.error(red('✖ ') + j.error)
    if (j.suggestion) console.error(dim('  → ' + j.suggestion))
    process.exitCode = 1
    return
  }
  if (!res.ok || !j.ok) die(j.error || `HTTP ${res.status}`)

  if (j.rows.length === 0) {
    console.log(dim('(0 rows)'))
    return
  }
  // Column-aligned output, JSON for objects, NULL dimmed.
  const cols = j.fields.length ? j.fields : Object.keys(j.rows[0])
  const render = (v) => v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  const widths = cols.map((c) => Math.min(40, Math.max(c.length, ...j.rows.map((r) => render(r[c]).length))))
  const line = (vals) => vals.map((v, i) => v.slice(0, 40).padEnd(widths[i])).join('  ')
  console.log(bold(line(cols)))
  console.log(dim(line(widths.map((w) => '─'.repeat(w)))))
  for (const r of j.rows) console.log(line(cols.map((c) => render(r[c]))))
  console.log(dim(`\n(${j.rowCount} rows${j.capped ? ', capped at 500' : ''} · ${j.ms}ms · read-only)`))
}

// ── MCP tools from the shell ────────────────────────────────────────────────

async function cmdTools(flags) {
  const auth = resolveAuth(flags)
  const manifest = await apiJson('/api/mcp/manifest', auth)
  const tools = manifest.tools ?? []
  if (flags.json) {
    console.log(JSON.stringify(tools, null, 2))
    return
  }
  const width = Math.max(...tools.map((t) => t.name.length))
  for (const t of tools) {
    const kind = t.annotations?.readOnlyHint ? 'read ' : 'write'
    const first = (t.description ?? '').split(/(?<=\.)\s/)[0]
    console.log(`${bold(t.name.padEnd(width))}  ${dim(kind)}  ${first}`)
  }
  console.log(dim(`\n${tools.length} tools${manifest.server?.readOnly ? ' (read-only key)' : ''} · backenly call <tool> key=value …`))
}

/**
 * Tool arguments, from whichever form was shell-safe for the caller:
 *   key=value pairs      values parsed as JSON when they are JSON, else strings
 *   one JSON object      '{"table":"posts"}'
 *   --args '<json>'      the same, as a flag
 *   --args -             JSON read from stdin (a heredoc, no quoting at all)
 *   --args-file <path>   JSON read from a file (PowerShell mangles inline quotes)
 */
async function readToolArgs(flags, positional) {
  let source = null
  if (typeof flags['args-file'] === 'string') source = fs.readFileSync(flags['args-file'], 'utf8')
  else if (flags.args === '-') source = await readStdin()
  else if (typeof flags.args === 'string') source = flags.args
  else if (positional.length === 1 && positional[0].trim().startsWith('{')) source = positional[0]

  if (source !== null) {
    let parsed
    try {
      parsed = JSON.parse(source)
    } catch (e) {
      die(`Arguments are not valid JSON: ${e.message}\n  Tip: use key=value pairs, or --args-file args.json`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) die('Arguments must be a JSON object.')
    return parsed
  }

  const args = {}
  for (const pair of positional) {
    const eq = pair.indexOf('=')
    if (eq <= 0) die(`Expected key=value, got "${pair}".`)
    const key = pair.slice(0, eq)
    const raw = pair.slice(eq + 1)
    args[key] = parseValue(key, raw)
  }
  return args
}

function parseValue(key, raw) {
  const text = raw.trim()
  if (/^[\[{"]|^-?\d|^(true|false|null)$/.test(text)) {
    try {
      return JSON.parse(text)
    } catch {
      // An object or array that does not parse was almost always mangled by the
      // shell (PowerShell strips inner double quotes from native arguments).
      // Sending it on as a string would be a silent wrong write.
      if (/^[\[{]/.test(text)) {
        die(
          `${key}= looks like JSON but does not parse (${text.slice(0, 40)}…). ` +
          `Your shell may have stripped the quotes — put the arguments in a file and use --args-file.`,
        )
      }
    }
  }
  return raw
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { data += c })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

/** POST to an MCP handler and print its answer. Exit code 1 when it says ok:false. */
async function runMcp(auth, pathname, body) {
  let res
  try {
    res = await fetch(auth.url + pathname, {
      method: 'POST',
      headers: { 'x-api-key': auth.key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    die(`Network error calling ${auth.url}${pathname}: ${e?.message ?? e}`)
  }
  const text = await res.text()
  let j
  try {
    j = JSON.parse(text)
  } catch {
    die(`${pathname} returned HTTP ${res.status} with a non-JSON body.`)
  }

  const ok = j.ok !== false && res.ok
  const out = leanForAgent(j)
  if (isTTY) {
    const mark = ok ? green('✔') : red('✖')
    const line = j.summary ?? j.error ?? `HTTP ${res.status}`
    console.log(`${mark} ${line}`)
    const { summary: _s, ...rest } = out
    if (Object.keys(rest).length) console.log(JSON.stringify(rest, null, 2))
  } else {
    console.log(JSON.stringify(out, null, 2))
  }
  if (!ok) process.exitCode = 1
}

/** Same trimming the remote MCP endpoint applies before an agent sees a result. */
function leanForAgent(body) {
  const { timing: _t, events, partialEvents, ...rest } = body
  if (body.ok !== false) return rest
  const trail = Array.isArray(partialEvents) ? partialEvents : Array.isArray(events) ? events : null
  return trail && trail.length ? { ...rest, whatRanBeforeItFailed: trail.slice(-25) } : rest
}

async function cmdCall(flags, positional) {
  const [tool, ...rest] = positional
  if (!tool) die('Usage: backenly call <tool> [key=value …]   (list tools with: backenly tools)')
  const auth = resolveAuth(flags)
  const args = await readToolArgs(flags, rest)
  if (tool === 'backend_chat') {
    if (typeof args.message !== 'string' || !args.message.trim()) die('backend_chat needs message="…"')
    return runMcp(auth, '/api/mcp/chat', { message: args.message })
  }
  return runMcp(auth, '/api/mcp/tool', { tool, args })
}

async function cmdChat(flags, positional) {
  const message = positional.join(' ').trim()
  if (!message) die('Usage: backenly chat "add a posts table with a title and an author"')
  return runMcp(resolveAuth(flags), '/api/mcp/chat', { message })
}

async function cmdInstallSkill(flags) {
  // skill.md is public — no key required, so resolve only the URL.
  const cfg = readConfig()
  const url = (flags.url || process.env.BACKENLY_API_URL || cfg.url || DEFAULT_URL).replace(/\/$/, '')
  const agent = typeof flags.agent === 'string' ? flags.agent : 'all'
  if (!['claude', 'cursor', 'all'].includes(agent)) {
    die(`Unknown agent '${agent}' — use claude, cursor, or all`)
  }

  let body
  try {
    const res = await fetch(`${url}/skill.md`, { headers: { accept: 'text/plain, text/markdown' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    body = await res.text()
  } catch (e) {
    die(`Could not fetch ${url}/skill.md: ${e?.message ?? e}`)
  }

  const written = []
  if (agent === 'claude' || agent === 'all') {
    const dir = path.join('.claude', 'skills', 'backenly')
    fs.mkdirSync(dir, { recursive: true })
    const frontmatter = [
      '---',
      'name: backenly',
      'description: Use when reading, calling, or changing this project’s Backenly backend — schema/type generation via the CLI, backend changes via MCP backend_chat, REST/SDK usage, and the governance rules (no raw SQL; destructive ops need human approval).',
      '---',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter + body)
    written.push(path.join(dir, 'SKILL.md'))
  }
  if (agent === 'cursor' || agent === 'all') {
    const dir = path.join('.cursor', 'rules')
    fs.mkdirSync(dir, { recursive: true })
    const frontmatter = [
      '---',
      'description: How to work with this project’s Backenly backend (CLI, MCP, SDK, governance rules)',
      'alwaysApply: true',
      '---',
      '',
    ].join('\n')
    fs.writeFileSync(path.join(dir, 'backenly.mdc'), frontmatter + body)
    written.push(path.join(dir, 'backenly.mdc'))
  }

  for (const f of written) console.log(green('✔') + ` ${f}`)
  console.log(dim('  Your coding agent now knows the Backenly vocabulary. Source: ' + url + '/skill.md'))
}

function cmdHelp() {
  console.log(`${bold('backenly')} v${VERSION} — CLI for Backenly backends

  ${bold('backenly link')} --project <id> --key <scoped-key>   link this repo to a project
  ${bold('backenly status')}                                   project overview
  ${bold('backenly schema')}                                   tables, columns, FK graph
  ${bold('backenly types')} [--client] [--out <file>]          generate TypeScript types
  ${bold('backenly openapi')} [--out <file>]                   download OpenAPI 3.0 spec
  ${bold('backenly diff')} [--against <file>]                  exit 1 on schema/type drift (CI gate)
  ${bold('backenly logs')} [--limit n] [--status 4xx|5xx] [--path <substr>] [--follow]
  ${bold('backenly query')} "select …"                    read-only SQL against your workspace
  ${bold('backenly tools')} [--json]                           the MCP tools this key can call
  ${bold('backenly call')} <tool> [key=value …]               run any MCP tool (or --args-file a.json)
  ${bold('backenly chat')} "<request>"                        plain-English build request (backend_chat)
  ${bold('backenly install-skill')} [--agent claude|cursor|all]  teach your coding agent Backenly

  Keys: scoped + revocable, from backenly.com → project → Connect → Agents.
  Also honored: BACKENLY_API_KEY, BACKENLY_API_URL environment variables.
  Docs: https://backenly.com/llms.txt`)
}

// ── main ───────────────────────────────────────────────────────────────────────

const argv = parseArgs(process.argv.slice(2))
const cmd = argv._[0]

if (argv.flags.version || cmd === 'version') {
  console.log(VERSION)
  process.exitCode = 0
}

const commands = {
  link: cmdLink,
  status: cmdStatus,
  schema: cmdSchema,
  types: cmdTypes,
  openapi: cmdOpenapi,
  diff: cmdDiff,
  logs: cmdLogs,
  query: cmdQuery,
  tools: cmdTools,
  call: cmdCall,
  chat: cmdChat,
  'install-skill': cmdInstallSkill,
  help: cmdHelp,
}

// Only dispatch when we didn't already handle --version above.
if (!(argv.flags.version || cmd === 'version')) {
  const handler = commands[cmd] ?? cmdHelp
  Promise.resolve(handler(argv.flags, argv._.slice(1))).catch((e) => {
    // die() throws SilentExit after it has already printed + set exitCode.
    // Anything else is an unexpected throw — report it and fail cleanly.
    if (!(e instanceof SilentExit)) {
      console.error(red('✖ ') + (e?.message ?? String(e)))
      process.exitCode = 1
    }
  })
}
