/**
 * Blocking an end user stops their existing tokens at request time
 * (medium finding AUTH-F4).
 *
 * block_end_user promises "their existing JWT tokens stop working
 * immediately" and its receipt says "They will receive a 403 on their next
 * request" — but is_blocked was read only at sign-in and refresh, so a
 * blocked user's live token kept serving data for up to seven days. The
 * request-time identity resolvers now check is_blocked, and both data doors
 * answer the promised 403 instead of silently downgrading the caller to the
 * anonymous identity (public-readable tables would still have served them).
 * Presence, which binds identity to the same resolver, refuses the token too.
 */
import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import crypto, { randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey, resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'

let server: http.Server
let base: string
let ownerId: string
let projectId: string
let legacyProjectId: string
let jwtSecret: string
let legacySecret: string
let publicKey: string
let endUserId: string

const tokenFor = (uid: string, secret: string, pid: string) =>
  jwt.sign(
    { userId: uid, email: `${uid}@blocked.test`, projectId: pid, role: 'user', jti: randomUUID() },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' },
  )

async function makeProject(name: string, secret: string): Promise<string> {
  const id = (
    await prisma.project.create({ data: { name, userId: ownerId, jwtSecret: secret }, select: { id: true } })
  ).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "workspace_${id}"`)
  return id
}

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `blocked-tokens-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Blocked Tokens Suite',
      },
      select: { id: true },
    })
  ).id

  jwtSecret = crypto.randomBytes(32).toString('hex')
  legacySecret = crypto.randomBytes(32).toString('hex')
  projectId = await makeProject('blocked-tokens', jwtSecret)
  legacyProjectId = await makeProject('blocked-tokens-legacy', legacySecret)

  // Canonical users table, with is_blocked.
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "workspace_${projectId}"."users" (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password text NOT NULL,
       name text, role text DEFAULT 'user', is_blocked boolean NOT NULL DEFAULT false,
       created_at timestamptz NOT NULL DEFAULT now())`,
  )
  // A notes table the end user would read.
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "workspace_${projectId}"."notes" (id serial PRIMARY KEY, body text)`,
  )
  await prisma.table.create({ data: { projectId, name: 'notes', schema: {} } as any }).catch(() => {})
  // Legacy workspace: users table WITHOUT is_blocked.
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "workspace_${legacyProjectId}"."users" (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL, password text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now())`,
  )

  endUserId = (
    await prisma.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "workspace_${projectId}"."users" (email, password) VALUES ($1, 'x') RETURNING id`,
      'alice@blocked.test',
    )
  )[0].id

  const raw = `proj_live_${crypto.randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'blocked-tokens', keyPrefix: raw.slice(0, 16), permissions: ['read', 'write'], capabilities: [],
      userId: ownerId, projectId, keyType: 'public', serviceRole: false, keyHash: hashApiKey(raw),
    },
  })
  publicKey = raw

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 180_000)

afterAll(async () => {
  await flushRecordedRequests().catch(() => {})
  for (const id of [projectId, legacyProjectId]) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
  }
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
}, 120_000)

const queryNotes = async (token: string, where?: Record<string, unknown>) => {
  const res = await fetch(`${base}/api/v1/${projectId}/database/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': publicKey, 'x-user-token': token },
    body: JSON.stringify({ table: 'notes', ...(where ? { where } : {}) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

/**
 * The data door that authenticates through getProjectIdFromAuth (server/routes/
 * dynamic.ts), as /api/v2 does. No PostgREST runs in this suite, so a request
 * that is authenticated goes on to the data plane and fails there; what is
 * asserted is how far it got.
 */
const dataDoor = async (headers: Record<string, string>) => {
  const res = await fetch(`${base}/api/v1/${projectId}/db/notes`, { headers })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const AUTH_REFUSALS = ['API_KEY_REQUIRED', 'END_USER_BLOCKED', 'INVALID_TOKEN', 'INVALID_API_KEY', 'AUTHENTICATION_REQUIRED']

describe('AUTH-F4: a blocked user is refused at request time', () => {
  it('an unblocked user resolves and reads', async () => {
    const token = tokenFor(endUserId, jwtSecret, projectId)
    await expect(resolveEndUserFromToken(projectId, token)).resolves.toMatchObject({ userId: endUserId })
    const out = await queryNotes(token)
    expect(out.status).toBe(200)
  }, 60_000)

  it('blocking flips the SAME token to a 403 on the data door', async () => {
    const token = tokenFor(endUserId, jwtSecret, projectId)
    await prisma.$executeRawUnsafe(
      `UPDATE "workspace_${projectId}"."users" SET is_blocked = TRUE WHERE id = $1::uuid`,
      endUserId,
    )
    await expect(resolveEndUserFromToken(projectId, token)).resolves.toBe('blocked')
    const out = await queryNotes(token)
    expect(out.status).toBe(403)
    expect(JSON.stringify(out.body)).toContain('blocked')
    // Refused before anything in the request is read, a filter the route would refuse included.
    expect((await queryNotes(token, { title: { equals: 'x' } })).status).toBe(403)
  }, 60_000)

  it('unblocking restores the same token', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE "workspace_${projectId}"."users" SET is_blocked = FALSE WHERE id = $1::uuid`,
      endUserId,
    )
    const token = tokenFor(endUserId, jwtSecret, projectId)
    expect((await queryNotes(token)).status).toBe(200)
  }, 60_000)

  it('presence refuses a blocked token too, instead of reading it as a sign-in', async () => {
    const token = tokenFor(endUserId, jwtSecret, projectId)
    const announce = async () => {
      const res = await fetch(`${base}/api/v1/${projectId}/presence`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': publicKey, 'x-user-token': token },
        body: JSON.stringify({ userId: endUserId, metadata: {} }),
      })
      return { status: res.status, body: await res.json().catch(() => ({})) }
    }
    expect((await announce()).status).toBe(200)
    await prisma.$executeRawUnsafe(
      `UPDATE "workspace_${projectId}"."users" SET is_blocked = TRUE WHERE id = $1::uuid`,
      endUserId,
    )
    try {
      const out = await announce()
      expect(out.status).toBe(403)
      expect(out.body.code).toBe('END_USER_BLOCKED')
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE "workspace_${projectId}"."users" SET is_blocked = FALSE WHERE id = $1::uuid`,
        endUserId,
      )
    }
  }, 60_000)

  it('a legacy workspace without is_blocked keeps serving (nobody was ever blocked there)', async () => {
    const legacyUserId = (
      await prisma.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "workspace_${legacyProjectId}"."users" (email, password) VALUES ($1, 'x') RETURNING id`,
        'legacy@blocked.test',
      )
    )[0].id
    const token = tokenFor(legacyUserId, legacySecret, legacyProjectId)
    await expect(resolveEndUserFromToken(legacyProjectId, token)).resolves.toMatchObject({ userId: legacyUserId })
  }, 60_000)
})

describe("an end-user token on the data door travels with the project's key", () => {
  const setBlocked = (blocked: boolean) =>
    prisma.$executeRawUnsafe(`UPDATE "workspace_${projectId}"."users" SET is_blocked = $2 WHERE id = $1::uuid`, endUserId, blocked)

  it('is refused without the key, naming what to send', async () => {
    const token = tokenFor(endUserId, jwtSecret, projectId)
    const out = await dataDoor({ authorization: `Bearer ${token}` })
    expect(out.status).toBe(401)
    expect(out.body.code).toBe('API_KEY_REQUIRED')
  }, 60_000)

  it('is refused without the key for a blocked user too, before any data is read', async () => {
    await setBlocked(true)
    try {
      const token = tokenFor(endUserId, jwtSecret, projectId)
      const out = await dataDoor({ authorization: `Bearer ${token}` })
      expect(out.status).toBe(401)
      expect(out.body.code).toBe('API_KEY_REQUIRED')
    } finally {
      await setBlocked(false)
    }
  }, 60_000)

  it('with the key, Authorization: Bearer is read as the user and passes authentication', async () => {
    const token = tokenFor(endUserId, jwtSecret, projectId)
    const out = await dataDoor({ 'x-api-key': publicKey, authorization: `Bearer ${token}` })
    expect([401, 403]).not.toContain(out.status)
    expect(AUTH_REFUSALS).not.toContain(out.body?.code)
  }, 60_000)

  it('with the key, Authorization: Bearer of a blocked user is refused 403', async () => {
    await setBlocked(true)
    try {
      const token = tokenFor(endUserId, jwtSecret, projectId)
      const out = await dataDoor({ 'x-api-key': publicKey, authorization: `Bearer ${token}` })
      expect(out.status).toBe(403)
      expect(out.body.code).toBe('END_USER_BLOCKED')
    } finally {
      await setBlocked(false)
    }
  }, 60_000)
})
