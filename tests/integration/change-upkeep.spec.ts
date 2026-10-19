/**
 * EACH REGION'S SCHEDULER KEEPS ITS OWN PROJECTS' CHANGE LEDGER TRUE
 * ==================================================================
 *
 * Settling a change a process stopped working on, and dropping a vault past its
 * retention window, each read a project's catalog or drop its schemas in the
 * project's own database. They run from each region's scheduler for the
 * projects that region serves (lib/changes/upkeep.ts, called by
 * runRegionalSystemTasks). Against a real database:
 *
 *   an interrupted change of a project this region serves is settled; one of a
 *   project another region serves is left to that region;
 *   a process serving a region it cannot reach skips that region's projects
 *   and records the skip, and does not touch another region's;
 *   a vault past its window is dropped for this region's projects and only
 *   those, and its record marked.
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
import { keepChange } from '@/lib/changes/recovery'
import { closeChangeLockPool, readCatalogOn, withChangeLock } from '@/lib/changes/lock'
import { vaultSchemaName } from '@/lib/changes/names'
import { rollbackWindowDays, VAULT_GRACE_DAYS } from '@/lib/changes/policy'
import { purgeExpiredVaultsHere, settleInterruptedChangesHere } from '@/lib/changes/upkeep'
import { AUTONOMY_SKIPPED, resetSkipRecords } from '@/lib/autonomy/region-skip'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

let ownerId: string
let projectId: string
let schema: string
let regionalId: string
let checkpoint: unknown

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE
const originalServiceRegion = process.env.BACKENLY_SERVICE_REGION
const originalUsEast1 = process.env.DATABASE_URL_US_EAST_1

const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const record = (id: string) => prisma.backendChange.findUniqueOrThrow({ where: { id } })

async function schemaExists(name: string): Promise<boolean> {
  const r = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = '${name}'`)
  return r[0].n > 0
}

async function nextSeq(id: string): Promise<number> {
  const last = await prisma.backendChange.findFirst({ where: { projectId: id }, orderBy: { seq: 'desc' }, select: { seq: true } })
  return (last?.seq ?? 0) + 1
}

/** A change as a process that died mid-change leaves it: the row, its checkpoint, nothing else. */
async function interrupted(id: string, title: string) {
  return prisma.backendChange.create({
    data: {
      projectId: id, seq: await nextSeq(id), kind: 'change', source: 'mcp', title, status: 'applying',
      checkpoint: { database: checkpoint } as any, createdAt: new Date(Date.now() - HOUR),
    },
  })
}

