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
 *     [--job-wait-minutes 15] [--repair-wait-minutes 6] [--freshness-seconds 30] \
 *     [--member <a developer or viewer of the probe project, by email>] \
 *     [--kill-command '<kills the process serving the control plane>'] [--kill-after-seconds 8] \
 *     [--kill-drain-seconds 70] [--settle-wait-minutes 30] [--skip-deletion-drill] \
 *     [--foreign <a project of another region>@<its region>,...]
 *
 * The home region (--region ap-south-1) is qualified the same way through the
 * home host, which serves its data plane: --api is then the home host itself.
 * Its snapshots and restores are taken by the home host while the request
 * waits, and the two checks only a region's own host can make (no console
 * paths; the home host's refusal) are reported as not run.
 *
 * --foreign names projects that live in other regions (the home region's probe
 * project, another region's): the region's host must refuse each of them. No
 * key of theirs is needed, since the refusal comes before any key is read, so
 * name projects that exist: an id with no project resolves to the home region.
 * Without it, that check is reported as not run.
 *
 * The member's password comes from BACKENLY_QUALIFY_MEMBER_PASSWORD (and its
 * current two-factor code, if it has two-factor sign-in, from
 * BACKENLY_QUALIFY_MEMBER_TOTP). The kill command is run with a shell while the
 * drill's governed changes are applying: an ECS stop-task of the web tasks, for
 * instance. Without --member or --kill-command those two drills are reported
 * as not run.
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
 * The probe project's production must not be protected (Settings, or
 * PUT /api/projects/<id>/protection): the run changes its schema directly, and
 * a new Cloud project starts protected.
 *
 * What it checks, in order:
 *   region     the region's host answers health; it serves no console path;
 *              the home host refuses the project with 421 WRONG_REGION, naming
 *              the region and its address; and the region's host refuses every
 *              --foreign project the same way, on /api/v1 and /api/v2, naming
 *              that project's region and an address that is not its own
 *   operator   the probe project's owner signs in at the home host
 *   fixtures   over MCP: the key is the probe project's; a table, an owner-only
 *              policy installed as exact SQL, end-user auth, realtime on the
 *              table, a private bucket, an HTTP function and a sandboxed one
 *   auth       two end users sign up; one refreshes its session and signs out
 *   rls        each user sees exactly its own rows, on /api/v1 and on /api/v2
 *              (PostgREST); a caller with no user sees none
 *   realtime   an insert reaches a subscriber of the table within 15 s; a second
 *              user's stream receives its own insert and never the first user's
 *   storage    upload, download (bytes equal), delete
 *   functions  the HTTP function answers at the region's host; the sandboxed
 *              one reads the region's table
 *   latency    p50 and p95 of 20 reads through the region's host
 *   rollback   a table added over MCP is a governed change, verified; the
 *              console restores the state before it (Restore previous state),
 *              verified; the fixtures and their rows are left as they were
 *   autonomy   a fault the region repairs on its own: a reference column added
 *              over MCP with a DEFAULT, a path that creates no index, is
 *              indexed by the region's repair loop without anyone asking
 *              (missing_fk_index, Tier 0), confirmed by its HEALTH_AUTO_FIXED
 *              record and by the table's own indexes. A repair made from home
 *              instead proves nothing about the region and fails the check. The
 *              fault is timed by the service's clock (its Date header), not this
 *              machine's. When the loop froze changes during an incident
 *              (AUTONOMY_CHANGE_FREEZE in the feed) and nothing repaired, the
 *              drill is reported as not exercised: a skip that leaves the region
 *              unqualified until a calm run shows the repair.
 *              The changes the drill made are then restored from the console,
 *              newest first
 *   rollback drills
 *              Backenly puts a change back on its own when it fails part-way
 *              (a migration whose second statement cannot apply) and when it
 *              fails its verification (a rename that would break end-user
 *              sign-in). A coding agent's request to restore a change waits for
 *              a person, who declines it. A restore that would set rows aside
 *              names them and is refused without a person's acknowledgement,
 *              then runs with it, verified; reapplying brings the table and its
 *              rows back. A restore is refused, changing nothing, while a later
 *              change depends on what it would undo. PostgREST at the region
 *              serves a new table, stops serving a restored one and serves a
 *              reapplied one within --freshness-seconds, each timed, and so do
 *              read_backend_state's tables and schema sections, what a coding
 *              agent reads to learn the backend (one lagged a restore by 12
 *              minutes once). The rollback check above is held to the same bound.
 *              After the console's restore and the acknowledged restore, no
 *              function generated for the removed table (its `<table>-schema`
 *              endpoint) is still listed; after the reapply they are listed
 *              again; once every drill table is gone, none of theirs is left
 *   recovery   the console asks for a snapshot and home queues it for the
 *              region, which takes it; its download link is the region's own
 *              bucket, never the home host; rows changed after it are put back
 *              by a restore the region carries out, and both users then see
 *              exactly their rows from the snapshot, on /api/v1 and PostgREST.
 *              Each wait is timed, from the request to the job's end. With
 *              --member, a member without the administer role is refused the
 *              snapshot restore (403) and a change's restore
 *              The autonomy status the control plane reports closes the phase
 *   process kill
 *              with --kill-command: the process serving the control plane is
 *              killed while the drill's governed changes apply; the change it
 *              cut off is settled by the region's scheduler as needing a person
 *              within --settle-wait-minutes, and the change lock is free again.
 *              Nothing goes on until --kill-drain-seconds have passed (a
 *              graceful stop drains connections for the load balancer's
 *              deregistration delay, then sends SIGTERM, on which the web
 *              process exits at once) and fresh connections to the home host
 *              are answered twice in a row. A graceful stop lets a change
 *              shorter than the drain finish, so when no change was cut off the
 *              drill is reported as not exercised, never as passed: it needs a
 *              change that outlasts the drain (a regional project's, applied
 *              from home, can) or an abrupt kill
 *   deletion   unless --skip-deletion-drill: a project of the drill's own, in
 *              the region, with a governed change, the vault its restore kept
 *              the table in and a preview branch, is deleted, and is gone at
 *              home and in the region
 *   revocation a throwaway key is revoked (a person approves it in the Review
 *              Queue, by design) and the region refuses it; the wait is timed
 * Not here, and reported as not run: the infrastructure failure drills
 * (projection lag, blocked peering, a database failover, killed PostgREST
 * tasks), which need a fault made inside the region's infrastructure and are
 * qualification steps of their own, and a restore refused because its restore
 * point was altered, which needs database access.
 *
 * The fixtures stay for the next run; this run's rows and file are removed, and
 * so is the table the rollback check adds. Its two end users stay, with random
 * passwords nobody keeps, named qualify-<run>-a@example.com and -b@example.com.
 * The snapshot the recovery check takes stays, under the snapshots' own
 * retention.
 */

