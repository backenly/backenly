/**
 * Presence identity is bound to the caller's sign-in (medium finding RT-10).
 *
 * Both presence writers took `userId` from the request body unchecked, so any
 * holder of the PUBLIC anon key could mark any user online with arbitrary
 * metadata, or kick anyone offline — presence renders as "that user is online"
 * in every subscribed client, so the name is an identity claim, not a label.
 *
 * The rule, on both runtimes (Express server/routes/presence.ts and the Next
 * route), now matches the data plane's:
 *   - service-role key          → any userId (trusted server-side caller)
 *   - public key + X-User-Token → only the token's own userId
 *   - public key, no token      → refused, with the remedy named
 */
import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import crypto, { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { POST as nextJoin, DELETE as nextLeave } from '@/app/api/v1/[projectId]/presence/route'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'

let server: http.Server
let base: string
let ownerId: string
let projectId: string
let jwtSecret: string
let publicKey: string
let serviceKey: string

const userToken = (uid: string) =>
  jwt.sign(
    { userId: uid, email: `${uid}@presence.test`, projectId, role: 'user', jti: randomUUID() },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: '1h' },
  )

async function makeKey(prefix: string, serviceRole: boolean): Promise<string> {
  const raw = `${prefix}${crypto.randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: `presence-${serviceRole ? 'service' : 'public'}`,
      keyPrefix: raw.slice(0, 16),
      permissions: ['read', 'write'],
      capabilities: [],
      userId: ownerId,
      projectId,
      keyType: 'public',
      serviceRole,
      keyHash: hashApiKey(raw),
    },
  })
  return raw
}

async function onlineUserIds(): Promise<string[]> {
  // A refused FIRST write never bootstraps the presence table — a missing
  // table therefore means exactly "nobody was marked online".
  try {
    const rows = await prisma.$queryRawUnsafe<{ userId: string }[]>(
      `SELECT "userId" FROM "workspace_${projectId}"."_backenly_presence"`,
    )
    return rows.map((r) => r.userId)
  } catch (err: any) {
    if (err?.code === '42P01' || String(err?.message ?? err).includes('42P01')) return []
    throw err
  }
}

type Call = (opts: { key: string; token?: string; userId: string; metadata?: unknown }) => Promise<{ status: number; body: any }>

const runtimes: Record<'express' | 'next', { join: Call; leave: Call }> = {
  express: {
    join: async ({ key, token, userId, metadata }) => {
      const res = await fetch(`${base}/api/v1/${projectId}/presence`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          ...(token ? { 'x-user-token': token } : {}),
        },
        body: JSON.stringify({ userId, metadata: metadata ?? {} }),
      })
      return { status: res.status, body: await res.json().catch(() => ({})) }
    },
    leave: async ({ key, token, userId }) => {
      const res = await fetch(`${base}/api/v1/${projectId}/presence?userId=${encodeURIComponent(userId)}`, {
        method: 'DELETE',
        headers: { 'x-api-key': key, ...(token ? { 'x-user-token': token } : {}) },
      })
      return { status: res.status, body: await res.json().catch(() => ({})) }
    },
  },
  next: {
    join: async ({ key, token, userId, metadata }) => {
      const req = new NextRequest(`http://test.local/api/v1/${projectId}/presence`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          ...(token ? { 'x-user-token': token } : {}),
        },
        body: JSON.stringify({ userId, metadata: metadata ?? {} }),
      })
      const res = await nextJoin(req, { params: Promise.resolve({ projectId }) })
      return { status: res.status, body: await res.json().catch(() => ({})) }
    },
    leave: async ({ key, token, userId }) => {
      const req = new NextRequest(
        `http://test.local/api/v1/${projectId}/presence?userId=${encodeURIComponent(userId)}`,
        { method: 'DELETE', headers: { 'x-api-key': key, ...(token ? { 'x-user-token': token } : {}) } },
      )
      const res = await nextLeave(req, { params: Promise.resolve({ projectId }) })
      return { status: res.status, body: await res.json().catch(() => ({})) }
    },
  },
}

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `presence-binding-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Presence Binding Suite',
      },
      select: { id: true },
    })
  ).id
  jwtSecret = crypto.randomBytes(32).toString('hex')
  projectId = (
    await prisma.project.create({
      data: { name: 'presence-binding', userId: ownerId, jwtSecret },
      select: { id: true },
    })
  ).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
  publicKey = await makeKey('proj_live_', false)
  serviceKey = await makeKey('svc_live_', true)

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 180_000)

afterAll(async () => {
  await flushRecordedRequests().catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
}, 120_000)

describe.each(Object.keys(runtimes) as Array<keyof typeof runtimes>)('%s runtime', (name) => {
  const rt = runtimes[name]
  // Per-runtime ids so the two runtimes never read each other's rows.
  const alice = `alice-${name}`
  const bob = `bob-${name}`
  const victim = `victim-${name}`

  it('the public key alone cannot announce anyone', async () => {
    const out = await rt.join({ key: publicKey, userId: victim })
    expect(out.status).toBe(401)
    expect(out.body.code ?? out.body.error?.code).toBeDefined()
    expect(JSON.stringify(out.body)).toContain('PRESENCE_TOKEN_REQUIRED')
    expect(await onlineUserIds()).not.toContain(victim)
  }, 60_000)

  it('a signed-in user cannot announce someone else, with any metadata', async () => {
    const out = await rt.join({
      key: publicKey,
      token: userToken(alice),
      userId: victim,
      metadata: { name: 'Impersonated', role: 'admin' },
    })
    expect(out.status).toBe(403)
    expect(JSON.stringify(out.body)).toContain('PRESENCE_IDENTITY_MISMATCH')
    expect(await onlineUserIds()).not.toContain(victim)
  }, 60_000)

  it('a signed-in user announces themselves', async () => {
    const out = await rt.join({ key: publicKey, token: userToken(alice), userId: alice })
    expect(out.status).toBe(200)
    expect(await onlineUserIds()).toContain(alice)
  }, 60_000)

  it('a signed-in user cannot kick someone else offline', async () => {
    const seeded = await rt.join({ key: serviceKey, userId: bob })
    expect(seeded.status).toBe(200)
    const out = await rt.leave({ key: publicKey, token: userToken(alice), userId: bob })
    expect(out.status).toBe(403)
    expect(await onlineUserIds()).toContain(bob)
  }, 60_000)

  it('a service-role key may announce and clear any user', async () => {
    const synthetic = `synthetic-${name}`
    expect((await rt.join({ key: serviceKey, userId: synthetic })).status).toBe(200)
    expect(await onlineUserIds()).toContain(synthetic)
    expect((await rt.leave({ key: serviceKey, userId: synthetic })).status).toBe(200)
    expect(await onlineUserIds()).not.toContain(synthetic)
  }, 60_000)

  it('leaving as yourself still works', async () => {
    const out = await rt.leave({ key: publicKey, token: userToken(alice), userId: alice })
    expect(out.status).toBe(200)
    expect(await onlineUserIds()).not.toContain(alice)
  }, 60_000)
})
