/**
 * SCHEMA SNAPSHOTS HOLD THE SCHEMA, AND ROLLBACK TELLS THE TRUTH
 * ==============================================================
 * `snapshotSchema` round-tripped the live schema through a human-formatted
 * string and a parser expecting `Table:` / `FK:` lines that format never
 * contained. Every snapshot therefore stored ZERO tables: the History panel's
 * snapshot view was always empty, and `rollbackToVersion` diffed two empty
 * sets, dropped nothing, and reported "Rolled back to schema vN. Dropped 0
 * table(s)." as a success — a no-op presented as a restore.
 *
 * Pinned here against a real workspace schema:
 *
 *   - a snapshot captures the real tables, columns (type/nullable/unique/
 *     default) and foreign keys, straight from the catalog
 *   - rollback drops a table and a column added after the target version,
 *     and says exactly what it dropped
 *   - rollback never drops the auth-managed users table
 *   - a rollback that cannot restore dropped structure says so and FAILS,
 *     instead of claiming success
 *   - a no-diff rollback says "nothing to roll back"
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { snapshotSchema, getSchemaVersion, rollbackToVersion } from '@/lib/versioning/schema-versions'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const createdUserIds: string[] = []
const createdProjectIds: string[] = []
let projectId = ''
let schema = ''

async function tableNames(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
    schema
  )
  return rows.map((r) => r.table_name)
}

async function columnsOf(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    schema,
    table
  )
  return rows.map((r) => r.column_name)
}

beforeAll(async () => {
  assertSafeTestDatabase()
  const u = await prisma.user.create({
    data: { email: `svs-${randomUUID()}@test.invalid`, name: 'Schema Versions Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  const p = await prisma.project.create({
    data: { name: `svs-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  projectId = p.id
  schema = `workspace_${projectId}`

  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."authors" (id uuid primary key default gen_random_uuid(), email text unique not null)`
  )
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."posts" (
       id uuid primary key default gen_random_uuid(),
       author_id uuid references "${schema}"."authors"(id),
       title text not null
     )`
  )
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."users" (id uuid primary key, email text)`)
}, 60000)

afterAll(async () => {
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (createdProjectIds.length) {
    await prisma.schemaVersion.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

describe('snapshotSchema', () => {
  it('captures the real tables, columns and foreign keys', async () => {
    const versionId = await snapshotSchema(projectId, 'baseline', 'test')
    const version = await getSchemaVersion(versionId, projectId)

    const names = version!.snapshot.tables.map((t) => t.name).sort()
    expect(names).toEqual(['authors', 'posts', 'users'])

    const posts = version!.snapshot.tables.find((t) => t.name === 'posts')!
    expect(posts.columns.map((c) => c.name).sort()).toEqual(['author_id', 'id', 'title'])
    expect(posts.columns.find((c) => c.name === 'title')).toMatchObject({ type: 'text', nullable: false })
    expect(posts.foreignKeys).toContainEqual({
      column: 'author_id',
      referencesTable: 'authors',
      referencesColumn: 'id',
    })

    const authors = version!.snapshot.tables.find((t) => t.name === 'authors')!
    expect(authors.columns.find((c) => c.name === 'email')).toMatchObject({ nullable: false, unique: true })
    expect(authors.columns.find((c) => c.name === 'id')?.default).toContain('gen_random_uuid')
  })
})

describe('rollbackToVersion', () => {
  it('drops the table and the column added after the target, and says exactly that', async () => {
    const baseline = await snapshotSchema(projectId, 'before changes', 'test')
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."drafts" (id serial primary key)`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."posts" ADD COLUMN subtitle text`)

    const result = await rollbackToVersion(projectId, baseline)

    expect(result.success).toBe(true)
    expect(result.message).toContain('Dropped 1 table(s) and 1 column(s)')
    expect(await tableNames()).toEqual(['authors', 'posts', 'users'])
    expect(await columnsOf('posts')).not.toContain('subtitle')
  })

  it('never drops the auth-managed users table, even when the target lacks it', async () => {
    // A hand-made target shaped like a project before auth was provisioned.
    const versionId = await snapshotSchema(projectId, 'with users', 'test')
    const version = await getSchemaVersion(versionId, projectId)
    const withoutUsers = {
      ...version!.snapshot,
      tables: version!.snapshot.tables.filter((t) => t.name !== 'users'),
    }
    await prisma.schemaVersion.update({ where: { id: versionId }, data: { snapshot: withoutUsers as any } })

    const result = await rollbackToVersion(projectId, versionId)

    expect(await tableNames()).toContain('users')
    expect(result.statementsExecuted.join(' ')).not.toContain('"users"')
  })

  it('a rollback that cannot restore dropped structure fails and names it', async () => {
    const baseline = await snapshotSchema(projectId, 'before drop', 'test')
    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."posts" DROP COLUMN title`)

    const result = await rollbackToVersion(projectId, baseline)

    expect(result.success).toBe(false)
    expect(result.message).toContain('INCOMPLETE')
    expect(result.message).toContain('posts.title')
    expect(result.message).toContain('Snapshot')

    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."posts" ADD COLUMN title text`)
  })

  it('a no-diff rollback says there is nothing to roll back', async () => {
    const versionId = await snapshotSchema(projectId, 'steady state', 'test')

    const result = await rollbackToVersion(projectId, versionId)

    expect(result.success).toBe(true)
    expect(result.statementsExecuted).toEqual([])
    expect(result.message).toContain('nothing to roll back')
  })
})
