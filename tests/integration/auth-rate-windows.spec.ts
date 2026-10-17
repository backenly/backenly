/**
 * A KEY'S RATE LIMIT IS COUNTED IN ITS PROJECT'S REGION ONCE THE COPY IS ENFORCED
 * ==============================================================================
 * lib/auth-projection/rate.ts counts a regional project's keyed requests in the
 * region's public.auth_rate_windows instead of on the home api_keys row. This
 * suite runs it as a service in us-east-1 against a real home database and a
 * second database standing in for that region's, and pins:
 *
 *   home's rules   allowed while under the limit; refused after it, with how
 *                  long to wait; a new window when the old one ends, when the
 *                  window length changes, and when the key is rotated
 *   atomic         concurrent requests never pass the limit together
 *   one counter    the Express runtime and the Next-owned routes count the same
 *                  window, and neither writes home on a request
 *   the mirror     counts and last use reach home for the console, each use once
 *   the switch     off and shadow keep counting at home, exactly as before
 *
 * Real databases, the real SQL and the real Express app; nothing is mocked.
 */

import '@/tests/helpers/real-web-standard'
import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { NextRequest } from 'next/server'
import { Client } from 'pg'
import app from '@/server/app'
import { prisma } from '@/lib/db'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { deliverRegion } from '@/lib/auth-projection/deliver'
import { countInRegion, mirrorRateWindows, pruneRateWindows } from '@/lib/auth-projection/rate'
import { enforceKeyRateLimit } from '@/server/lib/auth'
import { authenticateApiKey } from '@/lib/middleware/apiKeyAuth'
import { hashApiKey } from '@/server/lib/end-user-identity'

jest.setTimeout(120_000)

const REGION = 'us-east-1' as const
const REGIONAL_DB = `backenly_ratewin_${randomBytes(4).toString('hex')}`
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

async function windowOf(keyId: string): Promise<{ count: number; mirroredAt: Date | null } | undefined> {
  const client = new Client({ connectionString: regionalUrl })
  await client.connect()
  try {
    return (await client.query(`SELECT "count", "mirroredAt" FROM public.auth_rate_windows WHERE "keyId" = $1`, [keyId])).rows[0]
  } finally {
    await client.end().catch(() => {})
  }
}

const homeCount = async (keyId: string) =>
  (await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId }, select: { requestCount: true } })).requestCount

const ENV_KEYS = ['DATABASE_URL_US_EAST_1', 'BACKENLY_SERVICE_REGION', 'BACKENLY_AUTH_PROJECTION', 'MASTER_ENCRYPTION_KEY'] as const
const saved: Record<string, string | undefined> = {}

let ownerId = ''
let projectId = ''
let server: http.Server
let baseUrl = ''
let regionalDbCreated = false

async function makeKey(rateLimit: number, rateLimitWindow = 60) {
  const raw = `proj_live_${randomBytes(24).toString('hex')}`
  const row = await prisma.apiKey.create({
    data: {
      name: `rate-${randomUUID()}`,
      keyPrefix: raw.slice(0, 12),
      keyHash: hashApiKey(raw),
      userId: ownerId,
      projectId,
      permissions: ['read', 'write'],
      capabilities: [],
      rateLimit,
      rateLimitWindow,
    },
    select: { id: true, keyHash: true, rateLimit: true, rateLimitWindow: true },
  })
  return { raw, key: row }
}

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

  ownerId = (await prisma.user.create({ data: { email: `ratewin-${randomUUID()}@example.test`, name: 'rate windows fixture' }, select: { id: true } })).id
  projectId = (
    await prisma.project.create({ data: { name: `ratewin-${randomUUID()}`, userId: ownerId, region: REGION }, select: { id: true } })
  ).id

  process.env.BACKENLY_SERVICE_REGION = REGION
  process.env.BACKENLY_AUTH_PROJECTION = 'enforce'
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

afterEach(() => {
  process.env.BACKENLY_AUTH_PROJECTION = 'enforce'
})

describe("home's rules, counted in the region", () => {
  it('allows up to the limit, then refuses with how long to wait, writing nothing home', async () => {
    const { key } = await makeKey(3)
    const decisions = []
    for (let i = 0; i < 4; i++) decisions.push(await countInRegion(REGION, key))
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false])
    expect(decisions.map((d) => d.remaining)).toEqual([2, 1, 0, 0])
    expect(decisions[3].retryAfter).toBeGreaterThanOrEqual(1)
    expect(decisions[3].retryAfter).toBeLessThanOrEqual(60)
    expect(await homeCount(key.id)).toBe(0)
  })

  it('starts a new window when the old one ends, when its length changes, and when the key is rotated', async () => {
    const { key } = await makeKey(2)
    await countInRegion(REGION, key)
    await countInRegion(REGION, key)
    expect((await countInRegion(REGION, key)).allowed).toBe(false)

    await run(regionalUrl, `UPDATE public.auth_rate_windows SET "resetAt" = now() - interval '1 second' WHERE "keyId" = $1`, [key.id])
    expect(await countInRegion(REGION, key)).toMatchObject({ allowed: true, remaining: 1 })

    await countInRegion(REGION, key)
    expect((await countInRegion(REGION, key)).allowed).toBe(false)
    expect(await countInRegion(REGION, { ...key, rateLimitWindow: 120 })).toMatchObject({ allowed: true, remaining: 1 })

    await countInRegion(REGION, { ...key, rateLimitWindow: 120 })
    expect((await countInRegion(REGION, { ...key, rateLimitWindow: 120 })).allowed).toBe(false)
    const rotated = { ...key, rateLimitWindow: 120, keyHash: randomBytes(32).toString('hex') }
    expect(await countInRegion(REGION, rotated)).toMatchObject({ allowed: true, remaining: 1 })
  })

  it('never lets concurrent requests pass the limit together', async () => {
    const { key } = await makeKey(5)
    const decisions = await Promise.all(Array.from({ length: 12 }, () => countInRegion(REGION, key)))
    expect(decisions.filter((d) => d.allowed)).toHaveLength(5)
    expect((await windowOf(key.id))?.count).toBe(5)
  })
})

