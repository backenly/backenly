/**
 * A REALTIME SUBSCRIBER RECEIVES ONLY ROWS IT COULD READ
 * =====================================================
 * lib/realtime/visibility.ts decides each change against real row-level
 * security: the row is selected again by its primary key, under the
 * subscriber's own identity, in the project's database. Pinned here with a
 * real own-rows policy (the same predicate the platform installs), real rows
 * for two end users, and the live checks:
 *
 *   alice     her own row's insert and update; never bob's
 *   anonymous neither (own-rows matches no one without an identity)
 *   service   both, as sent
 *   delete    the primary key only, whoever subscribes
 *   a table with no primary key: nothing for a non-service subscriber
 *
 * The production app role is NOSUPERUSER NOBYPASSRLS. When this suite's
 * connection is a superuser (CI's), each check runs under such a role, so the
 * policy decides as it does in production; the check's SQL is the real one.
 */

import { randomUUID } from 'crypto'

const mockPremise = { role: '' }
jest.mock('@/lib/services/workspace-rls', () => {
  const actual = jest.requireActual('@/lib/services/workspace-rls')
  return {
    ...actual,
    executeWithUserContext: async (projectId: string, userId: string, isServiceRole: boolean, sql: string, values: unknown[] = [], userRole = 'user') => {
      if (!mockPremise.role) return actual.executeWithUserContext(projectId, userId, isServiceRole, sql, values, userRole)
      const { prisma: db } = jest.requireActual('@/lib/db/prisma')
      const { rlsSessionSql, rlsSessionParams } = jest.requireActual('@/lib/services/rls-session')
      return db.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${mockPremise.role}`)
        await tx.$executeRawUnsafe(rlsSessionSql(), ...rlsSessionParams({ userId, isServiceRole, userRole }))
        return tx.$queryRawUnsafe(sql, ...values)
      })
    },
  }
})

import { prisma } from '@/lib/db/prisma'
import { jwtClaimFunctionSql, ownRowsPredicate } from '@/lib/postgrest/rls-translation'
import { visibleChange, type RealtimeSubscriber } from '@/lib/realtime/visibility'

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
const alice = randomUUID()
const bob = randomUUID()
const aliceNote = randomUUID()
const bobNote = randomUUID()

const as = (endUserId: string | null, serviceRole = false): RealtimeSubscriber => ({
  projectId, endUserId, endUserRole: endUserId ? 'user' : null, serviceRole,
})
const change = (type: string, table: string, data: Record<string, unknown>, old: Record<string, unknown> | null = null) => ({
  type, table, data, old, timestamp: 1,
})

beforeAll(async () => {
  assertSafeTestDatabase()
  ownerId = (await prisma.user.create({ data: { email: `rt-vis-${randomUUID()}@test.invalid`, name: 'Realtime Visibility' }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: `rt-vis-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  schema = `workspace_${projectId}`

  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."notes" (id uuid PRIMARY KEY, owner_id text, body text)`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."keyless" (owner_id text, body text)`)
  await prisma.$executeRawUnsafe(jwtClaimFunctionSql(schema))
  for (const table of ['notes', 'keyless']) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."${table}" ENABLE ROW LEVEL SECURITY`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."${table}" FORCE ROW LEVEL SECURITY`)
    const pred = ownRowsPredicate(schema, 'owner_id')
    await prisma.$executeRawUnsafe(`CREATE POLICY own_rows ON "${schema}"."${table}" FOR ALL USING (${pred}) WITH CHECK (${pred})`)
  }
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."notes" (id, owner_id, body) VALUES ($1::uuid, $2, 'alice private'), ($3::uuid, $4, 'bob private')`, aliceNote, alice, bobNote, bob)
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."keyless" (owner_id, body) VALUES ($1, 'alice keyless')`, alice)

  const [who] = await prisma.$queryRawUnsafe<Array<{ rolsuper: boolean; user: string }>>(
    `SELECT rolsuper, current_user AS "user" FROM pg_roles WHERE rolname = current_user`,
  )
  if (who.rolsuper) {
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_rls_premise') THEN
          CREATE ROLE backenly_rls_premise NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$`)
    await prisma.$executeRawUnsafe(`GRANT "${who.user}" TO backenly_rls_premise`)
    mockPremise.role = 'backenly_rls_premise'
  }
}, 60_000)

afterAll(async () => {
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('inserts and updates', () => {
  it("deliver alice's own row to alice, and never bob's", async () => {
    const own = await visibleChange(as(alice), change('insert', 'notes', { id: aliceNote, owner_id: alice, body: 'alice private' }))
    const other = await visibleChange(as(alice), change('insert', 'notes', { id: bobNote, owner_id: bob, body: 'bob private' }))
    expect(own).toMatchObject({ data: { id: aliceNote, body: 'alice private' } })
    expect(other).toBeNull()
  })

  it('deliver nothing to an anonymous stream under an own-rows policy', async () => {
    expect(await visibleChange(as(null), change('insert', 'notes', { id: aliceNote, owner_id: alice, body: 'alice private' }))).toBeNull()
  })

  it('deliver an update of her row with its old values reduced to the key', async () => {
    const out = await visibleChange(
      as(alice),
      change('update', 'notes', { id: aliceNote, owner_id: alice, body: 'alice edited' }, { id: aliceNote, owner_id: alice, body: 'alice private' }),
    )
    expect(out).toMatchObject({ data: { body: 'alice edited' }, old: { id: aliceNote } })
    expect(JSON.stringify(out?.old)).not.toContain('alice private')
  })

  it('deliver every row to a service-role stream', async () => {
    const out = await visibleChange(as(null, true), change('insert', 'notes', { id: bobNote, owner_id: bob, body: 'bob private' }))
    expect(out).toMatchObject({ data: { body: 'bob private' } })
  })
})

describe('deletes and tables without a key', () => {
  it('reduce a delete to its primary key for any subscriber', async () => {
    const out = await visibleChange(as(alice), change('delete', 'notes', { id: bobNote, owner_id: bob, body: 'bob private' }))
    expect(out).toMatchObject({ type: 'delete', data: { id: bobNote } })
    expect(JSON.stringify(out)).not.toContain('bob private')
  })

  it('deliver nothing from a table without a primary key, even a row the subscriber owns', async () => {
    expect(await visibleChange(as(alice), change('insert', 'keyless', { owner_id: alice, body: 'alice keyless' }))).toBeNull()
  })
})
