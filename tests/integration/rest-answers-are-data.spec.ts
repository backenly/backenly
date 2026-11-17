/**
 * THE REST APIS' ANSWERS ARE DATA, NEVER A PAGE OF THE PLATFORM'S ORIGIN
 * ======================================================================
 *
 * /api/v2/{projectId}/… sends PostgREST's answer in the media type PostgREST
 * gave, which is the one the request asked for and can be one the project's
 * schema defines. /api/v1/{projectId}/db/… wraps PostgREST's rows in its own
 * JSON. Both are served from Backenly's own origin, so (lib/security/data-answers.ts):
 *   - an answer PostgREST typed as HTML or SVG is sent as text/plain;
 *   - every answer on these paths carries `X-Content-Type-Options: nosniff`
 *     and `Content-Security-Policy: sandbox; default-src 'none'`;
 *   - PostgREST's own types (JSON, CSV, geo+json) are sent as before, with
 *     the headers a cross-origin app reads (Content-Range, through CORS).
 *
 * Both ways an answer leaves Backenly are followed: the runtime itself, and
 * the web server in front of it (tests/helpers/web-server-in-front.ts:
 * next.config.js's headers by Next's own matcher, middleware.ts, the real
 * forwarding routes and Next's response code). PostgREST is a stand-in that
 * answers each table in one media type; everything in front of it is real,
 * with a real project and key.
 */

jest.mock('@sentry/nextjs', () => ({ withSentryConfig: (config: unknown) => config }))
// middleware.ts imports `jose`, which ships ESM-only and jest cannot parse; no
// token is verified on the paths here.
jest.mock('jose', () => ({ jwtVerify: jest.fn(async () => ({ payload: {} })) }))

import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { webServerInFront } from '@/tests/helpers/web-server-in-front'

jest.setTimeout(120_000)

const SANDBOX = "sandbox; default-src 'none'"
const PAGE = '<!doctype html><p>ready</p><script>document.title = "ran"</script>'
const DRAWING = '<svg xmlns="http://www.w3.org/2000/svg"><script>document.title = "ran"</script></svg>'
const PLACES = '{"type":"FeatureCollection","features":[]}'
const ORIGIN = 'https://shop.example'

/** What the PostgREST stand-in answers for each table: one media type each, or CSV when asked. */
function upstreamAnswer(table: string, accept: string): { type: string; body: string; range?: string } {
  switch (table) {
    case 'pages': return { type: 'text/html; charset=utf-8', body: PAGE }
    case 'drawings': return { type: 'image/svg+xml', body: DRAWING }
    case 'places': return { type: 'application/geo+json; charset=utf-8', body: PLACES }
    default:
      return accept.includes('text/csv')
        ? { type: 'text/csv; charset=utf-8', body: 'id,item\n1,mug' }
        : { type: 'application/json; charset=utf-8', body: '[{"id":1,"item":"mug"}]', range: '0-0/1' }
  }
}

let ownerId = ''
let projectId = ''
let apiKey = ''
const servers: http.Server[] = []
const bases: Record<string, string> = {}
const saved = { runtime: process.env.RUNTIME_API_URL, url: process.env.POSTGREST_URL, secret: process.env.POSTGREST_JWT_SECRET }

