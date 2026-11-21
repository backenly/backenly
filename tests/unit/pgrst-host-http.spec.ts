/**
 * The PostgREST host over HTTP (services/pgrst-host/server.ts).
 *
 * Each "child" is a small HTTP server on 127.0.0.1 that echoes what it
 * received, launched through the host's Launcher interface, so what is asserted
 * is what a real PostgREST would be sent. The real binary is
 * tests/integration/pgrst-host.spec.ts.
 *
 *   - a request is verified before anything is started: no token, a wrong
 *     signature, an expired token, another project's token, a token naming no
 *     project database, all refused with nothing launched
 *   - a valid request reaches the child as sent (path, query, profile headers,
 *     body, the same Authorization), and its answer comes back unchanged apart
 *     from hop-by-hop headers
 *   - Connection headers naming other headers, upgrades, oversized bodies and unknown methods are
 *     refused; at the cap with every child busy, 503 DATA_PLANE_BUSY
 *   - __state and restart are authenticated like the proxy
 */

import http from 'http'
import type { AddressInfo } from 'net'

import { internalClaimsFor, mintInternalToken } from '@/lib/postgrest/gateway'
import { readConfig, type HostConfig } from '@/services/pgrst-host/config'
import type { ChildExit, Launcher, LaunchSpec } from '@/services/pgrst-host/launcher'
import { createPgrstHost, routeFor, type PgrstHost } from '@/services/pgrst-host/server'

const SECRET = 'a-region-postgrest-secret-of-at-least-32-chars'
const A = 'ac6b51fd-5ed7-4c00-9938-cff57f34d304'
const B = 'b1c2d3e4-0000-4000-8000-000000000001'
const C = 'c1c2d3e4-0000-4000-8000-000000000002'
const DB_A = `p_${'a'.repeat(32)}`
const DB_B = `p_${'b'.repeat(32)}`
const DB_C = `p_${'c'.repeat(32)}`

function token(projectId: string, database: string | null, opts: { role?: 'anon' | 'service_role'; secret?: string; ttl?: number } = {}): string {
  return mintInternalToken(
    internalClaimsFor({ projectId, serviceRole: opts.role === 'service_role', database }),
    opts.secret ?? SECRET,
    opts.ttl,
  )
}

/** How long a test child takes to answer /slow. */
const SLOW_CHILD_MS = 400

/** Children that echo what they were sent; /slow answers after SLOW_CHILD_MS. */
function echoLauncher() {
  const launches: LaunchSpec[] = []
  const servers: http.Server[] = []
  const launcher: Launcher = async (spec) => {
    launches.push(spec)
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const respond = () => {
          const body = JSON.stringify({
            spec,
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
          res.writeHead(206, {
            'content-type': 'application/json; charset=utf-8',
            'content-range': '0-0/1',
            'x-child': spec.projectId,
            'x-child-private': 'hop-by-hop by Connection',
            connection: 'keep-alive, x-child-private',
            'keep-alive': 'timeout=7, max=3',
          })
          res.end(body)
        }
        // A fixed delay: the test only needs "slow", and a delay from the
        // request would be an unbounded timer.
        if ((req.url ?? '').startsWith('/slow')) setTimeout(respond, SLOW_CHILD_MS)
        else respond()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    let resolveExit!: (exit: ChildExit) => void
    const exited = new Promise<ChildExit>((resolve) => (resolveExit = resolve))
    return {
      pid: null,
      port: (server.address() as AddressInfo).port,
      ready: Promise.resolve(),
      exited,
      stop: async () => {
        server.closeAllConnections()
        server.close()
        resolveExit({ code: 0, signal: 'SIGTERM' })
        return exited
      },
      probeReady: async () => server.listening,
      rssBytes: () => null,
    }
  }
  return { launcher, launches, servers }
}

interface Answer {
  status: number
  headers: http.IncomingHttpHeaders
  text: string
  json: any
}

function call(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string | Buffer; chunks?: Buffer[] } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: opts.headers, agent: false }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8')
        let json: unknown = null
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (opts.chunks) {
      for (const chunk of opts.chunks) req.write(chunk)
      req.end()
    } else {
      req.end(opts.body)
    }
  })
}

