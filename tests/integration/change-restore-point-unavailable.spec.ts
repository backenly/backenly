/**
 * WHEN A RESTORE POINT CANNOT BRING EVERYTHING BACK, AGAINST A REAL DATABASE
 * ==========================================================================
 *
 * A restore point is a catalog checkpoint plus the data the change kept in its
 * vault. Either can stop being usable: the checkpoint can fail its integrity
 * check (change-recovery.spec.ts), the restore window can close, and the kept
 * data can go, purged by retention once the window and a grace week are over,
 * or lost outside Backenly. Here:
 *
 *   kept data lost outside Backenly is noticed before anything runs: the
 *   restore is never called lossless, it says what would come back empty, and
 *   it runs only for a person who approves exactly that;
 *   retention purges a vault only once its change is past the window and the
 *   grace week, marks the record, and leaves younger vaults, the workspace and
 *   other projects alone; a vault no change recorded goes once it is as old;
 *   past its window a restore is not offered, and the record says its kept
 *   data was removed.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', logRetentionDays: 7 }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { withChangeAttribution, withGovernedChange } from '@/lib/changes/ledger'
import { archiveTable } from '@/lib/changes/preserve'
import { availabilityOf, previewRecovery, recoverChange } from '@/lib/changes/recovery'
import { getChange } from '@/lib/changes/history'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { purgeExpiredVaults } from '@/lib/changes/retention'
import { rollbackWindowDays, VAULT_GRACE_DAYS } from '@/lib/changes/policy'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

const DAY = 24 * 60 * 60 * 1000

let ownerId: string
let projectId: string
let schema: string
let otherProjectId: string
let otherSchema: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)
const record = (id: string) => prisma.backendChange.findUniqueOrThrow({ where: { id } })
const vaultOf = async (id: string) => ((await record(id)).preserved as any).vault as string

async function schemaExists(name: string): Promise<boolean> {
  return (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = '${name}'`))[0].n > 0
}

async function tableExists(name: string): Promise<boolean> {
  return (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = '${schema}' AND tablename = '${name}'`))[0].n > 0
}

/** A person's change in the dashboard that drops a table, keeping its rows. */
async function dropKeeping(table: string, values: string[]) {
  await ddl(`CREATE TABLE ${T(table)} (id serial PRIMARY KEY, v text)`)
  if (values.length > 0) await ddl(`INSERT INTO ${T(table)} (v) VALUES ${values.map((v) => `('${v}')`).join(', ')}`)
  const { change } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    withGovernedChange({ projectId, title: `drop ${table}` }, async () => { await archiveTable(projectId, schema, table) }))
  return change!
}

