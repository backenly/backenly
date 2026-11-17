/**
 * EVERY /db RESPONSE SAYS /db IS DEPRECATED, FROM EITHER SERVER
 * =============================================================
 *
 * /api/v2/{projectId}/{table} is the one REST API (production QA, #22: two
 * dialects over the same tables). /db keeps working for existing apps, and
 * every /api/v1/{projectId}/db response carries Deprecation (RFC 9745) and a
 * Link rel="successor-version" to the same table on /api/v2
 * (lib/api/v1/deprecation.ts). A /api/v2 response carries neither.
 *
 * Two servers answer /db. The runtime (server/app.ts) serves it, and is driven
 * here over a real socket: its refusals carry the headers too, because they
 * are set before any gate. Next is the ingress on AWS: it forwards /db to the
 * runtime and answers some requests itself, so its route handlers are called
 * here directly, with and without a runtime behind them. Browsers can read both
 * headers: they are in the CORS exposed headers.
 *
 * Requests carry no key on purpose: a refusal is a /db response like any other.
 */

import '../helpers/real-web-standard'
import http from 'http'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'
import { NextRequest } from 'next/server'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'

/** RFC 9745: a Structured Field Date, 2026-11-17T00:00:00Z (lib/api/v1/deprecation.ts). */
const V1_DB_DEPRECATION = '@1794873600'

let server: http.Server
let base = ''
let ownerId = ''
let projectId = ''
const ROW = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const savedRuntime = process.env.RUNTIME_API_URL

async function call(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(15_000) })
  await res.text()
  return res
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({
    data: { email: `db-deprecated-${randomUUID()}@example.test` },
    select: { id: true },
  })).id
  projectId = (await prisma.project.create({
    data: { name: `db-deprecated-${randomUUID().slice(0, 8)}`, userId: ownerId },
    select: { id: true },
  })).id
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  if (savedRuntime === undefined) delete process.env.RUNTIME_API_URL
  else process.env.RUNTIME_API_URL = savedRuntime
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}, 120_000)

describe('the runtime', () => {
  it('marks a /db table response, a refusal included, and points it at the table on /api/v2', async () => {
    const res = await call(`/api/v1/${projectId}/db/things?status=paid`)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.headers.get('deprecation')).toBe(V1_DB_DEPRECATION)
    expect(res.headers.get('link')).toBe(`</api/v2/${projectId}/things>; rel="successor-version"`)
  }, 60_000)

  it('points a record at the same record on /api/v2', async () => {
    const res = await call(`/api/v1/${projectId}/db/things/${ROW}`)
    expect(res.headers.get('link')).toBe(`</api/v2/${projectId}/things/${ROW}>; rel="successor-version"`)
  }, 60_000)

  it('marks nothing on /api/v2, or on a v1 route that is not /db', async () => {
    for (const path of [`/api/v2/${projectId}/things`, `/api/v1/${projectId}/fn/hello`]) {
      const res = await call(path)
      expect({ path, deprecation: res.headers.get('deprecation'), link: res.headers.get('link') })
        .toEqual({ path, deprecation: null, link: null })
    }
  }, 60_000)

  it('lets a browser read both headers', async () => {
    const res = await call(`/api/v1/${projectId}/db/things`, { origin: 'https://app.example.test' })
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').split(',').map((h) => h.trim())
    expect(exposed).toEqual(expect.arrayContaining(['Deprecation', 'Link', 'Retry-After']))
  }, 60_000)
})

describe('the Next ingress', () => {
  const catchAll = async (path: string[]) => {
    const { GET } = await import('@/app/api/v1/[projectId]/[...unmatched]/route')
    return GET(
      new NextRequest(`https://backenly.test/api/v1/${projectId}/${path.join('/')}`),
      { params: Promise.resolve({ projectId, unmatched: path }) },
    )
  }

  it('marks a /db response it answers itself, with no runtime behind it', async () => {
    delete process.env.RUNTIME_API_URL
    const res = await catchAll(['db', 'things'])
    expect(res.status).toBe(404)
    expect(res.headers.get('deprecation')).toBe(V1_DB_DEPRECATION)
    expect(res.headers.get('link')).toBe(`</api/v2/${projectId}/things>; rel="successor-version"`)
  }, 60_000)

  it('marks a response forwarded from a runtime that did not, and leaves a runtime’s own marking alone', async () => {
    let marked = false
    const runtime = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        ...(marked ? { deprecation: '@1', link: '</elsewhere>; rel="successor-version"' } : {}),
      })
      res.end('{"data":[]}')
    })
    await new Promise<void>((resolve) => runtime.listen(0, '127.0.0.1', resolve))
    process.env.RUNTIME_API_URL = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}`
    try {
      const bare = await catchAll(['db', 'things'])
      expect(bare.status).toBe(200)
      expect(bare.headers.get('deprecation')).toBe(V1_DB_DEPRECATION)
      expect(bare.headers.get('link')).toBe(`</api/v2/${projectId}/things>; rel="successor-version"`)

      // Sent once: what the runtime said is kept, never appended to.
      marked = true
      const forwarded = await catchAll(['db', 'things'])
      expect(forwarded.headers.get('deprecation')).toBe('@1')
      expect(forwarded.headers.get('link')).toBe('</elsewhere>; rel="successor-version"')
    } finally {
      delete process.env.RUNTIME_API_URL
      runtime.closeAllConnections()
      await new Promise<void>((resolve) => runtime.close(() => resolve()))
    }
  }, 60_000)

  it('marks nothing on its /api/v2 route', async () => {
    delete process.env.RUNTIME_API_URL
    const { GET } = await import('@/app/api/v2/[projectId]/[[...path]]/route')
    const res = await GET(
      new NextRequest(`https://backenly.test/api/v2/${projectId}/things`),
      { params: Promise.resolve({ projectId, path: ['things'] }) },
    )
    expect(res.headers.get('deprecation')).toBeNull()
    expect(res.headers.get('link')).toBeNull()
  }, 60_000)
})
