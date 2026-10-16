/**
 * QUALIFY A REGION: ONE PROJECT, END TO END, THROUGH THE REGION'S OWN HOST
 * ========================================================================
 * The gate a region passes before it opens (backenly-infra
 * REGIONS_REFERENCE_ARCHITECTURE.md section 9, REGIONS_RUNBOOK.md step 10). It
 * drives a project that lives in the region the way a customer's coding agent
 * and app do: the control plane over MCP for what only it may change (schema,
 * row-level security, auth, functions), and the published SDK against the
 * region's API host for everything an app does. It asserts outcomes, not status
 * codes alone: which rows each user sees, which caller is refused, the event
 * that arrives, the bytes that come back.
 *
 *   BACKENLY_QUALIFY_MCP_KEY=mcp_live_... BACKENLY_QUALIFY_PROJECT_KEY=proj_live_... \
 *   npx tsx scripts/qualify-region.ts \
 *     --project <id> --region us-east-1 \
 *     --api https://us-east-1.api.staging.backenly.com \
 *     --home https://staging.backenly.com \
 *     [--connect us-east-1.api.staging.backenly.com=<regional ALB DNS>,staging.backenly.com=<home ALB DNS>] \
 *     [--report qualify-us-east-1.json] [--skip-revocation] [--approval-wait-minutes 10]
 *
 * --connect is for hosts not in public DNS (staging): the TCP connection goes to
 * the named target while TLS (SNI, certificate validation) and the Host header
 * stay the real hostname, as the release smoke does.
 *
 * Both keys come from the ENVIRONMENT ONLY, never an argument, and are never
 * printed. The MCP key is the probe project's agent key; the project key is a
 * publishable key of the same project (create both once in the console).
 *
 * What it checks, in order:
 *   region     the region's host answers health; it serves no console path;
 *              the home host refuses the project with 421 WRONG_REGION, naming
 *              the region and its address
 *   fixtures   over MCP: the key is the probe project's; a table, an owner-only
 *              policy installed as exact SQL, end-user auth, realtime on the
 *              table, a private bucket, an HTTP function and a sandboxed one
 *   auth       two end users sign up; one refreshes its session and signs out
 *   rls        each user sees exactly its own rows, on /api/v1 and on /api/v2
 *              (PostgREST); a caller with no user sees none
 *   realtime   an insert reaches a subscriber of the table within 15 s
 *   storage    upload, download (bytes equal), delete
 *   functions  the HTTP function answers at the region's host; the sandboxed
 *              one reads the region's table
 *   latency    p50 and p95 of 20 reads through the region's host
 *   autonomy   the project's autonomy status, as the control plane reports it
 *   revocation a throwaway key is revoked (a person approves it in the Review
 *              Queue, by design) and the region refuses it; the wait is timed
 * Not here, and reported as not run: autonomy fault injection and repair, a
 * governed change rolled back, backup and restore. Those are qualification
 * steps of their own (failure injection and the recovery drill).
 *
 * The fixtures stay for the next run; this run's rows and file are removed. Its
 * two end users stay, with random passwords nobody keeps, named
 * qualify-<run>-a@example.com and -b@example.com.
 */

import { randomBytes } from 'node:crypto'
import dns from 'node:dns'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { BackenlyClient } from '@/packages/sdk/src/index'
import { findRegion } from '@/lib/regions'

// ── Arguments ────────────────────────────────────────────────────────────────

