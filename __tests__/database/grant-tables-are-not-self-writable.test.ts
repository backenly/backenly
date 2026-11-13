/**
 * A ROW THAT GRANTS ACCESS IS NOT WRITTEN BY THE USER IT GRANTS ACCESS TO
 * ======================================================================
 * Automatic row-level security gave every table with one owning user column
 * the owner's rows: read AND write. For most tables that is right. For
 * `user_roles(user_id, role)` it let any signed-in end user insert
 * `role = 'admin'` for themselves; for `team_members` a seat in any team; for
 * `conversation_participants` a place in any conversation. The app reads these
 * tables to decide who may do what.
 *
 * Such tables now get owner_read_only: each user reads their own rows, and
 * only service-role keys write. Other owned tables keep owner read/write.
 *
 * Reads and writes run as the REST API's own roles with production's grants
 * (scripts/sql/postgrest-ddl-sync.sql), so these are the API's answers.
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { isGrantTable } from '@/lib/services/rls-ownership'
import { jwtClaimsJson } from '@/lib/services/rls-session'

let ownerId = ''
let projectId = ''
let schema = ''
const alice = randomUUID()

async function as<T>(userId: string, sql: string, ...values: unknown[]): Promise<T[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE authenticated`)
    await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, jwtClaimsJson({ userId }))
    return tx.$queryRawUnsafe<T[]>(sql, ...values)
  })
}

async function create(tableName: string, columns: Array<Record<string, unknown>>): Promise<string> {
  const res = await executeAction({ action: 'CREATE_TABLE', params: { tableName, columns } }, projectId, undefined, 0, undefined, false)
  expect(res.success).toBe(true)
  return res.message
}

beforeAll(async () => {
  ownerId = (await prisma.user.create({ data: { email: `grants-${randomUUID()}@test.invalid`, name: 'Grant tables' }, select: { id: true } })).id
  projectId = (await prisma.project.create({ data: { name: `grants-${randomUUID().slice(0, 8)}`, userId: ownerId }, select: { id: true } })).id
  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."users" (id uuid PRIMARY KEY, email text)`)
  await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."users" (id, email) VALUES ($1::uuid, 'alice@example.test')`, alice)
}, 60_000)

afterAll(async () => {
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.projectPreference.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.permissionPolicy.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.table.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
})

describe('which tables grant access', () => {
  it.each(['user_roles', 'roles', 'admins', 'team_members', 'organization_members', 'conversation_participants', 'project_invites', 'role_assignments', 'user_permissions'])(
    '%s does',
    (t) => expect(isGrantTable(t)).toBe(true),
  )
  it.each(['notes', 'orders', 'order_items', 'profiles', 'messages', 'member_notes', 'rolex_watches'])('%s does not', (t) =>
    expect(isGrantTable(t)).toBe(false),
  )
})

describe('a table whose rows grant roles', () => {
  let message = ''

  beforeAll(async () => {
    message = await create('user_roles', [
      { name: 'user_id', type: 'UUID', fkTo: 'users' },
      { name: 'role', type: 'TEXT' },
    ])
    await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO anon, authenticated, service_role`)
    await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO authenticated, service_role`)
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."user_roles" (user_id, role) VALUES ($1::uuid, 'member')`, alice)
  }, 60_000)

  it('does not let a signed-in user grant themselves a role', async () => {
    await expect(as(alice, `INSERT INTO "${schema}"."user_roles" (user_id, role) VALUES ($1::uuid, 'admin')`, alice)).rejects.toThrow(
      /row-level security/,
    )
  })

  it('does not let them change the role they have', async () => {
    const changed = await as<{ role: string }>(alice, `UPDATE "${schema}"."user_roles" SET role = 'admin' WHERE user_id = $1::uuid RETURNING role`, alice)
    expect(changed).toEqual([])
  })

  it('still lets them read their own', async () => {
    expect(await as<{ role: string }>(alice, `SELECT role FROM "${schema}"."user_roles"`)).toEqual([{ role: 'member' }])
  })

  it('tells whoever created it why its rows are written by the server', () => {
    expect(message).toContain('grant access')
    expect(message).toContain('only service-role keys write them')
  })
})

describe('a table whose rows are only owned', () => {
  it('still lets its owner write their own rows', async () => {
    await create('journal_entries', [
      { name: 'user_id', type: 'UUID', fkTo: 'users' },
      { name: 'body', type: 'TEXT' },
    ])
    await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO authenticated`)
    const rows = await as<{ body: string }>(alice, `INSERT INTO "${schema}"."journal_entries" (user_id, body) VALUES ($1::uuid, 'mine') RETURNING body`, alice)
    expect(rows).toEqual([{ body: 'mine' }])
  })
})