const bearer = (t: string) => ({ authorization: `Bearer ${t}` })

/** Lets the host see the end of the last exchange (its lease is released when the response closes). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

let host: PgrstHost
let port = 0
let echo: ReturnType<typeof echoLauncher>
let config: HostConfig

async function start(overrides: Partial<HostConfig> = {}) {
  config = {
    ...readConfig({
      PGRST_HOST_JWT_SECRET: SECRET,
      PGRST_HOST_DB_URI: 'postgresql://authenticator:pw@127.0.0.1:5432/postgres',
    }),
    maxChildren: 2,
    maxBodyBytes: 1024,
    ...overrides,
  }
  echo = echoLauncher()
  host = createPgrstHost({ config, launcher: echo.launcher, log: () => {} })
  port = (await host.listen(0, '127.0.0.1')).port
}

afterEach(async () => {
  await host?.close()
})

describe('routes', () => {
  it('keeps the query string with the proxied path', () => {
    expect(routeFor(`/p/${A}/items?select=*,author(*)&id=eq.1`)).toEqual({
      kind: 'proxy',
      projectId: A,
      path: '/items?select=*,author(*)&id=eq.1',
    })
    expect(routeFor(`/p/${A}`)).toEqual({ kind: 'proxy', projectId: A, path: '/' })
    expect(routeFor(`/p/${A}?x=1`)).toEqual({ kind: 'proxy', projectId: A, path: '/?x=1' })
    expect(routeFor(`/p/${A}/__state`)).toEqual({ kind: 'state', projectId: A })
    expect(routeFor(`/admin/restart/${A}`)).toEqual({ kind: 'restart', projectId: A })
    expect(routeFor('/ready')).toEqual({ kind: 'ready' })
    expect(routeFor('/p//items')).toBeNull()
    expect(routeFor('/admin/restart/')).toBeNull()
    expect(routeFor('/')).toBeNull()
  })
})

describe('a request is verified before anything starts', () => {
  beforeEach(() => start())

  const refused: Array<[string, () => Record<string, string>, number, string]> = [
    ['no token', () => ({}), 401, 'UNAUTHORIZED'],
    ['another scheme', () => ({ authorization: 'Basic YTpi' }), 401, 'UNAUTHORIZED'],
    ['a wrong signature', () => bearer(token(A, DB_A, { secret: 'not-the-region-secret-but-32-chars-long' })), 401, 'TOKEN_INVALID'],
    ['an expired token', () => bearer(token(A, DB_A, { ttl: -10 })), 401, 'TOKEN_EXPIRED'],
    ['project B’s token on project A’s path', () => bearer(token(B, DB_B)), 403, 'TOKEN_AUDIENCE_MISMATCH'],
    ['a shared-database token (no aud, no db)', () => bearer(token(A, null)), 403, 'TOKEN_AUDIENCE_MISMATCH'],
  ]

  it.each(refused)('refuses %s on the proxy, __state and restart, starting nothing', async (_what, headers, status, code) => {
    for (const [method, path] of [
      ['GET', `/p/${A}/items`],
      ['GET', `/p/${A}/__state`],
      ['POST', `/admin/restart/${A}`],
    ]) {
      const answer = await call(port, method, path, { headers: headers() })
      expect({ path, status: answer.status, code: answer.json?.code }).toEqual({ path, status, code })
      if (status === 401) expect(answer.headers['www-authenticate']).toBe('Bearer')
    }
    expect(echo.launches).toEqual([])
  })

  it('refuses a token naming no project database, starting nothing', async () => {
    const noProjectDatabase = mintInternalToken({ role: 'anon', project_id: A, aud: A, db: 'postgres' } as any, SECRET)
    const answer = await call(port, 'GET', `/p/${A}/items`, { headers: bearer(noProjectDatabase) })
    expect(answer.status).toBe(403)
    expect(answer.json.code).toBe('TOKEN_DATABASE_INVALID')
    expect(echo.launches).toEqual([])
  })

  it('answers /ready without a token, and 404 elsewhere', async () => {
    const ready = await call(port, 'GET', '/ready')
    expect(ready.status).toBe(200)
    expect(ready.json).toEqual({ status: 'ready', children: 0, maxChildren: 2 })
    expect((await call(port, 'GET', '/elsewhere')).status).toBe(404)
  })
})

describe('a valid request', () => {
  beforeEach(() => start())

  it('reaches the project’s child as the runtime sent it, and its answer comes back', async () => {
    const t = token(A, DB_A, { role: 'service_role' })
    const answer = await call(port, 'POST', `/p/${A}/items?select=id,name&order=id.desc`, {
      headers: {
        ...bearer(t),
        'content-type': 'application/json',
        'content-profile': `workspace_${A}`,
        'accept-profile': `workspace_${A}`,
        prefer: 'return=representation',
        'keep-alive': 'timeout=99',
        te: 'trailers',
        connection: 'keep-alive',
      },
      body: JSON.stringify({ name: 'first' }),
    })
    expect(answer.status).toBe(206)
    expect(echo.launches).toEqual([{ projectId: A, database: DB_A }])
    const seen = answer.json
    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('/items?select=id,name&order=id.desc')
    expect(seen.body).toBe('{"name":"first"}')
    expect(seen.headers.authorization).toBe(`Bearer ${t}`)
    expect(seen.headers['content-profile']).toBe(`workspace_${A}`)
    expect(seen.headers['accept-profile']).toBe(`workspace_${A}`)
    expect(seen.headers.prefer).toBe('return=representation')
    expect(seen.headers.host).toBe(`127.0.0.1:${(echo.servers[0].address() as AddressInfo).port}`)
    expect(seen.headers['keep-alive']).toBeUndefined()
    expect(seen.headers.te).toBeUndefined()

    expect(answer.headers['content-range']).toBe('0-0/1')
    expect(answer.headers['x-child']).toBe(A)
    expect(answer.headers['x-child-private']).toBeUndefined()
    // The child's own Keep-Alive stays on its hop (the host's server may send its own).
    expect(answer.headers['keep-alive']).not.toBe('timeout=7, max=3')
  })

  it('starts one child per project and keeps using it', async () => {
    for (const [project, database] of [[A, DB_A], [B, DB_B], [A, DB_A], [B, DB_B]]) {
      const answer = await call(port, 'GET', `/p/${project}/items`, { headers: bearer(token(project, database)) })
      expect(answer.status).toBe(206)
      expect(answer.json.spec).toEqual({ projectId: project, database })
    }
    expect(echo.launches).toHaveLength(2)
  })

  it('streams a chunked body', async () => {
    const answer = await call(port, 'POST', `/p/${A}/items`, {
      headers: { ...bearer(token(A, DB_A)), 'content-type': 'application/json' },
      chunks: [Buffer.from('{"name":'), Buffer.from('"streamed"}')],
    })
    expect(answer.status).toBe(206)
    expect(answer.json.body).toBe('{"name":"streamed"}')
  })
})

describe('refusals of the request itself', () => {
  beforeEach(() => start())

  it('refuses a Connection header that names another header, so nothing the child relies on is dropped', async () => {
    const answer = await call(port, 'GET', `/p/${A}/items`, {
      headers: { ...bearer(token(A, DB_A)), connection: 'close, accept-profile', 'accept-profile': `workspace_${A}` },
    })
    expect(answer.status).toBe(400)
    expect(answer.json.code).toBe('HOP_BY_HOP_REFUSED')
    expect(echo.launches).toEqual([])
  })

  it('refuses a protocol upgrade', async () => {
    const answer = await call(port, 'GET', `/p/${A}/items`, {
      headers: { ...bearer(token(A, DB_A)), connection: 'upgrade', upgrade: 'websocket' },
    })
    expect(answer.status).toBe(400)
    expect(answer.json.code).toBe('UPGRADE_REFUSED')
    expect(echo.launches).toEqual([])
  })

  it('refuses a declared body over the cap before starting anything', async () => {
    const answer = await call(port, 'POST', `/p/${A}/items`, {
      headers: { ...bearer(token(A, DB_A)), 'content-type': 'application/json' },
      body: 'x'.repeat(2000),
    })
    expect(answer.status).toBe(413)
    expect(answer.json.code).toBe('BODY_TOO_LARGE')
    expect(echo.launches).toEqual([])
  })

  it('stops a streamed body at the cap', async () => {
    const answer = await call(port, 'POST', `/p/${A}/items`, {
      headers: { ...bearer(token(A, DB_A)), 'content-type': 'application/json' },
      chunks: [Buffer.alloc(800, 'x'), Buffer.alloc(800, 'y')],
    })
    expect(answer.status).toBe(413)
    expect(answer.json.code).toBe('BODY_TOO_LARGE')
  })

  it('refuses methods PostgREST does not serve', async () => {
    const answer = await call(port, 'PROPFIND', `/p/${A}/items`, { headers: bearer(token(A, DB_A)) })
    expect(answer.status).toBe(405)
    expect(echo.launches).toEqual([])
  })
})

describe('the cap', () => {
  it('answers 503 DATA_PLANE_BUSY with Retry-After when every child is busy, and never queues', async () => {
    await start({ maxChildren: 1 })
    const slow = call(port, 'GET', `/p/${A}/slow?ms=400`, { headers: bearer(token(A, DB_A)) })
    await new Promise((r) => setTimeout(r, 100))
    const busy = await call(port, 'GET', `/p/${B}/items`, { headers: bearer(token(B, DB_B)) })
    expect(busy.status).toBe(503)
    expect(busy.json.code).toBe('DATA_PLANE_BUSY')
    expect(busy.headers['retry-after']).toBe('5')
    expect(echo.launches).toHaveLength(1)

    expect((await slow).status).toBe(206)
    await settle()
    // Once A is idle, B takes its place.
    const after = await call(port, 'GET', `/p/${B}/items`, { headers: bearer(token(B, DB_B)) })
    expect(after.status).toBe(206)
    expect(echo.launches.map((l) => l.projectId)).toEqual([A, B])
  })
})

describe('__state and restart', () => {
  beforeEach(() => start())

  it('reports a project that has not started, then its running child', async () => {
    const t = token(A, DB_A)
    const before = await call(port, 'GET', `/p/${A}/__state`, { headers: bearer(t) })
    expect(before.status).toBe(200)
    expect(before.json).toMatchObject({ projectId: A, state: 'stopped', inFlight: 0, ready: null })
    expect(echo.launches).toEqual([])

    await call(port, 'GET', `/p/${A}/items`, { headers: bearer(t) })
    await settle()
    const after =await call(port, 'GET', `/p/${A}/__state`, { headers: bearer(t) })
    expect(after.json).toMatchObject({ projectId: A, database: DB_A, state: 'ready', inFlight: 0, ready: true })
    expect(typeof after.json.coldStartMs).toBe('number')
  })

  it('restarts only with a service_role token', async () => {
    const anon = await call(port, 'POST', `/admin/restart/${A}`, { headers: bearer(token(A, DB_A)) })
    expect(anon.status).toBe(403)
    expect(anon.json.code).toBe('ROLE_NOT_ALLOWED')
    expect(echo.launches).toEqual([])

    await call(port, 'GET', `/p/${A}/items`, { headers: bearer(token(A, DB_A)) })
    const restarted = await call(port, 'POST', `/admin/restart/${A}`, { headers: bearer(token(A, DB_A, { role: 'service_role' })) })
    expect(restarted.status).toBe(200)
    expect(restarted.json).toMatchObject({ projectId: A, database: DB_A, state: 'ready' })
    expect(echo.launches).toHaveLength(2)
    expect(echo.servers[0].listening).toBe(false)
    expect((await call(port, 'GET', `/p/${A}/items`, { headers: bearer(token(A, DB_A)) })).status).toBe(206)
  })

  it('refuses a database served here for another project', async () => {
    await call(port, 'GET', `/p/${A}/items`, { headers: bearer(token(A, DB_A)) })
    const answer = await call(port, 'GET', `/p/${C}/items`, { headers: bearer(token(C, DB_A)) })
    expect(answer.status).toBe(409)
    expect(answer.json.code).toBe('DATABASE_IN_USE')
    expect(echo.launches).toHaveLength(1)
    expect(DB_C).not.toBe(DB_A)
  })
})