export interface QualifyArgs {
  project: string
  region: string
  api: URL
  home: URL
  connect: Record<string, string>
  report: string | null
  skipRevocation: boolean
  approvalWaitMinutes: number
  mcpKey: string
  projectKey: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseArgs(argv: string[], env: Record<string, string | undefined>): QualifyArgs {
  const flags = new Map<string, string>()
  const switches = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--skip-revocation') {
      switches.add(arg)
      continue
    }
    if (/^--(mcp-key|project-key|key)/.test(arg)) {
      throw new Error('keys are read from BACKENLY_QUALIFY_MCP_KEY and BACKENLY_QUALIFY_PROJECT_KEY only, never from the command line')
    }
    if (!arg.startsWith('--') || argv[i + 1] === undefined) throw new Error(`unexpected argument: ${arg}`)
    flags.set(arg, argv[++i])
  }
  const known = ['--project', '--region', '--api', '--home', '--connect', '--report', '--approval-wait-minutes']
  for (const f of flags.keys()) if (!known.includes(f)) throw new Error(`unknown option: ${f}`)

  const project = flags.get('--project') ?? ''
  if (!UUID.test(project)) throw new Error('--project <id> is required: the probe project in the region, by its id')
  const region = flags.get('--region') ?? ''
  if (!findRegion(region)) throw new Error(`--region must name a Backenly Cloud region, not "${region}"`)

  const url = (flag: string): URL => {
    const raw = flags.get(flag)
    if (!raw) throw new Error(`${flag} <https origin> is required`)
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      throw new Error(`${flag} is not a URL: ${raw}`)
    }
    if (u.protocol !== 'https:') throw new Error(`${flag} must be https: ${raw}`)
    return new URL(u.origin)
  }
  const api = url('--api')
  const home = url('--home')
  if (!api.hostname.startsWith(`${region}.api.`)) {
    throw new Error(`--api must be the region's host, ${region}.api.<domain>, not ${api.hostname}`)
  }
  if (api.hostname === home.hostname) throw new Error('--api and --home are the same host: the region must be served apart from home')

  const connect: Record<string, string> = {}
  for (const pair of (flags.get('--connect') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [host, target, extra] = pair.split('=')
    if (!host || !target || extra !== undefined) throw new Error(`--connect takes host=target pairs, not "${pair}"`)
    connect[host.toLowerCase()] = target
  }

  const wait = Number(flags.get('--approval-wait-minutes') ?? '10')
  if (!Number.isFinite(wait) || wait <= 0 || wait > 120) throw new Error('--approval-wait-minutes must be between 0 and 120')

  const mcpKey = env.BACKENLY_QUALIFY_MCP_KEY?.trim() ?? ''
  const projectKey = env.BACKENLY_QUALIFY_PROJECT_KEY?.trim() ?? ''
  if (!mcpKey.startsWith('mcp_')) throw new Error('BACKENLY_QUALIFY_MCP_KEY must hold the probe project\'s MCP key (mcp_...)')
  if (!projectKey.startsWith('proj_')) throw new Error('BACKENLY_QUALIFY_PROJECT_KEY must hold a publishable key of the probe project (proj_...)')

  return {
    project,
    region,
    api,
    home,
    connect,
    report: flags.get('--report') ?? null,
    skipRevocation: switches.has('--skip-revocation'),
    approvalWaitMinutes: wait,
    mcpKey,
    projectKey,
  }
}

// ── Transport: connect elsewhere, keep the hostname ──────────────────────────

/**
 * A fetch that, for a host named in `overrides`, opens the TCP connection to the
 * override target and leaves everything else as the URL says: the Host header,
 * TLS SNI and certificate validation all use the real hostname. Any other host
 * goes to `base`. Response bodies stream, so a server-sent event stream works.
 */
export function connectingFetch(overrides: Record<string, string>, base: typeof fetch = globalThis.fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as any, init)
    const url = new URL(request.url)
    const target = overrides[url.hostname.toLowerCase()]
    if (!target) return base(request)

    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
    const transport = url.protocol === 'https:' ? https : http
    return new Promise<Response>((resolve, reject) => {
      const headers: Record<string, string> = {}
      request.headers.forEach((value, key) => (headers[key] = value))
      if (body) headers['content-length'] = String(body.length)
      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: request.method,
          headers,
          // The only thing overridden: where the connection goes.
          lookup: ((_host: string, options: any, callback: any) => dns.lookup(target, options, callback)) as any,
          signal: request.signal,
        },
        (res) => {
          const out = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach((v) => out.append(key, v))
            else if (value !== undefined) out.set(key, value)
          }
          const status = res.statusCode ?? 0
          const noBody = request.method === 'HEAD' || [204, 205, 304].includes(status)
          resolve(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage, headers: out }))
        },
      )
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })
  }) as typeof fetch
}

// ── Server-sent events ───────────────────────────────────────────────────────

export interface SseEvent {
  event: string
  data: string
}

/** Turns a text/event-stream, chunk by chunk, into complete events. */
export class SseReader {
  private buffer = ''

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const events: SseEvent[] = []
    let end: number
    while ((end = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      if (data.length) events.push({ event, data: data.join('\n') })
    }
    return events
  }
}

// ── MCP ──────────────────────────────────────────────────────────────────────

