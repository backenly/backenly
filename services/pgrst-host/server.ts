/**
 * The PostgREST host's HTTP contract.
 *
 *   GET  /ready                        200 while the host is serving (unauthenticated;
 *                                      reports counts only)
 *   ANY  /p/<projectId>/<path>?<query> proxied to the project's own PostgREST as
 *                                      /<path>?<query>, started on first use
 *   GET  /p/<projectId>/__state        the project's child: state, pid, cold start,
 *                                      memory, failures, circuit, and a live /ready
 *   POST /admin/restart/<projectId>    stop the project's child and start it again
 *                                      (needs a service_role token)
 *
 * Everything under /p and /admin carries `Authorization: Bearer <token>`, the
 * runtime's internal token, verified before anything else is done (token.ts):
 * no child is looked up, started or stopped for a request that fails it.
 * Refusals are JSON `{ code, message }`; a 503 carries Retry-After.
 */

import http from 'http'
import type { AddressInfo } from 'net'

import { ChildRegistry, HostRefusal } from './children'
import type { HostConfig } from './config'
import { postgrestLauncher, type Launcher } from './launcher'
import { consoleLog, PREFIX, type LogLine } from './log'
import { connectionRefusal, forward, PROXIED_METHODS, sendJson } from './proxy'
import { bearerToken, PROJECT_ID, verifyHostToken } from './token'

const STATE_PROBE_TIMEOUT_MS = 1000

export interface PgrstHost {
  readonly server: http.Server
  readonly registry: ChildRegistry
  /** Start listening and reaping. Defaults to the configured host and port. */
  listen(port?: number, host?: string): Promise<AddressInfo>
  /** Stop accepting requests, stop every child, close the server. */
  close(): Promise<void>
}

type Route =
  | { kind: 'ready' }
  | { kind: 'proxy'; projectId: string; path: string }
  | { kind: 'state'; projectId: string }
  | { kind: 'restart'; projectId: string }

/** The route for a raw request target, or null. The query string stays with the proxied path. */
export function routeFor(target: string): Route | null {
  const q = target.indexOf('?')
  const pathname = q === -1 ? target : target.slice(0, q)
  const search = q === -1 ? '' : target.slice(q)

  if (pathname === '/ready') return { kind: 'ready' }

  const restart = /^\/admin\/restart\/([^/]+)$/.exec(pathname)
  if (restart) return { kind: 'restart', projectId: restart[1] }

  const project = /^\/p\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!project) return null
  const rest = project[2] ?? '/'
  if (rest === '/__state') return { kind: 'state', projectId: project[1] }
  return { kind: 'proxy', projectId: project[1], path: `${rest}${search}` }
}

function refuse(res: http.ServerResponse, status: number, code: string, message: string, retryAfter?: number): void {
  const headers: Record<string, string> = {}
  if (retryAfter !== undefined) headers['retry-after'] = String(retryAfter)
  if (status === 401) headers['www-authenticate'] = 'Bearer'
  sendJson(res, status, { code, message }, headers)
}

function refuseWith(res: http.ServerResponse, err: unknown, log: LogLine): void {
  if (err instanceof HostRefusal) {
    refuse(res, err.status, err.code, err.message, err.retryAfterSeconds)
    return
  }
  log(`${PREFIX} internal error: ${err instanceof Error ? err.message : String(err)}`)
  refuse(res, 500, 'INTERNAL', 'The host could not handle this request.')
}

