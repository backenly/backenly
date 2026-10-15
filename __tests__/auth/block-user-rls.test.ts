/**
 * BLOCKING AN END USER MUST ACTUALLY FLIP THE ROW
 * ===============================================
 * The workspace `users` table is FORCE row-level security with an own-rows
 * policy: a query that carries no claims matches ZERO rows, table owner
 * included. `executeBlockUser` / `executeUnblockUser` ran their UPDATE as a
 * bare prisma call — no claims — so every real account answered "not found",
 * `is_blocked` never changed, and the blocked user kept signing in. That
 * includes the worst case: an agent's block_user parked for approval, a human
 * approving it on the Autonomy page, and the approval "executing" a no-op.
 *
 * Pinned here against a users table provisioned by the REAL pipeline
 * (`ensureAuthUsersTable`, which installs the policy):
 *
 *   - the FORCE-RLS premise holds (asserted, not assumed: a claimless UPDATE
 *     touches zero rows while the row exists)
 *   - BLOCK_USER through the real executor door flips is_blocked to true
 *   - UNBLOCK_USER flips it back
 *   - an unknown account is still reported honestly as not found
 *
 * Real database, the real executor, the real RLS session machinery.
 */

import { randomUUID } from 'crypto'

/**
 * Delegating record of every executeWithUserContext call. The fix IS the
 * claims path, and on a superuser connection the old bare-prisma UPDATE also
 * "works", so the row flip alone cannot catch a regression back to it. Nothing
 * is faked: every call runs the real implementation.
 */
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
import { executeAction } from '@/lib/ai/minimal-executor'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'
import { executeWithUserContext } from '@/lib/services/workspace-rls'

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
let schemaName = ''
const EMAIL = `blockee-${randomUUID().slice(0, 8)}@test.invalid`

async function serviceRows<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  return executeWithUserContext<T>('', true, sql, values)
}

beforeAll(async () => {
  assertSafeTestDatabase()
  const u = await prisma.user.create({
    data: { email: `block-${randomUUID()}@test.invalid`, name: 'Block Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  const p = await prisma.project.create({
    data: { name: `block-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  projectId = p.id
  schemaName = `workspace_${projectId}`

  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  // The real provisioning path: creates/heals the users table and installs the
  // own-rows FORCE policy. The requester email must not look like a verifier
  // account (@*.internal / @backenly-selftest.com), which may never provision.
  await ensureAuthUsersTable(projectId, { email: EMAIL })

  // The premise this whole suite exists for must HOLD, not be assumed: RLS is
  // enabled and forced on the table. If provisioning ever stops forcing it,
  // this suite must fail loudly rather than pass blindly.
  const [rls] = await prisma.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
    `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${schemaName}' AND c.relname = 'users'`
  )
  expect(rls).toBeDefined()
  expect(rls.relrowsecurity).toBe(true)
  expect(rls.relforcerowsecurity).toBe(true)

  await serviceRows(
    `INSERT INTO "${schemaName}"."users" (email, password) VALUES ($1, 'x') RETURNING id`,
    [EMAIL]
  )
}, 60000)

afterAll(async () => {
  if (schemaName) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {})
  }
  if (createdProjectIds.length) {
    await prisma.permissionPolicy.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.backendEvent.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.healthFinding.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

describe('the FORCE-RLS premise', () => {
  it('a claimless UPDATE matches zero rows while the account exists', async () => {
    // The local test connection may be a superuser, which bypasses RLS no
    // matter what the table says — production's app role is NOSUPERUSER
    // NOBYPASSRLS (the credential split). SET LOCAL ROLE to a non-superuser
    // member of the same role reproduces production binding on any connection.
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

    const bare = await prisma.$transaction(async (tx) => {
      if (who.rolsuper) await tx.$executeRawUnsafe(`SET LOCAL ROLE backenly_rls_premise`)
      return tx.$executeRawUnsafe(
        `UPDATE "${schemaName}"."users" SET is_blocked = FALSE WHERE "email" = $1`,
        EMAIL
      )
    })
    const viaService = await serviceRows<{ id: string }>(
      `SELECT id FROM "${schemaName}"."users" WHERE "email" = $1`,
      [EMAIL]
    )

    expect(viaService).toHaveLength(1)
    expect(bare).toBe(0)
  })

  it('BLOCK_USER runs its UPDATE through the service-role claims machinery', async () => {
    rlsCalls.length = 0
    try {
      await executeAction(
        { action: 'BLOCK_USER', params: { email: EMAIL, confirmed: true } } as any,
        projectId
      )
      const updateCall = rlsCalls.find(
        (c) => typeof c[2] === 'string' && /UPDATE .*users.* SET is_blocked = TRUE/.test(c[2] as string)
      )
      expect(updateCall).toBeDefined()
      expect(updateCall![0]).toBe('')
      expect(updateCall![1]).toBe(true)
    } finally {
      await executeAction(
        { action: 'UNBLOCK_USER', params: { email: EMAIL, confirmed: true } } as any,
        projectId
      )
    }
  })
})

describe('BLOCK_USER / UNBLOCK_USER through the real executor door', () => {
  it('blocks the account: reported success and the row really flipped', async () => {
    const result = await executeAction(
      { action: 'BLOCK_USER', params: { email: EMAIL, confirmed: true } } as any,
      projectId
    )

    expect(result.success).toBe(true)
    const [row] = await serviceRows<{ is_blocked: boolean }>(
      `SELECT is_blocked FROM "${schemaName}"."users" WHERE "email" = $1`,
      [EMAIL]
    )
    expect(row.is_blocked).toBe(true)
  })

  it('unblocks it again', async () => {
    const result = await executeAction(
      { action: 'UNBLOCK_USER', params: { email: EMAIL, confirmed: true } } as any,
      projectId
    )

    expect(result.success).toBe(true)
    const [row] = await serviceRows<{ is_blocked: boolean }>(
      `SELECT is_blocked FROM "${schemaName}"."users" WHERE "email" = $1`,
      [EMAIL]
    )
    expect(row.is_blocked).toBe(false)
  })

  it('still reports an unknown account as not found', async () => {
    const result = await executeAction(
      { action: 'BLOCK_USER', params: { email: `ghost-${randomUUID().slice(0, 8)}@test.invalid`, confirmed: true } } as any,
      projectId
    )

    expect(result.success).toBe(false)
    expect(result.message).toContain('not found')
  })
})