interface ToolOutcome {
  text: string
  structured: unknown
}

/** An approval a parked call is waiting on, wherever the result carries it. */
export function pendingApproval(outcome: ToolOutcome): string | null {
  const candidates: unknown[] = [outcome.structured]
  try {
    candidates.push(JSON.parse(outcome.text))
  } catch {
    // not JSON
  }
  for (const c of candidates) {
    const approval = (c as { approval?: { id?: unknown; status?: unknown } } | null)?.approval
    if (approval && typeof approval.id === 'string' && approval.status === 'pending') return approval.id
  }
  return null
}

class Mcp {
  private constructor(private readonly client: Client) {}

  static async connect(home: URL, key: string, fetchImpl: typeof fetch): Promise<Mcp> {
    const client = new Client({ name: 'qualify-region', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/api/mcp', home), {
        requestInit: { headers: { 'x-api-key': key } },
        fetch: fetchImpl as any,
      }),
    )
    return new Mcp(client)
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const result = (await this.client.callTool({ name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>
      structuredContent?: unknown
      isError?: boolean
    }
    const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
    if (result.isError) throw new Error(`${name}: ${text.slice(0, 500)}`)
    return { text, structured: result.structuredContent ?? null }
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {})
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

type Status = 'pass' | 'fail' | 'skip'

interface Result {
  phase: string
  check: string
  status: Status
  detail: string
  ms: number
}

const TABLE = 'qualify_notes'
const BUCKET = 'qualify'
const HTTP_FUNCTION = 'qualify-ping'
const SANDBOX_FUNCTION = 'qualify-count'

const NOT_RUN = [
  'autonomy fault injection and repair (the failure-injection drill)',
  'a governed change rolled back',
  'backup and restore (the recovery drill)',
]

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export async function qualify(args: QualifyArgs, log: (line: string) => void = console.log): Promise<{ ok: boolean; results: Result[] }> {
  const results: Result[] = []
  const run = randomBytes(4).toString('hex')
  const theFetch = Object.keys(args.connect).length ? connectingFetch(args.connect) : globalThis.fetch
  // The SDK uses the global fetch; route it the same way.
  const originalFetch = globalThis.fetch
  globalThis.fetch = theFetch

  const failed = new Set<string>()
  async function check(phase: string, name: string, needs: string[], body: () => Promise<string>): Promise<boolean> {
    const missing = needs.filter((n) => failed.has(n))
    if (missing.length) {
      results.push({ phase, check: name, status: 'skip', detail: `needs ${missing.join(', ')}`, ms: 0 })
      log(`  skip  ${phase}/${name}: needs ${missing.join(', ')}`)
      failed.add(name)
      return false
    }
    const started = Date.now()
    try {
      const detail = await body()
      results.push({ phase, check: name, status: 'pass', detail, ms: Date.now() - started })
      log(`  ok    ${phase}/${name}: ${detail}`)
      return true
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      results.push({ phase, check: name, status: 'fail', detail, ms: Date.now() - started })
      log(`  FAIL  ${phase}/${name}: ${detail}`)
      failed.add(name)
      return false
    }
  }

  const apiUrl = (path: string) => new URL(path, args.api).toString()
  const homeUrl = (path: string) => new URL(path, args.home).toString()
  const json = async (res: Response) => {
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text.slice(0, 200) }
    }
  }
  const must = (cond: unknown, message: string) => {
    if (!cond) throw new Error(message)
  }

  let mcp: Mcp | null = null
  const users: Record<'a' | 'b', { client: any; id: string; email: string } | null> = { a: null, b: null }
  const madeRows: Array<{ user: 'a' | 'b'; id: string }> = []

  /** A parked call waits for a person: say so, and wait as long as allowed. */
  async function untilApproved(id: string, what: string): Promise<string> {
    log(`        ${what} waits for approval ${id}: approve it in the console's Review Queue`)
    const deadline = Date.now() + args.approvalWaitMinutes * 60_000
    while (Date.now() < deadline) {
      const status = await mcp!.call('check_approval', { id })
      const parsed = (status.structured ?? (() => { try { return JSON.parse(status.text) } catch { return {} } })()) as { status?: string }
      const state = parsed.status ?? (/\b(executed|rejected|failed|expired|partial)\b/.exec(status.text)?.[1] ?? 'pending')
      if (state === 'executed') return 'approved and executed'
      if (['rejected', 'failed', 'expired', 'partial'].includes(state)) throw new Error(`${what}: approval ${id} is ${state}`)
      await new Promise((r) => setTimeout(r, 15_000))
    }
    throw new Error(`${what}: approval ${id} was not given within ${args.approvalWaitMinutes} minutes`)
  }