export function createPgrstHost(options: {
  config: HostConfig
  launcher?: Launcher
  now?: () => number
  log?: LogLine
}): PgrstHost {
  const { config } = options
  const log = options.log ?? consoleLog
  const registry = new ChildRegistry(options.launcher ?? postgrestLauncher(config, log), config, {
    now: options.now,
    log,
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const route = routeFor(req.url ?? '/')
    if (!route) return refuse(res, 404, 'NOT_FOUND', 'No such route on this host.')

    if (route.kind === 'ready') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res, 405, 'METHOD_NOT_ALLOWED', 'GET /ready only.')
      return sendJson(res, 200, { status: 'ready', children: registry.size, maxChildren: config.maxChildren })
    }

    // The token first: nothing below runs for a request that fails it.
    const verdict = verifyHostToken(bearerToken(req.headers.authorization), config.jwtSecret, route.projectId)
    // `=== false`, not `!`: the repository compiles without strictNullChecks, where only an equality narrows.
    if (verdict.ok === false) return refuse(res, verdict.status, verdict.code, verdict.message)
    if (!PROJECT_ID.test(route.projectId)) return refuse(res, 400, 'INVALID_PROJECT_ID', 'The project id is not valid.')
    const { claims } = verdict

    if (route.kind === 'state') {
      if (req.method !== 'GET') return refuse(res, 405, 'METHOD_NOT_ALLOWED', 'GET only.')
      const state = registry.state(route.projectId, claims.db)
      const child = registry.child(route.projectId)
      const ready = child ? await child.probeReady(STATE_PROBE_TIMEOUT_MS) : null
      return sendJson(res, 200, { ...state, ready })
    }

    if (route.kind === 'restart') {
      if (req.method !== 'POST') return refuse(res, 405, 'METHOD_NOT_ALLOWED', 'POST only.')
      if (claims.role !== 'service_role') {
        return refuse(res, 403, 'ROLE_NOT_ALLOWED', 'Restarting a project database server needs a service_role token.')
      }
      try {
        const state = await registry.restart(route.projectId, claims.db)
        return sendJson(res, 200, state as unknown as Record<string, unknown>)
      } catch (err) {
        return refuseWith(res, err, log)
      }
    }

    // ── proxy ────────────────────────────────────────────────────────────────
    if (!PROXIED_METHODS.has(req.method ?? '')) {
      return refuse(res, 405, 'METHOD_NOT_ALLOWED', `${req.method} is not forwarded.`)
    }
    const connection = connectionRefusal(req.headers)
    if (connection) return refuse(res, 400, 'HOP_BY_HOP_REFUSED', connection)
    const declared = req.headers['content-length']
    if (declared !== undefined && Number(declared) > config.maxBodyBytes) {
      res.setHeader('connection', 'close')
      return refuse(res, 413, 'BODY_TOO_LARGE', `The request body is larger than ${config.maxBodyBytes} bytes.`)
    }

    let lease
    try {
      lease = await registry.acquire(route.projectId, claims.db)
    } catch (err) {
      return refuseWith(res, err, log)
    }
    // The caller may have gone while the child started.
    if (res.destroyed) {
      lease.release()
      return
    }
    forward(req, res, {
      port: lease.port,
      path: route.path,
      token: verdict.token,
      maxBodyBytes: config.maxBodyBytes,
      timeoutMs: config.upstreamTimeoutMs,
      release: lease.release,
    })
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => refuseWith(res, err, log))
  })
  // WebSocket and other upgrades are not part of PostgREST's API.
  server.on('upgrade', (_req, socket) => {
    const body = JSON.stringify({ code: 'UPGRADE_REFUSED', message: 'Protocol upgrades are not served.' })
    socket.end(
      `HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
  })

  let reaper: ReturnType<typeof setInterval> | null = null

  return {
    server,
    registry,
    listen(port = config.port, host = config.listenHost) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          const every = Math.min(30_000, Math.max(250, Math.floor(config.idleMs / 4)))
          reaper = setInterval(() => {
            void registry.reapIdle().catch((err) => log(`${PREFIX} idle reap failed: ${err instanceof Error ? err.message : err}`))
          }, every)
          reaper.unref?.()
          resolve(server.address() as AddressInfo)
        })
      })
    },
    async close() {
      if (reaper) clearInterval(reaper)
      reaper = null
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeIdleConnections?.()
      await registry.shutdown()
      server.closeAllConnections?.()
      await closed
    },
  }
}
