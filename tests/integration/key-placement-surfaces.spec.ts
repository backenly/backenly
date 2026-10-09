/**
 * A KEY IS SERVED ONLY WHERE IT BELONGS
 * =====================================
 *
 * An MCP key (scope 'mcp') drives a coding agent's tools. The runtime used to
 * serve it as a service-role data key, so an agent building a frontend shipped
 * its own MCP key in the bundle (reported 2026-10-09). lib/security/
 * key-placement.ts now refuses it at the runtime's two doors, from anywhere, and
 * refuses a service-role key from a browser on every surface, including the
 * Next-owned ones that never checked.
 *
 * This drives the REAL server/app.ts over a real socket against a real
 * database, because the property is mount order: the refusal has to sit in
 * front of every router, the key-less auth routes and the Next proxy included.
 * The Next door is recordedV1, exercised on a wrapped handler that records
 * whether it ran. The routes' own authentication repeats both rules for a
 * request a door let through, and is called directly at the end.
 *
 * Every refusal has a control: the same door and the same headers with a key
 * that belongs there, which must reach its router.
 */
import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'
import { NextRequest } from 'next/server'

import app from '@/server/app'
import { getProjectIdFromAuth } from '@/server/routes/dynamic'
import { v1AuthMiddleware } from '@/server/lib/auth'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { recordedV1 } from '@/lib/traffic/recorded-v1'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'
import { MCP_KEY_HINT, MCP_KEY_IN_APP, clearKeyPlacementCache } from '@/lib/security/key-placement'
import { SERVICE_ROLE_BROWSER_BLOCKED, SERVICE_ROLE_IN_BROWSER } from '@/lib/security/service-role-exposure'

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** What a page's fetch() carries, and page JavaScript cannot remove. */
const BROWSER: Record<string, string> = {
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  origin: 'https://app.example.test',
  'user-agent': CHROME_UA,
}

const PLACEMENT_CODES = [MCP_KEY_IN_APP, SERVICE_ROLE_IN_BROWSER]

let server: http.Server
let base: string
let ownerId: string
let projectId: string
let mcpKey: string
let mcpKeyId: string
let clientKey: string
let serviceKey: string
let serviceKeyId: string

async function makeKey(input: {
  prefix: string
  name: string
  keyType: string
  scope: string
  serviceRole: boolean
  permissions: string[]
}): Promise<{ raw: string; id: string }> {
  const raw = `${input.prefix}${randomBytes(24).toString('hex')}`
  const row = await prisma.apiKey.create({
    data: {
      name: input.name,
      keyPrefix: raw.slice(0, 16),
      keyHash: hashApiKey(raw),
      permissions: input.permissions,
      capabilities: [],
      userId: ownerId,
      projectId,
      keyType: input.keyType,
      scope: input.scope,
      serviceRole: input.serviceRole,
      rateLimit: 1000,
    },
    select: { id: true },
  })
  return { raw, id: row.id }
}

async function call(method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body ? JSON.stringify(init.body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* SSE or empty */ }
  return { status: res.status, json }
}

/** The code a response carries, whichever of the runtime's error shapes it used. */
function codeOf(json: any): string | undefined {
  return json?.code ?? json?.error?.code
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `key-placement-${randomUUID()}@example.test` },
    select: { id: true },
  })
  ownerId = owner.id
  const project = await prisma.project.create({
    data: { name: `key-placement-${randomUUID().slice(0, 8)}`, userId: ownerId },
    select: { id: true },
  })
  projectId = project.id

  // The MCP key exactly as app/api/projects/[id]/mcp/keys/route.ts mints it.
  const mcp = await makeKey({
    prefix: 'mcp_live_', name: 'MCP Key', keyType: 'mcp', scope: 'mcp',
    serviceRole: true, permissions: ['read', 'write', 'admin'],
  })
  mcpKey = mcp.raw
  mcpKeyId = mcp.id
  clientKey = (await makeKey({
    prefix: 'proj_live_', name: 'web app', keyType: 'public', scope: 'runtime',
    serviceRole: false, permissions: ['read', 'write'],
  })).raw
  const svc = await makeKey({
    prefix: 'svc_live_', name: 'server key', keyType: 'public', scope: 'runtime',
    serviceRole: true, permissions: ['read', 'write'],
  })
  serviceKey = svc.raw
  serviceKeyId = svc.id
  clearKeyPlacementCache()

  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  // Project.user is onDelete: Cascade: the project, its keys and audit rows go too.
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}, 120_000)