/** A finished change whose vault is still kept. */
async function withVault(id: string) {
  const seq = await nextSeq(id)
  const vault = vaultSchemaName(id, seq)
  const row = await prisma.backendChange.create({
    data: {
      projectId: id, seq, kind: 'change', source: 'dashboard', title: 'drop a table', status: 'healthy',
      checkpoint: { database: checkpoint } as any, completedAt: new Date(),
      preserved: { vault, entries: [] } as any,
    },
  })
  return { id: row.id, vault, createdAt: row.createdAt }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `change-upkeep-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'x', name: 'Ada Owner' },
  })).id
  const project = await createProvisionedProject({ name: 'change-upkeep', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  checkpoint = await withChangeLock(projectId, (client) => readCatalogOn(client, schema))
  // A project kept in N. Virginia: its catalog and vaults are in that region's
  // database, which this suite's home process must never reach for.
  regionalId = (await prisma.project.create({
    data: { name: 'change-upkeep-regional', userId: ownerId, jwtSecret: 'a'.repeat(64), region: 'us-east-1' },
  })).id
}, 180_000)

beforeEach(() => {
  resetSkipRecords()
  delete process.env.BACKENLY_SERVICE_REGION
  delete process.env.DATABASE_URL_US_EAST_1
})

afterAll(async () => {
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  // The guard allows deleting a project's changes only once the project is gone.
  for (const id of [projectId, regionalId].filter(Boolean)) await prisma.project.delete({ where: { id } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
  if (originalServiceRegion === undefined) delete process.env.BACKENLY_SERVICE_REGION
  else process.env.BACKENLY_SERVICE_REGION = originalServiceRegion
  if (originalUsEast1 === undefined) delete process.env.DATABASE_URL_US_EAST_1
  else process.env.DATABASE_URL_US_EAST_1 = originalUsEast1
})

describe('settling changes a process stopped working on', () => {
  it('settles this region\'s, and leaves another region\'s to it', async () => {
    const here = await interrupted(projectId, 'interrupted here')
    const elsewhere = await interrupted(regionalId, 'interrupted in us-east-1')

    // Counts are lower bounds: the database may hold other suites' projects.
    const pass = await settleInterruptedChangesHere()
    expect(pass.done).toBeGreaterThanOrEqual(1)
    expect((await record(here.id)).status).toBe('manual_intervention_required')
    expect((await record(here.id)).error).toMatch(/stopped before it finished/)
    expect((await record(elsewhere.id)).status).toBe('applying')
    // Another region's project is that region's work, not a failure to record.
    expect(await prisma.auditLog.count({ where: { projectId: regionalId, action: AUTONOMY_SKIPPED } })).toBe(0)

    // It now needs a person; clear it so automation is not left paused.
    expect((await keepChange(projectId, here.id, ownerId)).ok).toBe(true)
  }, 60_000)

  it('from a region it cannot reach, skips that region\'s projects, records why, and leaves the home region\'s alone', async () => {
    process.env.BACKENLY_SERVICE_REGION = 'us-east-1'
    const homeChange = await interrupted(projectId, 'interrupted at home')
    const regional = await prisma.backendChange.findFirstOrThrow({ where: { projectId: regionalId, status: 'applying' } })

    const pass = await settleInterruptedChangesHere()
    expect(pass).toMatchObject({ projects: 0, done: 0 })
    expect((await record(regional.id)).status).toBe('applying')
    expect((await record(homeChange.id)).status).toBe('applying')
    const skip = await prisma.auditLog.findFirstOrThrow({ where: { projectId: regionalId, action: AUTONOMY_SKIPPED } })
    expect(JSON.parse(skip.details as string)).toMatchObject({ pass: 'change-settle', region: 'us-east-1', reason: 'REGION_NOT_CONFIGURED' })

    // Back at home, the home change settles on the next pass; clear it.
    delete process.env.BACKENLY_SERVICE_REGION
    await settleInterruptedChangesHere()
    expect((await record(homeChange.id)).status).toBe('manual_intervention_required')
    expect((await keepChange(projectId, homeChange.id, ownerId)).ok).toBe(true)
  }, 60_000)
})

describe('dropping vaults past their window', () => {
  it('drops this region\'s and marks the record, and leaves another region\'s alone', async () => {
    const window = await rollbackWindowDays(projectId)
    const here = await withVault(projectId)
    await ddl(`CREATE SCHEMA "${here.vault}"`)
    const elsewhere = await withVault(regionalId)

    // Before the window and the grace week are over, nothing goes.
    await purgeExpiredVaultsHere(new Date(here.createdAt.getTime() + (window + VAULT_GRACE_DAYS) * DAY - HOUR))
    expect(await schemaExists(here.vault)).toBe(true)
    expect(((await record(here.id)).preserved as any).purgedAt).toBeUndefined()

    const at = new Date(here.createdAt.getTime() + (window + VAULT_GRACE_DAYS) * DAY + HOUR)
    const pass = await purgeExpiredVaultsHere(at)
    expect(pass.done).toBeGreaterThanOrEqual(1)
    expect(await schemaExists(here.vault)).toBe(false)
    expect(((await record(here.id)).preserved as any).purgedAt).toBe(at.toISOString())
    expect(((await record(elsewhere.id)).preserved as any).purgedAt).toBeUndefined()

    // A second pass leaves the record as it was.
    await purgeExpiredVaultsHere(at)
    expect(((await record(here.id)).preserved as any).purgedAt).toBe(at.toISOString())
  }, 60_000)
})
