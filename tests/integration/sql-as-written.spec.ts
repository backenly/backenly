/**
 * A TABLE DECLARED IN SQL IS CREATED AS WRITTEN
 * =============================================
 * apply_migration's CREATE TABLE used to come out with what the column names
 * suggested on top of what the statement said: a UNIQUE on `email`, CHECK
 * value lists on `status` and `payment_status` (from the table being called
 * `orders`), a NOT NULL foreign key with ON DELETE CASCADE on `plan_id`, and the
 * foreign-key repair after every new table added keys to it later. A UNIQUE
 * constraint the SQL named became an index scoped to live rows, which
 * ON CONFLICT on its columns cannot use.
 *
 * Now the statement is the schema: its columns, keys, uniques, checks and
 * defaults, plus the four columns every table gets, which the result names.
 * A table the brain designs from a description keeps its inference.
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
import { applyMigrationToMain, type MigrationSuccess } from '@/lib/mcp/apply-migration'
import { executeAction } from '@/lib/ai/minimal-executor'
import { closeChangeLockPool } from '@/lib/changes/lock'

let ownerId: string
let projectId: string
let schema: string
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

async function migrated(sql: string): Promise<MigrationSuccess> {
  const out = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    applyMigrationToMain(projectId, ownerId, sql, { agentSurface: false, workspaceSchema: schema }),
  )
  if (!out.ok) throw new Error(`"${sql}" did not apply: ${JSON.stringify(out)}`)
  return out as MigrationSuccess
}

async function constraintsOn(table: string): Promise<Array<{ name: string; type: string; def: string }>> {
  return prisma.$queryRawUnsafe(
    `SELECT c.conname AS name, c.contype::text AS type, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND c.contype <> 'p' ORDER BY 1`,
    schema,
    table,
  )
}

async function uniqueIndexesOn(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ def: string }>>(
    `SELECT indexdef AS def FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexdef ILIKE 'CREATE UNIQUE%' AND indexname NOT LIKE '%_pkey'`,
    schema,
    table,
  )
  return rows.map((r) => r.def)
}

async function columnsOf(table: string): Promise<Record<string, { nullable: boolean; default: string | null }>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string; nullable: string; def: string | null }>>(
    `SELECT column_name AS name, is_nullable AS nullable, column_default AS def
       FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
    schema,
    table,
  )
  return Object.fromEntries(rows.map((r) => [r.name, { nullable: r.nullable === 'YES', default: r.def }]))
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  ownerId = (
    await prisma.user.create({
      data: { email: `as-written-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
    })
  ).id
  const project = await createProvisionedProject({ name: 'sql-as-written', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await migrated('CREATE TABLE plans (name text NOT NULL)')
}, 240_000)

afterAll(async () => {
  const vaults = await prisma
    .$queryRawUnsafe<Array<{ nspname: string }>>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`)
    .catch(() => [])
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

describe('CREATE TABLE in a migration', () => {
  let summary = ''

  beforeAll(async () => {
    summary = (await migrated('CREATE TABLE orders (email text, status text, payment_status text, plan_id uuid)')).summary
  }, 120_000)

  it('adds no constraint the statement did not declare', async () => {
    expect(await constraintsOn('orders')).toEqual([])
    expect(await uniqueIndexesOn('orders')).toEqual([])
  })

  it('leaves nullability and defaults as declared', async () => {
    const cols = await columnsOf('orders')
    for (const c of ['email', 'status', 'payment_status', 'plan_id']) expect(cols[c]).toEqual({ nullable: true, default: null })
  })

  it('adds the four columns every table gets, and says so', async () => {
    const cols = await columnsOf('orders')
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(['id', 'createdAt', 'updatedAt', 'deleted_at']))
    expect(summary).toContain('as written')
    expect(summary).toContain('"deleted_at"')
  })

  it('stays as written when the foreign-key repair runs after the next table', async () => {
    await migrated('CREATE TABLE invoices (amount integer)')
    expect((await constraintsOn('orders')).filter((c) => c.type === 'f')).toEqual([])
  }, 120_000)

  it('makes a composite UNIQUE a real constraint', async () => {
    await migrated('CREATE TABLE seats (row_no integer, seat_no integer, UNIQUE (row_no, seat_no))')
    expect(await constraintsOn('seats')).toEqual([expect.objectContaining({ type: 'u', def: 'UNIQUE (row_no, seat_no)' })])
  }, 120_000)
})

describe('ADD CONSTRAINT … UNIQUE in a migration', () => {
  it('is a real constraint, by the name it was given, that ON CONFLICT can target', async () => {
    const out = await migrated('ALTER TABLE orders ADD CONSTRAINT orders_email_key UNIQUE (email)')
    expect(await constraintsOn('orders')).toEqual([{ name: 'orders_email_key', type: 'u', def: 'UNIQUE (email)' }])
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."orders" (email) VALUES ('a@example.test') ON CONFLICT (email) DO NOTHING`)
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."orders" (email) VALUES ('a@example.test') ON CONFLICT (email) DO NOTHING`)
    expect(out.summary).toContain('soft-deleted ones too')
  }, 120_000)
})

describe('a table the brain designs from a description', () => {
  it('still gets what its column names suggest', async () => {
    const res = await executeAction(
      { action: 'CREATE_TABLE', params: { tableName: 'contacts', columns: [{ name: 'email', type: 'TEXT' }] } },
      projectId,
      undefined,
      0,
      undefined,
      false,
    )
    expect(res.success).toBe(true)
    expect((await uniqueIndexesOn('contacts')).join(' ')).toContain('(email)')
  }, 120_000)
})
