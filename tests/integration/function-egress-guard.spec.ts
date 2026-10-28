/**
 * MODULE CODE'S fetch GOES THROUGH THE EGRESS GUARD, NOT THE HOST
 * ===============================================================
 * Route modules run in an in-process vm whose sandbox handed them the HOST
 * realm's global fetch. The runner's comment justified that with "first-party
 * templates, never user/LLM free-form" — a premise deploy_code and the
 * generator broke long ago. The ctx sandbox routes ctx.http through safeFetch
 * precisely because a bare fetch reaches everything the platform process can
 * reach: the cloud metadata service, the VPC, the loopback admin ports.
 *
 * This proves it with a real loopback server: on the unfixed runner the
 * module reads it; on the fixed runner the request is refused AND the server
 * never sees a connection. The self-host escape hatch
 * (BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE) still works, which also pins the
 * wrapper's web-fetch call shape (method, headers, body, res.json()).
 *
 * Real vm runner, real guard, real sockets. No mocks.
 */

import http from 'http'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeRouteModuleFunction, validateRouteModule } from '@/lib/services/ai-functions/route-module-runner'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId = ''
let projectId = ''
let server: http.Server
let loopbackUrl = ''
let hits = 0
let lastReq: { method: string; auth: string | undefined; body: string } | null = null

// The handler catches, so the assertion reads data instead of depending on
// throw semantics: reached=true carries the loopback server's answer.
const probeModule = (url: string) => `
import { NextResponse } from 'next/server'
export async function POST(req: Request) {
  try {
    const res = await fetch('${url}', {
      method: 'POST',
      headers: { authorization: 'Bearer probe', 'content-type': 'application/json' },
      body: JSON.stringify({ probe: true }),
    })
    const data = await res.json()
    return NextResponse.json({ reached: true, status: res.status, data })
  } catch (e) {
    return NextResponse.json({ reached: false, error: String((e && e.message) || e) })
  }
}
`

async function runProbe(url: string) {
  const result = await executeRouteModuleFunction(
    probeModule(url),
    projectId,
    { type: 'manual', data: {} },
    'POST /fn/egress-probe',
    { testRun: true },
  )
  return result.returnValue.body as { reached: boolean; status?: number; data?: any; error?: string }
}

beforeAll(async () => {
  assertSafeTestDatabase()
  delete process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE

  ownerId = (
    await prisma.user.create({
      data: { email: `fn-egress-${randomUUID()}@test.invalid`, name: 'Egress Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `fn-egress-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id

  // Stands in for a loopback admin service (PostgREST, the runtime, ...).
  server = http.createServer((req, res) => {
    hits++
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      lastReq = { method: req.method ?? '', auth: req.headers.authorization as string | undefined, body }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ secret: 'loopback-only' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  loopbackUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal`
}, 120_000)

afterAll(async () => {
  delete process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

describe('module fetch cannot reach what the process can', () => {
  it('a loopback service is refused, and never even sees a connection', async () => {
    hits = 0
    const body = await runProbe(loopbackUrl)
    expect(body.reached).toBe(false)
    expect(hits).toBe(0)
  }, 60_000)

  it('the refusal names the guard, not a generic network error', async () => {
    const body = await runProbe(loopbackUrl)
    expect(body.error).toMatch(/loopback|blocked|private/i)
  }, 60_000)
})

describe('the self-host escape hatch and the call shape still work', () => {
  it('with BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE the same call goes through, faithfully', async () => {
    process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE = 'true'
    try {
      hits = 0
      const body = await runProbe(loopbackUrl)
      expect(body.reached).toBe(true)
      expect(body.status).toBe(200)
      expect(body.data).toEqual({ secret: 'loopback-only' })
      expect(hits).toBe(1)
      // method, headers and body crossed the wrapper intact
      expect(lastReq).toMatchObject({ method: 'POST', auth: 'Bearer probe', body: JSON.stringify({ probe: true }) })
    } finally {
      delete process.env.BACKENLY_FUNCTION_EGRESS_ALLOW_PRIVATE
    }
  }, 60_000)
})

describe('validation never touches the network', () => {
  it('a module that fetches at top level fails evaluation instead of reaching out', () => {
    hits = 0
    const check = validateRouteModule(
      `import { NextResponse } from 'next/server'
fetch('${loopbackUrl}')
export async function GET(req: Request) { return NextResponse.json({ ok: true }) }`,
      'GET',
    )
    expect(check.valid).toBe(false)
    expect(check.error).toContain('fetch is not available')
    expect(hits).toBe(0)
  }, 60_000)
})