interface Door {
  name: string
  method: string
  path: string
  body?: unknown
  carrier?: 'x-api-key' | 'apikey' | 'bearer' | 'query'
  /**
   * Accepted, this door does not answer with a finished body here: realtime
   * opens a stream that never ends, and storage is proxied to a Next server this
   * suite does not run. Refusals are immediate either way, so these are left out
   * of the controls only.
   */
  openEnded?: boolean
}

/** One representative of every way into the runtime, and every way a key is carried. */
function doors(id: string): Door[] {
  return [
    { name: 'data API /db', method: 'GET', path: `/api/v1/${id}/db/things` },
    { name: 'data API /api/v2, PostgREST apikey header', method: 'GET', path: `/api/v2/${id}/things`, carrier: 'apikey' },
    { name: 'legacy /api/v1/{table}, where the key names the project', method: 'GET', path: '/api/v1/things' },
    { name: 'function invocation', method: 'POST', path: `/api/v1/${id}/fn/hello`, body: {} },
    { name: 'end-user sign-in, which takes no key', method: 'POST', path: `/api/v1/${id}/auth/signin`, body: { email: 'a@example.test', password: 'not-a-real-password' } },
    { name: 'logs, key as a Bearer token', method: 'GET', path: `/api/v1/${id}/logs`, carrier: 'bearer' },
    { name: 'realtime, key in the query string', method: 'GET', path: `/api/v1/${id}/realtime`, carrier: 'query', openEnded: true },
    { name: 'Next-owned storage, refused before the proxy', method: 'GET', path: `/api/v1/${id}/storage/files`, openEnded: true },
  ]
}

function at(door: Door, key: string, extra: Record<string, string> = {}): { path: string; headers: Record<string, string> } {
  const path = door.path.replace('__ID__', projectId)
  if (door.carrier === 'query') return { path: `${path}?apiKey=${encodeURIComponent(key)}`, headers: { ...extra } }
  if (door.carrier === 'bearer') return { path, headers: { ...extra, authorization: `Bearer ${key}` } }
  if (door.carrier === 'apikey') return { path, headers: { ...extra, apikey: key } }
  return { path, headers: { ...extra, 'x-api-key': key } }
}

describe('an MCP key on the runtime API', () => {
  it.each(doors('__ID__'))('is refused from a server on the $name door', async (door) => {
    const { path, headers } = at(door, mcpKey)
    const res = await call(door.method, path, { headers, body: door.body })
    expect(res.status).toBe(403)
    expect(res.json?.code).toBe(MCP_KEY_IN_APP)
    expect(res.json?.hint).toBe(MCP_KEY_HINT)
  }, 60_000)

  it('is told it is an MCP key, not that it came from a browser, when it did', async () => {
    const res = await call('GET', `/api/v1/${projectId}/db/things`, { headers: { ...BROWSER, 'x-api-key': mcpKey } })
    expect(res.status).toBe(403)
    expect(res.json?.code).toBe(MCP_KEY_IN_APP)
  }, 60_000)

  it('is answered in each surface’s own vocabulary', async () => {
    const v1 = await call('GET', `/api/v1/${projectId}/db/things`, { headers: { 'x-api-key': mcpKey } })
    expect(v1.json).toEqual({ error: expect.stringContaining('"MCP Key" is an MCP key'), code: MCP_KEY_IN_APP, hint: MCP_KEY_HINT })
    const v2 = await call('GET', `/api/v2/${projectId}/things`, { headers: { apikey: mcpKey } })
    expect(v2.json).toEqual({ code: MCP_KEY_IN_APP, message: expect.stringContaining('"MCP Key" is an MCP key'), hint: MCP_KEY_HINT })
  }, 60_000)

  it('never reached a route: the key was not stamped as used or charged a request', async () => {
    const row = await prisma.apiKey.findUnique({ where: { id: mcpKeyId }, select: { lastUsed: true, requestCount: true } })
    expect(row?.lastUsed).toBeNull()
    expect(row?.requestCount).toBe(0)
  })
})

