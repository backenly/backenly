/**
 * RUNTIME-ONLY PATHS REACH THE RUNTIME
 * ====================================
 * On AWS the load balancer sends everything to Next. Three read-only requests
 * against production on 2026-09-24 showed what that meant for a project's API:
 *
 *   GET /api/v1/{id}/db/todos   404 ROUTE_NOT_FOUND   Next's catch-all
 *   GET /api/v1/{id}/fn/hello   404 ROUTE_NOT_FOUND   Next's catch-all
 *   GET /api/v2/{id}/todos      401 "Authentication required"   Next's middleware
 *
 * The Express runtime answers a keyless /db request with 401 NO_AUTH_PROVIDED,
 * so neither answer came from it. These pin the routing that fixes that,
 * against a stub runtime.
 */

import fs from 'fs'
import path from 'path'
import http from 'http'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'
import type { NextRequest } from 'next/server'

import * as unmatched from '@/app/api/v1/[projectId]/[...unmatched]/route'
import * as v2 from '@/app/api/v2/[projectId]/[[...path]]/route'
import { internalTrafficHeaders, INTERNAL_TRAFFIC_HEADER } from '@/lib/traffic/request-recorder'

interface Seen {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

let seen: Seen[] = []
let origin = ''
let server: http.Server

// jest.setup.js swaps the global Request/Response/Headers for stubs that
// cannot carry a stream. The forwarder is plain Web-API code, so this suite
// gives it Node's real Response and Headers (reachable through a real fetch
// result) and restores the stubs afterwards.
const stubs = { Response: global.Response, Headers: global.Headers }

/** The members the handlers read, over Node's real Headers. */
function req(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  const RealHeaders = (global as any).Headers
  return {
    url,
    method: init.method ?? 'GET',
    headers: new RealHeaders(init.headers ?? {}),
    body: init.body,
  } as unknown as NextRequest
}

beforeAll(async () => {
  const real = await fetch('data:text/plain,x')
  ;(global as any).Response = real.constructor
  ;(global as any).Headers = real.headers.constructor

  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body })
      res.writeHead(200, {
        'Content-Type': 'application/json',
        // The runtime's own CORS answer, which must not reach the browser twice.
        'Access-Control-Allow-Origin': '*',
        'X-Runtime': 'yes',
      })
      res.end(JSON.stringify({ data: [{ id: 1 }] }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  ;(global as any).Response = stubs.Response
  ;(global as any).Headers = stubs.Headers
  delete process.env.RUNTIME_API_URL
  await new Promise<void>(r => server.close(() => r()))
})

beforeEach(() => {
  seen = []
  process.env.RUNTIME_API_URL = origin
})

const ctx = (projectId: string, rest: string[]) => ({
  params: Promise.resolve({ projectId, unmatched: rest, path: rest }),
})

describe('Next forwards what it does not serve', () => {
  it('sends /db/{table} to the runtime, with its query, marked as internal', async () => {
    const id = randomUUID()
    const res = await unmatched.GET(
      req(`https://backenly.com/api/v1/${id}/db/todos?limit=1`, { headers: { 'x-api-key': 'anon_x' } }),
      ctx(id, ['db', 'todos']),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: [{ id: 1 }] })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe(`/api/v1/${id}/db/todos?limit=1`)
    expect(seen[0].headers['x-api-key']).toBe('anon_x')
    expect(seen[0].headers[INTERNAL_TRAFFIC_HEADER]).toBe(internalTrafficHeaders()[INTERNAL_TRAFFIC_HEADER])
    expect(res.headers.get('x-runtime')).toBe('yes')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('streams a write body through', async () => {
    const id = randomUUID()
    await unmatched.POST(
      req(`https://backenly.com/api/v1/${id}/db/todos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'ship it' }),
      }),
      ctx(id, ['db', 'todos']),
    )
    expect(seen[0].method).toBe('POST')
    expect(JSON.parse(seen[0].body)).toEqual({ title: 'ship it' })
  })

  it('forwards /api/v2 as well', async () => {
    const id = randomUUID()
    const res = await v2.GET(req(`https://backenly.com/api/v2/${id}/todos?select=id`), ctx(id, ['todos']))
    expect(res.status).toBe(200)
    expect(seen[0].url).toBe(`/api/v2/${id}/todos?select=id`)
  })

  it('never sends back what the runtime forwarded here, so a path cannot loop', async () => {
    const id = randomUUID()
    const res = await unmatched.GET(
      req(`https://backenly.com/api/v1/${id}/storage/nope`, { headers: internalTrafficHeaders() }),
      ctx(id, ['storage', 'nope']),
    )
    expect(res.status).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it('answers 404 itself when no runtime is configured', async () => {
    delete process.env.RUNTIME_API_URL
    const id = randomUUID()
    const res = await unmatched.GET(req(`https://backenly.com/api/v1/${id}/db/todos`), ctx(id, ['db', 'todos']))
    expect(res.status).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it('says the runtime did not answer, rather than hanging or pretending', async () => {
    process.env.RUNTIME_API_URL = 'http://127.0.0.1:9'
    const id = randomUUID()
    const res = await unmatched.GET(req(`https://backenly.com/api/v1/${id}/db/todos`), ctx(id, ['db', 'todos']))
    expect(res.status).toBe(502)
    expect((await res.json()).error.code).toBe('RUNTIME_UNREACHABLE')
  })
})

describe('the platform middleware lets the v2 data API through', () => {
  // The middleware module does not load under jest (ESM-only dependencies), so
  // this reads its source. The staging release check exercises it for real.
  const src = fs.readFileSync(path.resolve(__dirname, '../../middleware.ts'), 'utf8')

  it('does not demand a platform session for /api/v2', () => {
    expect(src).toMatch(/^\s*'\/api\/v2\/',/m)
  })

  it('answers CORS for /api/v2 the way it does for the SDK routes', () => {
    expect(src).toContain("pathname.startsWith('/api/v2/')")
    // The project id is read from either version's path.
    expect(src).toContain(String.raw`pathname.match(/^\/api\/v[12]\/([^/]+)/)`)
  })
})
