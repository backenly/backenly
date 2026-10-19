/**
 * EACH REGION'S COPY OF WHAT AUTHORIZES ITS REQUESTS
 * ==================================================
 * A request to a project kept outside the home region is authorized from home
 * rows: the project's lock, pause and signing secret, its publishable keys and
 * their branches. Option C gives each region a copy of those rows, delivered
 * from home with a watermark (lib/auth-projection/deliver.ts). This suite
 * installs the real capture triggers from the migration in the home test
 * database, creates a second database as the stand-in for another region's
 * with the real regional tables (scripts/sql/auth-projection.sql), and pins:
 *
 *   capture       a regional project's key, branch and project changes are
 *                 recorded in their own transaction; its counters are not; a
 *                 home project records nothing
 *   delivery      the region gets its rows and a watermark, which every later
 *                 delivery moves, even with nothing to deliver
 *   removal       a revoked or rotated key, a key that stops being publishable,
 *                 and a deleted project with its keys and branches leave the copy
 *   secrets       a signing secret is never copied in the clear
 *   restore       a copy out of step with home is emptied and delivered afresh,
 *                 so a row from before a restore cannot outlive it
 *   failure       a delivery the region refuses leaves its watermark where it
 *                 was, so the copy goes stale rather than wrong
 *   one at a time, the fence, batches, and a database holding another region's copy
 *
 * Real databases and the real SQL; nothing that carries the property is mocked.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { Client } from 'pg'
import { prisma } from '@/lib/db'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { deliverAuthProjection, deliverRegion } from '@/lib/auth-projection/deliver'
import { copyFreshness } from '@/lib/auth-projection/copy'
import { reconcileRegionCopy } from '@/lib/auth-projection/reconcile'
import { JWTSecretManager } from '@/lib/services/jwtSecretManager'
import { ORPHANED_PROJECT_MODELS, deleteAccountCompletely, deleteProjectCompletely } from '@/lib/projects/delete'

jest.setTimeout(120_000)

const REGION = 'us-east-1' as const
const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
const REGIONAL_DB = `backenly_authcopy_${randomBytes(4).toString('hex')}`
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

async function rowsIn<T>(connectionString: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return (await client.query(sql, params)).rows as T[]
  } finally {
    await client.end().catch(() => {})
  }
}

const copiedKeys = (projectId: string) =>
  rowsIn<{ id: string; keyHash: string; permissions: string[]; serviceRole: boolean; branchId: string | null; version: string }>(
    regionalUrl,
    `SELECT "id", "keyHash", "permissions", "serviceRole", "branchId", "version" FROM public.auth_projection_keys WHERE "projectId" = $1 ORDER BY "id"`,
    [projectId],
  )
// Timestamps as the database's text: a column without a time zone, which node-postgres would read in this machine's.
const copiedProject = async (projectId: string) =>
  (
    await rowsIn<{ id: string; lockedDownAt: string | null; pausedAt: string | null; pauseReason: string | null; jwtSecret: string | null; userId: string | null }>(
      regionalUrl,
      `SELECT "id", "lockedDownAt"::text AS "lockedDownAt", "pausedAt"::text AS "pausedAt", "pauseReason", "jwtSecret", "userId"
         FROM public.auth_projection_projects WHERE "id" = $1`,
      [projectId],
    )
  )[0]
const copiedBranches = (projectId: string) =>
  rowsIn<{ id: string; status: string }>(regionalUrl, `SELECT "id", "status" FROM public.auth_projection_branches WHERE "projectId" = $1 ORDER BY "id"`, [projectId])
const regionalState = async () =>
  (await rowsIn<{ epoch: string; round: string; watermarkAt: Date | null }>(regionalUrl, `SELECT "epoch", "round"::text AS "round", "watermarkAt" FROM public.auth_projection_state`))[0]
const homeState = async () =>
  (
    await rowsIn<{ epoch: string; round: string; lastError: string | null }>(
      homeUrl(),
      `SELECT "epoch", "round"::text AS "round", "lastError" FROM "auth_projection_regions" WHERE "region" = $1`,
      [REGION],
    )
  )[0]
const pendingFor = (projectId: string) =>
  rowsIn<{ entity: string; entityId: string }>(
    homeUrl(),
    `SELECT "entity", "entityId" FROM "auth_projection_changes" WHERE "projectId" = $1 AND "deliveredAt" IS NULL ORDER BY "id"`,
    [projectId],
  )
const recordedFor = async (projectId: string) =>
  Number((await rowsIn<{ n: string }>(homeUrl(), `SELECT count(*)::text AS n FROM "auth_projection_changes" WHERE "projectId" = $1`, [projectId]))[0].n)

let ownerId = ''
let homeProject = ''
let regionalProject = ''
let regionalDbCreated = false
const priorKey = process.env.MASTER_ENCRYPTION_KEY
const PLAINTEXT_SECRET = randomBytes(32).toString('hex')

async function makeKey(projectId: string, overrides: Record<string, unknown> = {}) {
  return prisma.apiKey.create({
    data: {
      name: `copy-${randomUUID()}`,
      keyPrefix: 'proj_live_x',
      keyHash: randomBytes(32).toString('hex'),
      userId: ownerId,
      projectId,
      permissions: ['read', 'write'],
      capabilities: [],
      ...overrides,
    },
    select: { id: true, keyHash: true },
  })
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  process.env.MASTER_ENCRYPTION_KEY = randomBytes(32).toString('hex')

  // The capture, exactly as the migration installs it. `prisma db push` builds
  // test databases from the schema and knows nothing of triggers; everything
  // from the first function on is written to be run again.
  const migration = fs.readFileSync(MIGRATION, 'utf8')
  await run(homeUrl(), migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION "auth_projection_capture_project"')))
  // A previous run's delivery state for this region names a database that is gone.
  await run(homeUrl(), `DELETE FROM "auth_projection_regions" WHERE "region" = $1`, [REGION])

  await run(homeUrl(), `CREATE DATABASE "${REGIONAL_DB}"`)
  regionalDbCreated = true
  await run(regionalUrl, `CREATE FUNCTION public.backenly_app_role() RETURNS text LANGUAGE sql AS $$ SELECT current_user::text $$`)
  await run(regionalUrl, fs.readFileSync('scripts/sql/auth-projection.sql', 'utf8'))
  process.env[REGION_VARIABLE] = regionalUrl

  ownerId = (
    await prisma.user.create({ data: { email: `authcopy-${randomUUID()}@example.test`, name: 'authorization copy fixture' }, select: { id: true } })
  ).id
  homeProject = (await prisma.project.create({ data: { name: `authcopy-home-${randomUUID()}`, userId: ownerId }, select: { id: true } })).id
  regionalProject = (
    await prisma.project.create({
      data: { name: `authcopy-region-${randomUUID()}`, userId: ownerId, region: REGION, jwtSecret: PLAINTEXT_SECRET },
      select: { id: true },
    })
  ).id
})

afterAll(async () => {
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await run(homeUrl(), `DELETE FROM "auth_projection_regions" WHERE "region" = $1`, [REGION]).catch(() => {})
  delete process.env[REGION_VARIABLE]
  if (priorKey === undefined) delete process.env.MASTER_ENCRYPTION_KEY
  else process.env.MASTER_ENCRYPTION_KEY = priorKey
  await disconnectRegionalClients().catch(() => {})
  if (regionalDbCreated) await run(homeUrl(), `DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`).catch(() => {})
})

describe('capture', () => {
  it("records a regional project's key, branch and project changes, and none of its counters", async () => {
    const before = await recordedFor(regionalProject)
    const key = await makeKey(regionalProject)
    expect(await recordedFor(regionalProject)).toBe(before + 1)

    // What a request writes on every call is not watched.
    await prisma.apiKey.update({ where: { id: key.id }, data: { requestCount: { increment: 1 }, lastUsed: new Date(), resetAt: new Date() } })
    await prisma.project.update({ where: { id: regionalProject }, data: { lastActivityAt: new Date() } })
    expect(await recordedFor(regionalProject)).toBe(before + 1)

    await prisma.apiKey.update({ where: { id: key.id }, data: { permissions: ['read'] } })
    await prisma.project.update({ where: { id: regionalProject }, data: { pauseReason: 'inactivity', pausedAt: new Date() } })
    await prisma.workspaceBranch.create({
      data: { projectId: regionalProject, name: `b${randomBytes(3).toString('hex')}`, schemaName: `workspace_x_br_${randomBytes(3).toString('hex')}`, createdBy: ownerId },
    })
    expect(await recordedFor(regionalProject)).toBe(before + 4)

    // In the change's own transaction: a change rolled back records nothing.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.apiKey.update({ where: { id: key.id }, data: { permissions: ['read', 'write'] } })
        throw new Error('rolled back')
      }),
    ).rejects.toThrow('rolled back')
    expect(await recordedFor(regionalProject)).toBe(before + 4)

    await prisma.project.update({ where: { id: regionalProject }, data: { pauseReason: null, pausedAt: null } })
  })

  it('records nothing for a project in the home region', async () => {
    const key = await makeKey(homeProject)
    await prisma.apiKey.update({ where: { id: key.id }, data: { permissions: ['read'] } })
    await prisma.project.update({ where: { id: homeProject }, data: { lockedDownAt: new Date() } })
    await prisma.apiKey.delete({ where: { id: key.id } })
    await prisma.project.update({ where: { id: homeProject }, data: { lockedDownAt: null } })
    expect(await recordedFor(homeProject)).toBe(0)
  })

  it('forgets every delivery when a watched table is truncated, so each region is delivered afresh', async () => {
    await run(homeUrl(), `INSERT INTO "auth_projection_regions" ("region", "epoch") VALUES ('us-west-2', 'truncate-probe') ON CONFLICT DO NOTHING`)
    const client = new Client({ connectionString: homeUrl() })
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query('TRUNCATE "workspace_branches" CASCADE')
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM "auth_projection_regions"`)
      expect(rows[0].n).toBe(0)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      await client.end().catch(() => {})
    }
    await run(homeUrl(), `DELETE FROM "auth_projection_regions" WHERE "region" = 'us-west-2'`)
  })
})

describe('delivery', () => {
  let publishable: { id: string; keyHash: string }
  let serviceRole: { id: string; keyHash: string }
  let mcp: { id: string; keyHash: string }
  let dashboard: { id: string; keyHash: string }

  beforeAll(async () => {
    publishable = await makeKey(regionalProject)
    serviceRole = await makeKey(regionalProject, { serviceRole: true })
    mcp = await makeKey(regionalProject, { scope: 'mcp', keyType: 'mcp' })
    dashboard = await makeKey(regionalProject, { keyType: 'dashboard' })
  })

  it('gives the region its rows and a watermark, and every later delivery moves the watermark', async () => {
    const first = await deliverAuthProjection({ regions: [REGION] })
    expect(first).toEqual([expect.objectContaining({ region: REGION, outcome: 'resynced' })])
    expect(first[0].watermarkAt).toBeInstanceOf(Date)

    const keys = await copiedKeys(regionalProject)
    expect(keys.map((k) => k.id)).toContain(publishable.id)
    // The sensitive path: these are only ever authorized at home.
    for (const notCopied of [serviceRole, mcp, dashboard]) expect(keys.map((k) => k.id)).not.toContain(notCopied.id)
    expect(keys.find((k) => k.id === publishable.id)).toMatchObject({ keyHash: publishable.keyHash, serviceRole: false })
    expect(await copiedProject(regionalProject)).toMatchObject({ id: regionalProject, userId: ownerId, lockedDownAt: null, pausedAt: null })
    expect(await copiedBranches(regionalProject)).toHaveLength(1)
    expect(await pendingFor(regionalProject)).toEqual([])
    expect(await copiedProject(homeProject)).toBeUndefined()

    const fresh = await copyFreshness(REGION)
    expect(fresh.fresh).toBe(true)
    expect(fresh.ageMs).toBeLessThan(15_000)

    // A heartbeat: nothing to deliver, and the watermark still moves.
    const second = await deliverRegion(REGION)
    expect(second).toMatchObject({ outcome: 'delivered', applied: 0 })
    expect(second.watermarkAt!.getTime()).toBeGreaterThan(first[0].watermarkAt!.getTime())
    const [here, there] = [await homeState(), await regionalState()]
    expect(there.epoch).toBe(here.epoch)
    expect(there.round).toBe(here.round)
  })

  it('carries a lockdown and a pause to the region at the next delivery', async () => {
    const lockedAt = new Date('2026-10-17T05:00:00.123Z')
    await prisma.project.update({ where: { id: regionalProject }, data: { lockedDownAt: lockedAt, lockedDownReason: 'probe' } })
    expect((await copiedProject(regionalProject)).lockedDownAt).toBeNull()
    expect(await deliverRegion(REGION)).toMatchObject({ outcome: 'delivered', applied: 1 })
    // The same instant, kept as home keeps it: UTC, without a zone.
    expect((await copiedProject(regionalProject)).lockedDownAt).toBe('2026-10-17 05:00:00.123')

    await prisma.project.update({ where: { id: regionalProject }, data: { lockedDownAt: null, lockedDownReason: null, pausedAt: lockedAt, pauseReason: 'inactivity' } })
    await deliverRegion(REGION)
    expect(await copiedProject(regionalProject)).toMatchObject({ lockedDownAt: null, pauseReason: 'inactivity' })
    await prisma.project.update({ where: { id: regionalProject }, data: { pausedAt: null, pauseReason: null } })
    await deliverRegion(REGION)
    expect(await copiedProject(regionalProject)).toMatchObject({ pausedAt: null, pauseReason: null })
  })

  it('takes a revoked key out of the copy, and a rotated one under its new hash only', async () => {
    const revoked = await makeKey(regionalProject)
    const rotated = await makeKey(regionalProject)
    await deliverRegion(REGION)
    expect((await copiedKeys(regionalProject)).map((k) => k.id)).toEqual(expect.arrayContaining([revoked.id, rotated.id]))

    await prisma.apiKey.delete({ where: { id: revoked.id } })
    const newHash = randomBytes(32).toString('hex')
    await prisma.apiKey.update({ where: { id: rotated.id }, data: { keyHash: newHash } })
    await deliverRegion(REGION)

    const keys = await copiedKeys(regionalProject)
    expect(keys.map((k) => k.id)).not.toContain(revoked.id)
    expect(keys.map((k) => k.keyHash)).not.toContain(revoked.keyHash)
    expect(keys.map((k) => k.keyHash)).not.toContain(rotated.keyHash)
    expect(keys.find((k) => k.id === rotated.id)?.keyHash).toBe(newHash)
  })

  it('takes a key out of the copy when it stops being publishable', async () => {
    const promoted = await makeKey(regionalProject)
    await deliverRegion(REGION)
    expect((await copiedKeys(regionalProject)).map((k) => k.id)).toContain(promoted.id)

    await prisma.apiKey.update({ where: { id: promoted.id }, data: { serviceRole: true } })
    await deliverRegion(REGION)
    expect((await copiedKeys(regionalProject)).map((k) => k.id)).not.toContain(promoted.id)

    await prisma.apiKey.update({ where: { id: promoted.id }, data: { serviceRole: false } })
    await deliverRegion(REGION)
    expect((await copiedKeys(regionalProject)).map((k) => k.id)).toContain(promoted.id)
  })

  it('copies a key whose lists are NULL at home as empty lists, as home reads them, instead of failing every delivery', async () => {
    // A create that omits a list leaves its column NULL. The copy's columns are NOT NULL, so one such key made
    // every delivery to the region fail (23502) and the copy never filled.
    const listless = await makeKey(regionalProject)
    await run(homeUrl(), `UPDATE "api_keys" SET "permissions" = NULL, "capabilities" = NULL WHERE "id" = $1`, [listless.id])
    expect(await deliverRegion(REGION)).toMatchObject({ outcome: 'delivered' })
    const [copied] = await rowsIn<{ permissions: string[]; capabilities: string[] }>(
      regionalUrl,
      `SELECT "permissions", "capabilities" FROM public.auth_projection_keys WHERE "id" = $1`,
      [listless.id],
    )
    expect(copied).toEqual({ permissions: [], capabilities: [] })
  })

  it('takes a deleted project out of the copy with its keys and branches', async () => {
    const doomed = (await prisma.project.create({ data: { name: `authcopy-doomed-${randomUUID()}`, userId: ownerId, region: REGION }, select: { id: true } })).id
    await makeKey(doomed)
    await prisma.workspaceBranch.create({
      data: { projectId: doomed, name: `b${randomBytes(3).toString('hex')}`, schemaName: `workspace_y_br_${randomBytes(3).toString('hex')}`, createdBy: ownerId },
    })
    await deliverRegion(REGION)
    expect(await copiedProject(doomed)).toBeDefined()
    expect(await copiedKeys(doomed)).toHaveLength(1)
    expect(await copiedBranches(doomed)).toHaveLength(1)

    // Its keys and branches go by cascade, before their own triggers could
    // name its region: the project's own removal carries theirs.
    await prisma.project.delete({ where: { id: doomed } })
    await deliverRegion(REGION)
    expect(await copiedProject(doomed)).toBeUndefined()
    expect(await copiedKeys(doomed)).toEqual([])
    expect(await copiedBranches(doomed)).toEqual([])
  })

  it("carries the product's own project and account deletions to the region, whose copy then holds none of their keys", async () => {
    // deleteProjectCompletely and deleteAccountCompletely sweep every row that
    // still names the project after the cascade, model by model from the
    // generated client. The deletion's own record must survive that sweep, or
    // the region never hears of it while its copy stays fresh, and the deleted
    // project's keys keep working there.
    expect(ORPHANED_PROJECT_MODELS).not.toContain('AuthProjectionChange')
    const doomed = (await prisma.project.create({ data: { name: `authcopy-deleted-${randomUUID()}`, userId: ownerId, region: REGION }, select: { id: true } })).id
    const doomedKey = await makeKey(doomed)
    const leaver = (await prisma.user.create({ data: { email: `authcopy-leaver-${randomUUID()}@example.test`, name: 'leaving account' }, select: { id: true } })).id
    const leaversProject = (await prisma.project.create({ data: { name: `authcopy-leaver-${randomUUID()}`, userId: leaver, region: REGION }, select: { id: true } })).id
    const leaversKey = await prisma.apiKey.create({
      data: { name: 'leaver key', keyPrefix: 'proj_live_x', keyHash: randomBytes(32).toString('hex'), userId: leaver, projectId: leaversProject, permissions: ['read'], capabilities: [] },
      select: { id: true, keyHash: true },
    })
    await deliverRegion(REGION)
    expect((await copiedKeys(doomed)).map((k) => k.id)).toEqual([doomedKey.id])
    expect((await copiedKeys(leaversProject)).map((k) => k.id)).toEqual([leaversKey.id])

    try {
      await deleteProjectCompletely(doomed)
      await deleteAccountCompletely(leaver)
      expect((await deliverRegion(REGION)).outcome).toBe('delivered')

      for (const gone of [doomed, leaversProject]) {
        expect(await copiedProject(gone)).toBeUndefined()
        expect(await copiedKeys(gone)).toEqual([])
      }
      expect((await copyFreshness(REGION)).fresh).toBe(true)
    } finally {
      // Each deletion queues its purge for the region, whose database this
      // suite drops: not left for a later suite's purge pass to trip over.
      await prisma.backgroundJob.deleteMany({
        where: { type: 'purge_project', OR: [doomed, leaversProject].map((id) => ({ payload: { path: ['projectId'], equals: id } })) },
      })
    }
  })

  it('never copies a signing secret in the clear', async () => {
    const copied = (await copiedProject(regionalProject)).jwtSecret as string
    expect(copied).not.toContain(PLAINTEXT_SECRET)
    expect(copied).toMatch(/^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/)
    expect(JWTSecretManager.resolve(copied)).toBe(PLAINTEXT_SECRET)
  })

  it('empties and redelivers a copy out of step with home, so nothing restored outlives the restore', async () => {
    // A restore of the region's database: a key revoked since is back, and the
    // copy's round and watermark are the old ones.
    const state = await regionalState()
    await run(
      regionalUrl,
      `INSERT INTO public.auth_projection_keys ("id", "projectId", "keyHash", "name", "keyPrefix", "userId", "role", "permissions",
         "capabilities", "rateLimit", "rateLimitWindow", "scope", "keyType", "serviceRole", "version")
       VALUES ('restored-key', $1, 'restored-hash', 'restored', 'proj_live_x', $2, 'client', '{read}', '{}', 1000, 3600, 'runtime', 'public', false, 1)`,
      [regionalProject, ownerId],
    )
    await run(regionalUrl, `UPDATE public.auth_projection_state SET "round" = "round" - 1, "watermarkAt" = now() - interval '1 hour'`)
    // The restored watermark is old, so nothing trusts the copy meanwhile.
    expect((await copyFreshness(REGION)).fresh).toBe(false)

    const result = await deliverRegion(REGION)
    expect(result.outcome).toBe('resynced')
    expect((await copiedKeys(regionalProject)).map((k) => k.id)).not.toContain('restored-key')
    expect((await copiedKeys(regionalProject)).map((k) => k.id)).toContain(publishable.id)
    expect((await regionalState()).epoch).not.toBe(state.epoch)
    expect((await copyFreshness(REGION)).fresh).toBe(true)
  })

  it('leaves the watermark where it was when the region refuses a delivery, and delivers once it can', async () => {
    const before = await regionalState()
    await run(regionalUrl, `ALTER TABLE public.auth_projection_keys RENAME TO auth_projection_keys_away`)
    try {
      const changed = await makeKey(regionalProject)
      const refused = await deliverRegion(REGION)
      expect(refused.outcome).toBe('unavailable')
      expect((await regionalState()).watermarkAt).toEqual(before.watermarkAt)
      expect(await pendingFor(regionalProject)).toEqual([{ entity: 'api_key', entityId: changed.id }])
      expect((await homeState()).lastError).toMatch(/auth_projection_keys/)
    } finally {
      await run(regionalUrl, `ALTER TABLE public.auth_projection_keys_away RENAME TO auth_projection_keys`)
    }
    const delivered = await deliverRegion(REGION)
    expect(delivered).toMatchObject({ outcome: 'delivered', applied: 1 })
    expect(await pendingFor(regionalProject)).toEqual([])
    expect((await homeState()).lastError).toBeNull()
  })

  it('never lets an older delivery overwrite a newer row', async () => {
    await run(regionalUrl, `UPDATE public.auth_projection_keys SET "version" = 9223372036854775000, "permissions" = '{fenced}' WHERE "id" = $1`, [publishable.id])
    await prisma.apiKey.update({ where: { id: publishable.id }, data: { permissions: ['read'] } })
    await deliverRegion(REGION)
    expect((await copiedKeys(regionalProject)).find((k) => k.id === publishable.id)?.permissions).toEqual(['fenced'])
    await run(regionalUrl, `UPDATE public.auth_projection_keys SET "version" = 0 WHERE "id" = $1`, [publishable.id])
    await prisma.apiKey.update({ where: { id: publishable.id }, data: { permissions: ['read', 'write'] } })
    await deliverRegion(REGION)
    expect((await copiedKeys(regionalProject)).find((k) => k.id === publishable.id)?.permissions).toEqual(['read', 'write'])
  })

  it('delivers a backlog in rounds, and moves the watermark only once none is left', async () => {
    const before = (await regionalState()).watermarkAt as Date
    for (let i = 0; i < 5; i++) await makeKey(regionalProject)
    const partial = await deliverRegion(REGION, { batch: 2, budgetMs: 0 })
    expect(partial).toMatchObject({ outcome: 'delivered', applied: 2 })
    expect((await regionalState()).watermarkAt).toEqual(before)

    const rest = await deliverRegion(REGION, { batch: 2 })
    expect(rest).toMatchObject({ outcome: 'delivered', applied: 3 })
    expect(((await regionalState()).watermarkAt as Date).getTime()).toBeGreaterThan(before.getTime())
  })

  it('delivers to a region one delivery at a time', async () => {
    const holder = new Client({ connectionString: homeUrl() })
    await holder.connect()
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [`auth-projection:${REGION}`])
      expect(await deliverRegion(REGION)).toMatchObject({ outcome: 'busy', applied: 0 })
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`auth-projection:${REGION}`]).catch(() => {})
      await holder.end().catch(() => {})
    }
    expect((await deliverRegion(REGION)).outcome).toBe('delivered')
  })

  it("refuses a database that keeps another region's copy", async () => {
    await run(regionalUrl, `INSERT INTO public.auth_projection_state ("region", "epoch", "round") VALUES ('us-west-2', 'elsewhere', 0)`)
    try {
      const result = await deliverRegion(REGION)
      expect(result.outcome).toBe('failed')
      expect(result.error).toMatch(/keeps the copy for us-west-2/)
    } finally {
      await run(regionalUrl, `DELETE FROM public.auth_projection_state WHERE "region" = 'us-west-2'`)
    }
  })

  it('reports a copy past the staleness bound as not fresh', async () => {
    await deliverRegion(REGION)
    expect((await copyFreshness(REGION, 15_000)).fresh).toBe(true)
    await run(regionalUrl, `UPDATE public.auth_projection_state SET "watermarkAt" = now() - interval '16 seconds'`)
    expect((await copyFreshness(REGION, 15_000)).fresh).toBe(false)
    // A watermark in this clock's future means the clocks disagree.
    await run(regionalUrl, `UPDATE public.auth_projection_state SET "watermarkAt" = now() + interval '5 seconds'`)
    expect((await copyFreshness(REGION, 15_000)).fresh).toBe(false)
    await deliverRegion(REGION)
    expect((await copyFreshness(REGION, 15_000)).fresh).toBe(true)
  })
})

describe('the hourly check against home', () => {
  // A change whose record never reached the region: the row is put straight
  // into the copy, as a record removed before delivery would leave it.
  const plantKey = (id: string, projectId: string) =>
    run(
      regionalUrl,
      `INSERT INTO public.auth_projection_keys ("id", "projectId", "keyHash", "name", "keyPrefix", "userId", "role", "permissions",
         "capabilities", "rateLimit", "rateLimitWindow", "scope", "keyType", "serviceRole", "version")
       VALUES ($1, $2, $3, 'planted', 'proj_live_x', $4, 'client', '{read}', '{}', 1000, 3600, 'runtime', 'public', false, 1)`,
      [id, projectId, randomBytes(32).toString('hex'), ownerId],
    )

  it('finds nothing to queue while the copy agrees with home', async () => {
    await deliverRegion(REGION)
    expect(await reconcileRegionCopy(REGION)).toMatchObject({ queued: 0 })
    expect((await reconcileRegionCopy(REGION)).checked).toBeGreaterThan(0)
  })

  it('queues a key home no longer has, which the next delivery removes', async () => {
    await deliverRegion(REGION)
    const planted = `planted-${randomUUID()}`
    await plantKey(planted, regionalProject)
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await reconcileRegionCopy(REGION)).toMatchObject({ queued: 1 })
      expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/held 1 row\(s\) home no longer has/)
    } finally {
      errors.mockRestore()
    }
    await deliverRegion(REGION)
    expect((await copiedKeys(regionalProject)).map((k) => k.id)).not.toContain(planted)
  })

  it('queues a project home no longer has, whose keys go with it', async () => {
    await deliverRegion(REGION)
    const ghost = `ghost-${randomUUID()}`
    await run(regionalUrl, `INSERT INTO public.auth_projection_projects ("id", "userId", "version") VALUES ($1, $2, 1)`, [ghost, ownerId])
    await plantKey(`ghost-key-${randomUUID()}`, ghost)
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await reconcileRegionCopy(REGION)).toMatchObject({ queued: 2 })
    } finally {
      errors.mockRestore()
    }
    await deliverRegion(REGION)
    expect(await copiedProject(ghost)).toBeUndefined()
    expect(await copiedKeys(ghost)).toEqual([])
  })

  // A change whose record never reached the region, to a row the copy still holds:
  // the copy is edited the way the missed change would have left it.
  const quietly = async <T>(work: () => Promise<T>): Promise<{ value: T; errors: string }> => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const value = await work()
      return { value, errors: errors.mock.calls.map((call) => String(call[0])).join('\n') }
    } finally {
      errors.mockRestore()
    }
  }

  it("queues a key whose permissions differ from home's, which the next delivery writes again", async () => {
    await deliverRegion(REGION)
    const [key] = await copiedKeys(regionalProject)
    const atHome = await prisma.apiKey.findUniqueOrThrow({ where: { id: key.id }, select: { permissions: true } })
    expect(atHome.permissions).not.toEqual(['admin'])
    // As if a key narrowed to read had been widened back in the copy: the region would authorize more than home does.
    await run(regionalUrl, `UPDATE public.auth_projection_keys SET "permissions" = '{admin}' WHERE "id" = $1`, [key.id])
    const { value, errors } = await quietly(() => reconcileRegionCopy(REGION))
    expect(value).toMatchObject({ queued: 1, drifted: 1 })
    expect(errors).toMatch(/and 1 whose contents differ from home's/)
    await deliverRegion(REGION)
    expect((await copiedKeys(regionalProject)).find((k) => k.id === key.id)?.permissions).toEqual(atHome.permissions)
  })

  it('queues a project still locked in the copy after home lifted the lock, which the next delivery clears', async () => {
    await deliverRegion(REGION)
    expect((await copiedProject(regionalProject)).lockedDownAt).toBeNull()
    await run(regionalUrl, `UPDATE public.auth_projection_projects SET "lockedDownAt" = now(), "lockedDownReason" = 'lifted at home' WHERE "id" = $1`, [regionalProject])
    const { value } = await quietly(() => reconcileRegionCopy(REGION))
    expect(value).toMatchObject({ queued: 1, drifted: 1 })
    await deliverRegion(REGION)
    expect((await copiedProject(regionalProject)).lockedDownAt).toBeNull()
  })

  it('compares a signing secret by its value: the same secret encrypted afresh agrees, another one is written again', async () => {
    await deliverRegion(REGION)
    // The copy's text never equals home's, yet the check finds nothing while they mean the same secret.
    await run(regionalUrl, `UPDATE public.auth_projection_projects SET "jwtSecret" = $2 WHERE "id" = $1`, [
      regionalProject,
      JWTSecretManager.atRest(PLAINTEXT_SECRET),
    ])
    expect(await reconcileRegionCopy(REGION)).toMatchObject({ queued: 0, drifted: 0 })
    // A secret rotated at home whose change never arrived: the copy still verifies the old one.
    await run(regionalUrl, `UPDATE public.auth_projection_projects SET "jwtSecret" = $2 WHERE "id" = $1`, [
      regionalProject,
      JWTSecretManager.atRest(randomBytes(32).toString('hex')),
    ])
    const { value } = await quietly(() => reconcileRegionCopy(REGION))
    expect(value).toMatchObject({ queued: 1, drifted: 1 })
    await deliverRegion(REGION)
    expect(JWTSecretManager.resolve((await copiedProject(regionalProject)).jwtSecret as string)).toBe(PLAINTEXT_SECRET)
  })

  it('leaves a change already waiting for delivery to it, and agrees on timestamps once it is delivered', async () => {
    await deliverRegion(REGION)
    const [key] = await copiedKeys(regionalProject)
    await prisma.project.update({ where: { id: regionalProject }, data: { pausedAt: new Date(Date.now() - 60_000), pauseReason: 'reconcile probe' } })
    await prisma.apiKey.update({ where: { id: key.id }, data: { expiresAt: new Date(Date.now() + 86_400_000) } })
    try {
      // Recorded by the capture triggers and not delivered yet: in flight, neither gone nor drifted.
      expect(await reconcileRegionCopy(REGION)).toMatchObject({ queued: 0, drifted: 0 })
      await deliverRegion(REGION)
      expect((await copiedProject(regionalProject)).pausedAt).not.toBeNull()
      // Delivered: a pause and an expiry, timestamps without a time zone on both sides, compare equal.
      expect(await reconcileRegionCopy(REGION)).toMatchObject({ queued: 0, drifted: 0 })
    } finally {
      await prisma.project.update({ where: { id: regionalProject }, data: { pausedAt: null, pauseReason: null } })
      await prisma.apiKey.update({ where: { id: key.id }, data: { expiresAt: null } })
      await deliverRegion(REGION)
    }
  })
})
