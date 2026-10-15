/**
 * ENABLE_REALTIME TELLS THE TRUTH
 * ===============================
 * `realtime {action:'enable'}` answered "✅ Realtime active" in three cases
 * where nothing streamed:
 *
 *   - the CREATE TRIGGER failed (table missing, or wrong case — the DDL quotes
 *     identifiers), reported only as a footnote under the success banner
 *   - the table was silently REFUSED (internal `_` tables; the auth-managed
 *     `users` table, whose rows carry credentials) — the refusal was a bare
 *     `return`, so the executor listed the table under "Enabled by this call"
 *   - a project-wide call on a project with no tables: "Realtime active for
 *     0 table(s)"
 *
 * The agent then told its user the app was live-streaming, the app subscribed,
 * and nothing ever arrived. Pinned here against a real schema, real triggers
 * and the real catalog read-back:
 *
 *   - enabling a real table installs a trigger the catalog can see
 *   - a wrong-case / missing table is a FAILURE with a code, not a footnote
 *   - the users table is a REFUSAL with the reason, and carries no trigger
 *   - project-wide: users is skipped-with-reason, real tables stream
 *   - an empty project is told plainly that nothing was installed
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'

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

async function fixtureProject(): Promise<{ projectId: string; schema: string }> {
  const u = await prisma.user.create({
    data: { email: `rte-${randomUUID()}@test.invalid`, name: 'Realtime Honesty Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  const p = await prisma.project.create({
    data: { name: `rte-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  const schema = `workspace_${p.id}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  return { projectId: p.id, schema }
}

async function triggerOn(schema: string, table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
    `SELECT t.tgname FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = 'backenly_realtime'`,
    schema,
    table
  )
  return rows.length > 0
}

const enable = (projectId: string, tableName?: string) =>
  executeAction(
    { action: 'ENABLE_REALTIME', params: { ...(tableName ? { tableName } : {}), confirmed: true } } as any,
    projectId
  )

beforeAll(() => {
  assertSafeTestDatabase()
})

afterAll(async () => {
  for (const id of createdProjectIds) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "workspace_${id}" CASCADE`).catch(() => {})
  }
  if (createdProjectIds.length) {
    await prisma.backendEvent.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

describe('single table', () => {
  it('enables a real table and the catalog shows the trigger', async () => {
    const f = await fixtureProject()
    await prisma.$executeRawUnsafe(`CREATE TABLE "${f.schema}"."posts" (id serial primary key, title text)`)

    const result = await enable(f.projectId, 'posts')

    expect(result.success).toBe(true)
    expect(result.message).toContain('Realtime active')
    expect(await triggerOn(f.schema, 'posts')).toBe(true)
  })

  it('a wrong-case table is a failure with a code, never an active banner', async () => {
    const f = await fixtureProject()
    await prisma.$executeRawUnsafe(`CREATE TABLE "${f.schema}"."messages" (id serial primary key)`)

    const result = await enable(f.projectId, 'Messages')

    expect(result.success).toBe(false)
    expect(result.error).toBe('REALTIME_TABLE_NOT_FOUND')
    expect(result.message).not.toContain('Realtime active')
    expect((result.data as any)?.enabled).toBe(false)
  })

  it('the auth-managed users table is a refusal with the reason, and gets no trigger', async () => {
    const f = await fixtureProject()
    await prisma.$executeRawUnsafe(`CREATE TABLE "${f.schema}"."users" (id serial primary key, email text, password text)`)

    const result = await enable(f.projectId, 'users')

    expect(result.success).toBe(false)
    expect(result.error).toBe('REALTIME_TABLE_REFUSED')
    expect(result.message).toContain('auth-managed')
    expect(await triggerOn(f.schema, 'users')).toBe(false)
  })
})

describe('project-wide', () => {
  it('streams the real tables, skips users with its reason, and says so', async () => {
    const f = await fixtureProject()
    await prisma.$executeRawUnsafe(`CREATE TABLE "${f.schema}"."orders" (id serial primary key)`)
    await prisma.$executeRawUnsafe(`CREATE TABLE "${f.schema}"."users" (id serial primary key, email text, password text)`)

    const result = await enable(f.projectId)

    expect(result.success).toBe(true)
    expect((result.data as any)?.enabledNow).toEqual(['orders'])
    expect(await triggerOn(f.schema, 'orders')).toBe(true)
    expect(await triggerOn(f.schema, 'users')).toBe(false)
    expect(result.message).toContain('auth-managed')
    // The old answer listed `users` under "Enabled by this call". Scope the
    // check to that section: `users` legitimately appears later under Skipped.
    const enabledSection = String(result.message).match(/\*\*Enabled by this call:\*\*\n([^*]*)/)?.[1] ?? ''
    expect(enabledSection).toContain('`orders`')
    expect(enabledSection).not.toContain('`users`')
  })

  it('an empty project is told nothing was installed, not "active for 0 table(s)"', async () => {
    const f = await fixtureProject()

    const result = await enable(f.projectId)

    expect(result.success).toBe(true)
    expect(result.message).toContain('No realtime triggers were installed')
    expect(result.message).not.toContain('Realtime active')
    expect((result.data as any)?.enabledNow).toEqual([])
  })
})
