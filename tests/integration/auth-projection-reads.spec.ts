/**
 * A REGIONAL REQUEST IS AUTHORIZED FROM THE REGION'S COPY WHILE IT IS FRESH
 * =========================================================================
 * lib/auth-projection/read.ts is where the runtime reads a key, its branch, a
 * project's lock and pause and its signing secret. This suite runs it as a
 * service in us-east-1 against a real home database and a second database
 * standing in for that region's, with the copy delivered by the real delivery
 * (lib/auth-projection/deliver.ts), and pins:
 *
 *   off        home only, whatever the copy says
 *   enforce    the copy while it is fresh, without asking home; home when the
 *              copy is stale or does not hold the row (a service-role key never
 *              is); fail closed, 503 AUTHORIZATION_UNAVAILABLE, when the copy is
 *              stale and home cannot answer; and the copy keeps answering within
 *              its bound when home cannot
 *   shadow     home's answer, with any difference reported
 *   tokens     an end user's token verifies against the copy's signing secret,
 *              and a rotation reaches the region at the next delivery
 *   serving    a lock delivered to the copy refuses the project in the region
 *   the route  /api/v1/:id/db answers 503 AUTHORIZATION_UNAVAILABLE, never a
 *              stale answer, when neither side can authorize
 *
 * Real databases, the real SQL and the real Express app. Home's failure is
 * injected into one Prisma call at a time; nothing else is mocked.
 */

import '@/tests/helpers/real-web-standard'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import jwt from 'jsonwebtoken'
import { Client } from 'pg'
import app from '@/server/app'
import { prisma } from '@/lib/db'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { deliverRegion } from '@/lib/auth-projection/deliver'
import { AuthorizationUnavailableError, authorizingKeyByHash, authorizingProject } from '@/lib/auth-projection/read'
import { getProjectServingState, invalidateProjectServingState } from '@/lib/projects/serving-state'
import { hashApiKey, resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { NextRequest } from 'next/server'
import { authenticateApiKey } from '@/lib/middleware/apiKeyAuth'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'
import { resolveAuthEnvironment } from '@/lib/branches/auth-environment'
import { clearBranchKeyCache } from '@/lib/branches/key-scope'
import { clearKeyPlacementCache } from '@/lib/security/key-placement'

jest.setTimeout(120_000)

const REGION = 'us-east-1' as const
const REGIONAL_DB = `backenly_authread_${randomBytes(4).toString('hex')}`
const MIGRATION = 'prisma/migrations-canonical/20261017120000_auth_projection/migration.sql'

const homeUrl = () => process.env.DATABASE_URL as string
function urlFor(database: string): string {
  const url = new URL(homeUrl())
  url.pathname = `/${database}`
  return url.toString()
}
const regionalUrl = urlFor(REGIONAL_DB)

async function run(connectionString: string, sql: string, params: unknown[] = []): Promise<void> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query(sql, params)
  } finally {
    await client.end().catch(() => {})
  }
}

const ENV_KEYS = ['DATABASE_URL_US_EAST_1', 'BACKENLY_SERVICE_REGION', 'BACKENLY_AUTH_PROJECTION', 'MASTER_ENCRYPTION_KEY'] as const
const saved: Record<string, string | undefined> = {}

let ownerId = ''
let projectId = ''
let publicKey = ''
let serviceKey = ''
let regionalDbCreated = false
let server: http.Server
let baseUrl = ''
const SECRET = randomBytes(32).toString('hex')

function mode(value: 'off' | 'shadow' | 'enforce'): void {
  process.env.BACKENLY_AUTH_PROJECTION = value
}