  /** A fixture call, waiting out an approval if the control plane parks it. */
  async function fixture(name: string, toolArgs: Record<string, unknown>): Promise<ToolOutcome> {
    const outcome = await mcp!.call(name, toolArgs)
    const approval = pendingApproval(outcome)
    if (approval) await untilApproved(approval, name)
    return outcome
  }

  try {
    log(`Qualifying ${args.region} with project ${args.project} (run ${run})`)
    log(`  region host ${args.api.origin}, home ${args.home.origin}${Object.keys(args.connect).length ? `, connecting via ${Object.keys(args.connect).join(', ')}` : ''}`)

    // ── region ───────────────────────────────────────────────────────────────
    log('\n── region')
    await check('region', 'health', [], async () => {
      const res = await theFetch(apiUrl('/api/health'))
      const body = await json(res)
      must(res.status === 200 && body.healthy === true, `GET /api/health answered ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
      return 'the region host is healthy (its platform database checks pass)'
    })
    await check('region', 'project-health', [], async () => {
      const res = await theFetch(apiUrl(`/api/v1/${args.project}/healthz`), { headers: { 'x-api-key': args.projectKey } })
      must(res.status === 200, `GET /api/v1/<project>/healthz at the region answered ${res.status}`)
      return 'the region serves the project'
    })
    await check('region', 'no-console', [], async () => {
      for (const path of ['/app', '/api/projects', '/login']) {
        const res = await theFetch(apiUrl(path), { redirect: 'manual' })
        const body = await json(res)
        must(res.status === 404 && body.code === 'NOT_FOUND', `${path} at the region answered ${res.status}, not the listener's 404`)
      }
      return 'console paths are answered 404 by the region\'s load balancer'
    })
    await check('region', 'wrong-region-at-home', [], async () => {
      const res = await theFetch(homeUrl(`/api/v1/${args.project}/healthz`), { headers: { 'x-api-key': args.projectKey } })
      const body = await json(res)
      must(res.status === 421, `the home host answered ${res.status} for the regional project, not 421`)
      must(body.code === 'WRONG_REGION' && body.region === args.region, `the refusal names ${body.code}/${body.region}`)
      must(typeof body.apiUrl === 'string' && body.apiUrl.startsWith(args.api.origin), `the refusal points to ${body.apiUrl}, not the region's host`)
      return `421 WRONG_REGION, pointing to ${body.apiUrl}`
    })

    // ── fixtures over MCP ────────────────────────────────────────────────────
    log('\n── fixtures (control plane, MCP)')
    await check('fixtures', 'connect', [], async () => {
      mcp = await Mcp.connect(args.home, args.mcpKey, theFetch)
      const who = await mcp.call('connect', { action: 'whoami' })
      must(who.text.includes(args.project) || JSON.stringify(who.structured ?? '').includes(args.project), 'the MCP key is not bound to the probe project')
      return 'the MCP key is the probe project\'s'
    })
    await check('fixtures', 'table', ['connect'], async () => {
      const state = await mcp!.call('read_backend_state', { section: 'schema' })
      if (state.text.includes(TABLE)) return `${TABLE} already exists`
      await fixture('apply_migration', { sql: `CREATE TABLE ${TABLE} (owner_id uuid NOT NULL, body text NOT NULL)` })
      return `${TABLE} created through apply_migration`
    })
    await check('fixtures', 'rls', ['table'], async () => {
      const owner = `owner_id = backenly_jwt_claim('sub')::uuid`
      await fixture('set_rls', {
        tableName: TABLE,
        select: { using: owner },
        insert: { check: owner },
        update: { using: owner, check: owner },
        delete: { using: owner },
      })
      return 'owner-only policy installed verbatim, all four commands'
    })
    await check('fixtures', 'auth', ['connect'], async () => {
      await fixture('auth', { action: 'enable' })
      return 'end-user email and password auth on'
    })
    await check('fixtures', 'realtime', ['table'], async () => {
      await fixture('realtime', { action: 'enable', table: TABLE })
      return `${TABLE} streams its changes`
    })
    await check('fixtures', 'bucket', ['connect'], async () => {
      const buckets = await mcp!.call('storage', { action: 'list_buckets' })
      if (buckets.text.includes(`"${BUCKET}"`) || new RegExp(`\\b${BUCKET}\\b`).test(buckets.text)) return `bucket ${BUCKET} already exists`
      await fixture('storage', { action: 'create_bucket', name: BUCKET, isPublic: false })
      return `private bucket ${BUCKET} created`
    })
    await check('fixtures', 'functions', ['table'], async () => {
      await fixture('functions', {
        action: 'deploy_code',
        name: HTTP_FUNCTION,
        trigger: 'http',
        method: 'GET',
        code: "import { NextResponse } from 'next/server'\nexport async function GET() {\n  return NextResponse.json({ ok: true, function: 'qualify-ping' })\n}\n",
      })
      await fixture('functions', {
        action: 'deploy_code',
        name: SANDBOX_FUNCTION,
        trigger: 'manual',
        code: `const rows = await ctx.db.query('${TABLE}', {}, { limit: 1000 })\nreturn { count: rows.length }\n`,
      })
      return `${HTTP_FUNCTION} (http) and ${SANDBOX_FUNCTION} (sandbox) deployed`
    })

    // ── auth ─────────────────────────────────────────────────────────────────
    log('\n── auth (data plane, SDK)')
    const sdk = () => new BackenlyClient({ projectId: args.project, apiKey: args.projectKey, apiUrl: args.api.origin })
    for (const who of ['a', 'b'] as const) {
      await check('auth', `sign-up-${who}`, ['auth'], async () => {
        const client = sdk()
        const email = `qualify-${run}-${who}@example.com`
        const password = randomBytes(18).toString('base64url')
        const signedUp = await client.auth.signUp({ email, password })
        must(signedUp?.token && signedUp?.user?.id, 'sign-up returned no session')
        users[who] = { client, id: signedUp.user.id, email }
        return `${email} signed up`
      })
    }
    await check('auth', 'refresh', ['sign-up-a'], async () => {
      const refreshed = await users.a!.client.auth.refreshToken()
      must(refreshed?.token, 'refresh returned no token')
      return 'session refreshed'
    })

    // ── rls ──────────────────────────────────────────────────────────────────
    log('\n── row-level security')
    for (const who of ['a', 'b'] as const) {
      await check('rls', `insert-${who}`, ['rls', `sign-up-${who}`], async () => {
        const row = await users[who]!.client[TABLE].create({ owner_id: users[who]!.id, body: `${run}-${who}` })
        must(row?.id, 'the insert returned no row')
        madeRows.push({ user: who, id: row.id })
        return `user ${who} inserted its own row`
      })
    }
    await check('rls', 'v1-own-rows-only', ['insert-a', 'insert-b'], async () => {
      for (const who of ['a', 'b'] as const) {
        const rows: Array<{ owner_id: string; body: string }> = await users[who]!.client[TABLE].list({ limit: 1000 })
        must(rows.length > 0, `user ${who} sees none of its rows`)
        must(rows.every((r) => r.owner_id === users[who]!.id), `user ${who} sees another user's row`)
        must(rows.some((r) => r.body === `${run}-${who}`), `user ${who} does not see this run's row`)
      }
      return 'each user sees only its own rows on /api/v1'
    })
    await check('rls', 'v2-own-rows-only', ['insert-a', 'insert-b'], async () => {
      for (const who of ['a', 'b'] as const) {
        const res = await theFetch(apiUrl(`/api/v2/${args.project}/${TABLE}?select=owner_id,body`), {
          headers: { 'x-api-key': args.projectKey, authorization: `Bearer ${users[who]!.client.getUserToken()}` },
        })
        const rows = await json(res)
        must(res.status === 200 && Array.isArray(rows), `GET /api/v2 for user ${who} answered ${res.status}`)
        must(rows.every((r: { owner_id: string }) => r.owner_id === users[who]!.id), `PostgREST showed user ${who} another user's row`)
        must(rows.some((r: { body: string }) => r.body === `${run}-${who}`), `PostgREST did not show user ${who} this run's row`)
      }
      return 'each user sees only its own rows through PostgREST'
    })
    await check('rls', 'anonymous-sees-none', ['insert-a', 'insert-b'], async () => {
      const res = await theFetch(apiUrl(`/api/v2/${args.project}/${TABLE}?select=body`), { headers: { 'x-api-key': args.projectKey } })
      const rows = await json(res)
      must(res.status === 200 && Array.isArray(rows), `GET /api/v2 with no user answered ${res.status}`)
      must(!rows.some((r: { body: string }) => r.body.startsWith(run)), 'a caller with no user saw this run\'s rows')
      return 'a caller with no user sees none of them'
    })

    // ── realtime ─────────────────────────────────────────────────────────────
    log('\n── realtime')
    await check('realtime', 'insert-reaches-subscriber', ['realtime', 'insert-a'], async () => {
      const a = users.a!.client
      const ticketRes = await theFetch(apiUrl(`/api/v1/${args.project}/realtime/ticket`), {
        method: 'POST',
        headers: { 'x-api-key': args.projectKey, 'content-type': 'application/json', 'X-User-Token': a.getUserToken() },
      })
      const { ticket } = await json(ticketRes)
      must(ticketRes.status === 200 && ticket, `the ticket request answered ${ticketRes.status}`)
      const controller = new AbortController()
      const stream = await theFetch(apiUrl(`/api/v1/${args.project}/realtime?table=${TABLE}&ticket=${encodeURIComponent(ticket)}`), {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      })
      must(stream.status === 200 && stream.body, `the stream answered ${stream.status}`)
      const reader = stream.body!.getReader()
      const decoder = new TextDecoder()
      const sse = new SseReader()
      const marker = `${run}-realtime`
      let inserted = false
      const started = Date.now()
      const timer = setTimeout(() => controller.abort(), 15_000)
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) throw new Error('the stream ended before the event arrived')
          for (const event of sse.push(decoder.decode(value, { stream: true }))) {
            let data: { type?: string; table?: string } = {}
            try {
              data = JSON.parse(event.data)
            } catch {
              continue
            }
            if (data.type === 'connected' && !inserted) {
              inserted = true
              const row = await a[TABLE].create({ owner_id: users.a!.id, body: marker })
              madeRows.push({ user: 'a', id: row.id })
            }
            if (data.type === 'insert' && data.table === TABLE && event.data.includes(marker)) {
              return `the insert arrived ${Date.now() - started} ms after connecting`
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) throw new Error('no insert event within 15 s')
        throw err
      } finally {
        clearTimeout(timer)
        controller.abort()
      }
    })

