/**
 * A schema call on the agent doors refuses instead of guessing
 * (medium finding DB-06).
 *
 * apply_migration already refused CREATE TABLE of an existing table and any
 * statement on a missing one. The typed create_table and add_column did not:
 * create_table on an existing table changed nothing and answered "Created",
 * and add_column on a missing table CREATED it, so an agent that mistyped
 * "porducts" got a stray one-column table and reported that it had changed
 * `products`. Both doors now apply apply_migration's rule, with its wording,
 * and a missing table names the closest existing one.
 */
import crypto from 'crypto'
import { Client } from 'pg'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'

let ownerId: string
let projectId: string
let schema: string

const call = (tool: string, args: Record<string, unknown>) =>
  dispatchTool(tool, args, { projectId, userId: ownerId, createdThisTurn: new Set<string>() } as any)

async function tables(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
    schema,
  )
  return rows.map((r) => r.table_name)
}

async function columns(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
    schema, table,
  )
  return rows.map((r) => r.column_name).sort()
}

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `db-doors-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'DB Doors Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({ data: { name: 'db-doors', userId: ownerId }, select: { id: true } })
  ).id
  schema = getWorkspaceDatabaseNames(projectId).postgresSchema
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  const created = await executeAction(
    { action: 'CREATE_TABLE', params: { tableName: 'products', columns: [{ name: 'title', type: 'text' }] } } as any,
    projectId, undefined, 0, undefined, false,
  )
  expect(created.success).toBe(true)
}, 120_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('DB-06: create_table and add_column refuse instead of guessing', () => {
  it('add_column on a mistyped table refuses, names the real one, and creates nothing', async () => {
    const before = await tables()
    const out = await call('add_column', { tableName: 'porducts', columnName: 'price', columnType: 'numeric' })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('TABLE_NOT_FOUND')
    expect(out.summary).toContain('Did you mean products?')
    expect(await tables()).toEqual(before)
    expect(await columns('products')).not.toContain('price')
  }, 60_000)

  it('a case-only mismatch is caught the same way', async () => {
    const out = await call('add_column', { tableName: 'Products', columnName: 'price', columnType: 'numeric' })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('TABLE_NOT_FOUND')
    expect(out.summary).toContain('Did you mean products?')
  }, 60_000)

  it('create_table of an existing table refuses and changes nothing', async () => {
    const before = await columns('products')
    const out = await call('create_table', { tableName: 'products', columns: [{ name: 'sku', type: 'text' }] })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('TABLE_EXISTS')
    expect(out.summary).toContain('Nothing was created')
    expect(await columns('products')).toEqual(before)
  }, 60_000)

  it('the honest calls still work (control)', async () => {
    const added = await call('add_column', { tableName: 'products', columnName: 'price', columnType: 'numeric' })
    expect(added.ok).toBe(true)
    expect(await columns('products')).toContain('price')
    const fresh = await call('create_table', { tableName: 'orders', columns: [{ name: 'total', type: 'numeric' }] })
    expect(fresh.ok).toBe(true)
    expect(await tables()).toContain('orders')
  }, 120_000)
})

describe('the doors read a regional project’s tables in its region', () => {
  // A project in another region keeps its tables only in that region's
  // database; the home database holds no schema for it. A second database
  // stands in for us-east-1, as in project-region.spec.ts.
  const REGION_VARIABLE = 'DATABASE_URL_US_EAST_1'
  const REGIONAL_DB = `backenly_region_${crypto.randomBytes(4).toString('hex')}`
  let regionalProject = ''
  let regionalDbCreated = false

  function urlFor(database: string): string {
    const url = new URL(process.env.DATABASE_URL as string)
    url.pathname = `/${database}`
    return url.toString()
  }

  async function run(connectionString: string, sql: string): Promise<void> {
    const client = new Client({ connectionString })
    await client.connect()
    try {
      await client.query(sql)
    } finally {
      await client.end().catch(() => {})
    }
  }

  const callRegional = (tool: string, args: Record<string, unknown>) =>
    dispatchTool(tool, args, { projectId: regionalProject, userId: ownerId, createdThisTurn: new Set<string>() } as any)

  beforeAll(async () => {
    regionalProject = (
      await prisma.project.create({ data: { name: 'db-doors-region', userId: ownerId, region: 'us-east-1' }, select: { id: true } })
    ).id
    await run(process.env.DATABASE_URL as string, `CREATE DATABASE "${REGIONAL_DB}"`)
    regionalDbCreated = true
    const regionalSchema = getWorkspaceDatabaseNames(regionalProject).postgresSchema
    await run(urlFor(REGIONAL_DB), `CREATE SCHEMA "${regionalSchema}"; CREATE TABLE "${regionalSchema}".customers (name text)`)
    process.env[REGION_VARIABLE] = urlFor(REGIONAL_DB)
  }, 60_000)

  afterAll(async () => {
    delete process.env[REGION_VARIABLE]
    await disconnectRegionalClients()
    if (regionalDbCreated) {
      await run(process.env.DATABASE_URL as string, `DROP DATABASE IF EXISTS "${REGIONAL_DB}" WITH (FORCE)`).catch(() => {})
    }
    await prisma.project.deleteMany({ where: { id: regionalProject } }).catch(() => {})
  }, 60_000)

  it('create_table of a table that exists only in the region is refused', async () => {
    const out = await callRegional('create_table', { tableName: 'customers', columns: [{ name: 'email', type: 'text' }] })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('TABLE_EXISTS')
  }, 60_000)

  it('a mistyped name is answered with the regional table it meant', async () => {
    const out = await callRegional('add_column', { tableName: 'customer', columnName: 'email', columnType: 'text' })
    expect(out.ok).toBe(false)
    expect(out.code).toBe('TABLE_NOT_FOUND')
    expect(out.summary).toContain('Did you mean customers?')
  }, 60_000)
})
