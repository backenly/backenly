/**
 * Restore must never destroy a project and report success.
 *
 * It did. `restoreWorkspace` dropped the schema, recreated it, then fed in a
 * dump whose own first statement is `CREATE SCHEMA`. That collided, the
 * --single-transaction restore aborted, psql still exited 0 because
 * ON_ERROR_STOP was not set, and the function returned `{ success: true }`
 * over a schema it had just emptied. Observed on a cold install: 3 tables and
 * 5 rows before, 0 tables and a 404 data plane after, with a success response.
 *
 * The path had never run end to end — the audit found the backup API has zero
 * dashboard callers — so nothing caught it. These tests are that end.
 *
 * Real database, real pg_dump, real psql. Mocking any of the three would test
 * the mock: the defect lived in the interaction between the dump's contents
 * and psql's exit code.
 */
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Read at module load by the service, so it has to be set before the import.
const BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backenly-restore-test-'))
process.env.BACKUP_DIR = BACKUP_DIR

const ORIGINAL_EDITION = process.env.BACKENLY_EDITION
const DB_URL = process.env.TEST_DATABASE_URL

/** Cleanup is scoped to this file's own rows: suites share one database. */
function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) {
    throw new Error('Refusing: DATABASE_URL is not the test database')
  }
}

// require, not import: BACKUP_DIR above must be set before the service module
// evaluates, and import declarations hoist above it.
const { prisma } = require('@/lib/db/prisma')
const { backupWorkspace, restoreWorkspace } = require('@/lib/services/workspace-backup')

const createdUserIds: string[] = []
const createdProjectIds: string[] = []

async function makeProject(): Promise<string> {
  const u = await prisma.user.create({
    data: { email: `restore-${randomUUID()}@test.invalid`, name: 'Restore Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  const p = await prisma.project.create({
    data: { name: `restore-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  return p.id
}

const schemaOf = (projectId: string) => `workspace_${projectId}`

/** A workspace shaped like a real one: rows, an index, a constraint. */
async function seedWorkspace(projectId: string): Promise<void> {
  const s = schemaOf(projectId)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${s}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${s}".customers (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       email text NOT NULL UNIQUE,
       age int CHECK (age >= 0)
     )`
  )
  await prisma.$executeRawUnsafe(`CREATE INDEX idx_customers_age ON "${s}".customers(age)`)
  for (let i = 1; i <= 5; i++) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${s}".customers (email, age) VALUES ($1, $2)`,
      `user${i}@test.invalid`,
      20 + i,
    )
  }
}

async function relationCount(schema: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','p')`,
    schema,
  )
  return Number(rows[0].count)
}

async function rowCount(schema: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM "${schema}".customers`
  )
  return Number(rows[0].count)
}

async function indexCount(schema: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM pg_indexes WHERE schemaname = $1`,
    schema,
  )
  return Number(rows[0].count)
}

/** Schemas this file moved aside and did not clean up would mask a leak. */
async function asideSchemas(projectId: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ nspname: string }[]>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`,
    `${schemaOf(projectId)}_pre%`,
  )
  return rows.map((r) => r.nspname)
}

beforeAll(() => {
  assertSafeTestDatabase()
  // Deliberately NOT forcing an edition any more.
  //
  // These used to set BACKENLY_EDITION = 'cloud' because backupWorkspace
  // refused off Cloud. Snapshots are un-gated now, so leaving that line in
  // would mean this suite only ever exercised the Cloud path - and the
  // self-host path, which is the entire point of un-gating, would be the one
  // thing untested. The default edition is single-tenant, so this now runs as
  // a self-hosted install does.
})

afterAll(async () => {
  for (const id of createdProjectIds) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaOf(id)}" CASCADE`).catch(() => {})
    for (const aside of await asideSchemas(id).catch(() => [])) {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${aside}" CASCADE`).catch(() => {})
    }
  }
  await prisma.workspaceBackup.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {})
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true })

  if (ORIGINAL_EDITION === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = ORIGINAL_EDITION
  await prisma.$disconnect()
})

describe('restore round-trips a destroyed workspace', () => {
  it('brings back tables, rows and indexes after a destructive change', async () => {
    const projectId = await makeProject()
    const s = schemaOf(projectId)
    await seedWorkspace(projectId)

    const backup = await backupWorkspace(projectId)
    expect(backup.success).toBe(true)

    // Destroy: lose rows and the index.
    await prisma.$executeRawUnsafe(`DELETE FROM "${s}".customers WHERE age > 22`)
    await prisma.$executeRawUnsafe(`DROP INDEX "${s}".idx_customers_age`)
    expect(await rowCount(s)).toBe(2)

    const restored = await restoreWorkspace(projectId)
    expect(restored.success).toBe(true)

    // This is the assertion the old implementation would have failed: it
    // reported success with zero relations.
    expect(await relationCount(s)).toBeGreaterThan(0)
    expect(await rowCount(s)).toBe(5)
    // pkey + the unique on email + the dropped idx_customers_age, back again.
    expect(await indexCount(s)).toBe(3)
  }, 120_000)

  it('leaves no schema moved aside once it succeeds', async () => {
    const projectId = await makeProject()
    await seedWorkspace(projectId)
    expect((await backupWorkspace(projectId)).success).toBe(true)
    expect((await restoreWorkspace(projectId)).success).toBe(true)

    // The pre-restore copy is only safe to keep until the restore is verified.
    expect(await asideSchemas(projectId)).toEqual([])
  }, 120_000)
})

describe('a restore that cannot succeed must not report success', () => {
  it('returns success:false and keeps the original data when the archive is corrupt', async () => {
    const projectId = await makeProject()
    const s = schemaOf(projectId)
    await seedWorkspace(projectId)

    const backup = await backupWorkspace(projectId)
    expect(backup.success).toBe(true)

    // Truncate the gzip so decompression fails. The live schema must survive:
    // nothing may be destroyed before the archive is known to be readable.
    fs.writeFileSync(backup.filePath!, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]))

    const restored = await restoreWorkspace(projectId)
    expect(restored.success).toBe(false)
    expect(restored.error).toBeTruthy()

    expect(await relationCount(s)).toBeGreaterThan(0)
    expect(await rowCount(s)).toBe(5)
    expect(await asideSchemas(projectId)).toEqual([])
  }, 120_000)

  it('returns success:false when the dump restores nothing', async () => {
    const projectId = await makeProject()
    const s = schemaOf(projectId)
    await seedWorkspace(projectId)

    const backup = await backupWorkspace(projectId)
    expect(backup.success).toBe(true)

    // A syntactically valid archive that creates no relations. psql exits 0 on
    // this, which is exactly how the original defect reported success.
    const zlib = require('zlib')
    fs.writeFileSync(backup.filePath!, zlib.gzipSync(Buffer.from('SELECT 1;\n')))

    const restored = await restoreWorkspace(projectId)
    expect(restored.success).toBe(false)

    // And the project is still there.
    expect(await relationCount(s)).toBeGreaterThan(0)
    expect(await rowCount(s)).toBe(5)
    expect(await asideSchemas(projectId)).toEqual([])
  }, 120_000)
})
