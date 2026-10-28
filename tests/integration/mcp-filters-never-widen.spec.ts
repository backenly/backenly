/**
 * AN MCP FILTER IS APPLIED WHOLE OR REFUSED, NEVER WIDENED
 * ========================================================
 * db_update and db_delete run as the service role, past every RLS policy.
 * Their filter was built condition by condition, and a condition it could not
 * build was skipped: an invalid column name, an operator it did not know
 * ({ $eq: 3 }, or gt without its $), an empty or non-list $in, and on a json
 * column any object (its keys were read as operators). Whatever conditions
 * remained then chose the rows, so `{ done: false, qty: { $eq: 3 } }` updated
 * or deleted every row not done. $ne: null compared with `!= NULL` and
 * matched nothing.
 *
 * The filter is now built by whereConditions (lib/api/v1/where.ts), the
 * builder both v1 data servers use: each condition applies, or the call is
 * refused before anything runs.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { dbDelete, dbQuery, dbUpdate } from '@/lib/mcp/runtime-db'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const OWNER = randomUUID()
let ownerId = ''
let projectId = ''
let schema = ''

/** Every row as it stands, to see that a refused call changed nothing. */
const snapshot = () =>
  prisma.$queryRawUnsafe<Array<{ title: string; qty: number | null; done: boolean }>>(
    `SELECT title, qty, done FROM "${schema}".items ORDER BY title`,
  )

/** Three rows: two not done, one owned, one with a json document. */
async function seed(): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE "${schema}".items`)
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}".items (title, qty, done, owner_id, meta) VALUES
       ('alpha', 3, false, $1::uuid, '{"mode": "dark"}'),
       ('beta',  5, false, NULL,     '{"mode": "light"}'),
       ('gamma', 3, true,  NULL,     NULL)`,
    OWNER,
  )
}

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `mcp-filters-${randomUUID()}@test.invalid`, name: 'MCP filters fixture' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `mcp-filters-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}".items (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       title text NOT NULL UNIQUE,
       qty integer,
       done boolean NOT NULL DEFAULT false,
       owner_id uuid,
       meta jsonb
     )`,
  )
  await prisma.table.create({ data: { projectId, name: 'items', schema } })
}, 120_000)

beforeEach(seed)

afterAll(async () => {
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

// Each beside a condition that alone would choose rows, as a skipped one left it.
const UNAPPLIABLE: Array<[string, Record<string, unknown>]> = [
  ['an invalid column name', { done: false, 'title; --': 'alpha' }],
  ['an operator it does not know', { done: false, qty: { $eq: 3 } }],
  ['an operator without its $', { done: false, qty: { gt: 4 } }],
  ['an operator object naming nothing', { done: false, qty: {} }],
  ['an $in that is not a list', { done: false, qty: { $in: 3 } }],
]

describe.each(UNAPPLIABLE)('a filter with %s', (_label, filter) => {
  it('is refused by db_update, and no row changes', async () => {
    const before = await snapshot()
    await expect(dbUpdate(projectId, { table: 'items', filter, patch: { qty: 99 } })).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('is refused by db_delete, and no row changes', async () => {
    const before = await snapshot()
    await expect(dbDelete(projectId, { table: 'items', filter })).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('is refused by db_query', async () => {
    await expect(dbQuery(projectId, { table: 'items', filter })).rejects.toThrow()
  })
})

it('an empty $in matches no row, so db_delete removes none', async () => {
  const before = await snapshot()
  expect(await dbDelete(projectId, { table: 'items', filter: { done: false, qty: { $in: [] } } })).toEqual({ deleted: 0 })
  expect(await snapshot()).toEqual(before)
})

it('an object on a json column is compared whole, not read as operators', async () => {
  expect(await dbUpdate(projectId, { table: 'items', filter: { meta: { mode: 'dark' } }, patch: { qty: 7 } }))
    .toMatchObject({ updated: 1 })
  expect(await snapshot()).toEqual([
    { title: 'alpha', qty: 7, done: false },
    { title: 'beta', qty: 5, done: false },
    { title: 'gamma', qty: 3, done: true },
  ])
})

it('$ne: null matches the rows with a value', async () => {
  const out = await dbQuery(projectId, { table: 'items', filter: { owner_id: { $ne: null } } })
  expect(out.rows.map((row: any) => row.title)).toEqual(['alpha'])
})

it('a range on one column applies both bounds', async () => {
  expect(await dbDelete(projectId, { table: 'items', filter: { qty: { $gt: 2, $lt: 5 }, done: false } })).toEqual({ deleted: 1 })
  expect((await snapshot()).map((row) => row.title)).toEqual(['beta', 'gamma'])
})

it('every MCP operator still applies', async () => {
  const titles = async (filter: Record<string, unknown>) =>
    ((await dbQuery(projectId, { table: 'items', filter, orderBy: { title: 'asc' } })).rows as any[]).map((row) => row.title)
  expect(await titles({ qty: { $gte: 5 } })).toEqual(['beta'])
  expect(await titles({ qty: { $lte: 3 } })).toEqual(['alpha', 'gamma'])
  expect(await titles({ qty: { $ne: 3 } })).toEqual(['beta'])
  expect(await titles({ qty: { $in: [5, 9] } })).toEqual(['beta'])
  expect(await titles({ title: { $contains: 'amm' } })).toEqual(['gamma'])
  expect(await titles({ title: { $ilike: 'AL%' } })).toEqual(['alpha'])
  expect(await titles({ owner_id: OWNER })).toEqual(['alpha'])
  expect(await titles({ meta: null })).toEqual(['gamma'])
})

it('a json column takes a $ operator, and refuses one mixed with plain keys', async () => {
  const titles = async (filter: Record<string, unknown>) =>
    ((await dbQuery(projectId, { table: 'items', filter, orderBy: { title: 'asc' } })).rows as any[]).map((row) => row.title)
  // != {"mode":"dark"}: beta's document differs; gamma's NULL compares as unknown.
  expect(await titles({ meta: { $ne: { mode: 'dark' } } })).toEqual(['beta'])
  const before = await snapshot()
  await expect(dbDelete(projectId, { table: 'items', filter: { done: false, meta: { $ne: { mode: 'dark' }, mode: 'x' } } })).rejects.toThrow(/Unknown filter "mode"/)
  expect(await snapshot()).toEqual(before)
})

it('a key only an object prototype has is no operator, and is refused by its own name', async () => {
  const before = await snapshot()
  await expect(dbDelete(projectId, { table: 'items', filter: { done: false, qty: { constructor: 1 } } })).rejects.toThrow(/Unknown filter "constructor"/)
  expect(await snapshot()).toEqual(before)
})
