/**
 * A TABLE WHOSE ROWS GRANT ACCESS IS NEVER SELF-WRITABLE, ON ANY PATH
 * ===================================================================
 * A row of user_roles, team_members or project_invites grants access, so a
 * user who can write a row naming themselves can grant themselves that access.
 * Backenly gives such a table owner_read_only (each user reads their own rows,
 * only service-role keys write them), or admin_only when its rows name several
 * users. __tests__/database/grant-tables-are-not-self-writable.test.ts pins it
 * on create_table; this file pins it on each door a table comes through and
 * each place Backenly picks the rule:
 *
 *   apply_migration on production, SQL as written, with the reason in what
 *     the agent reads;
 *   a grant table that starts closed (no owner yet) and a later migration that
 *     shows the owner;
 *   apply_migration on a preview branch, and the merge;
 *   backend_chat building on a preview branch while production is protected;
 *   the chat blueprint's conversation_participants, applied as its steps say;
 *   a grant table adopted from the database (REGISTER_TABLE).
 *
 * Reads and writes run as the REST API's own roles with production's grants.
 * Only PostgREST's schema registry and the Cloud plan are stubbed.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER', logRetentionDays: 30 }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { createProvisionedProject } from '@/lib/projects/provision'
import { POST } from '@/app/api/mcp/tool/route'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { executeAction } from '@/lib/ai/minimal-executor'
import { createBranch, mergeBranch } from '@/lib/branches/engine'
import { BuildBranch } from '@/lib/branches/build-branch'
import { forgetProtection } from '@/lib/branches/protection'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { CHAT_APP_BLUEPRINT } from '@/lib/ai/blueprints/chat-app'
import { jwtClaimsJson } from '@/lib/services/rls-session'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let ownerEmail: string
let projectId: string
let schema: string
let mcpKey: string
const alice = crypto.randomUUID()

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const OWNER_READ_ONLY = ['backenly_own_rows_read_delete', 'backenly_own_rows_read_insert', 'backenly_own_rows_read_select', 'backenly_own_rows_read_update']

const T = (sch: string, table: string) => `"${sch}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)

async function call(tool: string, args: Record<string, unknown> = {}) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

async function setProtected(on: boolean) {
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: on } })
  forgetProtection(projectId)
}

async function policies(sch: string, table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT policyname::text AS name FROM pg_policies WHERE schemaname = $1 AND tablename = $2 ORDER BY 1`,
    sch,
    table,
  )
  return rows.map((r) => r.name)
}

async function grantRestRoles(sch: string): Promise<void> {
  await ddl(`GRANT USAGE ON SCHEMA "${sch}" TO anon, authenticated, service_role`)
  await ddl(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${sch}" TO authenticated, service_role`)
  await ddl(`GRANT SELECT ON ALL TABLES IN SCHEMA "${sch}" TO anon`)
}

async function asUser<R>(userId: string, sql: string): Promise<R[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE authenticated`)
    await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, jwtClaimsJson({ userId }))
    return tx.$queryRawUnsafe<R[]>(sql)
  })
}

/**
 * Owner-read-only: a signed-in user reads their own row and cannot write one
 * naming themselves. `columns` is what a row needs besides user_id.
 */
