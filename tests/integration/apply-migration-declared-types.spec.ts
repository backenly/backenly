/**
 * A migration's column types are created as declared, never as a column's
 * name suggests and never folded into a coarser kind.
 *
 * On production (2026-11-09):
 *   - `session_id text NOT NULL` was created as uuid, so inserting "s1" failed
 *     with 22P02. Any external id kept as text (Stripe `cus_…`, SKUs, session
 *     ids) breaks the same way.
 *   - `refunded_at timestamptz` was timestamptz on the branch and `timestamp
 *     without time zone` in production after the merge, which replays the
 *     statements through this same path.
 *
 * Both came from the migration parser folding every type into Backenly's
 * eight kinds (timestamptz, date and time all became "timestamp"; numeric lost
 * its scale) and the executor choosing the SQL type from the kind and, for
 * text, from the name. Types are read back from the catalog here, with
 * format_type, exactly as PostgreSQL reports them.
 */

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { applyMigrationToMain } from '@/lib/mcp/apply-migration'

let ownerId: string
let projectId: string
let schema: string
const originalEngineMode = process.env.ENGINE_MODE
const originalEdition = process.env.BACKENLY_EDITION

async function typesOf(table: string): Promise<Record<string, string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string; type: string }>>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
    `"${schema}"."${table}"`,
  )
  return Object.fromEntries(rows.map((r) => [r.name, r.type]))
}

beforeAll(async () => {
  process.env.ENGINE_MODE = 'runtime'
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({
    data: { email: `declared-types-${crypto.randomUUID()}@example.test`, password: 'test-only-hash', name: 'declared types' },
  })).id
  const project = await createProvisionedProject({ name: 'declared-types', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })
}, 120_000)

afterAll(async () => {
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } })
    await prisma.user.delete({ where: { id: ownerId } })
  }
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
}, 60_000)

describe('CREATE TABLE creates every column with the type it declares', () => {
  let types: Record<string, string> = {}

  beforeAll(async () => {
    const created = await applyMigrationToMain(
      projectId,
      ownerId,
      `CREATE TABLE product_views (
         session_id text NOT NULL,
         stripe_customer_id text,
         sku_id varchar(40),
         viewed_at timestamptz NOT NULL DEFAULT now(),
         shipped_on date,
         opens_at time,
         price numeric(10,2),
         weight double precision,
         tags text[]
       )`,
      { workspaceSchema: schema, agentSurface: true },
    )
    expect(created.ok).toBe(true)
    types = await typesOf('product_views')
  }, 60_000)

  it('keeps a text column named like an id as text, so an external id can be stored', async () => {
    expect(types.session_id).toBe('text')
    expect(types.stripe_customer_id).toBe('text')
    expect(types.sku_id).toBe('character varying(40)')
    // The value production refused with 22P02.
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}".product_views (session_id) VALUES ('s1')`)
  })

  it('keeps time zones, dates and times apart', () => {
    expect(types.viewed_at).toBe('timestamp with time zone')
    expect(types.shipped_on).toBe('date')
    expect(types.opens_at).toBe('time without time zone')
  })

  it('keeps numeric scale, floating point and arrays', () => {
    expect(types.price).toBe('numeric(10,2)')
    expect(types.weight).toBe('double precision')
    expect(types.tags).toBe('text[]')
  })
})

describe('ALTER TABLE ADD COLUMN, the statement a merge replays', () => {
  it('adds a timestamptz column as timestamptz', async () => {
    const created = await applyMigrationToMain(projectId, ownerId, 'CREATE TABLE orders (total numeric(10,2))', {
      workspaceSchema: schema, agentSurface: true,
    })
    expect(created.ok).toBe(true)
    const added = await applyMigrationToMain(projectId, ownerId, 'ALTER TABLE orders ADD COLUMN refunded_at timestamptz', {
      workspaceSchema: schema, agentSurface: true,
    })
    expect(added.ok).toBe(true)
    expect((await typesOf('orders')).refunded_at).toBe('timestamp with time zone')
  }, 60_000)
})
