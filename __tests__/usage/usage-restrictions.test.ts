/**
 * PAST THE GRACE PERIOD: A READ-ONLY DATA API, AND FILES NOT SERVED
 * =================================================================
 * Database and egress quotas do not refuse at the moment they are reached.
 * After GRACE_DAYS continuously over (usage_limit_states, kept by the usage
 * alert sweep), the data API refuses writes that add or change rows while reads
 * and deletes keep working, and file downloads stop for everyone but the
 * project's members and export links. Every case is two-sided: the same
 * request succeeds past the gate when the account is not restricted.
 *
 * Real database, the real download route on the local storage driver, and the
 * real runtime /api/v2 router authenticated with a real API key. PostgREST is
 * never reached: the gate answers before it, and the unrestricted control only
 * needs to show the request got past the gate.
 */

// Real Request/Response/Headers: the download route builds a NextResponse
// around the file bytes, which jest.setup.js's stand-ins cannot carry.
import '../../tests/helpers/real-web-standard'

process.env.STORAGE_DRIVER = 'local'
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || 'usage-restrictions-suite-secret'
process.env.POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:9'
process.env.POSTGREST_JWT_SECRET = process.env.POSTGREST_JWT_SECRET || 'x'.repeat(40)

import { randomBytes, randomUUID } from 'crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import express from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { accountRestriction, GRACE_DAYS, invalidateRestrictions } from '@/lib/usage/restrictions'
import { apiKeyRateCeilingViolation } from '@/lib/quota/kernel'

// Who may read a project is not under test here (tests/integration covers the
// download route's access rules), and the single-tenant resolver rightly
// refuses to pick one project out of a shared test database. The project's
// owner is its member.
jest.mock('@/lib/edition/guard', () => ({
  ...jest.requireActual('@/lib/edition/guard'),
  canAccessProject: () => Promise.resolve(true),
}))

// The plan is an input only to the API-key rate ceiling below; everything else
// in this file reads no entitlements. null = no ceiling, as self-host answers.
let ratePerMin: number | null = null
jest.mock('@/lib/entitlements', () => {
  const actual = jest.requireActual('@/lib/entitlements')
  return {
    ...actual,
    getUserEntitlements: async () => ({ ...actual.selfHostedEntitlements(), planName: 'BUILDER', apiRateLimitPerMin: ratePerMin }),
  }
})

const DB_URL = process.env.TEST_DATABASE_URL ?? ''
const DAY = 86_400_000
const BYTES = 'restricted-file-bytes'

type DownloadHandler = (req: unknown, ctx: { params: Promise<{ fileId: string }> }) => Promise<any>
let download: DownloadHandler
let app: express.Express
let dir: string
const users: string[] = []

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

async function owner() {
  const user = await prisma.user.create({
    data: { email: `restrict-${randomUUID()}@test.invalid`, name: 'Restrict', password: 'not-a-real-hash' },
    select: { id: true },
  })
  users.push(user.id)
  const project = await prisma.project.create({ data: { name: 'restrict', userId: user.id }, select: { id: true } })
  return { userId: user.id, projectId: project.id }
}

async function overFor(userId: string, axis: 'db_bytes' | 'egress_bytes', days: number | null) {
  const overSince = days === null ? null : new Date(Date.now() - days * DAY)
  await prisma.usageLimitState.upsert({
    where: { billingAccountId_axis: { billingAccountId: userId, axis } },
    update: { overSince },
    create: { billingAccountId: userId, axis, overSince },
  })
  invalidateRestrictions()
}

async function publicFile(projectId: string) {
  const bucket = await prisma.storageBucket.create({
    data: { name: `b-${randomBytes(4).toString('hex')}`, projectId, isPublic: true, accessPolicy: 'public_read' },
  })
  const path = join(dir, `${randomBytes(5).toString('hex')}.txt`)
  writeFileSync(path, BYTES)
  return prisma.storageFile.create({
    data: { bucketId: bucket.id, projectId, name: 'f.txt', path, isPublic: true, size: BigInt(BYTES.length), mimeType: 'text/plain' },
  })
}

function downloadRequest(bearer?: string) {
  return {
    nextUrl: { searchParams: new URLSearchParams() },
    headers: { get: (n: string) => (n.toLowerCase() === 'authorization' && bearer ? `Bearer ${bearer}` : null) },
    cookies: { get: () => undefined },
  } as any
}

async function sessionFor(userId: string): Promise<string> {
  const token = jwt.sign({ userId, email: `${userId}@example.test`, role: 'user' }, process.env.JWT_SECRET!, { expiresIn: '10m' })
  await prisma.session.create({ data: { userId, token, expiresAt: new Date(Date.now() + 10 * 60_000) } })
  return token
}