async function expectOwnerReadOnly(sch: string, table: string, columns: Record<string, string> = {}): Promise<void> {
  expect(await policies(sch, table)).toEqual(OWNER_READ_ONLY)
  await grantRestRoles(sch)
  const names = ['user_id', ...Object.keys(columns)].map((c) => `"${c}"`).join(', ')
  const values = [`'${alice}'`, ...Object.values(columns)].join(', ')
  await ddl(`INSERT INTO ${T(sch, table)} (${names}) VALUES (${values})`)
  expect((await asUser(alice, `SELECT user_id::text AS u FROM ${T(sch, table)}`)).length).toBe(1)
  await expect(asUser(alice, `INSERT INTO ${T(sch, table)} (${names}) VALUES (${values})`)).rejects.toThrow(/row-level security/)
  expect(await asUser(alice, `UPDATE ${T(sch, table)} SET user_id = user_id RETURNING 1`)).toEqual([])
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()

  ownerEmail = `grant-paths-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, password: 'not-a-real-hash', name: 'Ada Owner' } })).id
  const project = await createProvisionedProject({ name: 'grant-tables-on-every-path', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  await setProtected(false)
  await ensureAuthUsersTable(projectId, { email: ownerEmail })
  // Alice, the end user each table's rows name: a key into users finds her.
  await ddl(`INSERT INTO ${T(schema, 'users')} (id, email) VALUES ('${alice}', 'alice@example.test')`)

  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'Claude Code', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })
}, 180_000)

afterAll(async () => {
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await ddl(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
}, 180_000)

describe('apply_migration on production', () => {
  it('gives user_roles owner_read_only, and says why', async () => {
    const r = await call('apply_migration', { sql: 'CREATE TABLE user_roles (user_id uuid, role text)' })
    expect(r.status).toBe(200)
    expect(r.body.data.change.status).toBe('healthy')
    expect(r.body.summary).toContain('grant access')
    expect(r.body.summary).toContain('set_rls')
    await expectOwnerReadOnly(schema, 'user_roles', { role: `'member'` })
  }, 120_000)

  it('gives a grant table whose rows name several users admin_only', async () => {
    const r = await call('apply_migration', { sql: 'CREATE TABLE room_members (room_id uuid, user_id uuid, owner_id uuid)' })
    expect(r.status).toBe(200)
    expect(await policies(schema, 'room_members')).toEqual(['backenly_admin_only'])
  }, 120_000)

  it('opens a grant table that started closed as owner_read_only once a migration shows its owner', async () => {
    expect((await call('apply_migration', { sql: 'CREATE TABLE admins (email text)' })).status).toBe(200)
    expect(await policies(schema, 'admins')).toEqual(['backenly_admin_only'])
    const shown = await call('apply_migration', { sql: 'ALTER TABLE admins ADD COLUMN user_id uuid' })
    expect(shown.status).toBe(200)
    expect(shown.body.data.change.status).toBe('healthy')
    await expectOwnerReadOnly(schema, 'admins', { email: `'a@example.test'` })
  }, 120_000)
})

describe('a preview branch, and the merge', () => {
  it('gives team_members owner_read_only on the branch and on production', async () => {
    const made = await createBranch(projectId, ownerId, 'teams')
    if (!made.ok) throw new Error(`createBranch failed: ${(made as any).error}`)
    const branch = (made as any).branch as { id: string; schemaName: string }
    const applied = await call('apply_migration', { branchId: branch.id, sql: 'CREATE TABLE team_members (team_id uuid, user_id uuid, role text)' })
    expect(applied.status).toBe(200)
    expect(await policies(branch.schemaName, 'team_members')).toEqual(OWNER_READ_ONLY)

    const merged: any = await mergeBranch(projectId, ownerId, branch.id)
    expect(merged).toMatchObject({ ok: true, fullyMerged: true })
    await expectOwnerReadOnly(schema, 'team_members', { role: `'member'` })
  }, 180_000)
})

describe('backend_chat building on a preview branch while production is protected', () => {
  afterAll(() => setProtected(false))

  it('gives project_invites owner_read_only on the branch', async () => {
    await setProtected(true)
    const buildBranch = new BuildBranch(projectId, ownerId, 'add invites')
    const r = await dispatchTool(
      'create_table',
      { tableName: 'project_invites', columns: [{ name: 'user_id', type: 'uuid' }, { name: 'email', type: 'text' }] },
      { projectId, userId: ownerId, agentSurface: true, buildBranch, createdThisTurn: new Set<string>() },
    )
    expect(r.ok).toBe(true)
    expect(await policies(buildBranch.current!.schemaName, 'project_invites')).toEqual(OWNER_READ_ONLY)
  }, 180_000)
})

describe('the chat blueprint, applied as its steps say', () => {
  it('gives conversation_participants owner_read_only', async () => {
    const ctx = { projectId, userId: ownerId, createdThisTurn: new Set<string>() }
    const steps = CHAT_APP_BLUEPRINT.steps.filter((s) =>
      (s.tool === 'create_table' && ['conversations', 'conversation_participants'].includes(String(s.args.tableName))) ||
      (s.tool === 'add_rls' && s.args.tableName === 'conversation_participants'))
    expect(steps.map((s) => s.tool)).toEqual(['create_table', 'create_table', 'add_rls'])
    for (const s of steps) {
      const r = await dispatchTool(s.tool, s.args, ctx)
      expect([s.label, r.ok]).toEqual([s.label, true])
    }
    expect(await policies(schema, 'conversation_participants')).toEqual(OWNER_READ_ONLY)
  }, 180_000)
})

describe('a grant table adopted from the database (REGISTER_TABLE)', () => {
  it('gets owner_read_only', async () => {
    await ddl(`CREATE TABLE ${T(schema, 'user_permissions')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, permission text)`)
    const r = await executeAction({ action: 'REGISTER_TABLE', params: { tableName: 'user_permissions' } } as any, projectId, undefined, 0, undefined, false)
    expect(r.success).toBe(true)
    await expectOwnerReadOnly(schema, 'user_permissions', { permission: `'read'` })
  }, 120_000)
})