const listen = async (server: http.Server) => {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

interface Answer {
  status: number
  type: string | null
  nosniff: string | null
  policy: string | null
  range: string | null
  text: string
}

async function get(base: string, path: string, headers: Record<string, string> = {}): Promise<Answer & { res: Response }> {
  const res = await fetch(`${base}${path}`, { headers: { 'x-api-key': apiKey, ...headers } })
  return {
    res,
    status: res.status,
    type: res.headers.get('content-type'),
    nosniff: res.headers.get('x-content-type-options'),
    policy: res.headers.get('content-security-policy'),
    range: res.headers.get('content-range'),
    text: await res.text(),
  }
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ownerId = (await prisma.user.create({ data: { email: `rest-answers-${randomUUID()}@example.test`, name: 'owner' }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: `rest-answers-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  apiKey = `proj_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'app',
      keyPrefix: apiKey.slice(0, 16),
      keyHash: hashApiKey(apiKey),
      permissions: ['read', 'write'],
      capabilities: [],
      userId: ownerId,
      projectId,
      keyType: 'public',
      scope: 'runtime',
      serviceRole: false,
      rateLimit: 1000,
    },
  })
  const postgrest = await listen(
    http.createServer((req, res) => {
      const table = new URL(req.url ?? '/', 'http://upstream').pathname.split('/').filter(Boolean)[0] ?? ''
      const answer = upstreamAnswer(table, String(req.headers.accept ?? ''))
      res.writeHead(200, { 'content-type': answer.type, ...(answer.range ? { 'content-range': answer.range } : {}) })
      res.end(answer.body)
    }),
  )
  process.env.POSTGREST_URL = postgrest
  process.env.POSTGREST_JWT_SECRET = 'rest-answers-test-secret-at-least-32-characters'
  bases.runtime = await listen(http.createServer(app))
  process.env.RUNTIME_API_URL = bases.runtime
  bases['web server'] = await listen(await webServerInFront())
}, 120_000)

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  restore('RUNTIME_API_URL', saved.runtime)
  restore('POSTGREST_URL', saved.url)
  restore('POSTGREST_JWT_SECRET', saved.secret)
  if (projectId) {
    await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe.each(['runtime', 'web server'])('an answer sent by the %s', (server) => {
  const v2 = (table: string, headers?: Record<string, string>) => get(bases[server], `/api/v2/${projectId}/${table}`, headers)
  const v1 = (table: string, headers?: Record<string, string>) => get(bases[server], `/api/v1/${projectId}/db/${table}`, headers)

  it.each([
    ['HTML', 'pages', PAGE],
    ['SVG', 'drawings', DRAWING],
  ])('on /api/v2, typed as %s by PostgREST, is sent as text, with nosniff and the sandbox policy', async (_type, table, body) => {
    expect(await v2(table)).toMatchObject({ status: 200, type: 'text/plain; charset=utf-8', nosniff: 'nosniff', policy: SANDBOX, text: body })
  })

  it('on /api/v1/db, typed as HTML by PostgREST, is Backenly’s JSON, with nosniff and the sandbox policy', async () => {
    const answer = await v1('pages')
    expect(answer).toMatchObject({ status: 200, type: 'application/json; charset=utf-8', nosniff: 'nosniff', policy: SANDBOX })
    expect(answer.text).not.toContain('<script>')
  })

  it.each([
    ['JSON', 'orders', {}, 'application/json; charset=utf-8', '[{"id":1,"item":"mug"}]'],
    ['CSV', 'orders', { accept: 'text/csv' }, 'text/csv; charset=utf-8', 'id,item\n1,mug'],
    ['geo+json', 'places', {}, 'application/geo+json; charset=utf-8', PLACES],
  ])('on /api/v2, typed as %s by PostgREST, is sent as before', async (_type, table, headers, type, text) => {
    expect(await v2(table, headers)).toMatchObject({ status: 200, type, text })
  })

  it('on /api/v1/db, PostgREST’s rows are sent in Backenly’s JSON as before', async () => {
    const answer = await v1('orders')
    expect(answer).toMatchObject({ status: 200, type: 'application/json; charset=utf-8' })
    expect(JSON.parse(answer.text).data).toEqual([{ id: 1, item: 'mug' }])
  })

  it('carries nosniff and the sandbox policy on every answer, Backenly’s own refusals included', async () => {
    for (const path of [`/api/v2/${projectId}/orders`, `/api/v1/${projectId}/db/orders`]) {
      expect({ path, ...(await get(bases[server], path)) }).toMatchObject({ path, nosniff: 'nosniff', policy: SANDBOX })
      const refused = await get(bases[server], path, { 'x-api-key': 'proj_live_not-a-key' })
      expect({ path, status: refused.status >= 400, nosniff: refused.nosniff, policy: refused.policy }).toEqual({ path, status: true, nosniff: 'nosniff', policy: SANDBOX })
    }
  })

  it('lets an app on another origin read Content-Range, as before', async () => {
    const answer = await v2('orders', { origin: ORIGIN, prefer: 'count=exact' })
    expect(answer.res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect((answer.res.headers.get('access-control-expose-headers') ?? '').split(/\s*,\s*/)).toContain('Content-Range')
    expect(answer.range).toBe('0-0/1')
  })
})
