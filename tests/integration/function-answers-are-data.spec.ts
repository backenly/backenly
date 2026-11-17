/**
 * A FUNCTION'S ANSWER IS DATA, NEVER A PAGE OF THE PLATFORM'S ORIGIN
 * ==================================================================
 *
 * /api/v1/{projectId}/fn/{name} is served from Backenly's own origin, and a
 * function chooses its answer's content type. An answer typed as HTML, SVG or
 * JavaScript is sent as text/plain, and every answer on a function's path
 * carries `X-Content-Type-Options: nosniff` and `Content-Security-Policy:
 * sandbox; default-src 'none'`. JSON and text answers are sent as before.
 *
 * Both ways an answer leaves Backenly are followed:
 *   - the runtime itself (server/app.ts and server/routes/dynamic.ts), as a
 *     load balancer that sends /api/v1 straight to it serves it;
 *   - the web server in front of it: next.config.js's headers, matched with
 *     Next's own loader and matcher and set before the route runs as
 *     server/lib/router-server.js sets them; the real route,
 *     app/api/v1/[projectId]/[...unmatched], which forwards to the runtime
 *     (lib/runtime/forward-to-runtime.ts); and Next's own
 *     server/send-response.js, which adds the route's headers where the config
 *     set none. (middleware.ts sets neither a policy nor a content type.)
 *
 * Real runtime, route, API key and function rows; functions run in the
 * function runner.
 */

jest.mock('@sentry/nextjs', () => ({ withSentryConfig: (config: unknown) => config }))

import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'
import { NextRequest } from 'next/server'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { GET as forwardGet, POST as forwardPost } from '@/app/api/v1/[projectId]/[...unmatched]/route'
import { configHeadersFor, nextConfigHeaderRules } from '@/tests/helpers/next-config-headers'

const { sendResponse } = require('next/dist/server/send-response') as {
  sendResponse: (req: http.IncomingMessage, res: unknown, response: Response) => Promise<void>
}
const { NodeNextResponse } = require('next/dist/server/base-http/node') as { NodeNextResponse: new (res: http.ServerResponse) => unknown }

jest.setTimeout(120_000)

const SANDBOX = "sandbox; default-src 'none'"
let ownerId = ''
let projectId = ''
let apiKey = ''
const servers: http.Server[] = []
const bases: Record<string, string> = {}
const savedRuntimeUrl = process.env.RUNTIME_API_URL

const listen = async (server: http.Server) => {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

/** The web server in front of the runtime, as Next serves a path under /api/v1/{projectId} it has no route of its own for. */
async function webServer(): Promise<http.Server> {
  const rules = await nextConfigHeaderRules()
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    for (const [name, value] of Object.entries(configHeadersFor(rules, url.pathname))) res.setHeader(name, value)
    const [, , , routeProject, ...unmatched] = url.pathname.split('/')
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value)
    const method = req.method ?? 'GET'
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req)
    const request = new NextRequest(url, { method, headers, body })
    const route = method === 'POST' ? forwardPost : forwardGet
    const response = await route(request, { params: Promise.resolve({ projectId: routeProject, unmatched }) })
    await sendResponse(req, new NodeNextResponse(res), response)
  })
}

interface Answer {
  status: number
  type: string | null
  nosniff: string | null
  policy: string | null
  text: string
}

async function call(base: string, path: string): Promise<Answer> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  return {
    status: res.status,
    type: res.headers.get('content-type'),
    nosniff: res.headers.get('x-content-type-options'),
    policy: res.headers.get('content-security-policy'),
    text: await res.text(),
  }
}

const PAGE = '<!doctype html><p>ready</p><script>document.title = "ran"</script>'
const DRAWING = '<svg xmlns="http://www.w3.org/2000/svg"><script>document.title = "ran"</script></svg>'
const SCRIPT = 'document.title = "ran"'