describe('a service-role key from a browser', () => {
  it.each(doors('__ID__'))('is refused on the $name door', async (door) => {
    const { path, headers } = at(door, serviceKey, BROWSER)
    const res = await call(door.method, path, { headers, body: door.body })
    expect(res.status).toBe(403)
    expect(codeOf(res.json)).toBe(SERVICE_ROLE_IN_BROWSER)
  }, 60_000)

  it('spent none of the key’s rate limit', async () => {
    const row = await prisma.apiKey.findUnique({ where: { id: serviceKeyId }, select: { requestCount: true } })
    expect(row?.requestCount).toBe(0)
  })

  it('leaves the evidence the exposure finding reads', async () => {
    // Recorded fire-and-forget, after the refusal was sent.
    let blocked = 0
    for (let i = 0; i < 20 && blocked === 0; i++) {
      const rows = await prisma.auditLog.findMany({
        where: { projectId, action: SERVICE_ROLE_BROWSER_BLOCKED },
        select: { details: true },
      })
      blocked = rows.filter(r => JSON.parse(r.details ?? '{}').apiKeyId === serviceKeyId).length
      if (blocked === 0) await new Promise(r => setTimeout(r, 100))
    }
    expect(blocked).toBeGreaterThan(0)
  }, 30_000)
})

describe('the controls: a key in its own place still reaches its router', () => {
  it.each(doors('__ID__').filter(d => !d.openEnded))('a client key from a browser, on the $name door', async (door) => {
    const { path, headers } = at(door, clientKey, BROWSER)
    const res = await call(door.method, path, { headers, body: door.body })
    expect(PLACEMENT_CODES).not.toContain(codeOf(res.json))
  }, 60_000)

  it.each(doors('__ID__').filter(d => !d.openEnded))('a service-role key from a server, on the $name door', async (door) => {
    const { path, headers } = at(door, serviceKey)
    const res = await call(door.method, path, { headers, body: door.body })
    expect(PLACEMENT_CODES).not.toContain(codeOf(res.json))
  }, 60_000)

  it('a keyless request from a browser', async () => {
    const res = await call('POST', `/api/v1/${projectId}/auth/signin`, {
      headers: BROWSER,
      body: { email: 'a@example.test', password: 'not-a-real-password' },
    })
    expect(PLACEMENT_CODES).not.toContain(codeOf(res.json))
  }, 60_000)
})

describe('the Next door (recordedV1)', () => {
  const ctx = () => ({ params: Promise.resolve({ projectId }) })

  function spyRoute() {
    const calls: string[] = []
    const handler = recordedV1(async (req: Request) => {
      calls.push(new URL(req.url).pathname)
      return new Response('{}', { status: 200 })
    })
    return { calls, handler }
  }

  it('refuses an MCP key before the route runs, on /api/v1 and /api/v2', async () => {
    const { calls, handler } = spyRoute()
    const v1 = await handler(
      new Request(`http://x/api/v1/${projectId}/storage/upload`, { method: 'POST', headers: { 'x-api-key': mcpKey } }),
      ctx(),
    )
    expect(v1.status).toBe(403)
    expect((await v1.json()).code).toBe(MCP_KEY_IN_APP)
    const v2 = await handler(new Request(`http://x/api/v2/${projectId}/things`, { headers: { apikey: mcpKey } }), ctx())
    expect(v2.status).toBe(403)
    expect(await v2.json()).toMatchObject({ code: MCP_KEY_IN_APP, message: expect.stringContaining('MCP key') })
    expect(calls).toEqual([])
  })

  it('refuses a service-role key from a browser before the route runs', async () => {
    const { calls, handler } = spyRoute()
    const res = await handler(
      new Request(`http://x/api/v1/${projectId}/storage/files`, { headers: { ...BROWSER, 'x-api-key': serviceKey } }),
      ctx(),
    )
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe(SERVICE_ROLE_IN_BROWSER)
    expect(calls).toEqual([])
  })

  it('runs the route for a client key from a browser and a service-role key from a server', async () => {
    const { calls, handler } = spyRoute()
    const a = await handler(
      new Request(`http://x/api/v1/${projectId}/storage/files`, { headers: { ...BROWSER, 'x-api-key': clientKey } }),
      ctx(),
    )
    const b = await handler(
      new Request(`http://x/api/v1/${projectId}/storage/files`, { headers: { 'x-api-key': serviceKey } }),
      ctx(),
    )
    expect([a.status, b.status]).toEqual([200, 200])
    expect(calls).toHaveLength(2)
  })
})

