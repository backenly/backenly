/**
 * A FUNCTION RUN IS RECORDED AS IT HAPPENED, AND A ROUTE FUNCTION READS THE PROJECT'S VARIABLES
 * =========================================================================================
 * Production QA (2026-11-09): a checkout called over HTTP answered 400, and
 * its run was recorded as success, with no log lines, triggered "manual".
 * And the project's environment variables, which the console says functions
 * read as ctx.env.KEY, never reached a route function at all: it saw only
 * the few variables Backenly sets.
 *
 * Pinned against the real runtime and real function rows:
 *  1. A call through /fn is recorded as triggered by http; the record ends with
 *     the status the function answered; a 4xx answer is a successful run, a 5xx
 *     a failed one.
 *  2. A route function reads the project's variables as process.env.KEY, and a
 *     variable cannot replace one Backenly sets.
 */

import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { setEnvVar } from '@/lib/services/projectEnvVars'

let server: http.Server
let base = ''
let ownerId = ''
let projectId = ''
let serviceKey = ''

async function deploy(name: string, code: string, triggerType: string): Promise<string> {
  return (await prisma.aiFunction.create({
    data: { projectId, name, description: name, generatedCode: code, triggerType, status: 'active' },
    select: { id: true },
  })).id
}

async function call(name: string) {
  const res = await fetch(`${base}/api/v1/${projectId}/fn/${name}`, {
    method: 'POST',
    headers: { 'x-api-key': serviceKey, 'content-type': 'application/json' },
    body: JSON.stringify({ item: 'mug' }),
  })
  return { status: res.status, body: (await res.json()) as any }
}

const lastRun = (functionId: string) =>
  prisma.aiFunctionLog.findFirst({
    where: { functionId },
    orderBy: { createdAt: 'desc' },
    select: { success: true, logs: true, error: true, triggerType: true },
  })

const route = (status: number, extra = '') =>
  [
    "import { NextResponse } from 'next/server'",
    'export async function POST(req) {',
    "  console.log('checked stock')",
    extra,
    `  return NextResponse.json({ error: 'answer ${status}' }, { status: ${status} })`,
    '}',
  ].join('\n')

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ownerId = (await prisma.user.create({ data: { email: `fn-runs-${randomUUID()}@example.test`, name: 'runs' }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: `fn-runs-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  const raw = `svc_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: { name: 'server', keyPrefix: raw.slice(0, 12), keyHash: hashApiKey(raw), userId: ownerId, projectId, permissions: ['read', 'write'], capabilities: [], serviceRole: true },
  })
  serviceKey = raw

  await setEnvVar({ projectId, key: 'STORE_NAME', value: 'Mugs & Co', userId: ownerId })
  await setEnvVar({ projectId, key: 'NODE_ENV', value: 'from-the-project', userId: ownerId })

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('the record of a call through /fn', () => {
  it('says it came over http, ends with the status answered, and counts a 4xx as a successful run', async () => {
    const id = await deploy('out-of-stock', route(400), 'http')
    expect((await call('out-of-stock')).status).toBe(400)
    expect(await lastRun(id)).toEqual({ success: true, logs: ['checked stock', 'answered HTTP 400'], error: null, triggerType: 'http' })
  }, 60_000)

  it('counts a 5xx answer as a failed run, and says so', async () => {
    const id = await deploy('broken-checkout', route(503), 'http')
    expect((await call('broken-checkout')).status).toBe(503)
    expect(await lastRun(id)).toEqual({
      success: false,
      logs: ['checked stock', 'answered HTTP 503'],
      error: 'The function answered HTTP 503.',
      triggerType: 'http',
    })
  }, 60_000)
})

describe("a route function and the project's variables", () => {
  it('reads them as process.env.KEY, and none replaces a variable Backenly sets', async () => {
    await deploy(
      'store-name',
      [
        "import { NextResponse } from 'next/server'",
        'export async function POST(req) {',
        '  return NextResponse.json({ store: process.env.STORE_NAME ?? null, nodeEnv: process.env.NODE_ENV ?? null })',
        '}',
      ].join('\n'),
      'http',
    )
    const reply = await call('store-name')
    expect(reply.status).toBe(200)
    // Backenly sets NODE_ENV; the project's variable of that name does not replace it.
    expect(reply.body).toEqual({ store: 'Mugs & Co', nodeEnv: process.env.NODE_ENV })
  }, 60_000)
})