const FUNCTIONS: Record<string, string> = {
  // NextResponse.json with its own headers, as functions written before
  // @backenly/functions answer.
  'page-before': `
    import { NextResponse } from 'next/server'
    export async function POST() {
      return NextResponse.json(${JSON.stringify(PAGE)}, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }`,
  page: `export async function POST() { return new Response(${JSON.stringify(PAGE)}, { headers: { 'content-type': 'text/html; charset=utf-8' } }) }`,
  drawing: `export async function POST() { return new Response(${JSON.stringify(DRAWING)}, { headers: { 'content-type': 'image/svg+xml' } }) }`,
  script: `export async function POST() { return new Response(${JSON.stringify(SCRIPT)}, { headers: { 'content-type': 'application/javascript; charset=utf-8' } }) }`,
  data: `export async function POST() { return Response.json({ ok: true }) }`,
  'data-before': `
    import { NextResponse } from 'next/server'
    export async function POST() { return NextResponse.json({ ok: true }, { status: 201 }) }`,
  pong: `export async function POST() { return new Response('pong') }`,
  table: `export async function POST() { return new Response('a,b\\n1,2', { headers: { 'content-type': 'text/csv' } }) }`,
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ownerId = (await prisma.user.create({ data: { email: `fn-answers-${randomUUID()}@example.test`, name: 'owner' }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: `fn-answers-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
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
  for (const [name, code] of Object.entries(FUNCTIONS)) {
    await prisma.aiFunction.create({ data: { projectId, name, description: name, generatedCode: code, triggerType: 'http', status: 'active' } })
  }
  bases.runtime = await listen(http.createServer(app))
  process.env.RUNTIME_API_URL = bases.runtime
  bases['web server'] = await listen(await webServer())
}, 120_000)

afterAll(async () => {
  for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()))
  if (savedRuntimeUrl === undefined) delete process.env.RUNTIME_API_URL
  else process.env.RUNTIME_API_URL = savedRuntimeUrl
  if (projectId) {
    await prisma.aiFunctionLog.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.aiFunction.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe.each(['runtime', 'web server'])('an answer sent by the %s', (server) => {
  const fn = (name: string) => call(bases[server], `/api/v1/${projectId}/fn/${name}`)

  it.each([
    ['HTML, through NextResponse.json', 'page-before', JSON.stringify(PAGE)],
    ['HTML', 'page', PAGE],
    ['SVG', 'drawing', DRAWING],
    ['JavaScript', 'script', SCRIPT],
  ])('typed as %s is sent as text, with nosniff and the sandbox policy', async (_type, name, body) => {
    const answer = await fn(name)
    expect(answer).toEqual({ status: 200, type: 'text/plain; charset=utf-8', nosniff: 'nosniff', policy: SANDBOX, text: body })
  })

  it.each([
    ['JSON', 'data', 200, 'application/json; charset=utf-8', '{"ok":true}'],
    ['JSON, through NextResponse.json', 'data-before', 201, 'application/json; charset=utf-8', '{"ok":true}'],
    ['text', 'pong', 200, 'text/plain; charset=utf-8', 'pong'],
    ['CSV', 'table', 200, 'text/csv; charset=utf-8', 'a,b\n1,2'],
  ])('typed as %s is sent as before', async (_type, name, status, type, text) => {
    expect(await fn(name)).toMatchObject({ status, type, text })
  })

  it('carries nosniff and the sandbox policy on every answer on a function’s path, Backenly’s own included', async () => {
    for (const name of ['data', 'pong', 'not-a-function']) {
      expect({ name, ...(await fn(name)) }).toMatchObject({ name, nosniff: 'nosniff', policy: SANDBOX })
    }
    expect((await fn('not-a-function')).status).toBe(404)
  })
})

it('runs no function on a path whose fn segment only percent-decoding makes', async () => {
  for (const path of [`/api/v1/${projectId}/%66n/page`, `/api/v1/${projectId}/fn%2Fpage`]) {
    const answer = await call(bases.runtime, path)
    expect({ path, status: answer.status >= 400, ran: answer.text.includes('ready') }).toEqual({ path, status: true, ran: false })
  }
})