describe('one counter for the key', () => {
  it('is counted by the Express runtime and the Next-owned routes alike, and the runtime refuses past it', async () => {
    const { raw, key } = await makeKey(3)
    await deliverRegion(REGION)

    // Two through the runtime's limiter, one through the Next-owned routes'.
    expect((await enforceKeyRateLimit({ ...key })).allowed).toBe(true)
    expect((await enforceKeyRateLimit({ ...key })).allowed).toBe(true)
    const next = await authenticateApiKey(new NextRequest(`http://localhost/api/v1/${projectId}/storage/files`, { headers: { 'x-api-key': raw } }))
    expect(next).toMatchObject({ authenticated: true })
    expect(next.rateLimited).toBeUndefined()
    expect((await windowOf(key.id))?.count).toBe(3)

    const refusedNext = await authenticateApiKey(new NextRequest(`http://localhost/api/v1/${projectId}/storage/files`, { headers: { 'x-api-key': raw } }))
    expect(refusedNext).toMatchObject({ authenticated: true, rateLimited: true })

    const res = await fetch(`${baseUrl}/api/v1/${projectId}/db/notes`, { headers: { 'x-api-key': raw } })
    expect(res.status).toBe(429)
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(await res.json()).toMatchObject({ error: { code: 'RATE_LIMIT_EXCEEDED' } })
    expect(await homeCount(key.id)).toBe(0)
  })

  it('stays at home while the switch is off or in shadow, exactly as before', async () => {
    const { key } = await makeKey(5)
    for (const mode of ['off', 'shadow'] as const) {
      process.env.BACKENLY_AUTH_PROJECTION = mode
      expect((await enforceKeyRateLimit({ ...key })).allowed).toBe(true)
    }
    expect(await homeCount(key.id)).toBe(2)
    expect(await windowOf(key.id)).toBeUndefined()
  })
})

describe('the mirror', () => {
  it("writes each window's count and last use home once, and again only after the next use", async () => {
    const { key } = await makeKey(10)
    await countInRegion(REGION, key)
    await countInRegion(REGION, key)
    expect(await mirrorRateWindows(REGION)).toBeGreaterThanOrEqual(1)
    const home = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id }, select: { requestCount: true, resetAt: true, lastUsed: true } })
    expect(home.requestCount).toBe(2)
    expect(home.resetAt).toBeInstanceOf(Date)
    expect(home.lastUsed).toBeInstanceOf(Date)
    expect(Math.abs(home.lastUsed!.getTime() - Date.now())).toBeLessThan(60_000)

    // Nothing new to write until the key is used again.
    await mirrorRateWindows(REGION)
    expect((await windowOf(key.id))?.mirroredAt).toBeInstanceOf(Date)
    const before = (await windowOf(key.id))?.mirroredAt
    await mirrorRateWindows(REGION)
    expect((await windowOf(key.id))?.mirroredAt).toEqual(before)

    await countInRegion(REGION, key)
    await mirrorRateWindows(REGION)
    expect(await homeCount(key.id)).toBe(3)
  })

  it('prunes only windows unused for a day and already written home', async () => {
    const { key: idle } = await makeKey(10)
    const { key: unwritten } = await makeKey(10)
    await countInRegion(REGION, idle)
    await countInRegion(REGION, unwritten)
    await mirrorRateWindows(REGION)
    await run(regionalUrl, `UPDATE public.auth_rate_windows SET "lastUsedAt" = now() - interval '2 days', "mirroredAt" = now() - interval '2 days' WHERE "keyId" = $1`, [idle.id])
    await run(regionalUrl, `UPDATE public.auth_rate_windows SET "lastUsedAt" = now() - interval '2 days', "mirroredAt" = NULL WHERE "keyId" = $1`, [unwritten.id])
    expect(await pruneRateWindows(REGION)).toBeGreaterThanOrEqual(1)
    expect(await windowOf(idle.id)).toBeUndefined()
    expect(await windowOf(unwritten.id)).toBeDefined()
  })
})