    // ── storage ──────────────────────────────────────────────────────────────
    log('\n── storage')
    await check('storage', 'round-trip', ['bucket', 'sign-up-a'], async () => {
      const a = users.a!.client
      const bytes = randomBytes(2048)
      const file = new File([bytes], `qualify-${run}.bin`, { type: 'application/octet-stream' })
      const up = await a.storage.upload(file, `qualify/${run}.bin`, { bucket: BUCKET })
      must(up?.id && up?.url, 'the upload returned no file')
      try {
        const down = await theFetch(new URL(up.url, args.api).toString(), {
          headers: { 'x-api-key': args.projectKey, 'X-User-Token': a.getUserToken() },
        })
        const got = Buffer.from(await down.arrayBuffer())
        must(down.status === 200 && got.equals(bytes), `the download answered ${down.status} with ${got.length} bytes`)
      } finally {
        await a.storage.delete(up.id)
      }
      return '2 KiB uploaded, read back byte for byte, deleted'
    })

    // ── functions ────────────────────────────────────────────────────────────
    log('\n── functions')
    await check('functions', 'http-at-region', ['functions'], async () => {
      const res = await theFetch(apiUrl(`/api/v1/${args.project}/fn/${HTTP_FUNCTION}`), { headers: { 'x-api-key': args.projectKey } })
      const body = await json(res)
      must(res.status === 200 && body.ok === true, `the function answered ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
      return `${HTTP_FUNCTION} answered at the region's host`
    })
    await check('functions', 'sandbox-reads-region', ['functions', 'insert-a'], async () => {
      const outcome = await mcp!.call('functions', { action: 'invoke', name: SANDBOX_FUNCTION })
      const count = /"count"\s*:\s*(\d+)/.exec(outcome.text + JSON.stringify(outcome.structured ?? ''))
      must(count && Number(count[1]) >= 2, `the function did not count this run's rows: ${outcome.text.slice(0, 300)}`)
      return `${SANDBOX_FUNCTION} read ${count![1]} rows of the region's table`
    })

    // ── latency ──────────────────────────────────────────────────────────────
    log('\n── latency')
    await check('latency', 'reads', ['insert-a'], async () => {
      const times: number[] = []
      for (let i = 0; i < 20; i++) {
        const t = Date.now()
        await users.a!.client[TABLE].list({ limit: 10 })
        times.push(Date.now() - t)
      }
      times.sort((x, y) => x - y)
      const p50 = percentile(times, 50)
      const p95 = percentile(times, 95)
      must(p95 < 3000, `p95 ${p95} ms is above 3 s`)
      return `p50 ${p50} ms, p95 ${p95} ms over 20 reads (from where this runs; each still checks the key in the home region)`
    })

    // ── autonomy ─────────────────────────────────────────────────────────────
    log('\n── autonomy')
    await check('autonomy', 'status', ['connect'], async () => {
      const status = await mcp!.call('autonomy', { action: 'status' })
      must(status.text.length > 0, 'the control plane reported nothing')
      return status.text.replace(/\s+/g, ' ').slice(0, 200)
    })

    // ── revocation ───────────────────────────────────────────────────────────
    log('\n── revocation')
    if (args.skipRevocation) {
      results.push({ phase: 'revocation', check: 'revoked-key-refused', status: 'skip', detail: '--skip-revocation', ms: 0 })
      log('  skip  revocation/revoked-key-refused: --skip-revocation')
    } else {
      await check('revocation', 'revoked-key-refused', ['connect', 'project-health'], async () => {
        const minted = await mcp!.call('connect', { action: 'create_api_key', description: `qualify ${run} (revoked by this run)` })
        const text = minted.text + JSON.stringify(minted.structured ?? '')
        const key = /proj_live_[0-9a-f]{48}/.exec(text)?.[0]
        const keyId = /"(?:keyId|id)"\s*:\s*"([0-9a-z-]{8,})"/i.exec(text)?.[1]
        must(key && keyId, 'create_api_key returned no key or id')
        const probe = () => theFetch(apiUrl(`/api/v1/${args.project}/healthz`), { headers: { 'x-api-key': key! } })
        must((await probe()).status === 200, 'the new key was not accepted')
        const revoke = await mcp!.call('connect', { action: 'revoke_api_key', keyId })
        const approval = pendingApproval(revoke)
        if (approval) await untilApproved(approval, 'revoke_api_key')
        const revokedAt = Date.now()
        for (;;) {
          const status = (await probe()).status
          if (status === 401 || status === 403) return `refused (${status}) ${Date.now() - revokedAt} ms after the revocation ran`
          if (Date.now() - revokedAt > 120_000) throw new Error(`the revoked key was still accepted (${status}) 120 s after the revocation`)
          await new Promise((r) => setTimeout(r, 1_000))
        }
      })
    }
  } finally {
    // ── cleanup: this run's own rows ───────────────────────────────────────
    for (const row of madeRows) {
      try {
        await users[row.user]!.client[TABLE].delete(row.id)
      } catch {
        log(`  note  could not delete row ${row.id}; remove it by hand`)
      }
    }
    if (mcp) await (mcp as Mcp).close()
    globalThis.fetch = originalFetch
  }

  const ok = results.every((r) => r.status === 'pass' || (r.status === 'skip' && r.detail === '--skip-revocation'))
  log(`\n${ok ? 'REGION QUALIFIED' : 'REGION NOT QUALIFIED'}: ${results.filter((r) => r.status === 'pass').length} passed, ${results.filter((r) => r.status === 'fail').length} failed, ${results.filter((r) => r.status === 'skip').length} skipped`)
  log(`Not run here: ${NOT_RUN.join('; ')}.`)

  if (args.report) {
    fs.writeFileSync(
      args.report,
      JSON.stringify(
        { region: args.region, project: args.project, api: args.api.origin, home: args.home.origin, run, at: new Date().toISOString(), ok, results, notRun: NOT_RUN },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    )
    log(`Report: ${args.report}`)
  }
  return { ok, results }
}

async function main(): Promise<void> {
  let args: QualifyArgs
  try {
    args = parseArgs(process.argv.slice(2), process.env)
  } catch (err) {
    console.error(`refusing: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 2
    return
  }
  const { ok } = await qualify(args)
  process.exitCode = ok ? 0 : 1
}

if (require.main === module) main()