const restore = (id: string, acknowledged?: Record<string, number> | null) =>
  recoverChange(projectId, id, { mode: 'manual', actorUserId: ownerId, acknowledged: acknowledged ?? null })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `restore-point-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'x', name: 'Ada Owner' },
  })).id
  const project = await createProvisionedProject({ name: 'restore-point-unavailable', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  const other = await createProvisionedProject({ name: 'restore-point-neighbour', userId: ownerId })
  otherProjectId = other.id
  otherSchema = other.postgresSchema
}, 180_000)

afterAll(async () => {
  for (const id of [projectId, otherProjectId].filter(Boolean)) {
    const vaults = await rows<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${id}_r%'`).catch(() => [])
    for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  }
  for (const s of [schema, otherSchema].filter(Boolean)) await ddl(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
  // The guard allows deleting a project's changes only once the project is gone.
  for (const id of [projectId, otherProjectId].filter(Boolean)) await prisma.project.delete({ where: { id } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

describe('kept data lost outside Backenly', () => {
  let changeId: string
  let preview: Awaited<ReturnType<typeof previewRecovery>>

  beforeAll(async () => {
    const c = await dropKeeping('ledger_lost', ['x', 'y'])
    changeId = c.id
    // An operator, a restored backup that predates the vault, a lost volume.
    await ddl(`DROP SCHEMA "${await vaultOf(changeId)}" CASCADE`)
    preview = await previewRecovery(projectId, changeId)
  }, 60_000)

  it('is noticed before anything runs: the restore is never called lossless, and says what would come back empty', () => {
    expect(preview!.safety).toBe('needs_approval')
    expect(preview!.checks.find((c) => c.id === 'data')).toMatchObject({ ok: false })
    expect(preview!.impact!.items).toEqual([
      expect.objectContaining({ effect: 'restore_incomplete', table: 'ledger_lost', needsApproval: true, detail: expect.stringMatching(/come back empty/) }),
    ])
  })

  it('is refused without a person approving exactly that, and nothing changes', async () => {
    const out = await restore(changeId)
    expect(out).toMatchObject({ ok: false, code: 'NEEDS_APPROVAL' })
    expect(await tableExists('ledger_lost')).toBe(false)
    expect((await record(changeId)).status).toBe('healthy')
  })

  it('with that approval, brings the table back empty, verified, and says so', async () => {
    const out = await restore(changeId, preview!.acknowledgement)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    expect((out as any).verification.outcome).toBe('confirmed')
    expect((out as any).impact.items.map((i: any) => i.effect)).toEqual(['restore_incomplete'])
    expect(await tableExists('ledger_lost')).toBe(true)
    expect(await rows(`SELECT count(*)::int AS n FROM ${T('ledger_lost')}`)).toEqual([{ n: 0 }])
  })
})

describe('retention', () => {
  let older: { id: string; createdAt: Date; vault: string }
  let newer: { id: string; createdAt: Date; vault: string }
  let orphan: string
  let neighbourVault: string
  let window: number

  beforeAll(async () => {
    window = await rollbackWindowDays(projectId)
    // A change whose process died after creating its vault and before
    // recording it: the vault is named for the change, the record names none.
    await ddl(`CREATE TABLE ${T('plain_one')} (id serial PRIMARY KEY)`)
    const { change: plain } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      withGovernedChange({ projectId, title: 'plain_one.a' }, async () => { await ddl(`ALTER TABLE ${T('plain_one')} ADD COLUMN a text`) }))
    orphan = `workspace_${projectId}_r${plain!.seq}`
    await ddl(`CREATE SCHEMA "${orphan}"`)
    await ddl(`CREATE TABLE "${orphan}".stray (v text)`)
    const a = await dropKeeping('aged_one', ['x'])
    // Far enough apart that a moment can fall between their two purge times.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const b = await dropKeeping('young_one', ['y'])
    older = { id: a.id, createdAt: (await record(a.id)).createdAt, vault: await vaultOf(a.id) }
    newer = { id: b.id, createdAt: (await record(b.id)).createdAt, vault: await vaultOf(b.id) }
    // Another project's vault, as old as anything here.
    neighbourVault = `workspace_${otherProjectId}_r1`
    await ddl(`CREATE SCHEMA IF NOT EXISTS "${neighbourVault}"`)
  }, 60_000)

  it('purges nothing before a change is past its window and the grace week', async () => {
    const first = await prisma.backendChange.findFirstOrThrow({ where: { projectId }, orderBy: { createdAt: 'asc' } })
    const { purged } = await purgeExpiredVaults(projectId, new Date(first.createdAt.getTime() + (window + VAULT_GRACE_DAYS) * DAY - 1000))
    expect(purged).toEqual([])
    expect(await schemaExists(older.vault)).toBe(true)
  })

  it('then purges the older vault, marks its record, and leaves the younger one, the workspace and other projects alone', async () => {
    const at = new Date(newer.createdAt.getTime() + (window + VAULT_GRACE_DAYS) * DAY - 500)
    expect(at.getTime() - older.createdAt.getTime()).toBeGreaterThan((window + VAULT_GRACE_DAYS) * DAY)
    const { purged } = await purgeExpiredVaults(projectId, at)
    expect(purged).toContain(older.vault)
    expect(purged).not.toContain(newer.vault)
    expect(await schemaExists(older.vault)).toBe(false)
    expect(await schemaExists(newer.vault)).toBe(true)
    expect(await schemaExists(schema)).toBe(true)
    expect(await schemaExists(neighbourVault)).toBe(true)
    expect(((await record(older.id)).preserved as any).purgedAt).toBe(at.toISOString())
    expect(((await record(newer.id)).preserved as any).purgedAt).toBeUndefined()
    // The orphan's change recorded no vault; it goes on its change's age alone.
    expect(purged).toContain(orphan)
    expect(await schemaExists(orphan)).toBe(false)
  })

  it('past its window a restore is not offered, and the record says its kept data was removed', async () => {
    const r = await record(older.id)
    const at = new Date(older.createdAt.getTime() + (window + VAULT_GRACE_DAYS) * DAY + 1000)
    const availability = availabilityOf(
      { kind: r.kind, status: r.status, footprint: r.footprint as any, createdAt: r.createdAt, intact: true },
      window,
      { now: at },
    )
    expect(availability).toMatchObject({ available: false, code: 'EXPIRED' })
    const detail = (await getChange(projectId, older.id))!
    expect(detail.preserved!.purgedAt).toBeTruthy()
  })

  it('a second purge finds nothing more to do', async () => {
    const at = new Date(newer.createdAt.getTime() + (window + VAULT_GRACE_DAYS) * DAY - 500)
    const { purged } = await purgeExpiredVaults(projectId, at)
    expect(purged).toEqual([])
  })
})
