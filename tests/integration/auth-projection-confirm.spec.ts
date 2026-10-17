/**
 * A REVOCATION IS REPORTED DONE ONLY ONCE THE REGION HAS IT
 * =========================================================
 * lib/auth-projection/confirm.ts waits, after a change commits at home, for the
 * project's region to apply it to its authorization copy, and says whether it
 * did within the founders' 5 seconds. This suite runs it as the home region
 * against a real home database and a second database standing in for
 * us-east-1's, and pins:
 *
 *   not_applicable   a home project's change, and any change while home does
 *                    not deliver copies
 *   confirmed        a regional key's revocation, delivered within the wait,
 *                    so the copy no longer holds the key when it returns
 *   pending          a region that cannot apply the change, within the time
 *                    allowed; confirmed once it can
 *   lockdown         a regional project's lock reports where it stands, and
 *                    the copy holds it when it says confirmed
 *
 * Real databases and the real SQL; nothing is mocked.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { Client } from 'pg'
import { prisma } from '@/lib/db'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { deliverRegion } from '@/lib/auth-projection/deliver'
import { confirmPropagation, propagationSentence } from '@/lib/auth-projection/confirm'
import { setProjectLockdown } from '@/lib/platform-controls/project-lockdown'

jest.setTimeout(120_000)

const REGION = 'us-east-1' as const
const REGIONAL_DB = `backenly_authconf_${randomBytes(4).toString('hex')}`
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

async function copiedKeyIds(projectId: string): Promise<string[]> {
  const client = new Client({ connectionString: regionalUrl })
  await client.connect()
  try {
    return (await client.query(`SELECT "id" FROM public.auth_projection_keys WHERE "projectId" = $1`, [projectId])).rows.map((r) => r.id)
  } finally {
    await client.end().catch(() => {})
  }
}

async function copiedLock(projectId: string): Promise<string | null | undefined> {
  const client = new Client({ connectionString: regionalUrl })
  await client.connect()
  try {
    const rows = (await client.query(`SELECT "lockedDownAt"::text AS "at" FROM public.auth_projection_projects WHERE "id" = $1`, [projectId])).rows
    return rows.length ? rows[0].at : undefined
  } finally {
    await client.end().catch(() => {})
  }
}

const ENV_KEYS = ['DATABASE_URL_US_EAST_1', 'BACKENLY_AUTH_PROJECTION', 'BACKENLY_SERVICE_REGION', 'MASTER_ENCRYPTION_KEY'] as const
const saved: Record<string, string | undefined> = {}
let ownerId = ''
let homeProject = ''
let regionalProject = ''
let regionalDbCreated = false

async function makeKey(projectId: string) {
  return prisma.apiKey.create({
    data: { name: `confirm-${randomUUID()}`, keyPrefix: 'proj_live_x', keyHash: randomBytes(32).toString('hex'), userId: ownerId, projectId, permissions: ['read'], capabilities: [] },
    select: { id: true },
  })
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString('hex')
  delete process.env.BACKENLY_SERVICE_REGION
  // Home delivers copies, as it does once the switch is past `off`.
  process.env.BACKENLY_AUTH_PROJECTION = 'shadow'

  const migration = fs.readFileSync(MIGRATION, 'utf8')
  await run(homeUrl(), migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION "auth_projection_capture_project"')))
  await run(homeUrl(), `DELETE FROM "auth_projection_regions" WHERE "region" = $1`, [REGION])
  await run(homeUrl(), `CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
  await run(regionalUrl, `CREATE FUNCTION public.backenly_app_role() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$`)
  await run(regionalUrl, fs.readFileSync('scripts/sql/auth-projection.sql', 'utf8'))
  process.env.DATABASE_URL_US_EAST_1 = regionalUrl

  ownerId = (await prisma.user.create({ data: { email: `authconf-${randomUUID()}@example.test`, name: 'propagation fixture' }, select: { id: true } })).id
  homeProject = (await prisma.project.create({ data: { name: `authconf-home-${randomUUID()}`, userId: ownerId }, select: { id: true } })).id
  regionalProject = (
    await prisma.project.create({ data: { name: `authconf-region-${randomUUID()}`, userId: ownerId, region: REGION }, select: { id: true } })
  ).id
  await deliverRegion(REGION)
})

afterAll(async () => {
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
  process.env.BACKENLY_AUTH_PROJECTION = 'shadow'
})

it("reports a home project's change as not applicable: home is where it is authorized", async () => {
  const key = await makeKey(homeProject)
  await prisma.apiKey.delete({ where: { id: key.id } })
  expect(await confirmPropagation({ entity: 'api_key', entityId: key.id })).toEqual({ status: 'not_applicable' })
})

it('confirms a regional revocation once the region has it, so the copy no longer holds the key', async () => {
  const key = await makeKey(regionalProject)
  await deliverRegion(REGION)
  expect(await copiedKeyIds(regionalProject)).toContain(key.id)

  await prisma.apiKey.delete({ where: { id: key.id } })
  const propagation = await confirmPropagation({ entity: 'api_key', entityId: key.id })
  expect(propagation).toEqual({ status: 'confirmed', regions: [REGION] })
  expect(await copiedKeyIds(regionalProject)).not.toContain(key.id)
  expect(propagationSentence(propagation)).toBe(`Applied in ${REGION}.`)
})

it('says pending, within the time allowed, when the region cannot apply the change, and confirmed once it can', async () => {
  const key = await makeKey(regionalProject)
  await deliverRegion(REGION)
  await run(regionalUrl, `ALTER TABLE public.auth_projection_keys RENAME TO auth_projection_keys_away`)
  try {
    await prisma.apiKey.delete({ where: { id: key.id } })
    const started = Date.now()
    const propagation = await confirmPropagation({ entity: 'api_key', entityId: key.id }, { timeoutMs: 1_500, pollMs: 100 })
    expect(propagation).toEqual({ status: 'pending', regions: [REGION] })
    expect(Date.now() - started).toBeLessThan(6_000)
    expect(propagationSentence(propagation)).toMatch(/Not yet confirmed in us-east-1; it is being retried\. .* at most 15 seconds/)
  } finally {
    await run(regionalUrl, `ALTER TABLE public.auth_projection_keys_away RENAME TO auth_projection_keys`)
  }
  expect(await confirmPropagation({ entity: 'api_key', entityId: key.id })).toEqual({ status: 'confirmed', regions: [REGION] })
  expect(await copiedKeyIds(regionalProject)).not.toContain(key.id)
})

it('reports not applicable while home does not deliver copies', async () => {
  process.env.BACKENLY_AUTH_PROJECTION = 'off'
  const key = await makeKey(regionalProject)
  await prisma.apiKey.delete({ where: { id: key.id } })
  expect(await confirmPropagation({ entity: 'api_key', entityId: key.id })).toEqual({ status: 'not_applicable' })
})

it("reports where a regional project's lock stands, and the copy holds it once confirmed", async () => {
  const propagation = await setProjectLockdown(regionalProject, true, 'propagation probe', { userId: ownerId, userEmail: 'founder@example.test' })
  expect(propagation).toEqual({ status: 'confirmed', regions: [REGION] })
  expect(await copiedLock(regionalProject)).not.toBeNull()

  expect(await setProjectLockdown(homeProject, true, 'home probe', { userId: ownerId, userEmail: 'founder@example.test' })).toEqual({
    status: 'not_applicable',
  })
  await setProjectLockdown(regionalProject, false, null, { userId: ownerId, userEmail: 'founder@example.test' })
  expect(await copiedLock(regionalProject)).toBeNull()
})
