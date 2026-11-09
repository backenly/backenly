/**
 * A UNIQUE INDEX AN UPSERT CAN USE
 * ================================
 *
 * On a table with soft delete, Backenly scopes a UNIQUE index to live rows
 * (WHERE deleted_at IS NULL), and Postgres cannot match an upsert's
 * `ON CONFLICT (cols)` to a partial index. Backenly's own answer said to pass
 * `where: "true"` for an index over every row, and both doors refused it:
 * create_index as "it does not reference any column", and apply_migration's
 * `CREATE UNIQUE INDEX … WHERE true` as UNSAFE_CONSTRAINT. So no upsert could
 * work on any Backenly table.
 *
 * Reading an index back also took the LAST parenthesised group of its
 * definition, which on a partial index is the predicate: asking twice for the
 * same scoped index answered INDEX_CONFLICT, and nothing could tell a scoped
 * index from one over every row.
 *
 * Pinned here on a real provisioned project, through apply_migration and the
 * executor as the dashboard and agents call them.
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
import { withChangeAttribution } from '@/lib/changes/attribution'
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { forgetProtection } from '@/lib/branches/protection'
import { executeAction } from '@/lib/ai/minimal-executor'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const asPerson = <R>(fn: () => Promise<R>) => withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, fn)
const migrate = (sql: string) =>
  asPerson(() => applyMigrationToMain(projectId, ownerId, sql, { agentSurface: false, workspaceSchema: schema }))
const createIndex = (params: Record<string, unknown>) =>
  asPerson(() =>
    executeAction({ action: 'CREATE_INDEX', params: { tableName: 'cart_items', ...params } } as any, projectId, undefined, 0, undefined, false),
  )

async function indexdef(name: string): Promise<string | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
    schema,
    name,
  )
  return rows[0]?.indexdef ?? null
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `every-row-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'Ada Owner' },
  })).id
  const project = await createProvisionedProject({ name: 'unique-index-over-every-row', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })
  forgetProtection(projectId)

  const created = await migrate(
    'CREATE TABLE cart_items (user_id uuid NOT NULL, product_id uuid NOT NULL, quantity integer NOT NULL DEFAULT 1)',
  )
  if (!created.ok) throw new Error(`cart_items was not created: ${JSON.stringify(created)}`)
  const columns = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'cart_items'`,
    schema,
  )
  // The premise: Backenly gives the table soft delete.
  expect(columns.map((c) => c.column_name)).toContain('deleted_at')
}, 180_000)

afterAll(async () => {
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

describe('a unique index over every row', () => {
  it('apply_migration creates one from CREATE UNIQUE INDEX … WHERE true', async () => {
    const out = await migrate('CREATE UNIQUE INDEX cart_items_user_product_all ON cart_items (user_id, product_id) WHERE true')
    expect(out).toMatchObject({ ok: true })

    const def = await indexdef('cart_items_user_product_all')
    expect(def).toMatch(/^CREATE UNIQUE INDEX cart_items_user_product_all ON .*\(user_id, product_id\)$/)
    expect(def).not.toMatch(/WHERE/i)
  }, 120_000)

  it('is one an upsert can target', async () => {
    const user = crypto.randomUUID()
    const product = crypto.randomUUID()
    const upsert = () =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "${schema}"."cart_items" (user_id, product_id, quantity) VALUES ($1::uuid, $2::uuid, 1)
         ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = "cart_items".quantity + EXCLUDED.quantity`,
        user,
        product,
      )
    await upsert()
    await upsert()
    const rows = await prisma.$queryRawUnsafe<Array<{ quantity: number }>>(
      `SELECT quantity FROM "${schema}"."cart_items" WHERE user_id = $1::uuid AND product_id = $2::uuid`,
      user,
      product,
    )
    expect(rows).toEqual([{ quantity: 2 }])
  }, 60_000)

  it('create_index makes one for where: "true", and says an upsert can use it', async () => {
    const out = await createIndex({ columns: ['product_id', 'user_id'], unique: true, where: 'true', indexName: 'cart_items_product_user_all' })
    expect(out).toMatchObject({ success: true, data: { everyRow: true, softDeleteScoped: false, where: null } })
    expect(out.message).toMatch(/covers every row, soft-deleted ones included/)
    expect(await indexdef('cart_items_product_user_all')).not.toMatch(/WHERE/i)
  }, 120_000)
})

describe('a unique index scoped to live rows', () => {
  it('is still what unique: true gives a soft-delete table, and asking again is not a conflict', async () => {
    const first = await createIndex({ columns: ['user_id', 'quantity'], unique: true })
    expect(first).toMatchObject({ success: true, data: { softDeleteScoped: true, indexName: 'uniq_cart_items_user_id_quantity' } })
    expect(first.message).toMatch(/where: "true"/)
    expect(await indexdef('uniq_cart_items_user_id_quantity')).toMatch(/WHERE \(deleted_at IS NULL\)$/)

    const again = await createIndex({ columns: ['user_id', 'quantity'], unique: true })
    expect(again).toMatchObject({ success: true, data: { alreadyExisted: true } })
  }, 120_000)

  it('is never mistaken for one over every row of the same name', async () => {
    const out = await createIndex({ columns: ['user_id', 'quantity'], unique: true, where: 'true' })
    expect(out).toMatchObject({ success: false, code: 'INDEX_CONFLICT', data: { requested: { where: 'true' } } })
    expect(out.message).toMatch(/over every row/)
    // The scoped index is left as it was.
    expect(await indexdef('uniq_cart_items_user_id_quantity')).toMatch(/WHERE \(deleted_at IS NULL\)$/)
  }, 120_000)
})
