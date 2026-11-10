/**
 * A FUNCTION'S CALLER GETS THE FUNCTION'S ANSWER, NOT ITS LOGS
 * ===========================================================
 *
 * Production QA (2026-11-09): an HTTP function written as a route handler
 * answered `NextResponse.json({ error: … }, { status: 400 })`, and the caller
 * received { success, name, result: { status, body, headers }, logs,
 * durationMs }. The frontend looked for `error`, found none, and said "Request
 * failed (400)". Every reply also carried the run's log lines, so whatever a
 * function logged reached the browser that called it.
 *
 * Pinned against the real runtime and real function rows:
 *
 *  1. At /fn/{name}, a route module's status, body and content type go out as
 *     it wrote them.
 *  2. A plain function keeps its envelope, without log lines for an app's key
 *     and with them for a service-role key, on success and on failure.
 */

import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'

let server: http.Server
let base = ''
let ownerId = ''
let projectId = ''
let appKey = ''
let serviceKey = ''

async function key(serviceRole: boolean): Promise<string> {
  const raw = `${serviceRole ? 'svc' : 'proj'}_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: serviceRole ? 'server' : 'app',
      keyPrefix: raw.slice(0, 12),
      keyHash: hashApiKey(raw),
      userId: ownerId,
      projectId,
      permissions: ['read', 'write'],
      capabilities: [],
      serviceRole,
    },
  })
  return raw
}

async function deploy(name: string, code: string, triggerType: string) {
  await prisma.aiFunction.create({
    data: { projectId, name, description: name, generatedCode: code, triggerType, status: 'active' },
  })
}

async function call(name: string, apiKey: string) {
  const res = await fetch(`${base}/api/v1/${projectId}/fn/${name}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ item: 'mug' }),
  })
  return { status: res.status, type: res.headers.get('content-type'), body: await res.json() as any }
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  ownerId = (await prisma.user.create({
    data: { email: `fn-replies-${randomUUID()}@example.test`, name: 'replies' }, select: { id: true },
  })).id
  projectId = (await prisma.project.create({
    data: { name: `fn-replies-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true },
  })).id
  appKey = await key(false)
  serviceKey = await key(true)

  await deploy('out-of-stock', [
    "import { NextResponse } from 'next/server'",
    'export async function POST(req) {',
    "  console.log('checked stock for card ending 4242')",
    "  return NextResponse.json({ error: 'Out of stock', item: 'mug' }, { status: 400 })",
    '}',
  ].join('\n'), 'http')
  await deploy('plain-answer', "ctx.log('looked up token abc123')\nreturn { ok: true }", 'manual')
  await deploy('plain-failure', "ctx.log('about to fail for user 42')\nthrow new Error('deliberately broken')", 'manual')

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 60_000)

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('a route module at /fn/{name}', () => {
  it('answers with its own status, body and content type', async () => {
    const reply = await call('out-of-stock', appKey)
    expect(reply.status).toBe(400)
    expect(reply.type).toMatch(/^application\/json/)
    expect(reply.body).toEqual({ error: 'Out of stock', item: 'mug' })
  }, 60_000)
})

describe('a plain function', () => {
  it('keeps its envelope, without the log lines, for an app key', async () => {
    const reply = await call('plain-answer', appKey)
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ success: true, name: 'plain-answer', result: { ok: true } })
    expect(reply.body).not.toHaveProperty('logs')
    expect(JSON.stringify(reply.body)).not.toContain('abc123')
  }, 60_000)

  it('sends the log lines to a service-role key', async () => {
    const reply = await call('plain-answer', serviceKey)
    expect(reply.body).toMatchObject({ success: true, result: { ok: true }, logs: ['looked up token abc123'] })
  }, 60_000)

  it('says it failed without the log lines for an app key, and with them for a service-role key', async () => {
    const forApp = await call('plain-failure', appKey)
    expect(forApp.status).toBe(500)
    expect(forApp.body).toMatchObject({ code: 'FUNCTION_EXECUTION_ERROR' })
    expect(forApp.body.error).toContain('deliberately broken')
    expect(forApp.body).not.toHaveProperty('logs')

    const forServer = await call('plain-failure', serviceKey)
    expect(forServer.body.logs).toEqual(['about to fail for user 42'])
  }, 60_000)
})