describe('the routes’ own authentication repeats both rules', () => {
  // Reached only when a door's lookup failed and let the request through, so it
  // has to stand on its own.

  function expressReq(key: string, extra: Record<string, string> = {}) {
    return {
      params: { projectId },
      query: {},
      method: 'GET',
      originalUrl: `/api/v1/${projectId}/db/things`,
      url: `/api/v1/${projectId}/db/things`,
      headers: { ...extra, 'x-api-key': key },
    } as any
  }

  function fakeRes() {
    const res: any = { statusCode: 0, body: null, headers: {} as Record<string, string> }
    res.status = (code: number) => { res.statusCode = code; return res }
    res.json = (body: unknown) => { res.body = body; return res }
    res.setHeader = (name: string, value: string) => { res.headers[name] = value }
    return res
  }

  it('getProjectIdFromAuth refuses an MCP key from a server, and still serves a client key', async () => {
    expect(await getProjectIdFromAuth(expressReq(mcpKey))).toMatchObject({
      success: false,
      code: MCP_KEY_IN_APP,
      hint: MCP_KEY_HINT,
    })
    expect(await getProjectIdFromAuth(expressReq(clientKey))).toMatchObject({ success: true, projectId })
  })

  it('v1AuthMiddleware names an MCP key instead of calling it a dashboard key', async () => {
    const res = fakeRes()
    const next = jest.fn()
    await v1AuthMiddleware(expressReq(mcpKey), res, next)
    expect(res.statusCode).toBe(403)
    expect(res.body?.error?.code).toBe(MCP_KEY_IN_APP)
    expect(res.body?.error?.details?.hint).toBe(MCP_KEY_HINT)
    expect(next).not.toHaveBeenCalled()
  })

  const nextReq = (key: string, extra: Record<string, string> = {}) =>
    new NextRequest(`https://backenly.test/api/v1/${projectId}/storage/files`, { headers: { ...extra, 'x-api-key': key } })

  it('v1ApiMiddleware refuses a service-role key from a browser, which the Next surfaces never did', async () => {
    const { response } = await v1ApiMiddleware(nextReq(serviceKey, BROWSER), { projectId })
    expect(response?.status).toBe(403)
    expect((await response!.json()).error.code).toBe(SERVICE_ROLE_IN_BROWSER)
  })

  it('v1ApiMiddleware refuses an MCP key by name', async () => {
    const { response } = await v1ApiMiddleware(nextReq(mcpKey), { projectId })
    expect(response?.status).toBe(403)
    const body = await response!.json()
    expect(body.error.code).toBe(MCP_KEY_IN_APP)
    expect(body.error.details.hint).toBe(MCP_KEY_HINT)
  })

  it('v1ApiMiddleware admits a client key from a browser and a service-role key from a server', async () => {
    for (const [key, extra] of [[clientKey, BROWSER], [serviceKey, {}]] as const) {
      const { response, context } = await v1ApiMiddleware(nextReq(key, extra), { projectId })
      expect(response).toBeUndefined()
      expect(context.projectId).toBe(projectId)
    }
  })
})
