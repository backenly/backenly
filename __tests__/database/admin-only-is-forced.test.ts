/**
 * "ONLY SERVICE-ROLE KEYS CAN ACCESS THIS TABLE" HOLDS FOR THE TABLE'S OWNER TOO
 * =============================================================================
 * Backenly's own code reads workspace tables as the app role, which owns them,
 * with the end user's identity in the session: realtime decides which changes
 * a subscriber may receive that way (lib/realtime/visibility.ts). PostgreSQL
 * exempts a table's owner, and every member of the owning role, from row-level
 * security unless the table FORCEs it. Every template FORCEs it except
 * admin_only, so an end user subscribed to an admin_only table received every
 * change to it.
 *
 * Pinned with the real installer (applyPermissionPolicy) and the real
 * visibility check, run as a NOSUPERUSER NOBYPASSRLS role that is a member of
 * the owning role: the production premise. The SDK's database routes read the
 * same way (GET /api/v1/{projectId}/database/query), so the app's publishable
 * key is held to the rule there too. Tables installed before the fix are
 * brought in line by scripts/force-admin-only-tables.ts (forceAdminOnlyTables).
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

import '@/tests/helpers/real-web-standard'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { applyPermissionPolicy, forceAdminOnlyTables } from '@/lib/services/workspace-rls'
import { GET as queryRoute } from '@/app/api/v1/[projectId]/database/query/route'
import { mintKey } from '@/lib/auth/key-prefix'
import { hashApiKey } from '@/server/lib/end-user-identity'
import { visibleChange, type RealtimeSubscriber } from '@/lib/realtime/visibility'
import { jwtClaimFunctionSql, serviceRoleClause } from '@/lib/postgrest/rls-translation'

let ownerId = ''
let projectId = ''
let schema = ''
const alice = randomUUID()
const secret = randomUUID()

const as = (endUserId: string | null, serviceRole = false): RealtimeSubscriber => ({
  projectId, endUserId, endUserRole: endUserId ? 'user' : null, serviceRole,
})
const insert = () => ({ type: 'insert', table: 'payouts', data: { id: secret, amount: 1200 }, old: null, timestamp: 1 })

beforeAll(async () => {
  ownerId = (await prisma.user.create({ data: { email: `admin-only-${randomUUID()}@test.invalid`, name: 'Admin only' }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: `admin-only-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."payouts" (id uuid PRIMARY KEY, amount int)`)
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."payouts" (id, amount) VALUES ($1::uuid, 1200)`, secret)
  // One installed the way admin_only was before it forced row-level security.
  await prisma.$executeRawUnsafe(jwtClaimFunctionSql(schema))
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."ledger" (id uuid PRIMARY KEY, amount int)`)
  await prisma.$executeRawUnsafe(`ALTER TABLE "${schema}"."ledger" ENABLE ROW LEVEL SECURITY`)
  await prisma.$executeRawUnsafe(`CREATE POLICY backenly_admin_only ON "${schema}"."ledger" FOR ALL USING (${serviceRoleClause(schema)})`)

  const result = await applyPermissionPolicy(projectId, { tableName: 'payouts', template: 'admin_only' })
  expect(result.success).toBe(true)

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
  await prisma.permissionPolicy.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('admin_only tables installed before the fix', () => {
  const ledger = () => ({ type: 'insert', table: 'ledger', data: { id: secret, amount: 1 }, old: null, timestamp: 1 })

  it('are found, and only they', async () => {
    const found = await forceAdminOnlyTables(projectId, { apply: false })
    expect(found).toEqual([{ schema, tables: ['ledger'], forced: false }])
  })

  it('are forced, after which an end user receives none of their changes', async () => {
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."ledger" (id, amount) VALUES ($1::uuid, 1)`, secret)
    expect(await visibleChange(as(alice), ledger())).not.toBeNull()

    expect(await forceAdminOnlyTables(projectId, { apply: true })).toEqual([{ schema, tables: ['ledger'], forced: true }])
    expect(await visibleChange(as(alice), ledger())).toBeNull()
    expect(await forceAdminOnlyTables(projectId, { apply: false })).toEqual([])
  })
})

describe('admin_only', () => {
  it('forces row-level security, so the owning role is held to it', async () => {
    const [t] = await prisma.$queryRawUnsafe<Array<{ forced: boolean }>>(
      `SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid = to_regclass($1)`,
      `"${schema}"."payouts"`,
    )
    expect(t.forced).toBe(true)
  })

  it('sends a signed-in end user none of its changes', async () => {
    expect(await visibleChange(as(alice), insert())).toBeNull()
  })

  it('sends an anonymous subscriber none of its changes', async () => {
    expect(await visibleChange(as(null), insert())).toBeNull()
  })

  it('still sends a service-role subscriber every change', async () => {
    expect(await visibleChange(as(null, true), insert())).not.toBeNull()
  })
})

describe('the SDK\'s database route', () => {
  it('reads none of an admin_only table\'s rows with the app\'s publishable key', async () => {
    const minted = mintKey({ keyType: 'public', serviceRole: false })
    await prisma.apiKey.create({
      data: {
        name: 'browser', keyPrefix: minted.prefix, keyHash: hashApiKey(minted.key), keyType: 'public',
        serviceRole: false, permissions: ['read'], capabilities: ['database'], projectId, userId: ownerId,
      },
    })
    await prisma.table.create({ data: { name: 'payouts', projectId } })
    const res = await queryRoute(
      new NextRequest(`https://backenly.test/api/v1/${projectId}/database/query?table=payouts`, { headers: { 'x-api-key': minted.key } }),
      { params: Promise.resolve({ projectId }) },
    )
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).not.toContain(secret)
  })
})