import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import dns from 'node:dns'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { BackenlyClient } from '@/packages/sdk/src/index'
import { HOME_REGION, findRegion } from '@/lib/regions'

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
  /** The longest PostgREST at the region may take to serve a schema change, or to stop serving what a restore removed. */
  freshnessSeconds: number
  /** Skip the drill that creates, changes, restores and deletes a project of its own in the region. */
  skipDeletionDrill: boolean
  /**
   * A member of the probe project WITHOUT its administer role (a developer or a
   * viewer), who must be refused a snapshot restore. Null: that drill is not run.
   */
  member: { email: string; password: string; totp: string | null } | null
  /**
   * A shell command that kills the process serving the control plane while a
   * governed change is applying (an ECS stop-task, for instance). Null: the
   * mid-change process kill is not run.
   */
  killCommand: string | null
  /** How long after the drill's changes start the kill command runs. */
  killAfterSeconds: number
  /**
   * How long after the kill command returns before anything is sent again: a
   * graceful stop (an ECS stop-task) drains the task's connections for the load
   * balancer's deregistration delay, then sends SIGTERM. Until then a request
   * can still land on the process going away.
   */
  killDrainSeconds: number
  /** How long the region's scheduler is given to settle a change whose process died. */
  settleWaitMinutes: number
  /** Projects of other regions, which the region's host must refuse. Empty: that check is not run. */
  foreign: Array<{ project: string; region: string }>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseArgs(argv: string[], env: Record<string, string | undefined>): QualifyArgs {
  const flags = new Map<string, string>()
  const switches = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--skip-revocation' || arg === '--skip-deletion-drill') {
      switches.add(arg)
      continue
    }
    if (/^--(mcp-key|project-key|key)/.test(arg)) {
      throw new Error('keys are read from BACKENLY_QUALIFY_MCP_KEY and BACKENLY_QUALIFY_PROJECT_KEY only, never from the command line')
    }
    if (/^--member-password/.test(arg)) {
      throw new Error('the member\'s password is read from BACKENLY_QUALIFY_MEMBER_PASSWORD only, never from the command line')
    }
    if (/^--(operator-password|password|token|session)/.test(arg)) {
      throw new Error('the operator\'s password is read from BACKENLY_QUALIFY_OPERATOR_PASSWORD only, never from the command line')
    }
    if (!arg.startsWith('--') || argv[i + 1] === undefined) throw new Error(`unexpected argument: ${arg}`)
    flags.set(arg, argv[++i])
  }
  const known = [
    '--project', '--region', '--api', '--home', '--connect', '--report', '--approval-wait-minutes', '--job-wait-minutes',
    '--repair-wait-minutes', '--operator', '--freshness-seconds', '--member', '--kill-command', '--kill-after-seconds',
    '--kill-drain-seconds', '--settle-wait-minutes', '--foreign',
  ]
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
  if (region === HOME_REGION) {
    // The home region's data plane is served by the home host itself.
    if (api.origin !== home.origin) throw new Error(`--api must be the home host for ${HOME_REGION}, whose projects are served there`)
  } else {
    if (!api.hostname.startsWith(`${region}.api.`)) {
      throw new Error(`--api must be the region's host, ${region}.api.<domain>, not ${api.hostname}`)
    }
    if (api.hostname === home.hostname) throw new Error('--api and --home are the same host: the region must be served apart from home')
  }

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

  const freshness = Number(flags.get('--freshness-seconds') ?? '30')
  if (!Number.isFinite(freshness) || freshness <= 0 || freshness > 600) throw new Error('--freshness-seconds must be between 0 and 600')

  let member: QualifyArgs['member'] = null
  const memberEmail = flags.get('--member')?.trim()
  if (memberEmail !== undefined) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(memberEmail)) throw new Error('--member takes an email: a member of the probe project without its administer role')
    if (memberEmail.toLowerCase() === operator.toLowerCase()) throw new Error('--member must not be the operator, who administers the project')
    const memberPassword = env.BACKENLY_QUALIFY_MEMBER_PASSWORD ?? ''
    if (!memberPassword) throw new Error('BACKENLY_QUALIFY_MEMBER_PASSWORD must hold the member\'s password')
    const memberTotp = env.BACKENLY_QUALIFY_MEMBER_TOTP?.trim() || null
    if (memberTotp !== null && !/^\d{6}$/.test(memberTotp)) {
      throw new Error('BACKENLY_QUALIFY_MEMBER_TOTP, when set, must hold the member\'s current six-digit code')
    }
    member = { email: memberEmail, password: memberPassword, totp: memberTotp }
  }

  const killCommand = flags.get('--kill-command')?.trim() || null
  const killAfter = Number(flags.get('--kill-after-seconds') ?? '8')
  if (!Number.isFinite(killAfter) || killAfter < 1 || killAfter > 120) throw new Error('--kill-after-seconds must be between 1 and 120')
  // A web target group drains for its deregistration delay (30 s; infra #57 sets
  // staging home's to 5 s), and the process exits on the SIGTERM that follows:
  // its own handlers (lib/db/mongodb.ts, lib/services/workspaceDatabase.ts)
  // call process.exit. 70 s also covers one that waited out the 30 s stop timeout.
  const killDrain = Number(flags.get('--kill-drain-seconds') ?? '70')
  if (!Number.isFinite(killDrain) || killDrain < 0 || killDrain > 600) throw new Error('--kill-drain-seconds must be between 0 and 600')
  // A change counts as interrupted 15 minutes after it began (RECOVERY_LEASE_MS),
  // and the region's scheduler settles such changes every 10 minutes.
  const settleWait = Number(flags.get('--settle-wait-minutes') ?? '30')
  if (!Number.isFinite(settleWait) || settleWait <= 0 || settleWait > 120) throw new Error('--settle-wait-minutes must be between 0 and 120')

  const foreign: QualifyArgs['foreign'] = []
  for (const item of (flags.get('--foreign') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id, other, extra] = item.split('@')
    if (!id || !UUID.test(id) || !other || extra !== undefined) throw new Error(`--foreign takes <project id>@<region> pairs, not "${item}"`)
    const known = findRegion(other)
    if (!known) throw new Error(`--foreign names "${other}", which is not a Backenly Cloud region`)
    if (known.id === region) throw new Error(`--foreign ${id} is in ${region}, the region being qualified: name a project of another region`)
    if (id.toLowerCase() === project.toLowerCase()) throw new Error('--foreign must not name the probe project')
    foreign.push({ project: id, region: known.id })
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
    freshnessSeconds: freshness,
    skipDeletionDrill: switches.has('--skip-deletion-drill'),
    member,
    killCommand,
    killAfterSeconds: killAfter,
    killDrainSeconds: killDrain,
    settleWaitMinutes: settleWait,
    foreign,
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

/**
 * The status a GET of `url` gets on a connection of its own: no keep-alive and
 * no pooled socket, so the answer comes from whatever serves a NEW connection
 * now, never from a process still draining an old one. `overrides` are
 * --connect's, kept as `connectingFetch` keeps them. 0 when nothing answered.
 */
export function freshStatus(url: string, overrides: Record<string, string> = {}, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve) => {
    const u = new URL(url)
    const target = overrides[u.hostname.toLowerCase()]
    const transport = u.protocol === 'https:' ? https : http
    const req = transport.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        agent: false,
        headers: { connection: 'close' },
        timeout: timeoutMs,
        ...(target ? { lookup: ((_host: string, options: any, callback: any) => dns.lookup(target, options, callback)) as any } : {}),
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('timeout', () => req.destroy(new Error('timed out')))
    req.on('error', () => resolve(0))
    req.end()
  })
}

/**
 * Wait until `url` answers 200 on `consecutive` fresh connections in a row,
 * and say how long that took. Throws once `byMs` passes without that.
 */
export async function untilAnswering(
  url: string,
  overrides: Record<string, string>,
  opts: { consecutive: number; byMs: number; intervalMs?: number },
): Promise<number> {
  const started = Date.now()
  let inARow = 0
  for (;;) {
    const status = await freshStatus(url, overrides)
    inARow = status === 200 ? inARow + 1 : 0
    if (inARow >= opts.consecutive) return Date.now() - started
    if (Date.now() > opts.byMs) {
      throw new Error(`${new URL(url).host} did not answer ${opts.consecutive} fresh connections in a row (the last got ${status || 'no answer'})`)
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 3_000))
  }
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

/** The `data` a tool answered with ({ ok, summary, data }), from the structured result or its JSON text. */
export function toolData<T>(outcome: ToolOutcome): T | null {
  const candidates: unknown[] = [outcome.structured]
  try {
    candidates.push(JSON.parse(outcome.text))
  } catch {
    // not JSON
  }
  for (const c of candidates) {
    const data = (c as { data?: unknown } | null)?.data
    if (data && typeof data === 'object') return data as T
  }
  return null
}

/**
 * Thrown by a check whose drill this run could not exercise (the region held it back, or the moment it needs never
 * came). Reported as a skip with the reason, never a pass: the region is not qualified until a run exercises it.
 */
export class NotExercised extends Error {}

/**
 * Whether a read_backend_state section's data describes `table`: any value in
 * it names the table (the tables list, relationships, realtime), except the
 * functions list, whose names are the functions' own. A table's generated
 * `<table>-schema` endpoint is a function, not the table; generatedFunctionsFor
 * reads those.
 */
export function describesTable(data: Record<string, unknown>, table: string): boolean {
  const named = new RegExp(`\\b${table}\\b`)
  const mentions = (value: unknown): boolean =>
    typeof value === 'string'
      ? named.test(value)
      : Array.isArray(value)
        ? value.some(mentions)
        : value !== null && typeof value === 'object' && Object.values(value).some(mentions)
  return Object.entries(data).some(([key, value]) => key !== 'functions' && mentions(value))
}

/** The functions a schema section lists that were generated for `table`: named `<table>-…`. */
export function generatedFunctionsFor(data: Record<string, unknown>, table: string): string[] {
  const names = (data.functions as { names?: unknown } | undefined)?.names
  return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string' && name.startsWith(`${table}-`)) : []
}

/**
 * A server's clock minus this machine's, in ms, from its Date header (whole
 * seconds, so its midpoint) and when the request went out and came back. 0
 * when the header is missing or unreadable.
 */
export function clockOffsetFromDate(header: string | null, sent: number, received: number): number {
  const date = Date.parse(header ?? '')
  return Number.isFinite(date) ? date + 500 - (sent + received) / 2 : 0
}