/** Make the copy's watermark as old as a stale one would be. */
const staleCopy = () => run(regionalUrl, `UPDATE public.auth_projection_state SET "watermarkAt" = now() - interval '1 minute'`)

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString('hex')

  const migration = fs.readFileSync(MIGRATION, 'utf8')
  await run(homeUrl(), migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION "auth_projection_capture_project"')))
  await run(homeUrl(), `DELETE FROM "auth_projection_regions" WHERE "region" = $1`, [REGION])
  await run(homeUrl(), `CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
  await run(regionalUrl, `CREATE FUNCTION public.backenly_app_role() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$`)
  await run(regionalUrl, fs.readFileSync('scripts/sql/auth-projection.sql', 'utf8'))
  process.env.DATABASE_URL_US_EAST_1 = regionalUrl

  ownerId = (await prisma.user.create({ data: { email: `authread-${randomUUID()}@example.test`, name: 'copy reads fixture' }, select: { id: true } })).id
  projectId = (
    await prisma.project.create({
      data: { name: `authread-${randomUUID()}`, userId: ownerId, region: REGION, jwtSecret: SECRET },
      select: { id: true },
    })
  ).id
  publicKey = `proj_live_${randomBytes(24).toString('hex')}`
  serviceKey = `proj_live_${randomBytes(24).toString('hex')}`
  for (const [key, serviceRole] of [[publicKey, false], [serviceKey, true]] as const) {
    await prisma.apiKey.create({
      data: { name: `copy-read-${serviceRole}`, keyPrefix: key.slice(0, 12), keyHash: hashApiKey(key), userId: ownerId, projectId, permissions: ['read', 'write'], capabilities: [], serviceRole },
    })
  }
  expect((await deliverRegion(REGION)).watermarkAt).toBeInstanceOf(Date)

  // This process serves the region, as a task in us-east-1 would.
  process.env.BACKENLY_SERVICE_REGION = REGION
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await run(homeUrl(), `DELETE FROM "auth_projection_regions" WHERE "region" = $1`, [REGION]).catch(() => {})
  await disconnectRegionalClients().catch(() => {})
  if (regionalDbCreated) await run(homeUrl(), `DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`).catch(() => {})
})

afterEach(async () => {
  jest.restoreAllMocks()
  mode('off')
  // Back to a fresh copy that agrees with home.
  await run(regionalUrl, `UPDATE public.auth_projection_keys SET "permissions" = '{read,write}'`)
  await deliverRegion(REGION)
})

describe('a key', () => {
  it('is read from home only while the switch is off', async () => {
    await run(regionalUrl, `UPDATE public.auth_projection_keys SET "permissions" = '{copied}'`)
    mode('off')
    expect((await authorizingKeyByHash(hashApiKey(publicKey)))?.permissions).toEqual(['read', 'write'])
  })

  it('is read from a fresh copy without asking home', async () => {
    await run(regionalUrl, `UPDATE public.auth_projection_keys SET "permissions" = '{copied}'`)
    mode('enforce')
    const home = jest.spyOn(prisma.apiKey, 'findFirst')
    const key = await authorizingKeyByHash(hashApiKey(publicKey))
    expect(key).toMatchObject({ projectId, serviceRole: false, permissions: ['copied'], branch: null })
    expect(home).not.toHaveBeenCalled()
  })

  it('is read from home when the copy is stale', async () => {
    await run(regionalUrl, `UPDATE public.auth_projection_keys SET "permissions" = '{copied}'`)
    await staleCopy()
    mode('enforce')
    expect((await authorizingKeyByHash(hashApiKey(publicKey)))?.permissions).toEqual(['read', 'write'])
  })

  it('is read from home when the copy does not hold it: a service-role key never is', async () => {
    mode('enforce')
    expect(await authorizingKeyByHash(hashApiKey(serviceKey))).toMatchObject({ projectId, serviceRole: true })
    expect(await authorizingKeyByHash(hashApiKey(`proj_live_${randomBytes(24).toString('hex')}`))).toBeNull()
  })

  it('is read from home when the copy holds the key but not its project', async () => {
    await run(regionalUrl, `UPDATE public.auth_projection_keys SET "permissions" = '{copied}'`)
    await run(regionalUrl, `DELETE FROM public.auth_projection_projects WHERE "id" = $1`, [projectId])
    try {
      mode('enforce')
      expect((await authorizingKeyByHash(hashApiKey(publicKey)))?.permissions).toEqual(['read', 'write'])
    } finally {
      // Queue the project again, so the next delivery puts it back.
      await run(homeUrl(), `INSERT INTO "auth_projection_changes" ("region", "projectId", "entity", "entityId") VALUES ($1, $2, 'project', $2)`, [REGION, projectId])
    }
  })

  it('fails closed when the copy is stale and home cannot answer', async () => {
    await staleCopy()
    mode('enforce')
    jest.spyOn(prisma.apiKey, 'findFirst').mockRejectedValue(new Error('home unreachable'))
    await expect(authorizingKeyByHash(hashApiKey(publicKey))).rejects.toBeInstanceOf(AuthorizationUnavailableError)
  })

  it('keeps being authorized from a fresh copy while home cannot answer', async () => {
    mode('enforce')
    jest.spyOn(prisma.apiKey, 'findFirst').mockRejectedValue(new Error('home unreachable'))
    expect(await authorizingKeyByHash(hashApiKey(publicKey))).toMatchObject({ projectId, serviceRole: false })
  })

  it("is home's answer in shadow mode, with the difference reported", async () => {
    await run(regionalUrl, `UPDATE public.auth_projection_keys SET "permissions" = '{copied}'`)
    mode('shadow')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await authorizingKeyByHash(hashApiKey(publicKey)))?.permissions).toEqual(['read', 'write'])
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/shadow: key .* differs from home in permissions/)
  })
})

describe('a project', () => {
  it("verifies an end user's token against the copy's secret, and a rotation reaches the region at the next delivery", async () => {
    mode('enforce')
    const token = jwt.sign({ projectId, userId: randomUUID(), role: 'user' }, SECRET, { algorithm: 'HS256', expiresIn: '5m' })
    expect(await resolveEndUserFromToken(projectId, token)).toMatchObject({ role: 'user' })

    // Rotated at home: until the next delivery the region keeps the old
    // secret, within the bound; after it, the old token is refused.
    const rotated = randomBytes(32).toString('hex')
    await prisma.project.update({ where: { id: projectId }, data: { jwtSecret: rotated } })
    expect(await resolveEndUserFromToken(projectId, token)).toMatchObject({ role: 'user' })
    await deliverRegion(REGION)
    expect(await resolveEndUserFromToken(projectId, token)).toBeNull()
    const fresh = jwt.sign({ projectId, userId: randomUUID(), role: 'user' }, rotated, { algorithm: 'HS256', expiresIn: '5m' })
    expect(await resolveEndUserFromToken(projectId, fresh)).toMatchObject({ role: 'user' })
    await prisma.project.update({ where: { id: projectId }, data: { jwtSecret: SECRET } })
  })

  it('is refused in the region once a lock is delivered, and unavailable when nothing can be read', async () => {
    mode('enforce')
    await prisma.project.update({ where: { id: projectId }, data: { lockedDownAt: new Date(), lockedDownReason: 'probe' } })
    await deliverRegion(REGION)
    invalidateProjectServingState(projectId)
    const home = jest.spyOn(prisma.project, 'findUnique')
    expect(await getProjectServingState(projectId)).toEqual({ kind: 'locked', reason: 'probe' })
    expect(home).not.toHaveBeenCalled()
    home.mockRestore()

    await prisma.project.update({ where: { id: projectId }, data: { lockedDownAt: null, lockedDownReason: null } })
    await deliverRegion(REGION)
    await staleCopy()
    invalidateProjectServingState(projectId)
    jest.spyOn(prisma.project, 'findUnique').mockRejectedValue(new Error('home unreachable'))
    jest.spyOn(console, 'error').mockImplementation(() => {})
    expect(await getProjectServingState(projectId)).toEqual({ kind: 'unavailable' })
    await expect(authorizingProject(projectId)).rejects.toBeInstanceOf(AuthorizationUnavailableError)
    invalidateProjectServingState(projectId)
  })
})

describe('the runtime route', () => {
  it('answers 503 AUTHORIZATION_UNAVAILABLE, and serves nothing, when neither the copy nor home can authorize', async () => {
    mode('enforce')
    await staleCopy()
    jest.spyOn(prisma.apiKey, 'findFirst').mockRejectedValue(new Error('home unreachable'))
    jest.spyOn(console, 'error').mockImplementation(() => {})
    const res = await fetch(`${baseUrl}/api/v1/${projectId}/db/notes`, { headers: { 'x-api-key': publicKey } })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'AUTHORIZATION_UNAVAILABLE' })
  })
})

describe("the runtime's own v1 routes (database, logs, presence, broadcast, realtime)", () => {
  // POST /broadcast with no channel answers 400 only after v1AuthMiddleware let the
  // request through: the key, the project and the count, and nothing else.
  const broadcast = (key: string) =>
    fetch(`${baseUrl}/api/v1/${projectId}/broadcast`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: '{}',
    })
  const regionCount = async (keyId: string): Promise<number | null> => {
    const client = new Client({ connectionString: regionalUrl })
    await client.connect()
    try {
      const { rows } = await client.query(`SELECT "count" FROM public.auth_rate_windows WHERE "keyId" = $1`, [keyId])
      return rows[0] ? Number(rows[0].count) : null
    } finally {
      await client.end().catch(() => {})
    }
  }
  const keyId = async (raw: string) =>
    (await prisma.apiKey.findFirstOrThrow({ where: { keyHash: hashApiKey(raw) }, select: { id: true } })).id

  it('take the key and its project from a fresh copy and count the request in the region, never asking home', async () => {
    mode('enforce')
    const id = await keyId(publicKey)
    const before = (await regionCount(id)) ?? 0
    // The gates before the middleware (key placement, branch scope) look the key up too: from nothing cached.
    clearKeyPlacementCache()
    clearBranchKeyCache()
    const homeKey = jest.spyOn(prisma.apiKey, 'findFirst')
    const homeCountWrite = jest.spyOn(prisma.apiKey, 'updateMany')
    const homeCountReset = jest.spyOn(prisma.apiKey, 'update')
    const homeProject = jest.spyOn(prisma.project, 'findUnique')
    const res = await broadcast(publicKey)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'channel is required' })
    expect(res.headers.get('x-ratelimit-limit')).not.toBeNull()
    expect(await regionCount(id)).toBe(before + 1)
    expect(homeKey).not.toHaveBeenCalled()
    expect(homeCountWrite).not.toHaveBeenCalled()
    expect(homeCountReset).not.toHaveBeenCalled()
    expect(homeProject).not.toHaveBeenCalled()
  })

  it('keep serving a copied key from a fresh copy while home cannot answer at all', async () => {
    mode('enforce')
    clearKeyPlacementCache()
    clearBranchKeyCache()
    invalidateProjectServingState(projectId)
    jest.spyOn(prisma.apiKey, 'findFirst').mockRejectedValue(new Error('home unreachable'))
    jest.spyOn(prisma.apiKey, 'findUnique').mockRejectedValue(new Error('home unreachable'))
    jest.spyOn(prisma.project, 'findUnique').mockRejectedValue(new Error('home unreachable'))
    const res = await broadcast(publicKey)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'channel is required' })
  })

  it('keep one counter with the Next-owned routes: past the limit, both refuse', async () => {
    const raw = `proj_live_${randomBytes(24).toString('hex')}`
    const created = await prisma.apiKey.create({
      data: {
        name: 'copy-read-limit', keyPrefix: raw.slice(0, 12), keyHash: hashApiKey(raw), userId: ownerId, projectId,
        permissions: ['read', 'write'], capabilities: [], serviceRole: false, rateLimit: 2, rateLimitWindow: 3600,
      },
      select: { id: true },
    })
    try {
      await deliverRegion(REGION)
      mode('enforce')
      expect((await broadcast(raw)).status).toBe(400)
      const viaNext = await authenticateApiKey(
        new NextRequest(`http://localhost/api/v1/${projectId}/storage/files`, { headers: { 'x-api-key': raw } }),
      )
      expect(viaNext).toMatchObject({ authenticated: true })
      expect(viaNext.rateLimited).toBeUndefined()
      // Two counted, of two: the runtime route is refused now, as the Next route is.
      const refused = await broadcast(raw)
      expect(refused.status).toBe(429)
      expect(refused.headers.get('retry-after')).not.toBeNull()
      const refusedNext = await authenticateApiKey(
        new NextRequest(`http://localhost/api/v1/${projectId}/storage/files`, { headers: { 'x-api-key': raw } }),
      )
      expect(refusedNext.rateLimited).toBe(true)
      expect(await regionCount(created.id)).toBe(2)
      // And home's counter, which the console reads, was not written on a request.
      expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: created.id }, select: { requestCount: true } })).requestCount).toBe(0)
    } finally {
      await prisma.apiKey.delete({ where: { id: created.id } }).catch(() => {})
      await run(regionalUrl, `DELETE FROM public.auth_rate_windows WHERE "keyId" = $1`, [created.id]).catch(() => {})
      await deliverRegion(REGION)
    }
  })

  it('read and count at home exactly as before while the switch is off', async () => {
    mode('off')
    const homeKey = jest.spyOn(prisma.apiKey, 'findFirst')
    const res = await broadcast(publicKey)
    expect(res.status).toBe(400)
    expect(homeKey).toHaveBeenCalled()
  })
})

