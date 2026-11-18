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
 *   - the web server in front of it (tests/helpers/web-server-in-front.ts):
 *     next.config.js's headers by Next's own matcher, middleware.ts, the real
 *     route app/api/v1/[projectId]/[...unmatched], which forwards to the
 *     runtime (lib/runtime/forward-to-runtime.ts), and Next's own
 *     server/send-response.js.
 *
 * Real runtime, route, API key and function rows; functions run in the
 * function runner.
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
  bases['web server'] = await listen(await webServerInFront())
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
