/**
 * NAMES BACKENLY MAKES FROM A COLUMN FOLLOW IT, AND A NAME IT CHOOSES NEVER COLLIDES
 * ==================================================================================
 *
 * Production QA (2026-11-09): six statements passed on a branch and the merge
 * a person approved failed on production at `CREATE INDEX ON orders (status)`.
 * The earlier `RENAME COLUMN status TO legacy_status` left Backenly's
 * idx_orders_status on legacy_status, and the new index wanted the same name:
 * INDEX_CONFLICT. On the branch the cloned index had another name, so the
 * branch never saw it. And an agent's named index was built next to Backenly's
 * identical one.
 *
 * Real provisioned project, governed migrations as a person runs them:
 *  1. A rename carries Backenly's index and foreign-key names to the new
 *     column, and the change verifies; the merge's sequence then succeeds.
 *  2. A name Backenly would choose that another index holds gives the next
 *     free name, not a failure; a name the author chose still conflicts.
 *  3. An index identical to one that exists is not built a second time.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
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
import { withChangeAttribution } from '@/lib/changes/attribution'
import { applyMigrationToMain, type MigrationFailure, type MigrationSuccess } from '@/lib/mcp/apply-migration'
import { closeChangeLockPool } from '@/lib/changes/lock'

let ownerId: string
let projectId: string
let schema: string
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const migrate = (sql: string) =>
  withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    applyMigrationToMain(projectId, ownerId, sql, { agentSurface: false, workspaceSchema: schema }),
  )

async function migrated(sql: string): Promise<MigrationSuccess> {
  const out = await migrate(sql)
  if (!out.ok) throw new Error(`"${sql}" did not apply: ${JSON.stringify(out)}`)
  return out as MigrationSuccess
}

async function indexes(): Promise<Record<string, string>> {
  const rows = await prisma.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = ${schema} AND tablename = 'orders'`
  return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]))
}

async function foreignKeys(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
    SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = ${schema} AND t.relname = 'orders' AND c.contype = 'f'`
  return rows.map((r) => r.conname).sort()
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (await prisma.user.create({
    data: { email: `index-names-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'index-names-follow-renames', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await migrated('CREATE TABLE customers (label text)')
  // customer_id without REFERENCES: Backenly's foreign-key repair adds the key, named fk_orders_customer.
  await migrated('CREATE TABLE orders (stage text, code text, customer_id uuid)')
  await migrated('CREATE INDEX ON orders (stage)')
}, 240_000)

afterAll(async () => {
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  await closeChangeLockPool()
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
})

it('carries the index name to the renamed column, so the sequence that failed the merge succeeds', async () => {
  expect(Object.keys(await indexes())).toContain('idx_orders_stage')

  const renamed = await migrated('ALTER TABLE orders RENAME COLUMN stage TO legacy_stage')
  expect(renamed.change).toMatchObject({ status: 'healthy', verified: true })
  const after = await indexes()
  expect(after.idx_orders_legacy_stage).toMatch(/\(legacy_stage\)/)
  expect(after.idx_orders_stage).toBeUndefined()

  // The merge's next two statements, which failed at the second on production.
  await migrated('ALTER TABLE orders ADD COLUMN stage text')
  const indexed = await migrated('CREATE INDEX ON orders (stage)')
  expect(indexed.change).toMatchObject({ status: 'healthy' })
  expect((await indexes()).idx_orders_stage).toMatch(/\(stage\)/)
}, 120_000)

it('carries a foreign key Backenly named after its column too, and the change verifies', async () => {
  expect(await foreignKeys()).toContain('fk_orders_customer')
  const out = await migrated('ALTER TABLE orders RENAME COLUMN customer_id TO legacy_customer_id')
  expect(out.change).toMatchObject({ status: 'healthy', verified: true })
  const after = await foreignKeys()
  expect(after).toContain('fk_orders_legacy_customer')
  expect(after).not.toContain('fk_orders_customer')
}, 120_000)

it('takes the next free name when another index holds the one Backenly would choose; an author\'s name still conflicts', async () => {
  // A name a person chose, holding Backenly's default for `code`, over another column.
  await migrated('CREATE INDEX idx_orders_code ON orders (legacy_stage, code)')
  const out = await migrated('CREATE INDEX ON orders (code)')
  expect(out.change).toMatchObject({ status: 'healthy' })
  expect((await indexes()).idx_orders_code_2).toMatch(/\(code\)/)

  const named = await migrate('CREATE INDEX idx_orders_code ON orders (stage, code)')
  expect(named.ok).toBe(false)
  expect((named as MigrationFailure).detail).toMatch(/already exists on orders with a DIFFERENT definition/)
}, 120_000)

it('does not build an index identical to one that exists: an unnamed request reuses it, a named one renames Backenly\'s', async () => {
  // Backenly's index on the key followed its column's rename, so the name it would choose is that index.
  const unnamed = await migrated('CREATE INDEX ON orders (legacy_customer_id)')
  expect(JSON.stringify(unnamed.applied)).toMatch(/idx_orders_legacy_customer_id\\\" already exists on orders \(legacy_customer_id\) — nothing to do/)
  // An unnamed request whose name is free still finds the same index under another name.
  await migrated('CREATE INDEX lookup_by_stage ON orders (legacy_stage, stage)')
  const again = await migrated('CREATE INDEX ON orders (legacy_stage, stage)')
  expect(JSON.stringify(again.applied)).toMatch(/already has this index, \\\"lookup_by_stage\\\"/)

  // Backenly's index on code takes the name the author asked for.
  const before = Object.keys(await indexes()).length
  const named = await migrated('CREATE INDEX orders_code_lookup ON orders (code)')
  expect(JSON.stringify(named.applied)).toMatch(/It is now named \\"orders_code_lookup\\", as asked, and a second one was not built/)
  const after = await indexes()
  expect(Object.keys(after)).toHaveLength(before)
  expect(after.orders_code_lookup).toMatch(/\(code\)/)
  expect(after.idx_orders_code_2).toBeUndefined()
}, 120_000)
