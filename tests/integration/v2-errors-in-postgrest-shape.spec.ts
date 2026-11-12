/**
 * EVERY v2 ERROR IS IN POSTGREST'S SHAPE
 * ======================================
 *
 * v2 exists so that someone fluent in PostgREST is fluent here, and PostgREST
 * answers an error as { code, message, details, hint }. The refusals v2 shares
 * with v1 answered in v1's envelope instead: the exposure check said
 * { error, code }, a body too large said { error, code }, the serving gate
 * said { success: false, error: { code, message } }. Production QA
 * (2026-11-09) counted four envelopes across the APIs.
 *
 * The real Express app on an ephemeral port, a real project and a real key.
 * PostgREST itself is never reached: each refusal here comes first.
 */
import http from 'http'
import type { AddressInfo } from 'net'
import { randomBytes, randomUUID } from 'crypto'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'

let server: http.Server
let base: string
let ownerId: string
let projectId: string
let key: string
const ORIGINAL = { url: process.env.POSTGREST_URL, secret: process.env.POSTGREST_JWT_SECRET }

beforeAll(async () => {
  // Configured, so v2 gets past "PostgREST is not configured" to the checks under
  // test. Nothing listens there: no request in this suite reaches it.
  process.env.POSTGREST_URL = 'http://127.0.0.1:9'
  process.env.POSTGREST_JWT_SECRET = 'v2-error-shape-test-secret-at-least-32-chars'
  ownerId = (await prisma.user.create({ data: { email: `v2-shape-${randomUUID()}@example.test` }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: `v2-shape-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  key = `bk_test_${randomBytes(16).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'v2 error shape', keyPrefix: key.slice(0, 12), permissions: ['read', 'write'], capabilities: [],
      userId: ownerId, projectId, keyType: 'public', keyHash: hashApiKey(key),
    },
  })
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  for (const [name, value] of [['POSTGREST_URL', ORIGINAL.url], ['POSTGREST_JWT_SECRET', ORIGINAL.secret]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}, 120_000)

async function call(method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(15_000) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

it("answers a table it never serves as PostgREST would: code, message, details and hint", async () => {
  const r = await call('GET', `/api/v2/${projectId}/users`, { headers: { apikey: key } })
  expect(r.status).toBe(404)
  expect(r.json).toEqual({ code: 'NOT_FOUND', message: 'Resource "users" not found', details: null, hint: null })
})

it('answers a body over the limit in the same shape', async () => {
  const r = await call('POST', `/api/v2/${projectId}/things`, {
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ blob: 'x'.repeat(11 * 1024 * 1024) }),
  })
  expect(r.status).toBe(413)
  expect(r.json).toMatchObject({ code: expect.any(String), message: expect.any(String), details: null, hint: null })
  expect(r.json).not.toHaveProperty('error')
})

it('CONTROL: v1 keeps its own envelope for the same refusal', async () => {
  const r = await call('GET', `/api/v1/${projectId}/db/_backenly_presence`, { headers: { 'x-api-key': key } })
  expect(r.status).toBe(404)
  // v1's `error` stays, with the top-level `message` every v1 error now
  // carries beside it (lib/api/v1/error-shape.ts); PostgREST's details and hint
  // are v2's alone.
  expect(r.json).toMatchObject({ error: 'Resource "_backenly_presence" not found', code: 'NOT_FOUND', message: 'Resource "_backenly_presence" not found' })
  expect(r.json).not.toHaveProperty('details')
  expect(r.json).not.toHaveProperty('hint')
})