/**
 * A failed call's text for the report. The SDK throws BackenlyError (an Error
 * with code and status beside its message); anything else is shown as JSON, so
 * an object never reads "[object Object]".
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const { code, status } = err as Error & { code?: unknown; status?: unknown }
    const extra = [code, status].filter((v) => v !== undefined && v !== null && v !== '').join(' ')
    return extra ? `${err.message} (${extra})` : err.message
  }
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
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
    const outcome = await this.attempt(name, args)
    if (!outcome.ok) throw new Error(`${name}: ${outcome.text.slice(0, 500)}`)
    return outcome
  }

  /**
   * A call whose refusal is the point: the tool's answer either way, with `ok`
   * false where `call` would throw. A refused tool's structured result is its
   * whole body ({ ok: false, code, ... }).
   */
  async attempt(name: string, args: Record<string, unknown>): Promise<ToolOutcome & { ok: boolean }> {
    const result = (await this.client.callTool({ name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>
      structuredContent?: unknown
      isError?: boolean
    }
    const text = (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
    return { ok: !result.isError, text, structured: result.structuredContent ?? null }
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
  // A checkpoint or a vault can only be altered with database access, which a
  // qualification run does not have. Pinned instead by
  // tests/integration/change-restore-point-unavailable.spec.ts and
  // tests/integration/change-ledger-residency.spec.ts.
  'a restore refused because its restore point was altered (needs database access)',
]

/** The answer of a tool call, refused or not: its structured result, or the JSON its text carries. */
export function toolBody<T = Record<string, unknown>>(outcome: ToolOutcome): T | null {
  if (outcome.structured && typeof outcome.structured === 'object') return outcome.structured as T
  try {
    const parsed = JSON.parse(outcome.text)
    return parsed && typeof parsed === 'object' ? (parsed as T) : null
  } catch {
    return null
  }
}

/** How often a queued snapshot or restore is looked at while it waits for its region. */
const JOB_POLL_MS = 5_000

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

export async function qualify(args: QualifyArgs, log: (line: string) => void = console.log): Promise<{ ok: boolean; results: Result[] }> {
  const results: Result[] = []
  /** What this run did not do, beside what no run here does: the report says so rather than passing it. */
  const notRun = [...NOT_RUN]
  const run = randomBytes(4).toString('hex')
  const theFetch = Object.keys(args.connect).length ? connectingFetch(args.connect) : globalThis.fetch
  // The SDK uses the global fetch; route it the same way.
  const originalFetch = globalThis.fetch
  globalThis.fetch = theFetch

  const failed = new Set<string>()
  /** The authorization copy's mode the region host reported (off, shadow, enforce), for the latency check's detail. */
  let authorizationMode: string | null = null
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
      if (err instanceof NotExercised) {
        // Not a pass: the run is not qualified until a run exercises it, and what depends on it is skipped.
        results.push({ phase, check: name, status: 'skip', detail: `not exercised: ${err.message}`, ms: Date.now() - started })
        log(`  skip  ${phase}/${name}: not exercised: ${err.message}`)
        failed.add(name)
        return false
      }
      const detail = describeError(err)
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
  /** The operator's user id, from the sign-in: a new project's body names its owner. */
  let operatorId: string | null = null
  const asOperator = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session!.token}` },
  })
  async function operatorJson(path: string): Promise<any> {
    const res = await theFetch(homeUrl(path), asOperator())
    must(res.status === 200, `GET ${path} at the home host answered ${res.status}`)
    return json(res)
  }

  /**
   * The home host's clock minus this machine's, in ms, from its Date header:
   * whole seconds, so the header's midpoint against the request's. 0 when the
   * header is missing, which leaves this machine's clock in charge.
   */
  async function serviceClockOffsetMs(): Promise<number> {
    const sent = Date.now()
    const res = await theFetch(homeUrl('/api/health'))
    const received = Date.now()
    await res.arrayBuffer().catch(() => undefined)
    return clockOffsetFromDate(res.headers.get('date'), sent, received)
  }

  /** The project's governed changes newer than `seq`, newest first, as the console lists them. */
  async function changesSince(seq: number): Promise<Array<{
    id: string
    seq: number
    touched: string[]
    actor: { type: string }
    outcome: { state: string }
    action: { kind: string; available: boolean; reason?: string; recordId?: string } | null
  }>> {
    const { changes } = await operatorJson(`/api/projects/${args.project}/changes?limit=50`)
    return ((changes ?? []) as Array<{ seq: number }>).filter((c) => c.seq > seq) as any
  }

  /**
   * Restore previous state, as the console does it: the preview's four checks,
   * then the restore, which must come back restored and verified. Only a
   * lossless restore is run here; one that would set data aside needs a person
   * reading what it would set aside, which a qualification run is not.
   */
  async function restoreFromConsole(change: { id: string; seq: number }): Promise<string> {
    const base = `/api/projects/${args.project}/changes/${change.id}`
    const preview = await json(await theFetch(homeUrl(`${base}/preview`), asOperator({ method: 'POST', body: '{}' })))
    must(preview.preview, `the preview of #${change.seq} answered: ${String(preview.error ?? '').slice(0, 200)}`)
    must(
      preview.preview.safety === 'lossless',
      `restoring #${change.seq} is ${preview.preview.safety}, not lossless: ${String(preview.preview.reason ?? '').slice(0, 200)}`,
    )
    const res = await theFetch(homeUrl(`${base}/restore`), asOperator({ method: 'POST', body: JSON.stringify({ seq: change.seq }) }))
    const body = await json(res)
    must(
      res.status === 200 && body.success === true && body.status === 'restored',
      `restoring #${change.seq} answered ${res.status}: ${String(body.error ?? '').slice(0, 200)}`,
    )
    must(body.verification?.outcome === 'confirmed', `#${change.seq} was restored but not verified against its restore point`)
    return `verified, as #${body.recoverySeq}`
  }
  const snapshotsPath = `/api/projects/${args.project}/backup`
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

  /**
   * How long after `since` both of what a coding agent reads to learn the
   * backend list `table`, or stop listing it, within --freshness-seconds:
   * read_backend_state's "tables" section, which answers from the platform's
   * table registry that a change or a restore refreshes when it settles (once
   * it went on describing a restored table for 12 minutes), and its "schema"
   * section, which reads the region's live catalog. `firstRead` says the very
   * first read already agreed, so the time is an upper bound set by the checks
   * before this one, not a measured lag.
   *
   * A section describes the table when anything in its data names it (the
   * tables list, relationships, realtime), except the functions list: those
   * names are functions' own (a table's generated `<table>-schema` endpoint is
   * a function, not the table), and functionsGeneratedFor checks them on their
   * own.
   */
  async function untilDescribed(table: string, want: 'listed' | 'gone', since: number): Promise<{ ms: number; firstRead: boolean }> {
    const bound = since + args.freshnessSeconds * 1_000
    for (let read = 1; ; read++) {
      const behind: string[] = []
      for (const section of ['tables', 'schema'] as const) {
        const listed = await sectionDescribes(section, table)
        if (want === 'listed' ? !listed : listed) behind.push(section)
      }
      if (behind.length === 0) return { ms: Date.now() - since, firstRead: read === 1 }
      if (Date.now() > bound) {
        throw new Error(
          `read_backend_state's ${behind.join(' and ')} section${behind.length > 1 ? 's' : ''} ` +
            `${want === 'listed' ? 'still did not list' : 'still listed'} ${table} ${args.freshnessSeconds} s after it was asked for`,
        )
      }
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }
  /** Whether read_backend_state's `section` describes `table` (describesTable). */
  async function sectionDescribes(section: 'tables' | 'schema', table: string): Promise<boolean> {
    const outcome = await mcp!.call('read_backend_state', { section })
    const data = toolData<Record<string, unknown>>(outcome)
    if (!data) throw new Error(`read_backend_state's ${section} section answered no data: ${outcome.text.slice(0, 160)}`)
    return describesTable(data, table)
  }
  /**
   * The functions read_backend_state's schema section lists that were generated for `table`. A section with no
   * functions list proves nothing either way, so it fails the check rather than passing it.
   */
  async function functionsGeneratedFor(table: string): Promise<string[]> {
    const outcome = await mcp!.call('read_backend_state', { section: 'schema' })
    const data = toolData<Record<string, unknown>>(outcome)
    if (!data || !Array.isArray((data.functions as { names?: unknown } | undefined)?.names)) {
      throw new Error(`read_backend_state's schema section answered no functions list: ${outcome.text.slice(0, 160)}`)
    }
    return generatedFunctionsFor(data, table)
  }
  /** The detail of a passing freshness check. */
  const described = (what: string, table: string, t: { ms: number; firstRead: boolean }, after: string) =>
    `read_backend_state's tables and schema sections ${what} ${table} ${t.firstRead ? 'by the first read, ' : ''}` +
    `${seconds(t.ms)} after ${after}`

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
      // check_approval answers { ok, summary, data: <the approval> }.
      const state = toolData<{ status?: string }>(status)?.status ?? (/\b(executed|rejected|failed|expired|partial)\b/.exec(status.text)?.[1] ?? 'pending')
      if (state === 'executed') return 'approved and executed'
      if (['rejected', 'failed', 'expired', 'partial'].includes(state)) throw new Error(`${what}: approval ${id} is ${state}`)
      await new Promise((r) => setTimeout(r, 15_000))
    }
    throw new Error(`${what}: approval ${id} was not given within ${args.approvalWaitMinutes} minutes`)
  }

  /** A fixture call, waiting out an approval if the control plane parks it. */
  async function fixture(name: string, toolArgs: Record<string, unknown>): Promise<ToolOutcome> {
    const outcome = await mcp!.call(name, toolArgs).catch((err: unknown) => {
      if (describeError(err).includes('BRANCH_REQUIRED')) {
        throw new Error(`${name}: the probe project's production is protected; turn protection off in its Settings, since the run changes its schema directly`)
      }
      throw err
    })
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
      authorizationMode = typeof copy?.mode === 'string' ? copy.mode : null
      return `the region host is ready and not degraded: its own database answers, home answers, authorization copy ${copy?.mode ?? 'unknown'}${typeof copy?.ageMs === 'number' ? ` ${(copy.ageMs / 1000).toFixed(1)} s old` : ''}`
    })
    await check('region', 'project-health', [], async () => {
      const res = await theFetch(apiUrl(`/api/v1/${args.project}/healthz`), { headers: { 'x-api-key': args.projectKey } })
      must(res.status === 200, `GET /api/v1/<project>/healthz at the region answered ${res.status}`)
      return 'the region serves the project'
    })
    // The home region is served by the home host, which serves the console and
    // has no home to refuse its projects: those two checks are a region's.
    const atHome = args.region === HOME_REGION
    if (atHome) {
      notRun.push(`no console at the region host, and the home host's refusal of the project (${HOME_REGION} is served by the home host)`)
    } else await check('region', 'no-console', [], async () => {
      for (const path of ['/app', '/api/projects', '/login']) {
        const res = await theFetch(apiUrl(path), { redirect: 'manual' })
        const body = await json(res)
        must(res.status === 404 && body.code === 'NOT_FOUND', `${path} at the region answered ${res.status}, not the listener's 404`)
      }
      return 'console paths are answered 404 by the region\'s load balancer'
    })
    if (!atHome) await check('region', 'wrong-region-at-home', [], async () => {
      const res = await theFetch(homeUrl(`/api/v1/${args.project}/healthz`), { headers: { 'x-api-key': args.projectKey } })
      const body = await json(res)
      must(res.status === 421, `the home host answered ${res.status} for the regional project, not 421`)
      must(body.code === 'WRONG_REGION' && body.region === args.region, `the refusal names ${body.code}/${body.region}`)
      must(typeof body.apiUrl === 'string' && body.apiUrl.startsWith(args.api.origin), `the refusal points to ${body.apiUrl}, not the region's host`)
      return `421 WRONG_REGION, pointing to ${body.apiUrl}`
    })
    // The other direction: this region's host serves only its own projects. A
    // project of another region is refused before anything about it, its key
    // included, is read here, so no key of it is needed.
    if (args.foreign.length === 0) {
      notRun.push('cross-region isolation at the region host: --foreign named no project of another region')
    }
    for (const other of args.foreign) {
      await check('region', `refuses-${other.region}-project`, [], async () => {
        const answers: string[] = []
        for (const path of [`/api/v1/${other.project}/healthz`, `/api/v2/${other.project}/${TABLE}?select=*&limit=1`]) {
          const res = await theFetch(apiUrl(path))
          const body = await json(res)
          const route = path.split('/').slice(0, 3).join('/')
          must(res.status === 421, `${route} at the ${args.region} host answered ${res.status} for a ${other.region} project, not 421`)
          must(
            body.code === 'WRONG_REGION' && body.region === other.region,
            `the refusal on ${route} names ${body.code}/${body.region}, not WRONG_REGION/${other.region}`,
          )
          // The address is a courtesy (lib/data-plane/serving.ts): a regional host
          // knows its own and the home host's, so another region's may be null.
          // When given, it must be the project's and never this host.
          if (body.apiUrl === null && other.region !== HOME_REGION) {
            answers.push(`${route} 421 with no address (this host is not given ${other.region}'s)`)
            continue
          }
          must(
            typeof body.apiUrl === 'string' && body.apiUrl.includes(other.project) && !body.apiUrl.startsWith(args.api.origin),
            `the refusal on ${route} points to ${body.apiUrl}, not the project's own region`,
          )
          if (other.region === HOME_REGION) {
            must(body.apiUrl.startsWith(args.home.origin), `the refusal on ${route} points to ${body.apiUrl}, not the home host`)
          }
          answers.push(`${route} 421 to ${body.apiUrl}`)
        }
        return `the ${args.region} host refuses ${other.region} project ${other.project.slice(0, 8)}: ${answers.join('; ')}`
      })
    }

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
      operatorId = typeof body.user?.id === 'string' ? body.user.id : null
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
      await fixture('realtime', { action: 'enable', tableName: TABLE })
      return `${TABLE} streams its changes`
    })
    await check('fixtures', 'bucket', ['connect'], async () => {
      const buckets = await mcp!.call('storage', { action: 'list_buckets' })
      if (buckets.text.includes(`"${BUCKET}"`) || new RegExp(`\\b${BUCKET}\\b`).test(buckets.text)) return `bucket ${BUCKET} already exists`
      await fixture('storage', { action: 'create_bucket', bucketName: BUCKET, isPublic: false })
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
        const rows: Array<{ owner_id: string; body: string }> = await users[who]!.client[TABLE].list({ limit: 100 })
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
    await check('realtime', 'others-rows-withheld', ['realtime', 'insert-a', 'insert-b'], async () => {
      // A stream opened as user b: a row user a inserts is not b's to read, so
      // it must not arrive; the row b inserts right after must. Changes reach a
      // stream in the order they were made, so a's would have come first.
      const a = users.a!.client
      const b = users.b!.client
      const ticketRes = await theFetch(apiUrl(`/api/v1/${args.project}/realtime/ticket`), {
        method: 'POST',
        headers: { 'x-api-key': args.projectKey, 'content-type': 'application/json', 'X-User-Token': b.getUserToken() },
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
      const othersMarker = `${run}-realtime-not-yours`
      const ownMarker = `${run}-realtime-yours`
      let inserted = false
      const timer = setTimeout(() => controller.abort(), 15_000)
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) throw new Error('the stream ended before user b\'s own insert arrived')
          for (const event of sse.push(decoder.decode(value, { stream: true }))) {
            must(!event.data.includes(othersMarker), "user b's stream received user a's row")
            let data: { type?: string; table?: string } = {}
            try {
              data = JSON.parse(event.data)
            } catch {
              continue
            }
            if (data.type === 'connected' && !inserted) {
              inserted = true
              const theirs = await a[TABLE].create({ owner_id: users.a!.id, body: othersMarker })
              madeRows.push({ user: 'a', id: theirs.id })
              const own = await b[TABLE].create({ owner_id: users.b!.id, body: ownMarker })
              madeRows.push({ user: 'b', id: own.id })
            }
            if (data.type === 'insert' && data.table === TABLE && event.data.includes(ownMarker)) {
              return "user b received its own insert and not user a's, which was made first"
            }
          }
        }
      } catch (err) {
        if (controller.signal.aborted) throw new Error("user b's own insert did not arrive within 15 s")
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
      // Plain text: the upload route refuses executable extensions (.bin among them).
      const bytes = Buffer.from(randomBytes(1024).toString('hex'))
      const file = new File([bytes], `qualify-${run}.txt`, { type: 'text/plain' })
      const up = await a.storage.upload(file, `qualify/${run}.txt`, { bucket: BUCKET })
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
      // The runtime answers with the function's own status and keeps its
      // envelope: { success, name, result: { status, body }, logs, durationMs }.
      must(res.status === 200 && body.success === true && body.result?.body?.ok === true, `the function answered ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
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
      const where =
        args.region === HOME_REGION
          ? 'each key checked at home, where the project lives'
          : authorizationMode === 'enforce'
            ? "each key checked against the region's own authorization copy while it is fresh, at home otherwise"
            : `each key still checked in the home region (authorization copy ${authorizationMode ?? 'not reported'})`
      return `p50 ${p50} ms, p95 ${p95} ms over 20 reads (from where this runs; ${where})`
    })

    // ── rollback ─────────────────────────────────────────────────────────────
    log('\n── rollback (a governed change, restored from the console)')
    const rollbackTable = `qualify_rollback_${run}`
    let restorable: { id: string; seq: number } | null = null
    await check('rollback', 'change', ['table', 'sign-in'], async () => {
      await fixture('apply_migration', { sql: `CREATE TABLE ${rollbackTable} (note text)` })
      // Every schema change is a governed change: checkpointed, applied, and
      // verified by Backenly in the region it ran in.
      const changes = await changesSince(0)
      const made = changes.find((c) => c.touched.includes(rollbackTable))
      must(made, `no governed change was recorded for ${rollbackTable}`)
      must(made.outcome.state === 'healthy', `the change that created ${rollbackTable} is ${made.outcome.state}, not applied and verified`)
      restorable = { id: made.id, seq: made.seq }
      return `${rollbackTable} created over MCP as change #${made.seq}, applied and verified`
    })
    let undoneAt = 0
    await check('rollback', 'undone', ['change', 'insert-a'], async () => {
      undoneAt = Date.now()
      const restored = await restoreFromConsole(restorable!)
      // The region's live catalog: the restore runs on the region's database.
      const gone = await mcp!.call('get_table_schema', { tableName: rollbackTable }).then((o) => o.text, (err: unknown) => describeError(err))
      must(/does not exist/i.test(gone), `${rollbackTable} is still in the region's schema after the restore: ${gone.slice(0, 160)}`)
      const tables = await mcp!.call('read_backend_state', { section: 'tables' })
      must(tables.text.includes(TABLE), `the restore removed ${TABLE}, which was there before the change`)
      const rows: Array<{ body: string }> = await users.a!.client[TABLE].list({ limit: 100 })
      must(rows.some((r) => r.body === `${run}-a`), `user a no longer sees its row in ${TABLE} after the restore`)
      return `restored the state before #${restorable!.seq} (${restored}): ${rollbackTable} is gone; ${TABLE} and its rows are as they were`
    })
    await check('rollback', 'described-after-undo', ['undone'], async () => {
      return described('stopped describing', rollbackTable, await untilDescribed(rollbackTable, 'gone', undoneAt), 'the restore was asked for')
    })
    await check('rollback', 'functions-after-undo', ['described-after-undo'], async () => {
      const left = await functionsGeneratedFor(rollbackTable)
      must(left.length === 0, `the restore removed ${rollbackTable} but left the functions generated for it: ${left.join(', ')}`)
      return `no function generated for ${rollbackTable} is listed once the restore removed it`
    })

    // ── autonomy: a fault the region repairs on its own ──────────────────────
    // Before recovery, so a restore's brief errors cannot hold the repair loop
    // back (it does not change a backend whose error rate is high).
    log('\n── autonomy (a fault the region repairs without being asked)')
    const probeColumn = `qualify_probe_${run}_id`
    /** The newest change before the drill: everything after it is the drill's to restore. */
    let seqBeforeFault: number | null = null
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
      seqBeforeFault = (await changesSince(0))[0]?.seq ?? 0
      // The region's repair loop runs at the top of each minute, and home's
      // observer looks at a project 60 s after an MCP change to it. A fault made
      // at second 40 or later reaches the region's loop first. Seconds on the
      // service's clock: this machine's may be minutes off (a qualification ran
      // with its clock 3.5 min slow and made the fault at second 9).
      const offset = await serviceClockOffsetMs()
      const second = new Date(Date.now() + offset).getUTCSeconds()
      if (second < 40) await new Promise((r) => setTimeout(r, (40 - second) * 1_000))
      const since = new Date()
      const sinceOnService = new Date(since.getTime() + offset)
      // With a DEFAULT, ADD COLUMN takes the declared-column path, which adds the
      // column exactly as written and indexes it only when it REFERENCES a table.
      // A column named like a reference with no index is the fault
      // (missing_fk_index, Tier 0), which the loop repairs without asking.
      await fixture('apply_migration', { sql: `ALTER TABLE ${TABLE} ADD COLUMN ${probeColumn} uuid DEFAULT NULL` })
      must(!(await indexLeadingWith(probeColumn)), `${probeColumn} was indexed as it was added, so there is no fault to repair`)
      const deadline = since.getTime() + args.repairWaitMinutes * 60_000
      let indexedAt: number | null = null
      /** The newest of the loop's change freezes in the window (it writes one on every frozen tick): it repairs nothing then. */
      let frozen: { at?: string; full?: string } | null = null
      for (;;) {
        const { events } = await operatorJson(
          // include=held adds the loop's change-freeze rows (AUTONOMY_CHANGE_FREEZE) to the feed; a server
          // without it ignores the parameter, and a freeze then reads as a repair that never came.
          `/api/projects/${args.project}/autonomy/events?since=${encodeURIComponent(sinceOnService.toISOString())}&limit=50&include=held`,
        )
        type Event = { action?: string; tableName?: string; full?: string; verified?: boolean; at?: string }
        const repair = ((events ?? []) as Event[]).find(
          (e) => e.action === 'HEALTH_AUTO_FIXED' && e.tableName === TABLE && String(e.full ?? '').includes(`${TABLE}.${probeColumn}`),
        )
        for (const e of (events ?? []) as Event[]) {
          if (e.action !== 'AUTONOMY_CHANGE_FREEZE' || !e.at || Number.isNaN(Date.parse(e.at))) continue
          if (!frozen?.at || Date.parse(e.at) > Date.parse(frozen.at)) frozen = e
        }
        const index = await indexLeadingWith(probeColumn)
        if (repair) {
          must(repair.verified === true, `the repair of ${probeColumn} ran but was not confirmed: ${repair.full}`)
          must(index, `the repair was recorded, but ${TABLE} has no index leading with ${probeColumn}`)
          const after = repair.at ? seconds(Date.parse(repair.at) - sinceOnService.getTime()) : 'some time'
          return (
            `the region's repair loop indexed ${probeColumn} ${after} after the fault, confirmed, with nobody asking ` +
            `(the service's clock ${seconds(Math.abs(offset))} ${offset >= 0 ? 'ahead of' : 'behind'} this machine's)`
          )
        }
        if (index && indexedAt === null) indexedAt = Date.now()
        // The loop records its repair once it is verified, moments after the
        // index. An index with no such record a while later was made elsewhere.
        if (indexedAt !== null && Date.now() - indexedAt > 90_000) {
          throw new Error(
            `${probeColumn} was indexed, but the region's repair loop recorded no confirmed repair: ` +
              (args.region === HOME_REGION
                ? 'another path at home made it (the observer that runs 60 s after a change), which proves nothing about the loop'
                : `home repaired it, which proves nothing about ${args.region}`) +
              '. Run again',
          )
        }
        if (Date.now() > deadline) {
          // A freeze is the loop doing its job (it changes no backend mid-incident), not a failed repair; but the
          // repair was not shown either, so the drill is reported as not exercised and the region is not qualified.
          // Only a freeze still holding at the end (one in its last two minutes, on the service's clock) explains a
          // repair that never came, and only while nothing else indexed the column: that stays a failure above.
          const stillFrozen = frozen?.at !== undefined && deadline + offset - Date.parse(frozen.at) <= 120_000
          if (frozen && stillFrozen && indexedAt === null) {
            throw new NotExercised(
              `held back by an incident freeze: the repair loop froze autonomous changes` +
                `${frozen.at ? ` at ${frozen.at}` : ''} (${String(frozen.full ?? 'mid-incident').slice(0, 160)}) and ` +
                `${probeColumn} was not repaired within ${args.repairWaitMinutes} minutes; run again when the project is calm`,
            )
          }
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
      // The drill made two changes to TABLE: the probe column (over MCP), then
      // its index (the region's repair loop). A later change to a table blocks
      // restoring an earlier one, so they are restored newest first.
      const drill = (await changesSince(seqBeforeFault!)).filter((c) => c.action?.kind === 'restore' && c.touched.includes(TABLE))
      must(drill.length > 0, `no governed change was recorded for ${probeColumn}`)
      const done: string[] = []
      for (const c of drill) done.push(`#${c.seq} ${await restoreFromConsole({ id: c.id, seq: c.seq })}`)
      must(!(await indexLeadingWith(probeColumn)), `${probeColumn}'s index is still there after the restore`)
      // The table's own columns: read_backend_state's schema section counts columns and never names them.
      const described = toolData<{ columns?: Array<{ name?: string }> }>(await mcp!.call('get_table_schema', { tableName: TABLE }))
      const columns = (described?.columns ?? []).map((c) => c.name)
      must(columns.length > 0, `get_table_schema listed no columns for ${TABLE}`)
      must(!columns.includes(probeColumn), `${probeColumn} is still in the schema after the restore`)
      return `restored the state before ${done.join(', then ')}: ${probeColumn} and its index are gone`
    })

    // ── rollback drills ──────────────────────────────────────────────────────
    // The rollback check above restores a change a person chose to restore,
    // losslessly. These are the other ways rollback has to hold up in a region:
    // Backenly putting a failed change back on its own, a restore that needs a
    // person because it sets rows aside, one refused because a later change
    // depends on what it would undo, and how soon PostgREST at the region
    // serves what each of them did.
    log('\n── rollback drills (recovery on its own, recovery that needs a person, recovery refused)')
    /** The newest change before the drills, so the drills' changes are told apart from older ones. */
    let seqBeforeDrills = 0

    /** A table's columns in the region's catalog; null when the table does not exist. */
    const columnsOf = async (table: string): Promise<string[] | null> => {
      const out = await mcp!.attempt('get_table_schema', { tableName: table })
      if (!out.ok) {
        if (/does not exist/i.test(out.text)) return null
        throw new Error(`get_table_schema ${table}: ${out.text.slice(0, 200)}`)
      }
      return (toolData<{ columns?: Array<{ name?: string }> }>(out)?.columns ?? []).map((c) => String(c.name))
    }

    /** The newest governed change after `seq` that touched `table`. */
    const changeTouching = async (table: string, seq: number) => {
      const found = (await changesSince(seq)).find((c) => c.touched.includes(table))
      must(found, `no governed change was recorded for ${table}`)
      return found!
    }

    /** What PostgREST at the region answers when a table is read with the probe project's publishable key. */
    const servedStatus = async (table: string): Promise<number> =>
      (await theFetch(apiUrl(`/api/v2/${args.project}/${table}?select=*&limit=1`), { headers: { 'x-api-key': args.projectKey } })).status

    /**
     * Milliseconds from `since` until PostgREST at the region serves `table` (a
     * 200), or stops serving it, within --freshness-seconds. PostgREST answers
     * from a schema cache, so this is how long a change, a restore or a reapply
     * takes to reach an app.
     */
    const untilServed = async (table: string, want: 'served' | 'gone', since: number): Promise<number> => {
      const bound = since + args.freshnessSeconds * 1_000
      for (;;) {
        const status = await servedStatus(table)
        if (want === 'served' ? status === 200 : status !== 200) return Date.now() - since
        if (Date.now() > bound) {
          throw new Error(
            `PostgREST at the region was ${want === 'served' ? 'still not serving' : 'still serving'} ${table} ` +
              `${args.freshnessSeconds} s after the change (it answered ${status})`,
          )
        }
        await new Promise((r) => setTimeout(r, 250))
      }
    }

    /** One change's preview or restore from the console, as the operator. */
    const changeCall = async (projectId: string, changeId: string, what: 'preview' | 'restore', body: unknown) => {
      const res = await theFetch(
        homeUrl(`/api/projects/${projectId}/changes/${changeId}/${what}`),
        asOperator({ method: 'POST', body: JSON.stringify(body) }),
      )
      return { status: res.status, body: await json(res) }
    }

    await check('rollback-drills', 'nothing-waiting', ['sign-in', 'connect'], async () => {
      const recent = await changesSince(0)
      // Backenly does not put a change back on its own while another one waits
      // for a person (recoverAutomatically), so a drill would read as a failure.
      const waiting = recent.filter((c) => c.outcome.state === 'needs_attention' || c.outcome.state === 'in_progress')
      must(
        waiting.length === 0,
        `${waiting.map((c) => `#${c.seq}`).join(', ')} waits for a person or is in progress, and Backenly recovers nothing on its own ` +
          'meanwhile: settle them in the console (Restore previous state, or Keep) and run again',
      )
      seqBeforeDrills = recent[0]?.seq ?? 0
      return 'no change waits for a person, so Backenly may recover on its own'
    })

    await check('rollback-drills', 'recovered-after-failing-part-way', ['nothing-waiting', 'insert-a'], async () => {
      // The first statement takes; the second cannot, because this run's rows in
      // TABLE are longer than it allows. The new table is empty, so putting the
      // state back loses nothing and Backenly does it without asking.
      const made = `qualify_partway_${run}`
      const out = await mcp!.attempt('apply_migration', {
        sql: `CREATE TABLE ${made} (note text);\nALTER TABLE ${TABLE} ADD CONSTRAINT qualify_tight_${run} CHECK (length(body) < 3)`,
      })
      const body = toolBody<{ code?: string; recovered?: boolean; change?: { seq?: number; status?: string } }>(out)
      must(!out.ok && body?.code === 'MIGRATION_FAILED', `the migration did not fail part-way, as the drill needs: ${out.text.slice(0, 200)}`)
      must(
        body?.recovered === true && body.change?.status === 'recovered',
        `Backenly did not put the state back on its own: ${JSON.stringify(body?.change ?? null).slice(0, 200)}`,
      )
      must((await columnsOf(made)) === null, `${made} is still in the region's schema after the recovery`)
      const listed = (await changesSince(seqBeforeDrills)).find((c) => c.seq === body!.change!.seq)
      must(listed?.outcome.state === 'recovered', `the console lists change #${body!.change!.seq} as ${listed?.outcome.state ?? 'missing'}, not recovered`)
      return `change #${body!.change!.seq} failed part-way, and Backenly put the state before it back on its own: ${made} is gone`
    })

    await check('rollback-drills', 'recovered-after-failing-verification', ['nothing-waiting', 'sign-up-a'], async () => {
      // A rename of a column end-user sign-in needs applies cleanly and fails
      // Backenly's own verification, since sign-in would break. Renaming it back
      // loses nothing, so Backenly does it without asking.
      const out = await mcp!.attempt('apply_migration', { sql: 'ALTER TABLE users RENAME COLUMN email TO login_email' })
      const body = toolBody<{ code?: string; recovered?: boolean; change?: { seq?: number; status?: string; reason?: string } }>(out)
      must(!out.ok && body?.code === 'VERIFICATION_FAILED', `the rename did not fail verification, as the drill needs: ${out.text.slice(0, 200)}`)
      must(
        body?.recovered === true && body.change?.status === 'recovered',
        `Backenly did not put users back on its own: ${JSON.stringify(body?.change ?? null).slice(0, 200)}`,
      )
      const columns = await columnsOf('users')
      must(columns?.includes('email') && !columns.includes('login_email'), `users is not as it was after the recovery: ${columns?.join(', ')}`)
      return `change #${body!.change!.seq} failed verification (${String(body!.change!.reason ?? 'sign-in would break').slice(0, 120)}), and Backenly renamed the column back on its own`
    })

    const keptTable = `qualify_kept_${run}`
    let kept: { id: string; seq: number } | null = null
    /** When the drill's change, its acknowledged restore and the reapply were each asked for. */
    const keptAt = { applied: 0, restored: 0, reapplied: 0 }
    await check('rollback-drills', 'served-after-a-change', ['nothing-waiting'], async () => {
      const started = Date.now()
      await fixture('apply_migration', { sql: `CREATE TABLE ${keptTable} (note text)` })
      const applied = Date.now()
      keptAt.applied = applied
      const made = await changeTouching(keptTable, seqBeforeDrills)
      must(made.outcome.state === 'healthy', `the change that created ${keptTable} is ${made.outcome.state}, not applied and verified`)
      kept = { id: made.id, seq: made.seq }
      const ms = await untilServed(keptTable, 'served', applied)
      return `change #${made.seq} applied and verified in ${seconds(applied - started)}; PostgREST at the region served ${keptTable} ${seconds(ms)} later`
    })
    await check('rollback-drills', 'described-after-a-change', ['served-after-a-change'], async () => {
      return described('described', keptTable, await untilDescribed(keptTable, 'listed', keptAt.applied), 'the change applied')
    })

    await check('rollback-drills', 'agent-asks-a-person-decides', ['served-after-a-change'], async () => {
      for (const n of [1, 2, 3]) await fixture('db_insert', { table: keptTable, row: { note: `${run}-${n}` } })
      // A coding agent may ask for a restore; only a person can let it run.
      const asked = await mcp!.attempt('deploy', { action: 'revert_change', changeId: kept!.id })
      const approvalId = pendingApproval(asked)
      must(approvalId, `the agent's request to restore #${kept!.seq} was not parked for a person: ${asked.text.slice(0, 200)}`)
      must((await columnsOf(keptTable)) !== null, `${keptTable} changed while the agent's request waited for a person`)
      // The operator declines it here; the restore below is the operator's own.
      const declined = await theFetch(
        homeUrl(`/api/projects/${args.project}/agent-approvals`),
        asOperator({ method: 'POST', body: JSON.stringify({ approvalId, decision: 'reject' }) }),
      )
      must(declined.ok, `declining the agent's request answered ${declined.status}`)
      must((await columnsOf(keptTable)) !== null, `${keptTable} changed when the agent's request was declined`)
      return `the agent asked to restore #${kept!.seq}; the request waited for a person (${approvalId}), who declined it, and nothing changed`
    })

    let acknowledgement: Record<string, number> | null = null
    await check('rollback-drills', 'restore-needs-a-person', ['agent-asks-a-person-decides'], async () => {
      const preview = (await changeCall(args.project, kept!.id, 'preview', {})).body.preview
      must(
        preview?.safety === 'needs_approval',
        `restoring #${kept!.seq} is ${preview?.safety ?? 'not previewed'}, not needs_approval: ${String(preview?.reason ?? '').slice(0, 200)}`,
      )
      acknowledgement = (preview.acknowledgement ?? null) as Record<string, number> | null
      const setAside = Object.entries(acknowledgement ?? {}).find(([key]) => key.startsWith('rows_set_aside:') && key.includes(keptTable))
      must(setAside?.[1] === 3, `the preview measured ${JSON.stringify(acknowledgement)}, not the 3 rows this run wrote to ${keptTable}`)
      const refused = await changeCall(args.project, kept!.id, 'restore', { seq: kept!.seq })
      must(
        refused.status === 409 && refused.body.code === 'NEEDS_APPROVAL',
        `a restore without the acknowledgement answered ${refused.status} ${refused.body.code ?? ''}, not 409 NEEDS_APPROVAL`,
      )
      must((await columnsOf(keptTable)) !== null, `${keptTable} changed although the restore was refused`)
      return 'the preview names the 3 rows the restore would set aside; without a person acknowledging them the restore was refused, and nothing changed'
    })

    let recoveryRecord: string | null = null
    await check('rollback-drills', 'restored-with-acknowledgement', ['restore-needs-a-person'], async () => {
      const asked = Date.now()
      keptAt.restored = asked
      const res = await changeCall(args.project, kept!.id, 'restore', { seq: kept!.seq, acknowledged: acknowledgement })
      must(res.status === 200 && res.body.status === 'restored', `the acknowledged restore answered ${res.status}: ${String(res.body.error ?? '').slice(0, 200)}`)
      must(res.body.verification?.outcome === 'confirmed', `#${kept!.seq} was restored but not verified against its restore point`)
      recoveryRecord = typeof res.body.recoveryId === 'string' ? res.body.recoveryId : null
      must((await columnsOf(keptTable)) === null, `${keptTable} is still in the region's schema after the restore`)
      const ms = await untilServed(keptTable, 'gone', asked)
      return `restored as #${res.body.recoverySeq} and verified, its 3 rows kept aside; PostgREST at the region stopped serving ${keptTable} ${seconds(ms)} after the restore was asked for`
    })
    await check('rollback-drills', 'described-after-acknowledged-restore', ['restored-with-acknowledgement'], async () => {
      return described('stopped describing', keptTable, await untilDescribed(keptTable, 'gone', keptAt.restored), 'the restore was asked for')
    })
    await check('rollback-drills', 'functions-after-acknowledged-restore', ['described-after-acknowledged-restore'], async () => {
      const left = await functionsGeneratedFor(keptTable)
      must(left.length === 0, `the restore removed ${keptTable} but left the functions generated for it: ${left.join(', ')}`)
      return `no function generated for ${keptTable} is listed once the restore removed it`
    })

    await check('rollback-drills', 'reapplied-and-served', ['restored-with-acknowledgement'], async () => {
      // Reapplying restores the restore: the table comes back, with its rows.
      must(recoveryRecord, 'the restore named no recovery record to reapply')
      const preview = (await changeCall(args.project, recoveryRecord!, 'preview', {})).body.preview
      must(
        preview?.action === 'reapply' && preview.safety === 'lossless',
        `reapplying #${kept!.seq} is ${preview?.safety ?? 'not previewed'}: ${String(preview?.reason ?? '').slice(0, 200)}`,
      )
      const asked = Date.now()
      keptAt.reapplied = asked
      const res = await changeCall(args.project, recoveryRecord!, 'restore', { seq: preview.seq })
      must(res.status === 200 && res.body.verification?.outcome === 'confirmed', `the reapply answered ${res.status}: ${String(res.body.error ?? '').slice(0, 200)}`)
      const ms = await untilServed(keptTable, 'served', asked)
      const rows = toolData<{ rows?: unknown[] }>(await mcp!.call('db_query', { table: keptTable, limit: 10 }))?.rows ?? []
      must(rows.length === 3, `${keptTable} came back with ${rows.length} rows, not its 3`)
      return `reapplied and verified, with its 3 rows; PostgREST at the region served ${keptTable} again ${seconds(ms)} after the reapply was asked for`
    })
    await check('rollback-drills', 'described-after-reapply', ['reapplied-and-served'], async () => {
      return described('described again', keptTable, await untilDescribed(keptTable, 'listed', keptAt.reapplied), 'the reapply was asked for')
    })
    // Only a restore that removed them shows the reapply bringing them back.
    await check('rollback-drills', 'functions-after-reapply', ['described-after-reapply', 'functions-after-acknowledged-restore'], async () => {
      // Every table gets a generated `<table>-schema` endpoint; the reapply brought the table back, so it is back too.
      const listed = await functionsGeneratedFor(keptTable)
      must(listed.includes(`${keptTable}-schema`), `the reapply brought ${keptTable} back without its generated functions: listed ${listed.join(', ') || 'none'}`)
      return `the functions generated for ${keptTable} are listed again: ${listed.join(', ')}`
    })

    const parentTable = `qualify_parent_${run}`
    await check('rollback-drills', 'restore-refused-under-a-later-change', ['nothing-waiting'], async () => {
      await fixture('apply_migration', { sql: `CREATE TABLE ${parentTable} (note text)` })
      const first = await changeTouching(parentTable, seqBeforeDrills)
      await fixture('apply_migration', { sql: `ALTER TABLE ${parentTable} ADD COLUMN later text` })
      const second = await changeTouching(parentTable, first.seq)
      const preview = (await changeCall(args.project, first.id, 'preview', {})).body.preview
      must(preview?.safety === 'blocked', `restoring #${first.seq} with #${second.seq} in effect is ${preview?.safety ?? 'not previewed'}, not blocked`)
      must(
        ((preview.blockedBy ?? []) as Array<{ seq?: number }>).some((b) => b.seq === second.seq),
        `the preview does not name #${second.seq} as what blocks it: ${JSON.stringify(preview.blockedBy ?? []).slice(0, 200)}`,
      )
      const refused = await changeCall(args.project, first.id, 'restore', { seq: first.seq })
      must(refused.status === 409 && refused.body.code === 'CONFLICT', `the restore answered ${refused.status} ${refused.body.code ?? ''}, not 409 CONFLICT`)
      must((await columnsOf(parentTable))?.includes('later'), `${parentTable} changed although the restore was refused`)
      // Newest first, both can go.
      const undone = [`#${second.seq} ${await restoreFromConsole(second)}`, `#${first.seq} ${await restoreFromConsole(first)}`]
      must((await columnsOf(parentTable)) === null, `${parentTable} is still in the region's schema after both restores`)
      return `restoring #${first.seq} was refused while #${second.seq} depends on it, and nothing changed; newest first, both were restored: ${undone.join(', then ')}`
    })

    await check('rollback-drills', 'drill-tables-removed', ['reapplied-and-served'], async () => {
      // keptTable is back after the reapply: restoring its change again, with
      // the person's acknowledgement of its rows, leaves the project as it was.
      const preview = (await changeCall(args.project, kept!.id, 'preview', {})).body.preview
      must(preview?.acknowledgement, `restoring #${kept!.seq} again asked for no acknowledgement: ${preview?.safety ?? 'not previewed'}`)
      const res = await changeCall(args.project, kept!.id, 'restore', { seq: kept!.seq, acknowledged: preview.acknowledgement })
      must(res.status === 200 && res.body.status === 'restored', `the final restore answered ${res.status}: ${String(res.body.error ?? '').slice(0, 200)}`)
      must((await columnsOf(keptTable)) === null, `${keptTable} is still in the region's schema`)
      return `${keptTable} is gone again, its rows kept aside in the restore's vault`
    })
    // Each drill that created and removed one of these tables must have run, or "none left" proves nothing.
    await check(
      'rollback-drills',
      'functions-after-drill-restores',
      ['drill-tables-removed', 'recovered-after-failing-part-way', 'restore-refused-under-a-later-change', 'functions-after-reapply'],
      async () => {
        // Every drill table is gone: put back automatically (partway), restored newest first (parent), restored again
        // (kept). None may leave its generated functions behind.
        const tables = [`qualify_partway_${run}`, parentTable, keptTable]
        const left = (await Promise.all(tables.map((t) => functionsGeneratedFor(t)))).flat()
        must(left.length === 0, `the drills removed their tables but left the functions generated for them: ${left.join(', ')}`)
        return `no function generated for ${tables.join(', ')} is listed once their tables were removed`
      },
    )

    // ── recovery ─────────────────────────────────────────────────────────────
    log('\n── recovery (a snapshot, taken and restored in the region)')
    let snapshotId: string | null = null
    const atSnapshot: Record<'a' | 'b', string[]> = { a: [], b: [] }
    const idsOf = async (who: 'a' | 'b') =>
      ((await users[who]!.client[TABLE].list({ limit: 100 })) as Array<{ id: string }>).map((r) => r.id).sort()
    await check('recovery', 'snapshot', ['sign-in', 'insert-a', 'insert-b'], async () => {
      for (const who of ['a', 'b'] as const) atSnapshot[who] = await idsOf(who)
      const known = new Set(((await operatorJson(snapshotsPath)).data ?? []).map((s: { id: string }) => s.id))
      const started = Date.now()
      const res = await theFetch(homeUrl(snapshotsPath), asOperator({ method: 'POST' }))
      const body = await json(res)
      if (atHome) {
        // A home project's snapshot is taken by the home host, while it waits;
        // the list below finds it (the answer describes the file, not its row).
        must(res.status === 201 && body.success === true, `asking for a snapshot answered ${res.status}, not 201 with the snapshot`)
      } else {
        // A snapshot of a regional project taken at home would be a full copy of
        // its data outside its region: home must queue it for the region instead.
        must(res.status === 202 && body.queued === true, `asking for a snapshot answered ${res.status}, not 202 queued for the region`)
        must(body.region === args.region, `the snapshot was queued for ${body.region}, not ${args.region}`)
        await untilRegionDone(body.jobId, 'the snapshot')
      }
      const taken = ((await operatorJson(snapshotsPath)).data ?? []).filter((s: { id: string }) => !known.has(s.id))
      must(taken.length === 1 && taken[0].status === 'completed', `expected one new completed snapshot, found ${taken.length}`)
      snapshotId = taken[0].id
      return `taken in ${args.region} ${seconds(Date.now() - started)} after the request, ${taken[0].sizeBytes ?? '?'} bytes`
    })
    await check('recovery', 'download-from-region', ['snapshot'], async () => {
      const res = await theFetch(homeUrl(`${snapshotsPath}/${snapshotId}/download`), asOperator({ redirect: 'manual' }))
      if (atHome) {
        // The home region's snapshots are kept by the home host, which sends the file itself.
        const bytes = Buffer.from(await res.arrayBuffer())
        must(res.status === 200 && bytes[0] === 0x1f && bytes[1] === 0x8b, `the download answered ${res.status} with ${bytes.length} bytes that are not a gzip`)
        return `${bytes.length} gzip bytes from the home host, which keeps the home region's snapshots`
      }
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
      if (atHome) {
        must(res.status === 200 && body.success === true, `asking for the restore answered ${res.status}: ${String(body.error ?? '').slice(0, 200)}`)
      } else {
        must(res.status === 202 && body.queued === true && body.region === args.region, `asking for the restore answered ${res.status}, not 202 queued for ${args.region}`)
        await untilRegionDone(body.jobId, 'the restore')
      }
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

    // A snapshot restore rewrites the whole database: only the project's
    // administrators may ask for one, whatever else a member may do.
    if (!args.member) {
      notRun.push('a snapshot restore refused to a project member without the administer role (--member not given)')
    } else {
      await check('recovery', 'restore-refused-to-a-non-administrator', ['snapshot'], async () => {
        const m = args.member!
        const signIn = await theFetch(homeUrl('/api/auth/login'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: m.email, password: m.password, ...(m.totp ? { totpCode: m.totp } : {}) }),
        })
        const signedIn = await json(signIn)
        must(signedIn.code !== 'TOTP_REQUIRED', 'the member account has two-factor sign-in: set BACKENLY_QUALIFY_MEMBER_TOTP to its current code')
        must(signIn.status === 200 && typeof signedIn.token === 'string', `the member's sign-in at the home host answered ${signIn.status}`)
        const asMember = (init: RequestInit = {}): RequestInit => ({
          ...init,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${signedIn.token}` },
        })
        try {
          // The member can open the project, so a refusal is about the role, not access.
          const listed = await theFetch(homeUrl(`/api/projects/${args.project}/changes?limit=1`), asMember())
          must(listed.status === 200, `${m.email} cannot open the probe project (${listed.status}): make it a developer or viewer of the project`)
          const restore = await theFetch(homeUrl(snapshotsPath), asMember({ method: 'PUT', body: JSON.stringify({ backupId: snapshotId }) }))
          const refused = await json(restore)
          must(
            restore.status === 403 && refused.code === 'PROJECT_ROLE_INSUFFICIENT',
            `a snapshot restore by ${m.email} answered ${restore.status} ${refused.code ?? ''}, not 403 PROJECT_ROLE_INSUFFICIENT`,
          )
          // Nor may the member restore a governed change: those routes do not exist for anyone below an administrator.
          const latest = ((await json(listed)).changes ?? [])[0] as { id?: string } | undefined
          if (latest?.id) {
            const preview = await theFetch(homeUrl(`/api/projects/${args.project}/changes/${latest.id}/preview`), asMember({ method: 'POST', body: '{}' }))
            must(preview.status === 404, `a change's restore preview answered ${preview.status} to ${m.email}, not 404`)
          }
          return `${m.email}, a member without the administer role, was refused the snapshot restore (403 PROJECT_ROLE_INSUFFICIENT)${latest?.id ? ' and a change\'s restore' : ''}`
        } finally {
          await theFetch(homeUrl('/api/auth/logout'), {
            method: 'POST',
            headers: { authorization: `Bearer ${signedIn.token}`, ...(signedIn.refreshToken ? { cookie: `refresh-token=${signedIn.refreshToken}` } : {}) },
          }).catch(() => log(`  note  ${m.email} could not be signed out; sign out of every device in the console`))
        }
      })
    }

    // ── autonomy ─────────────────────────────────────────────────────────────
    log('\n── autonomy')
    await check('autonomy', 'status', ['connect'], async () => {
      const status = await mcp!.call('autonomy', { action: 'status' })
      must(status.text.length > 0, 'the control plane reported nothing')
      return status.text.replace(/\s+/g, ' ').slice(0, 200)
    })

    // ── a change whose process dies ──────────────────────────────────────────
    // The process applying a governed change can die mid-change: a deploy, a
    // crash, a task the platform replaces. The change must not stay "in
    // progress" forever, holding its project's change lock: the region's
    // scheduler settles it as needing a person, from its record and the
    // region's catalog.
    log('\n── a change whose process dies')
    if (!args.killCommand) {
      notRun.push('a governed change whose process is killed while it applies (--kill-command not given)')
    } else {
      await check('rollback-drills', 'settled-after-its-process-died', ['nothing-waiting'], async () => {
        const before = (await changesSince(0))[0]?.seq ?? 0
        const made: string[] = []
        let stop = false
        // One change after another, so one is applying when the kill lands.
        const stream = (async () => {
          for (let i = 0; !stop && i < 100; i++) {
            const table = `qualify_kill${i}_${run}`
            made.push(table)
            await mcp!.attempt('apply_migration', { sql: `CREATE TABLE ${table} (note text)` }).catch(() => undefined)
          }
        })()
        await new Promise((r) => setTimeout(r, args.killAfterSeconds * 1_000))
        log(`        running the kill command, ${args.killAfterSeconds} s into the drill's changes`)
        const killed = spawnSync(args.killCommand!, { shell: true, encoding: 'utf8', timeout: 180_000 })
        const killedAt = Date.now()
        stop = true
        await stream
        must(killed.status === 0, `the kill command exited ${killed.status ?? killed.signal}: ${String(killed.stderr ?? '').trim().slice(0, 200)}`)
        // A graceful stop takes the task out of the load balancer and drains its
        // connections; the load balancer answers a request still in flight at
        // the end with a 502, and the SIGTERM that follows ends the process at
        // once (its own handlers call process.exit). Until then a request can
        // still reach the process going away, and with one task nothing answers
        // new connections while its
        // replacement starts. So nothing is sent until the drain has passed and
        // fresh connections to the home host are answered twice in a row; then
        // MCP connects again, to whatever serves it now.
        await mcp!.close()
        const drainLeft = killedAt + args.killDrainSeconds * 1_000 - Date.now()
        log(`        waiting ${seconds(Math.max(0, drainLeft))} for the killed process to drain and exit, then for fresh connections to the home host to be answered`)
        if (drainLeft > 0) await new Promise((r) => setTimeout(r, drainLeft))
        const answeredAfter = await untilAnswering(homeUrl('/api/health'), args.connect, { consecutive: 2, byMs: Date.now() + 5 * 60_000 })
        log(`        the home host answered fresh connections ${seconds(Date.now() - killedAt)} after the kill (${seconds(answeredAfter)} after the drain)`)
        const reconnectBy = Date.now() + 5 * 60_000
        for (;;) {
          try {
            mcp = await Mcp.connect(args.home, args.mcpKey, theFetch)
            break
          } catch (err) {
            if (Date.now() > reconnectBy) throw new Error(`the control plane did not come back within 5 minutes of answering health: ${describeError(err)}`)
            await new Promise((r) => setTimeout(r, 5_000))
          }
        }
        // The drill's finished changes are restored, newest first, and any table
        // left is named for removal, whether or not the kill cut a change off.
        const cleanUp = async (mine: Array<{ id: string; seq: number; outcome: { state: string } }>) => {
          for (const c of mine.filter((x) => x.outcome.state === 'healthy')) {
            await restoreFromConsole(c).catch((err: unknown) => log(`  note  could not restore drill change #${c.seq}: ${describeError(err)}`))
          }
          for (const table of made) {
            if ((await columnsOf(table)) !== null) log(`  note  ${table} is still in the schema; remove it from the console`)
          }
        }
        // Every change the drill made ends in a final state; one the kill cut off
        // is settled by the region's scheduler.
        const deadline = killedAt + args.settleWaitMinutes * 60_000
        for (;;) {
          const mine = (await changesSince(before)).filter((c) => c.actor?.type === 'agent')
          const open = mine.filter((c) => c.outcome.state === 'in_progress')
          if (open.length === 0) {
            const cutOff: Array<{ id: string; seq: number }> = []
            for (const c of mine.filter((x) => x.outcome.state === 'needs_attention')) {
              const { change } = await operatorJson(`/api/projects/${args.project}/changes/${c.id}`)
              if (/stopped before it finished/i.test(String(change?.error ?? ''))) cutOff.push(c)
            }
            if (cutOff.length === 0) {
              // Nothing to settle, so nothing about settling was shown. Not a
              // failure of recovery, and not a pass either.
              await cleanUp(mine)
              throw new NotExercised(
                `no change was applying when the process died (${mine.length} changes, each finished). A graceful stop drains ` +
                  'requests before it signals the process, so a change shorter than the drain always finishes. This drill needs a ' +
                  'change that outlasts the drain (a regional project\'s, applied from home, can) or an abrupt kill (e.g. over ECS Exec)',
              )
            }
            // A change cut off has no restore point it can vouch for: keep it, and
            // restore the drill's finished changes, newest first.
            for (const c of cutOff) {
              await theFetch(homeUrl(`/api/projects/${args.project}/changes/${c.id}/keep`), asOperator({ method: 'POST', body: JSON.stringify({ seq: c.seq }) }))
            }
            await cleanUp(mine)
            // The change lock is free: a governed change applies again.
            const after = await mcp!.attempt('apply_migration', { sql: `CREATE TABLE qualify_after_kill_${run} (note text)` })
            must(after.ok, `a governed change after the drill was refused: ${after.text.slice(0, 200)}`)
            await restoreFromConsole(await changeTouching(`qualify_after_kill_${run}`, before))
            return `#${cutOff.map((c) => c.seq).join(', #')} was cut off by the kill and settled as needing a person within ` +
              `${seconds(Date.now() - killedAt)}; the change lock was free again afterwards`
          }
          if (Date.now() > deadline) {
            throw new Error(
              `#${open.map((c) => c.seq).join(', #')} is still in progress ${args.settleWaitMinutes} minutes after the process died: ` +
                `the region's scheduler did not settle it (a change counts as interrupted 15 minutes after it began)`,
            )
          }
          await new Promise((r) => setTimeout(r, 15_000))
        }
      })
    }

    // ── project deletion ─────────────────────────────────────────────────────
    // Deleting a project removes its change history, the vaults its restores
    // kept data in and its preview branches, in the region, under the change
    // ledger's guard. A project of the drill's own, never the probe project.
    log('\n── project deletion (a project with a change history, a vault and a preview branch)')
    if (args.skipDeletionDrill) {
      results.push({ phase: 'deletion', check: 'deleted-with-its-history', status: 'skip', detail: '--skip-deletion-drill', ms: 0 })
      log('  skip  deletion/deleted-with-its-history: --skip-deletion-drill')
    } else {
      await check('deletion', 'deleted-with-its-history', ['sign-in'], async () => {
        must(operatorId, 'the sign-in did not say who the operator is')
        const created = await theFetch(
          homeUrl('/api/projects'),
          asOperator({ method: 'POST', body: JSON.stringify({ name: `qualify-delete-${run}`, userId: operatorId, region: args.region }) }),
        )
        const made = await json(created)
        must(created.status === 201 && typeof made.data?.id === 'string', `creating a project in ${args.region} answered ${created.status}: ${String(made.error ?? '').slice(0, 200)}`)
        // A home project's region may be recorded as null, which is the home region.
        must((made.data.region ?? HOME_REGION) === args.region, `the new project is in ${made.data.region}, not ${args.region}`)
        const doomed = made.data.id as string
        const doomedKey = typeof made.apiKey === 'string' ? made.apiKey : null
        let deleted = false
        try {
          // A governed change from the console: a table.
          const table = await theFetch(
            homeUrl(`/api/database/create-table?projectId=${doomed}`),
            asOperator({ method: 'POST', body: JSON.stringify({ tableName: 'qualify_doomed' }) }),
          )
          must(table.ok, `creating a table in the new project answered ${table.status}: ${JSON.stringify(await json(table)).slice(0, 200)}`)
          const { changes } = await operatorJson(`/api/projects/${doomed}/changes?limit=10`)
          const change = ((changes ?? []) as Array<{ id: string; seq: number; touched: string[] }>).find((c) => c.touched.includes('qualify_doomed'))
          must(change, 'creating the table recorded no governed change')
          // Its restore keeps the table in the restore's vault.
          const restored = await changeCall(doomed, change!.id, 'restore', { seq: change!.seq })
          must(restored.status === 200 && restored.body.status === 'restored', `restoring the new project's change answered ${restored.status}: ${String(restored.body.error ?? '').slice(0, 200)}`)
          // A preview branch, with its own schema.
          const branch = await theFetch(homeUrl(`/api/projects/${doomed}/branches`), asOperator({ method: 'POST', body: JSON.stringify({ name: 'qualify' }) }))
          const branched = await json(branch)
          must(branch.status === 200 && branched.success === true, `creating a branch answered ${branch.status}: ${String(branched.error ?? '').slice(0, 200)}`)
          // Deleted, with all of it.
          const del = await theFetch(homeUrl(`/api/projects/${doomed}`), asOperator({ method: 'DELETE' }))
          const gone = await json(del)
          must(del.status === 200 && gone.success === true, `deleting the project answered ${del.status}: ${String(gone.error ?? gone.message ?? '').slice(0, 200)}`)
          deleted = true
          const after = await theFetch(homeUrl(`/api/projects/${doomed}/changes?limit=1`), asOperator())
          must(after.status === 404 || after.status === 403, `the deleted project's changes still answer ${after.status} at home`)
          if (doomedKey) {
            // The region stops serving the project once the deletion reaches it.
            const deadline = Date.now() + 120_000
            for (;;) {
              const status = (await theFetch(apiUrl(`/api/v1/${doomed}/healthz`), { headers: { 'x-api-key': doomedKey } })).status
              if (status !== 200) break
              if (Date.now() > deadline) throw new Error(`${args.region} still served the deleted project 120 s after its deletion`)
              await new Promise((r) => setTimeout(r, 2_000))
            }
          }
          return `a project in ${args.region} with a governed change, its restore's vault and a preview branch was deleted, ` +
            `and is gone at home${doomedKey ? ' and in the region' : ''}`
        } finally {
          if (!deleted) {
            const del = await theFetch(homeUrl(`/api/projects/${doomed}`), asOperator({ method: 'DELETE' })).catch(() => null)
            if (del?.status !== 200) log(`  note  qualify-delete-${run} (${doomed}) may still exist; delete it from the console`)
          }
        }
      })
    }

    // ── revocation ───────────────────────────────────────────────────────────
    log('\n── revocation')
    if (args.skipRevocation) {
      results.push({ phase: 'revocation', check: 'revoked-key-refused', status: 'skip', detail: '--skip-revocation', ms: 0 })
      log('  skip  revocation/revoked-key-refused: --skip-revocation')
    } else {
      await check('revocation', 'revoked-key-refused', ['connect', 'project-health', 'functions'], async () => {
        const minted = await mcp!.call('connect', { action: 'create_api_key', description: `qualify ${run} (revoked by this run)` })
        // The whole key is data.apiKey (its prefix and 64 hex characters, lib/auth/key-prefix.ts).
        const created = toolData<{ apiKey?: unknown; keyId?: unknown }>(minted)
        const key = typeof created?.apiKey === 'string' ? created.apiKey : undefined
        const keyId = typeof created?.keyId === 'string' ? created.keyId : undefined
        must(key && keyId, 'create_api_key returned no key or id')
        // One key-checked endpoint per serving tier: the web tier's storage list
        // (without a bucket it answers 400 once the key is accepted) and the
        // runtime's HTTP function. /healthz takes no key, so it proves nothing.
        const probes: Record<string, () => Promise<Response>> = {
          web: () => theFetch(apiUrl(`/api/v1/${args.project}/storage/files`), { headers: { 'x-api-key': key! } }),
          runtime: () => theFetch(apiUrl(`/api/v1/${args.project}/fn/${HTTP_FUNCTION}`), { headers: { 'x-api-key': key! } }),
        }
        const refused = (status: number) => status === 401 || status === 403
        for (const [tier, probe] of Object.entries(probes)) {
          const status = (await probe()).status
          must(!refused(status), `the new key was refused by the ${tier} tier (${status}) before it was revoked`)
        }
        const revoke = await mcp!.call('connect', { action: 'revoke_api_key', keyId })
        const approval = pendingApproval(revoke)
        if (approval) await untilApproved(approval, 'revoke_api_key')
        const revokedAt = Date.now()
        const refusedAfter: Record<string, number> = {}
        for (;;) {
          for (const [tier, probe] of Object.entries(probes)) {
            if (refusedAfter[tier] === undefined && refused((await probe()).status)) refusedAfter[tier] = Date.now() - revokedAt
          }
          const waiting = Object.keys(probes).filter((tier) => refusedAfter[tier] === undefined)
          if (waiting.length === 0) return `refused by the web tier ${refusedAfter.web} ms and the runtime ${refusedAfter.runtime} ms after the revocation ran`
          if (Date.now() - revokedAt > 120_000) throw new Error(`the revoked key was still accepted 120 s after the revocation by: ${waiting.join(', ')}`)
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
    const passed = (check: string) => results.find((r) => r.phase === 'rollback-drills' && r.check === check)?.status === 'pass'
    const ran = (check: string) => results.some((r) => r.phase === 'rollback-drills' && r.check === check && r.status !== 'skip')
    if (passed('served-after-a-change') && !passed('drill-tables-removed')) {
      log(`  note  qualify_kept_${run} may still exist, with its rows; restore its change from the console`)
    }
    if (ran('restore-refused-under-a-later-change') && !passed('restore-refused-under-a-later-change')) {
      log(`  note  qualify_parent_${run} may still exist; restore its two changes from the console, newest first`)
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

  const optedOut = new Set(['--skip-revocation', '--skip-deletion-drill'])
  const ok = results.every((r) => r.status === 'pass' || (r.status === 'skip' && optedOut.has(r.detail)))
  log(`\n${ok ? 'REGION QUALIFIED' : 'REGION NOT QUALIFIED'}: ${results.filter((r) => r.status === 'pass').length} passed, ${results.filter((r) => r.status === 'fail').length} failed, ${results.filter((r) => r.status === 'skip').length} skipped`)
  log(`Not run here: ${notRun.join('; ')}.`)

  if (args.report) {
    fs.writeFileSync(
      args.report,
      JSON.stringify(
        { region: args.region, project: args.project, api: args.api.origin, home: args.home.origin, run, at: new Date().toISOString(), ok, results, notRun },
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
