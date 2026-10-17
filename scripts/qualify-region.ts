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
 *   BACKENLY_QUALIFY_OPERATOR_PASSWORD=... \
 *   npx tsx scripts/qualify-region.ts \
 *     --project <id> --region us-east-1 \
 *     --api https://us-east-1.api.staging.backenly.com \
 *     --home https://staging.backenly.com \
 *     --operator <the probe project's owner, by email> \
 *     [--connect us-east-1.api.staging.backenly.com=<regional ALB DNS>,staging.backenly.com=<home ALB DNS>] \
 *     [--report qualify-us-east-1.json] [--skip-revocation] [--approval-wait-minutes 10] \
 *     [--job-wait-minutes 15] [--repair-wait-minutes 6]
 *
 * --connect is for hosts not in public DNS (staging): the TCP connection goes to
 * the named target while TLS (SNI, certificate validation) and the Host header
 * stay the real hostname, as the release smoke does.
 *
 * The keys and the operator's password come from the ENVIRONMENT ONLY, never an
 * argument, and are never printed. The MCP key is the probe project's agent
 * key; the project key is a publishable key of the same project (create both
 * once in the console). The operator is the account that owns the probe
 * project: it signs in at the home host for what only the console does
 * (snapshots, restores and schema rollback), and signs out when the run ends.
 *
 * What it checks, in order:
 *   region     the region's host answers health; it serves no console path;
 *              the home host refuses the project with 421 WRONG_REGION, naming
 *              the region and its address
 *   operator   the probe project's owner signs in at the home host
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
 *   rollback   a table added over MCP is rolled back from the console to the
 *              restore point recorded before it; the fixtures and their rows
 *              are left as they were
 *   autonomy   a fault the region repairs on its own: a reference column added
 *              over MCP with a DEFAULT, a path that creates no index, is
 *              indexed by the region's repair loop without anyone asking
 *              (missing_fk_index, Tier 0), confirmed by its HEALTH_AUTO_FIXED
 *              record and by the table's own indexes. A repair made from home
 *              instead proves nothing about the region and fails the check.
 *              The column is then rolled back from the console
 *   recovery   the console asks for a snapshot and home queues it for the
 *              region, which takes it; its download link is the region's own
 *              bucket, never the home host; rows changed after it are put back
 *              by a restore the region carries out, and both users then see
 *              exactly their rows from the snapshot, on /api/v1 and PostgREST.
 *              Each wait is timed, from the request to the job's end
 *              The autonomy status the control plane reports closes the phase
 *   revocation a throwaway key is revoked (a person approves it in the Review
 *              Queue, by design) and the region refuses it; the wait is timed
 * Not here, and reported as not run: the infrastructure failure drills
 * (projection lag, blocked peering, a database failover, killed PostgREST
 * tasks). Those need a fault made inside the region's infrastructure and are
 * qualification steps of their own.
 *
 * The fixtures stay for the next run; this run's rows and file are removed, and
 * so is the table the rollback check adds. Its two end users stay, with random
 * passwords nobody keeps, named qualify-<run>-a@example.com and -b@example.com.
 * The snapshot the recovery check takes stays, under the snapshots' own
 * retention.
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
  jobWaitMinutes: number
  /** How long the region's repair loop is given to repair the drill's fault. */
  repairWaitMinutes: number
  mcpKey: string
  projectKey: string
  /** The probe project's owner, who signs in at the home host for what only the console does. */
  operator: string
  operatorPassword: string
  /** The operator's current two-factor code, when the account has two-factor sign-in. */
  operatorTotp: string | null
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
    if (/^--(operator-password|password|token|session)/.test(arg)) {
      throw new Error('the operator\'s password is read from BACKENLY_QUALIFY_OPERATOR_PASSWORD only, never from the command line')
    }
    if (!arg.startsWith('--') || argv[i + 1] === undefined) throw new Error(`unexpected argument: ${arg}`)
    flags.set(arg, argv[++i])
  }
  const known = ['--project', '--region', '--api', '--home', '--connect', '--report', '--approval-wait-minutes', '--job-wait-minutes', '--repair-wait-minutes', '--operator']
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
  const jobWait = Number(flags.get('--job-wait-minutes') ?? '15')
  if (!Number.isFinite(jobWait) || jobWait <= 0 || jobWait > 120) throw new Error('--job-wait-minutes must be between 0 and 120')
  const repairWait = Number(flags.get('--repair-wait-minutes') ?? '6')
  if (!Number.isFinite(repairWait) || repairWait <= 0 || repairWait > 60) throw new Error('--repair-wait-minutes must be between 0 and 60')

  const mcpKey = env.BACKENLY_QUALIFY_MCP_KEY?.trim() ?? ''
  const projectKey = env.BACKENLY_QUALIFY_PROJECT_KEY?.trim() ?? ''
  if (!mcpKey.startsWith('mcp_')) throw new Error('BACKENLY_QUALIFY_MCP_KEY must hold the probe project\'s MCP key (mcp_...)')
  if (!projectKey.startsWith('proj_')) throw new Error('BACKENLY_QUALIFY_PROJECT_KEY must hold a publishable key of the probe project (proj_...)')

  // Recovery and rollback are not optional: a region is not qualified until a
  // snapshot of its project has been restored there.
  const operator = flags.get('--operator')?.trim() ?? ''
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(operator)) {
    throw new Error('--operator <email> is required: the account that owns the probe project, for the snapshot, restore and rollback checks')
  }
  const operatorPassword = env.BACKENLY_QUALIFY_OPERATOR_PASSWORD ?? ''
  if (!operatorPassword) throw new Error('BACKENLY_QUALIFY_OPERATOR_PASSWORD must hold the operator\'s password')
  const operatorTotp = env.BACKENLY_QUALIFY_OPERATOR_TOTP?.trim() || null
  if (operatorTotp !== null && !/^\d{6}$/.test(operatorTotp)) {
    throw new Error('BACKENLY_QUALIFY_OPERATOR_TOTP, when set, must hold the operator\'s current six-digit code')
  }

  return {
    project,
    region,
    api,
    home,
    connect,
    report: flags.get('--report') ?? null,
    skipRevocation: switches.has('--skip-revocation'),
    approvalWaitMinutes: wait,
    jobWaitMinutes: jobWait,
    repairWaitMinutes: repairWait,
    mcpKey,
    projectKey,
    operator,
    operatorPassword,
    operatorTotp,
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
  'the infrastructure failure drills: projection lag, blocked peering, a database failover, killed PostgREST tasks',
]

