/**
 * A BRANCH REFUSES WHAT PRODUCTION REFUSES: FOREIGN KEYS
 * ======================================================
 * Production QA (2026-11-09), Branches: "Branches also skip checks production
 * enforces: the agent inserted orders for a user id that doesn't exist." The
 * clone copied no foreign key (LIKE never does), and a key a branch migration
 * declared was recorded for the merge but not created, so a test that passed
 * on the branch could fail on production.
 *
 * Now a branch is created with every key main has, pointing at its own tables
 * (as written: actions, DEFERRABLE, NOT VALID), and a key a branch migration
 * declares is installed on the branch. Real schemas, the real branch engine and
 * the real migration path. Only PostgREST's schema registry is stubbed, as in
 * branch-migrations.spec.ts.
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
import { createBranch, discardBranch } from '@/lib/branches/engine'
import { applyBranchMigration } from '@/lib/branches/migrate'

let ownerId: string
let projectId: string
let main: string
let branch: { id: string; schemaName: string }
const customer = crypto.randomUUID()

const exec = (sql: string) => prisma.$executeRawUnsafe(sql)

/** The SQLSTATE an insert fails with, or null when it succeeds. */
async function insertFails(sql: string): Promise<string | null> {
  try {
    await exec(sql)
    return null
  } catch (err: any) {
    return String(err?.meta?.code ?? err?.code ?? err?.message)
  }
}

interface Key { table: string; name: string; references: string; deferrable: boolean; deferred: boolean; validated: boolean; onDelete: string }

async function keysOf(schema: string): Promise<Key[]> {
  return prisma.$queryRaw<Key[]>`
    SELECT child.relname AS "table", con.conname AS name, parent_ns.nspname || '.' || parent.relname AS "references",
           con.condeferrable AS deferrable, con.condeferred AS deferred, con.convalidated AS validated,
           con.confdeltype::text AS "onDelete"
      FROM pg_constraint con
      JOIN pg_class child ON child.oid = con.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = con.confrelid
      JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
     WHERE con.contype = 'f' AND child_ns.nspname = ${schema}
     ORDER BY child.relname, con.conname`
}

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js points the executor at an in-memory graph that skips DDL;
  // a branch migration must issue its DDL as the product does.
  process.env.ENGINE_MODE = 'runtime'

  ownerId = (await prisma.user.create({
    data: { email: `branch-fk-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'branch-foreign-keys', userId: ownerId })
  projectId = project.id
  main = project.postgresSchema

  // Production as QA found it: orders reference a customer, notes reference an
  // order (deferred), and an older key was added NOT VALID over a row that
  // breaks it.
  await exec(`CREATE TABLE "${main}".customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text)`)
  await exec(`CREATE TABLE "${main}".orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid REFERENCES "${main}".customers(id) ON DELETE CASCADE, total integer)`)
  await exec(`CREATE TABLE "${main}".order_notes (id serial PRIMARY KEY, order_id uuid NOT NULL REFERENCES "${main}".orders(id) DEFERRABLE INITIALLY DEFERRED, body text)`)
  await exec(`CREATE TABLE "${main}".legacy_refs (id serial PRIMARY KEY, customer_id uuid)`)
  await exec(`INSERT INTO "${main}".customers (id, email) VALUES ('${customer}', 'shopper@example.com')`)
  await exec(`INSERT INTO "${main}".orders (customer_id, total) VALUES ('${customer}', 40)`)
  await exec(`INSERT INTO "${main}".legacy_refs (customer_id) VALUES (gen_random_uuid())`)
  await exec(`ALTER TABLE "${main}".legacy_refs ADD CONSTRAINT legacy_refs_customer_fk FOREIGN KEY (customer_id) REFERENCES "${main}".customers(id) NOT VALID`)

  const created = await createBranch(projectId, ownerId, 'fk-check', { includeData: true })
  if (!created.ok) throw new Error((created as { error: string }).error)
  branch = (created as { branch: { id: string; schemaName: string } }).branch
}, 180_000)

afterAll(async () => {
  if (branch) await discardBranch(projectId, ownerId, branch.id).catch(() => {})
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await exec(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  if (main) await exec(`DROP SCHEMA IF EXISTS "${main}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
}, 180_000)

describe('creating a branch', () => {
  it('copies every key main has, as written, pointing at the branch\'s own tables', async () => {
    const onMain = await keysOf(main)
    const onBranch = await keysOf(branch.schemaName)
    expect(onMain).toHaveLength(3)
    const relative = (keys: Key[], schema: string) =>
      keys.map((k) => ({ ...k, references: k.references.replace(`${schema}.`, '') }))
    expect(relative(onBranch, branch.schemaName)).toEqual(relative(onMain, main))
    expect(onBranch.every((k) => k.references.startsWith(`${branch.schemaName}.`))).toBe(true)

    const byName = Object.fromEntries(onBranch.map((k) => [k.name, k]))
    expect(byName.legacy_refs_customer_fk.validated).toBe(false)
    expect(Object.values(byName).find((k) => k.table === 'order_notes')).toMatchObject({ deferrable: true, deferred: true })
    expect(Object.values(byName).find((k) => k.table === 'orders')).toMatchObject({ onDelete: 'c' })
  })

  it('refuses an order for a customer that does not exist, as production does', async () => {
    const missing = crypto.randomUUID()
    expect(await insertFails(`INSERT INTO "${main}".orders (customer_id, total) VALUES ('${missing}', 5)`)).toBe('23503')
    expect(await insertFails(`INSERT INTO "${branch.schemaName}".orders (customer_id, total) VALUES ('${missing}', 5)`)).toBe('23503')
  })

  it('still takes an order for a customer it has', async () => {
    expect(await insertFails(`INSERT INTO "${branch.schemaName}".orders (customer_id, total) VALUES ('${customer}', 5)`)).toBeNull()
  })
})

describe('a key a branch migration declares', () => {
  it('is created with the table, and checked on the branch', async () => {
    const out = await applyBranchMigration(projectId, branch.id, 'CREATE TABLE shipments (order_id uuid REFERENCES orders(id), carrier text)', ownerId)
    expect(out.ok).toBe(true)
    const keys = (await keysOf(branch.schemaName)).filter((k) => k.table === 'shipments')
    expect(keys.map((k) => k.references)).toEqual([`${branch.schemaName}.orders`])
    expect(await insertFails(`INSERT INTO "${branch.schemaName}".shipments (order_id, carrier) VALUES ('${crypto.randomUUID()}', 'post')`)).toBe('23503')
    expect(await keysOf(main).then((k) => k.filter((x) => x.table === 'shipments'))).toEqual([])
  }, 60_000)

  it('is added by ALTER TABLE, and checked on the branch', async () => {
    const out = await applyBranchMigration(
      projectId,
      branch.id,
      'CREATE TABLE coupons (code text); ALTER TABLE coupons ADD COLUMN customer_id uuid; ' +
        'ALTER TABLE coupons ADD CONSTRAINT coupons_customer_fk FOREIGN KEY (customer_id) REFERENCES customers(id)',
      ownerId,
    )
    expect(out.ok).toBe(true)
    const keys = (await keysOf(branch.schemaName)).filter((k) => k.table === 'coupons')
    expect(keys.map((k) => [k.name, k.references])).toEqual([['coupons_customer_fk', `${branch.schemaName}.customers`]])
    expect(await insertFails(`INSERT INTO "${branch.schemaName}".coupons (code, customer_id) VALUES ('X', '${crypto.randomUUID()}')`)).toBe('23503')
  }, 60_000)
})
