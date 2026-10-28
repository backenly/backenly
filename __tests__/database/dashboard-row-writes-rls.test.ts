/**
 * DASHBOARD ROW WRITES WORK ON THE TABLES THE AGENT SECURED
 * =========================================================
 * `getTableRows` was fixed to read as the owner because FORCE row-level
 * security hides every row from a claimless query under the production app
 * role (NOSUPERUSER NOBYPASSRLS). The WRITE methods on the same class were
 * not: insertRow / updateRow / deleteRow ran bare `prisma.$queryRawUnsafe`,
 * so on every policied table the dashboard's own Insert/Edit/Delete buttons
 * failed or silently touched nothing — the better the agent's RLS, the more
 * broken the console's data grid.
 *
 * Pinned here against a table carrying the REAL policy shape (the same
 * claim-function and own-rows predicate set_rls installs):
 *
 *   - the premise, under production conditions: a claimless INSERT is refused
 *     once a non-superuser role is in effect
 *   - insert / update / delete through PostgresService all work and are
 *     visible to a service-role read
 *   - the mechanism pin: each write goes through executeWithUserContext
 *     ('', true, …) — the regression signal that holds even on a superuser
 *     connection, where a bare write would deceptively succeed
 */

import { randomUUID } from 'crypto'

/** Delegating record of every executeWithUserContext call — nothing is faked. */
const rlsCalls: unknown[][] = []
jest.mock('@/lib/services/workspace-rls', () => {
  const actual = jest.requireActual('@/lib/services/workspace-rls')
  return {
    ...actual,
    executeWithUserContext: (...args: unknown[]) => {
      rlsCalls.push(args)
      return (actual.executeWithUserContext as (...a: unknown[]) => unknown)(...args)
    },
  }
})

import { prisma } from '@/lib/db/prisma'
import { PostgresService } from '@/lib/db/hybrid'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { jwtClaimFunctionSql, ownRowsPredicate } from '@/lib/postgrest/rls-translation'

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

beforeAll(async () => {
  assertSafeTestDatabase()
  const u = await prisma.user.create({
    data: { email: `drw-${randomUUID()}@test.invalid`, name: 'Row Writes Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  const p = await prisma.project.create({
    data: { name: `drw-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  projectId = p.id
  schema = `workspace_${p.id}`

  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."notes" (
       id uuid primary key default gen_random_uuid(),
       owner_id text,
       title text,
       "createdAt" timestamptz default now(),
       "updatedAt" timestamptz default now()
     )`
  )
  // The REAL policy machinery: the per-schema claim function set_rls installs,
  // FORCE RLS, and the own-rows predicate with its service-role escape.
  await prisma.$executeRawUnsafe(jwtClaimFunctionSql(schema))
  await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."notes" ENABLE ROW LEVEL SECURITY`)
  await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."notes" FORCE ROW LEVEL SECURITY`)
  const pred = ownRowsPredicate(schema, 'owner_id')
  await prisma.$executeRawUnsafe(
    `CREATE POLICY own_rows ON "${schema}"."notes" FOR ALL USING (${pred}) WITH CHECK (${pred})`
  )
}, 60000)

afterAll(async () => {
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (createdProjectIds.length) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

const serviceSelect = (title: string) =>
  executeWithUserContext<{ id: string; title: string }>(
    projectId,
    '',
    true,
    `SELECT id, title FROM "${schema}"."notes" WHERE title = $1`,
    [title]
  )

describe('the FORCE-RLS premise', () => {
  it('a claimless INSERT is refused once a non-superuser role is in effect', async () => {
    const [who] = await prisma.$queryRawUnsafe<Array<{ rolsuper: boolean; user: string }>>(
      `SELECT rolsuper, current_user AS "user" FROM pg_roles WHERE rolname = current_user`
    )
    if (who.rolsuper) {
      await prisma.$executeRawUnsafe(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_rls_premise') THEN
            CREATE ROLE backenly_rls_premise NOSUPERUSER NOBYPASSRLS;
          END IF;
        END $$`)
      await prisma.$executeRawUnsafe(`GRANT "${who.user}" TO backenly_rls_premise`)
    }

    await expect(
      prisma.$transaction(async (tx) => {
        if (who.rolsuper) await tx.$executeRawUnsafe(`SET LOCAL ROLE backenly_rls_premise`)
        return tx.$executeRawUnsafe(
          `INSERT INTO "${schema}"."notes" (title) VALUES ($1)`,
          'claimless'
        )
      })
    ).rejects.toThrow(/row-level security|row level security/i)
  })
})

describe('dashboard row writes through PostgresService', () => {
  it('insertRow inserts, and did it through the service-role claims machinery', async () => {
    rlsCalls.length = 0

    const row = await PostgresService.insertRow(projectId, schema, 'notes', { title: 'first note' })

    expect(row?.title).toBe('first note')
    expect(await serviceSelect('first note')).toHaveLength(1)
    const call = rlsCalls.find((c) => typeof c[3] === 'string' && (c[3] as string).startsWith('INSERT INTO'))
    expect(call).toBeDefined()
    // Named by project, so the write runs on the database in its region.
    expect(call![0]).toBe(projectId)
    expect(call![1]).toBe('')
    expect(call![2]).toBe(true)
  })

  it('updateRow updates the row it names', async () => {
    const [existing] = await serviceSelect('first note')
    rlsCalls.length = 0

    const updated = await PostgresService.updateRow(projectId, schema, 'notes', existing.id, { title: 'renamed note' })

    expect(updated?.title).toBe('renamed note')
    expect(await serviceSelect('renamed note')).toHaveLength(1)
    const call = rlsCalls.find((c) => typeof c[3] === 'string' && (c[3] as string).startsWith('UPDATE'))
    expect(call?.[0]).toBe(projectId)
    expect(call?.[2]).toBe(true)
  })

  it('deleteRow removes it', async () => {
    const [existing] = await serviceSelect('renamed note')
    rlsCalls.length = 0

    const gone = await PostgresService.deleteRow(projectId, schema, 'notes', existing.id)

    expect(gone).toBe(true)
    expect(await serviceSelect('renamed note')).toHaveLength(0)
    const call = rlsCalls.find((c) => typeof c[3] === 'string' && (c[3] as string).startsWith('DELETE'))
    expect(call?.[0]).toBe(projectId)
    expect(call?.[2]).toBe(true)
  })
})