/** How often a queued snapshot or restore is looked at while it waits for its region. */
const JOB_POLL_MS = 5_000

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
  /** Rows the restore is expected to take away: removed at the end if it did not. */
  const rowsRestoreRemoves: Array<{ user: 'a' | 'b'; id: string }> = []
  /** This run's rows deleted before the restore, which it should bring back. */
  const rowsRestoreReturns = new Set<string>()

  /** The operator's session at the home host, once signed in. Never printed. */
  let session: { token: string; refreshToken: string | null } | null = null
  const asOperator = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session!.token}` },
  })
  async function operatorJson(path: string): Promise<any> {
    const res = await theFetch(homeUrl(path), asOperator())
    must(res.status === 200, `GET ${path} at the home host answered ${res.status}`)
    return json(res)
  }
  const snapshotsPath = `/api/projects/${args.project}/backup`
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

  /** Wait for a snapshot or restore the home host queued, until its region has done it. */
  async function untilRegionDone(jobId: string, what: string): Promise<void> {
    const deadline = Date.now() + args.jobWaitMinutes * 60_000
    let last = 'not listed'
    while (Date.now() < deadline) {
      const { jobs } = await operatorJson(snapshotsPath)
      const job = (jobs ?? []).find((j: { id: string }) => j.id === jobId) as { status: string; error: string | null } | undefined
      if (job?.status === 'completed') return
      if (job?.status === 'regional_failed') throw new Error(`${what} failed in ${args.region}: ${job.error ?? 'no reason given'}`)
      last = job ? `${job.status}${job.error ? ` (${job.error})` : ''}` : 'not listed'
      await new Promise((r) => setTimeout(r, JOB_POLL_MS))
    }
    throw new Error(`${what} did not finish within ${args.jobWaitMinutes} minutes; last seen ${last}`)
  }

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
      must(body.region === args.region, `the region host reports serving ${body.region}, not ${args.region}`)
      must(body.degraded === false, `the region host is degraded: ${JSON.stringify(body.dependencies ?? {}).slice(0, 300)}`)
      const copy = body.dependencies?.authProjection
      return `the region host is ready and not degraded: its own database answers, home answers, authorization copy ${copy?.mode ?? 'unknown'}${typeof copy?.ageMs === 'number' ? ` ${(copy.ageMs / 1000).toFixed(1)} s old` : ''}`
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

    // ── operator ─────────────────────────────────────────────────────────────
    log('\n── operator (control plane, signed in)')
    await check('operator', 'sign-in', [], async () => {
      const res = await theFetch(homeUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: args.operator,
          password: args.operatorPassword,
          ...(args.operatorTotp ? { totpCode: args.operatorTotp } : {}),
        }),
      })
      const body = await json(res)
      must(
        body.code !== 'TOTP_REQUIRED',
        'the operator account has two-factor sign-in: set BACKENLY_QUALIFY_OPERATOR_TOTP to its current code',
      )
      must(res.status === 200 && typeof body.token === 'string', `the sign-in at the home host answered ${res.status}`)
      session = { token: body.token, refreshToken: typeof body.refreshToken === 'string' ? body.refreshToken : null }
      await operatorJson(`/api/projects/${args.project}/schema-versions`)
      return `${args.operator} signed in at the home host and can open the probe project`
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

    // ── rollback ─────────────────────────────────────────────────────────────
    log('\n── rollback (a governed change, undone from the console)')
    const rollbackTable = `qualify_rollback_${run}`
    let restorePoint: { id: string; versionNum: number } | null = null
    await check('rollback', 'change', ['table', 'sign-in'], async () => {
      await fixture('apply_migration', { sql: `CREATE TABLE ${rollbackTable} (note text)` })
      const { versions } = await operatorJson(`/api/projects/${args.project}/schema-versions`)
      // Every schema change records the schema as it was just before it.
      const before = (versions ?? []).find((v: { description?: string }) => v.description?.includes(rollbackTable))
      must(before, `no restore point was recorded before ${rollbackTable} was created`)
      restorePoint = { id: before.id, versionNum: before.versionNum }
      return `${rollbackTable} created over MCP, after restore point v${before.versionNum}`
    })
    await check('rollback', 'undone', ['change'], async () => {
      const res = await theFetch(
        homeUrl(`/api/projects/${args.project}/schema-versions`),
        asOperator({ method: 'POST', body: JSON.stringify({ versionId: restorePoint!.id }) }),
      )
      const body = await json(res)
      must(res.status === 200 && body.success === true, `the rollback answered ${res.status}: ${String(body.message ?? body.error ?? '').slice(0, 200)}`)
      const state = await mcp!.call('read_backend_state', { section: 'schema' })
      must(!state.text.includes(rollbackTable), `${rollbackTable} is still in the schema after the rollback`)
      must(state.text.includes(TABLE), `the rollback removed ${TABLE}, which the restore point recorded`)
      const rows: Array<{ body: string }> = await users.a!.client[TABLE].list({ limit: 1000 })
      must(rows.some((r) => r.body === `${run}-a`), `user a no longer sees its row in ${TABLE} after the rollback`)
      return `rolled back to v${restorePoint!.versionNum}: ${rollbackTable} is gone; ${TABLE} and its rows are as they were`
    })

    // ── autonomy: a fault the region repairs on its own ──────────────────────
    // Before recovery, so a restore's brief errors cannot hold the repair loop
    // back (it does not change a backend whose error rate is high).
    log('\n── autonomy (a fault the region repairs without being asked)')
    const probeColumn = `qualify_probe_${run}_id`
    const versionsPath = `/api/projects/${args.project}/schema-versions`
    let versionsBeforeFault: Set<string> | null = null
    /** The definition of an index on TABLE that leads with `column`, or null. */
    const indexLeadingWith = async (column: string): Promise<string | null> => {
      const schema = await mcp!.call('get_table_schema', { tableName: TABLE })
      const strings: string[] = []
      const walk = (value: unknown): void => {
        if (typeof value === 'string') strings.push(value)
        else if (Array.isArray(value)) value.forEach(walk)
        else if (value && typeof value === 'object') Object.values(value).forEach(walk)
      }
      walk(schema.structured)
      try {
        walk(JSON.parse(schema.text))
      } catch {
        strings.push(schema.text)
      }
      // pg_indexes writes every definition as "... USING <method> (<columns>)".
      const leads = new RegExp(`USING \\w+ \\(\\s*"?${column}"?\\s*[,)]`)
      return strings.find((s) => /CREATE (UNIQUE )?INDEX/.test(s) && leads.test(s)) ?? null
    }
    await check('autonomy', 'repaired-in-region', ['table', 'sign-in'], async () => {
      versionsBeforeFault = new Set(((await operatorJson(versionsPath)).versions ?? []).map((v: { id: string }) => v.id))
      // The region's repair loop runs at the top of each minute, and home's
      // observer looks at a project 60 s after an MCP change to it. A fault made
      // at second 40 or later reaches the region's loop first.
      const second = new Date().getUTCSeconds()
      if (second < 40) await new Promise((r) => setTimeout(r, (40 - second) * 1_000))
      const since = new Date()
      // With a DEFAULT, ADD COLUMN takes the declared-column path, which adds the
      // column exactly as written and indexes it only when it REFERENCES a table.
      // A column named like a reference with no index is the fault
      // (missing_fk_index, Tier 0), which the loop repairs without asking.
      await fixture('apply_migration', { sql: `ALTER TABLE ${TABLE} ADD COLUMN ${probeColumn} uuid DEFAULT NULL` })
      must(!(await indexLeadingWith(probeColumn)), `${probeColumn} was indexed as it was added, so there is no fault to repair`)
      const deadline = since.getTime() + args.repairWaitMinutes * 60_000
      let indexedAt: number | null = null
      for (;;) {
        const { events } = await operatorJson(
          `/api/projects/${args.project}/autonomy/events?since=${encodeURIComponent(since.toISOString())}&limit=50`,
        )
        const repair = ((events ?? []) as Array<{ action?: string; tableName?: string; full?: string; verified?: boolean; at?: string }>).find(
          (e) => e.action === 'HEALTH_AUTO_FIXED' && e.tableName === TABLE && String(e.full ?? '').includes(`${TABLE}.${probeColumn}`),
        )
        const index = await indexLeadingWith(probeColumn)
        if (repair) {
          must(repair.verified === true, `the repair of ${probeColumn} ran but was not confirmed: ${repair.full}`)
          must(index, `the repair was recorded, but ${TABLE} has no index leading with ${probeColumn}`)
          const after = repair.at ? seconds(Date.parse(repair.at) - since.getTime()) : 'some time'
          return `the region's repair loop indexed ${probeColumn} ${after} after the fault, confirmed, with nobody asking`
        }
        if (index && indexedAt === null) indexedAt = Date.now()
        // The loop records its repair once it is verified, moments after the
        // index. An index with no such record a while later was made elsewhere.
        if (indexedAt !== null && Date.now() - indexedAt > 90_000) {
          throw new Error(
            `${probeColumn} was indexed, but the region's repair loop recorded no confirmed repair: home repaired it, ` +
              `which proves nothing about ${args.region}. Run again`,
          )
        }
        if (Date.now() > deadline) {
          throw new Error(
            `${probeColumn} was not repaired within ${args.repairWaitMinutes} minutes. The region's tasks need ` +
              'ENABLE_AUTONOMY_RECONCILER and ENABLE_AUTONOMY_LIVE_EXECUTION; the autonomy trust report says whether ' +
              'the loop ran in shadow or was held back',
          )
        }
        await new Promise((r) => setTimeout(r, 10_000))
      }
    })
    await check('autonomy', 'probe-rolled-back', ['repaired-in-region'], async () => {
      // The first restore point recorded after the drill began is the one taken
      // just before the probe column was added.
      const recorded = (((await operatorJson(versionsPath)).versions ?? []) as Array<{ id: string; versionNum: number }>)
        .filter((v) => !versionsBeforeFault!.has(v.id))
        .sort((a, b) => a.versionNum - b.versionNum)
      must(recorded.length > 0, `no restore point was recorded before ${probeColumn} was added`)
      const res = await theFetch(homeUrl(versionsPath), asOperator({ method: 'POST', body: JSON.stringify({ versionId: recorded[0].id }) }))
      const body = await json(res)
      must(res.status === 200 && body.success === true, `rolling ${probeColumn} back answered ${res.status}: ${String(body.message ?? body.error ?? '').slice(0, 200)}`)
      must(!(await indexLeadingWith(probeColumn)), `${probeColumn}'s index is still there after the rollback`)
      const state = await mcp!.call('read_backend_state', { section: 'schema' })
      must(!state.text.includes(probeColumn), `${probeColumn} is still in the schema after the rollback`)
      return `rolled back to v${recorded[0].versionNum}: ${probeColumn} and its index are gone`
    })

    // ── recovery ─────────────────────────────────────────────────────────────
    log('\n── recovery (a snapshot, taken and restored in the region)')
    let snapshotId: string | null = null
    const atSnapshot: Record<'a' | 'b', string[]> = { a: [], b: [] }
    const idsOf = async (who: 'a' | 'b') =>
      ((await users[who]!.client[TABLE].list({ limit: 1000 })) as Array<{ id: string }>).map((r) => r.id).sort()
    await check('recovery', 'snapshot', ['sign-in', 'insert-a', 'insert-b'], async () => {
      for (const who of ['a', 'b'] as const) atSnapshot[who] = await idsOf(who)
      const known = new Set(((await operatorJson(snapshotsPath)).data ?? []).map((s: { id: string }) => s.id))
      const started = Date.now()
      const res = await theFetch(homeUrl(snapshotsPath), asOperator({ method: 'POST' }))
      const body = await json(res)
      // A snapshot of a regional project taken at home would be a full copy of
      // its data outside its region: home must queue it for the region instead.
      must(res.status === 202 && body.queued === true, `asking for a snapshot answered ${res.status}, not 202 queued for the region`)
      must(body.region === args.region, `the snapshot was queued for ${body.region}, not ${args.region}`)
      await untilRegionDone(body.jobId, 'the snapshot')
      const taken = ((await operatorJson(snapshotsPath)).data ?? []).filter((s: { id: string }) => !known.has(s.id))
      must(taken.length === 1 && taken[0].status === 'completed', `expected one new completed snapshot, found ${taken.length}`)
      snapshotId = taken[0].id
      return `taken in ${args.region} ${seconds(Date.now() - started)} after the request, ${taken[0].sizeBytes ?? '?'} bytes`
    })
    await check('recovery', 'download-from-region', ['snapshot'], async () => {
      const res = await theFetch(homeUrl(`${snapshotsPath}/${snapshotId}/download`), asOperator({ redirect: 'manual' }))
      must(res.status === 302, `the download answered ${res.status}, not a redirect to the region's bucket`)
      const link = new URL(res.headers.get('location') ?? 'invalid:')
      must(
        link.protocol === 'https:' && link.hostname.endsWith('.amazonaws.com') && link.hostname.includes(args.region),
        `the download link points at ${link.hostname}, not ${args.region}'s bucket`,
      )
      const expires = Number(link.searchParams.get('X-Amz-Expires'))
      must(expires > 0 && expires <= 300, `the download link lasts ${expires} s, not at most 300`)
      // The link is the bucket's own, fetched directly: the bytes never pass the home host.
      const file = await originalFetch(link)
      const bytes = Buffer.from(await file.arrayBuffer())
      must(file.status === 200 && bytes[0] === 0x1f && bytes[1] === 0x8b, `the link answered ${file.status} with ${bytes.length} bytes that are not a gzip`)
      return `${bytes.length} gzip bytes straight from ${link.hostname}, by a link valid ${expires} s`
    })
    await check('recovery', 'restore', ['snapshot'], async () => {
      // Change what the snapshot holds: a row added after it, and one taken away.
      const added = await users.a!.client[TABLE].create({ owner_id: users.a!.id, body: `${run}-after-snapshot` })
      rowsRestoreRemoves.push({ user: 'a', id: added.id })
      await users.a!.client[TABLE].delete(atSnapshot.a[0])
      rowsRestoreReturns.add(atSnapshot.a[0])
      const started = Date.now()
      const res = await theFetch(homeUrl(snapshotsPath), asOperator({ method: 'PUT', body: JSON.stringify({ backupId: snapshotId }) }))
      const body = await json(res)
      must(res.status === 202 && body.queued === true && body.region === args.region, `asking for the restore answered ${res.status}, not 202 queued for ${args.region}`)
      await untilRegionDone(body.jobId, 'the restore')
      const took = Date.now() - started
      for (const who of ['a', 'b'] as const) {
        const now = await idsOf(who)
        must(
          JSON.stringify(now) === JSON.stringify(atSnapshot[who]),
          `after the restore user ${who} sees ${now.length} row(s), not the ${atSnapshot[who].length} it had at the snapshot`,
        )
      }
      return `restored in ${args.region} ${seconds(took)} after the request: each user sees exactly its rows at the snapshot`
    })
    await check('recovery', 'serves-after-restore', ['restore'], async () => {
      for (const who of ['a', 'b'] as const) {
        const res = await theFetch(apiUrl(`/api/v2/${args.project}/${TABLE}?select=id,owner_id`), {
          headers: { 'x-api-key': args.projectKey, authorization: `Bearer ${users[who]!.client.getUserToken()}` },
        })
        const rows = await json(res)
        must(res.status === 200 && Array.isArray(rows), `PostgREST answered ${res.status} for user ${who} after the restore`)
        must(rows.every((r: { owner_id: string }) => r.owner_id === users[who]!.id), `after the restore PostgREST showed user ${who} another user's row`)
        must(rows.length === atSnapshot[who].length, `after the restore PostgREST showed user ${who} ${rows.length} row(s), not ${atSnapshot[who].length}`)
      }
      return 'PostgREST serves the restored table, and each user still sees only its own rows'
    })
    await check('recovery', 'functions-after-restore', ['restore', 'functions'], async () => {
      // A restore recreates the schema's objects; a function's own database role
      // must still be granted them, or the function breaks while the rows are back.
      const outcome = await mcp!.call('functions', { action: 'invoke', name: SANDBOX_FUNCTION })
      const count = /"count"\s*:\s*(\d+)/.exec(outcome.text + JSON.stringify(outcome.structured ?? ''))
      must(count && Number(count[1]) >= atSnapshot.a.length + atSnapshot.b.length, `after the restore ${SANDBOX_FUNCTION} answered ${outcome.text.slice(0, 300)}`)
      return `${SANDBOX_FUNCTION} still reads the restored table (${count![1]} rows)`
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
        // A row deleted before the restore is gone for good if the restore failed.
        if (!rowsRestoreReturns.has(row.id)) log(`  note  could not delete row ${row.id}; remove it by hand`)
      }
    }
    for (const row of rowsRestoreRemoves) {
      // Already gone when the restore worked.
      await users[row.user]?.client[TABLE].delete(row.id).catch(() => {})
    }
    const rolledBack = results.find((r) => r.phase === 'rollback' && r.check === 'undone')?.status === 'pass'
    if (results.some((r) => r.phase === 'rollback' && r.check === 'change' && r.status === 'pass') && !rolledBack) {
      log(`  note  qualify_rollback_${run} may still exist; drop it from the console`)
    }
    const drilled = results.some((r) => r.phase === 'autonomy' && r.check === 'repaired-in-region' && r.status !== 'skip')
    const probeGone = results.find((r) => r.phase === 'autonomy' && r.check === 'probe-rolled-back')?.status === 'pass'
    if (drilled && !probeGone) {
      log(`  note  ${TABLE} may still have the column qualify_probe_${run}_id; roll it back from the console`)
    }
    if (mcp) await (mcp as Mcp).close()
    // Signed out with both of the session's tokens, so neither outlives the run.
    if (session) {
      const s = session as { token: string; refreshToken: string | null }
      await theFetch(homeUrl('/api/auth/logout'), {
        method: 'POST',
        headers: { authorization: `Bearer ${s.token}`, ...(s.refreshToken ? { cookie: `refresh-token=${s.refreshToken}` } : {}) },
      }).catch(() => log('  note  the operator could not be signed out; sign out of every device in the console'))
    }
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
