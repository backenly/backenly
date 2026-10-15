/**
 * db_query NEVER HANDS SECRET COLUMNS TO THE AGENT
 * ================================================
 * run_query redacts password/token/key-shaped columns because agent results
 * land in an LLM context, the host transcript and usage logs. db_query ran
 * `SELECT *` as the service role and returned the end-user `users` table —
 * bcrypt hashes included — verbatim (DB-03). The same applied to the rows
 * db_insert and db_update hand back via RETURNING *.
 *
 * All three now pass their results through the same redactRows the read door
 * uses: values replaced with "[redacted]" (never dropped, so the shape still
 * says the column exists) and the redacted column names surfaced.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { dbInsert, dbQuery, dbUpdate } from '@/lib/mcp/runtime-db'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

let ownerId = ''
let projectId = ''
let schema = ''
const HASH = '$2b$10$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvabcdefghiu'

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (
    await prisma.user.create({
      data: { email: `redact-${randomUUID()}@test.invalid`, name: 'Redaction Test' },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: `redact-${randomUUID().slice(0, 8)}`, userId: ownerId },
      select: { id: true },
    })
  ).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."users" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, "password" text NOT NULL)`,
  )
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."posts" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL)`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."users" (email, "password") VALUES ('end-user@test.invalid', '${HASH}')`,
  )
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."posts" (title) VALUES ('hello')`)
  // The metadata rows introspection back-fills — exactly how `users` becomes
  // visible to assertTable in production.
  for (const name of ['users', 'posts']) {
    await prisma.table.create({ data: { projectId, name, schema } })
  }
}, 120_000)

afterAll(async () => {
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
})

it('db_query on users returns the row with the hash replaced, and says which columns', async () => {
  const out: any = await dbQuery(projectId, { table: 'users' })
  expect(out.count).toBe(1)
  expect(out.rows[0].email).toBe('end-user@test.invalid')
  expect(out.rows[0].password).toBe('[redacted]')
  expect(JSON.stringify(out)).not.toContain(HASH)
  expect(out.redactedColumns).toContain('password')
}, 60_000)

it('db_insert and db_update RETURNING rows are redacted the same way', async () => {
  const ins: any = await dbInsert(projectId, {
    table: 'users',
    row: { email: 'second@test.invalid', password: HASH },
  })
  expect(ins.row.password).toBe('[redacted]')
  expect(ins.redactedColumns).toContain('password')

  const upd: any = await dbUpdate(projectId, {
    table: 'users',
    filter: { email: 'second@test.invalid' },
    patch: { password: `${HASH}x` },
  })
  expect(upd.updated).toBe(1)
  expect(upd.rows[0].password).toBe('[redacted]')
  expect(JSON.stringify(upd)).not.toContain(HASH)
}, 60_000)

it('a table without secret columns is untouched', async () => {
  const out: any = await dbQuery(projectId, { table: 'posts' })
  expect(out.rows[0].title).toBe('hello')
  expect(out.redactedColumns).toBeUndefined()
}, 60_000)