describe('the Next-owned routes', () => {
  const nextRequest = (key: string) =>
    new NextRequest(`http://localhost/api/v1/${projectId}/storage/files`, { headers: { 'x-api-key': key } })

  it('take a key from a fresh copy, without asking home, and count it in the region', async () => {
    mode('enforce')
    const home = jest.spyOn(prisma.apiKey, 'findFirst')
    const auth = await authenticateApiKey(nextRequest(publicKey))
    expect(auth).toMatchObject({ authenticated: true })
    expect(auth.rateLimited).toBeUndefined()
    expect(auth.record).toMatchObject({ projectId, serviceRole: false })
    expect(home).not.toHaveBeenCalled()
  })

  it('refuse a project whose delivered lock is in the copy, reading neither its key nor its row at home', async () => {
    mode('enforce')
    await prisma.project.update({ where: { id: projectId }, data: { lockedDownAt: new Date(), lockedDownReason: 'probe' } })
    try {
      await deliverRegion(REGION)
      const keyAtHome = jest.spyOn(prisma.apiKey, 'findUnique')
      const projectAtHome = jest.spyOn(prisma.project, 'findUnique')
      const { response } = await v1ApiMiddleware(nextRequest(publicKey), { projectId })
      expect(response?.status).toBe(503)
      expect(keyAtHome).not.toHaveBeenCalled()
      expect(projectAtHome).not.toHaveBeenCalled()
    } finally {
      await prisma.project.update({ where: { id: projectId }, data: { lockedDownAt: null, lockedDownReason: null } })
      await deliverRegion(REGION)
    }
  })

  it("check an end-user sign-in's key against the copy", async () => {
    mode('enforce')
    const home = jest.spyOn(prisma.apiKey, 'findFirst')
    const headers = new Headers({ 'x-api-key': publicKey })
    const result = await resolveAuthEnvironment(projectId, headers)
    expect(result.refusal).toBeNull()
    expect(result.env).not.toBeNull()
    expect(home).not.toHaveBeenCalled()
  })

  it('read home exactly as before while the switch is off', async () => {
    mode('off')
    const home = jest.spyOn(prisma.apiKey, 'findFirst')
    const auth = await authenticateApiKey(nextRequest(publicKey))
    expect(auth).toMatchObject({ authenticated: true })
    expect(auth.record).toBeUndefined()
    expect(home).toHaveBeenCalled()
  })
})