async function apiKeyFor(userId: string, projectId: string): Promise<string> {
  const key = `sk_test_${randomBytes(16).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'restrict',
      keyHash: hashApiKey(key),
      keyPrefix: key.slice(0, 12),
      keyType: 'public',
      role: 'service',
      serviceRole: true,
      permissions: ['read', 'write'],
      userId,
      projectId,
      rateLimit: 1000,
      rateLimitWindow: 3600,
    },
  })
  return key
}

beforeAll(async () => {
  assertSafeTestDatabase()
  ;({ GET: download } = (await import('@/app/api/storage/files/[fileId]/download/route')) as unknown as {
    GET: DownloadHandler
  })
  const v2 = (await import('@/server/routes/v2')).default
  app = express()
  app.use(express.json())
  app.use('/api/v2', v2)
  dir = mkdtempSync(join(tmpdir(), 'usage-restrictions-'))
}, 180_000)

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM "usage_limit_states" WHERE "billingAccountId" = ANY(${users}::text[])`
  await prisma.session.deleteMany({ where: { userId: { in: users } } })
  await prisma.apiKey.deleteMany({ where: { userId: { in: users } } })
  await prisma.storageFile.deleteMany({ where: { project: { userId: { in: users } } } })
  await prisma.storageBucket.deleteMany({ where: { project: { userId: { in: users } } } })
  await prisma.project.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
  rmSync(dir, { recursive: true, force: true })
}, 180_000)

describe('the grace period', () => {
  it(`restricts only after ${GRACE_DAYS} continuous days over`, async () => {
    const { userId } = await owner()
    await overFor(userId, 'db_bytes', GRACE_DAYS - 1)
    const inGrace = await accountRestriction(userId, 'db_bytes')
    expect(inGrace.restricted).toBe(false)
    expect(inGrace.graceEndsAt!.getTime() - inGrace.overSince!.getTime()).toBe(GRACE_DAYS * DAY)

    await overFor(userId, 'db_bytes', GRACE_DAYS + 1)
    expect((await accountRestriction(userId, 'db_bytes')).restricted).toBe(true)

    await overFor(userId, 'db_bytes', null)
    expect(await accountRestriction(userId, 'db_bytes')).toEqual({ restricted: false, overSince: null, graceEndsAt: null })
  })
})

describe('database: the data API goes read-only', () => {
  it('refuses POST, PUT and PATCH on /api/v2 once restricted, and lets them through otherwise', async () => {
    const { userId, projectId } = await owner()
    const key = await apiKeyFor(userId, projectId)

    await overFor(userId, 'db_bytes', GRACE_DAYS + 1)
    for (const method of ['post', 'put', 'patch'] as const) {
      const res = await request(app)[method](`/api/v2/${projectId}/todos`).set('x-api-key', key).send({ title: 'x' })
      expect(res.status).toBe(403)
      expect(res.body.code).toBe('PLAN_LIMIT_EXCEEDED')
      expect(res.body.message).toMatch(/read-only/)
    }

    // Reads and deletes are never refused: deleting is how an owner gets back under.
    for (const method of ['get', 'delete'] as const) {
      const res = await request(app)[method](`/api/v2/${projectId}/todos`).set('x-api-key', key)
      expect(res.body.code).not.toBe('PLAN_LIMIT_EXCEEDED')
    }

    await overFor(userId, 'db_bytes', GRACE_DAYS - 1)
    const inGrace = await request(app).post(`/api/v2/${projectId}/todos`).set('x-api-key', key).send({ title: 'x' })
    expect(inGrace.body.code).not.toBe('PLAN_LIMIT_EXCEEDED')
  }, 60_000)
})

describe('egress: files stop being served', () => {
  it('refuses the public and serves the owner once restricted, and serves everyone otherwise', async () => {
    const { userId, projectId } = await owner()
    const file = await publicFile(projectId)
    const get = (bearer?: string) => download(downloadRequest(bearer), { params: Promise.resolve({ fileId: file.id }) })

    await overFor(userId, 'egress_bytes', GRACE_DAYS + 2)
    const refused = await get()
    expect(refused.status).toBe(403)
    expect((await refused.json()).error.code).toBe('PLAN_LIMIT_EXCEEDED')

    // The project's own members still get their data out.
    const session = await sessionFor(userId)
    expect((await get(session)).status).toBe(200)

    await overFor(userId, 'egress_bytes', null)
    expect((await get()).status).toBe(200)
  }, 60_000)
})

describe('the API key rate ceiling', () => {
  it('refuses a key faster than the plan allows per minute, and allows one within it', async () => {
    const { userId, projectId } = await owner()
    ratePerMin = 1000

    // 1,000 per hour is ~17 a minute: well within.
    await expect(apiKeyRateCeilingViolation(projectId, userId, 1000, 3600)).resolves.toBeNull()
    // Exactly the ceiling is allowed; one more per minute is not.
    await expect(apiKeyRateCeilingViolation(projectId, userId, 1000, 60)).resolves.toBeNull()
    const refused = await apiKeyRateCeilingViolation(projectId, userId, 1001, 60)
    expect(refused).toMatch(/1,000 requests per minute/)
    // The same rate over a longer window is the same rate.
    await expect(apiKeyRateCeilingViolation(projectId, userId, 60_060, 3600)).resolves.toMatch(/at most 60,000/)

    // No ceiling on the plan: nothing is refused.
    ratePerMin = null
    await expect(apiKeyRateCeilingViolation(projectId, userId, 10_000_000, 60)).resolves.toBeNull()
  })
})
