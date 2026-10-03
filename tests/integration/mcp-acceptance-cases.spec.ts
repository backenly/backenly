/**
 * Acceptance cases no other suite covered, through the real MCP tool route.
 *
 * The acceptance matrix (scripts/mcp-acceptance/cases.ts) maps each case to the
 * test that proves it. Most already had one; these did not:
 *
 *   approvals   a rejection, an expiry, an approved call that revokes a key
 *               (and the key then refused), and the exact args a rollback parks
 *   RLS         a custom policy that admits its own end-user and denies another
 *               and the anonymous caller, read through the project's own
 *               function role; a read-only key cannot change it
 *   database    a delete by filter, and a migration that stops part-way
 *   auth, monitoring, autonomy, connect: the admin and settings actions
 *
 * Each runs on a project made by the provisioner, in runtime engine mode, with
 * a read-write and a read-only MCP key, against Postgres.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { execFileSync } from 'child_process'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { createProvisionedProject } from '@/lib/projects/provision'
import { decideApproval } from '@/lib/mcp/approvals'
import { JWTSecretManager } from '@/lib/services/jwtSecretManager'
import { executeRouteModuleFunction } from '@/lib/services/ai-functions/route-module-runner'
import { forgetFunctionDbClient, functionRoleName } from '@/lib/services/ai-functions/function-db-role'
import { POST } from '@/app/api/mcp/tool/route'

let ownerId: string
let projectId: string
let schema: string
let RW: string
let RO: string
const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

async function call(key: string, tool: string, args: Record<string, unknown> = {}) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

async function ok(key: string, tool: string, args: Record<string, unknown> = {}) {
  const r = await call(key, tool, args)
  if (!r.body?.ok) throw new Error(`${tool} ${JSON.stringify(args).slice(0, 200)} failed: ${JSON.stringify(r.body).slice(0, 800)}`)
  return r.body
}

async function mint(readOnly: boolean): Promise<{ raw: string; id: string }> {
  const raw = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  const row = await prisma.apiKey.create({
    data: {
      name: readOnly ? 'agent (read-only)' : 'agent', keyPrefix: raw.slice(0, 12), keyHash: hashApiKey(raw),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: readOnly, permissions: [], capabilities: [],
    },
  })
  return { raw, id: row.id }
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  for (const file of ['scripts/setup-direct-access.sql', 'scripts/sql/function-roles.sql']) {
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', file, '-d', process.env.TEST_DATABASE_URL!], { stdio: 'pipe' })
  }
  ownerId = (await prisma.user.create({
    data: { email: `accept-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'accept' },
  })).id
  const project = await createProvisionedProject({ name: 'mcp-acceptance-cases', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  RW = (await mint(false)).raw
  RO = (await mint(true)).raw
}, 180_000)

afterAll(async () => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
  await forgetFunctionDbClient(projectId).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  const role = functionRoleName(schema)
  await prisma.$executeRawUnsafe(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    EXECUTE 'DROP OWNED BY ${role}'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe('approvals', () => {
  it('APPROVAL-REJECT: a rejected call never runs, and check_approval says rejected', async () => {
    await ok(RW, 'storage', { action: 'create_bucket', bucketName: 'keep-me' })
    const parked = await call(RW, 'storage', { action: 'delete_bucket', bucketName: 'keep-me' })
    expect(parked.body.approval?.id).toBeTruthy()
    const decided = await decideApproval({ projectId, approvalId: parked.body.approval.id, approverUserId: ownerId, decision: 'reject' })
    expect(decided.status).toBe('rejected')
    expect(JSON.stringify(await ok(RO, 'check_approval', { id: parked.body.approval.id }))).toMatch(/rejected/)
    expect(JSON.stringify(await ok(RO, 'storage', { action: 'list_buckets' }))).toContain('keep-me')
  }, 120_000)

  it('APPROVAL-TIMEOUT: an expired request reports expired and can no longer be approved', async () => {
    await ok(RW, 'connect', { action: 'set_env', key: 'KEEP_ME', value: 'still-here' })
    const parked = await call(RW, 'connect', { action: 'delete_env', key: 'KEEP_ME' })
    expect(parked.body.approval?.id).toBeTruthy()
    await prisma.agentApprovalRequest.update({ where: { id: parked.body.approval.id }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    expect(JSON.stringify(await ok(RO, 'check_approval', { id: parked.body.approval.id }))).toMatch(/expired/)
    const late = await decideApproval({ projectId, approvalId: parked.body.approval.id, approverUserId: ownerId, decision: 'approve' })
    expect(late).toMatchObject({ ok: false, status: 'expired' })
    expect(JSON.stringify(await ok(RO, 'connect', { action: 'list_env' }))).toContain('KEEP_ME')
  }, 120_000)

  it('APPROVAL-EXACT-REPLAY and KEY-REVOKED: an approved revoke runs exactly as parked, and the key is then refused', async () => {
    const victim = await mint(false)
    expect((await call(victim.raw, 'read_backend_state')).body.ok).toBe(true)
    const parked = await call(RW, 'connect', { action: 'revoke_api_key', keyId: victim.id })
    expect(parked.body.approval?.id).toBeTruthy()
    const row = await prisma.agentApprovalRequest.findUnique({ where: { id: parked.body.approval.id } })
    expect(row).toMatchObject({ tool: 'revoke_api_key', toolArgs: { keyId: victim.id }, status: 'pending' })
    // Nothing happened yet.
    expect((await call(victim.raw, 'read_backend_state')).body.ok).toBe(true)
    const decided = await decideApproval({ projectId, approvalId: parked.body.approval.id, approverUserId: ownerId, decision: 'approve' })
    expect(decided.status).toBe('executed')
    const after = await call(victim.raw, 'read_backend_state')
    expect(after.status).toBe(401)
    expect(after.body.ok).toBe(false)
  }, 120_000)

  it('DEPLOY-ROLLBACK-EXACT: a rollback is parked with exactly the arguments sent', async () => {
    const parked = await call(RW, 'deploy', { action: 'rollback', version: 3 })
    expect(parked.body.approval?.id).toBeTruthy()
    const row = await prisma.agentApprovalRequest.findUnique({ where: { id: parked.body.approval.id } })
    expect(row).toMatchObject({ tool: 'rollback_deploy', toolArgs: { version: 3 }, status: 'pending' })
  }, 60_000)

  it('CONNECT-DISCONNECT-GOVERNED: disconnecting a frontend waits for a human, and nothing runs', async () => {
    // Connecting one needs a deployed backend (it says so, which is its own
    // honest refusal); the governance under test is that a disconnect parks.
    const parked = await call(RW, 'connect', { action: 'disconnect_frontend', url: 'https://app.example.test' })
    expect(parked.body.approval?.id).toBeTruthy()
    const row = await prisma.agentApprovalRequest.findUnique({ where: { id: parked.body.approval.id } })
    expect(row).toMatchObject({ tool: 'disconnect_frontend', toolArgs: { url: 'https://app.example.test' }, status: 'pending', executedAt: null })
    const refused = await call(RW, 'connect', { action: 'connect_frontend', url: 'https://app.example.test' })
    expect(refused.body.ok).toBe(false)
    expect(refused.body.summary).toMatch(/deploy/i)
  }, 60_000)
})

describe('row-level security under a real end-user', () => {
  const alice = '00000000-0000-4000-8000-00000000000a'
  const bob = '00000000-0000-4000-8000-00000000000b'
  const read = `
    import { NextResponse } from 'next/server'
    import { prisma } from '@/lib/db'
    export async function GET() {
      const rows = await prisma.$queryRawUnsafe('SELECT body FROM notes ORDER BY body')
      return NextResponse.json({ rows })
    }
  `
  async function readAs(sub?: string): Promise<string[]> {
    const secret = await JWTSecretManager.getOrCreateSecret(projectId)
    const headers = sub ? { 'x-user-token': `Bearer ${jwt.sign({ sub }, secret, { algorithm: 'HS256' })}` } : undefined
    const { returnValue } = await executeRouteModuleFunction(read, projectId, { type: 'manual', data: {} }, 'GET /fn/read-notes', {
      authMaterial: { jwtSecret: secret, adminKey: null },
      headers,
    })
    return (returnValue.body.rows ?? []).map((r: any) => r.body)
  }

  beforeAll(async () => {
    await ok(RW, 'apply_migration', { sql: 'CREATE TABLE notes (owner uuid NOT NULL, body text NOT NULL)' })
    await ok(RW, 'set_rls', {
      tableName: 'notes',
      select: { using: "owner = (backenly_jwt_claim('sub'))::uuid" },
      insert: { check: "owner = (backenly_jwt_claim('sub'))::uuid" },
    })
    await ok(RW, 'db_insert', { table: 'notes', row: { owner: alice, body: 'alice note' } })
    await ok(RW, 'db_insert', { table: 'notes', row: { owner: bob, body: 'bob note' } })
  }, 180_000)

  it('RLS-ALLOW: an end-user reads their own row', async () => {
    expect(await readAs(alice)).toEqual(['alice note'])
  }, 60_000)

  it('RLS-DENY: the same policy denies another end-user\'s row, and every row to an anonymous caller', async () => {
    expect(await readAs(bob)).toEqual(['bob note'])
    expect(await readAs()).toEqual([])
  }, 60_000)

  it('RLS-READ-ONLY: a read-only key cannot change a policy', async () => {
    const before = await prisma.$queryRaw<Array<{ qual: string }>>`SELECT qual FROM pg_policies WHERE schemaname = ${schema} AND tablename = 'notes' AND cmd = 'SELECT'`
    const r = await call(RO, 'set_rls', { tableName: 'notes', select: { using: 'true' } })
    expect(r.body.code).toBe('READ_ONLY_KEY')
    const after = await prisma.$queryRaw<Array<{ qual: string }>>`SELECT qual FROM pg_policies WHERE schemaname = ${schema} AND tablename = 'notes' AND cmd = 'SELECT'`
    expect(after).toEqual(before)
  }, 60_000)

  it('DB-DELETE: deletes by filter, only the matching row', async () => {
    await ok(RW, 'db_delete', { table: 'notes', filter: { owner: bob } })
    const rows = await prisma.$queryRawUnsafe<Array<{ body: string }>>(`SELECT body FROM "${schema}".notes ORDER BY body`)
    expect(rows.map((r) => r.body)).toEqual(['alice note'])
  }, 60_000)
})

describe('failure recovery', () => {
  it('FAIL-PARTIAL: a migration that stops part-way says what applied and what remains', async () => {
    // A statement that passes every check before running and fails in
    // Postgres: a CHECK the row already in notes ('alice note') violates.
    const sql = "CREATE TABLE partial_first (x text);\nALTER TABLE notes ADD CONSTRAINT notes_body_short CHECK (length(body) < 3);\nCREATE TABLE partial_never (z text)"
    const r = await call(RW, 'apply_migration', { sql })
    const t = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} AND table_name LIKE 'partial_%'`
    expect({ body: JSON.stringify(r.body).slice(0, 1500), tables: t.map((x) => x.table_name) })
      .toEqual({ body: expect.stringContaining('"code":"MIGRATION_FAILED"'), tables: ['partial_first'] })
    expect(r.body.applied.map((a: any) => a.statement)).toEqual(['CREATE TABLE partial_first (x text)'])
    expect(r.body.remaining).toEqual(['CREATE TABLE partial_never (z text)'])
    expect(r.body.hint).toMatch(/do not replay them/)
  }, 120_000)

  it('FAIL-MISSING-TABLE: a statement on a table that does not exist is refused before anything runs', async () => {
    const r = await call(RW, 'apply_migration', { sql: 'CREATE TABLE never_made (x text);\nALTER TABLE no_such_table ADD COLUMN y text' })
    expect(r.body).toMatchObject({ ok: false, code: 'TABLE_NOT_FOUND', applied: [] })
    const t = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${schema} AND table_name IN ('never_made', 'no_such_table')`
    expect(t).toEqual([])
  }, 60_000)
})

describe('section actions', () => {
  it('AUTH-ADMIN: lists users, and blocking one waits for a human', async () => {
    await ok(RW, 'auth', { action: 'enable' })
    await ok(RO, 'auth', { action: 'list_users' })
    const parked = await call(RW, 'auth', { action: 'block_user', email: 'someone@example.test' })
    expect(parked.body.approval?.id).toBeTruthy()
  }, 120_000)

  it('MON-USAGE: reads usage and incidents', async () => {
    await ok(RO, 'monitoring', { action: 'usage' })
    await ok(RO, 'monitoring', { action: 'incidents' })
  }, 60_000)

  it('MON-ALERT-NOT-OFFERED: there is no alert action to call, since nothing would evaluate it', async () => {
    const r = await call(RW, 'monitoring', { action: 'set_alert', type: 'error_rate', threshold: 5 })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('UNKNOWN_ACTION')
    expect(r.body.supported).not.toContain('set_alert')
  }, 60_000)

  it('AUTONOMY-STATUS-LEVEL: reads status, sets a level, and a read-only key cannot', async () => {
    await ok(RO, 'autonomy', { action: 'status' })
    await ok(RO, 'autonomy', { action: 'findings' })
    await ok(RW, 'autonomy', { action: 'set_level', level: 'CONSERVATIVE' })
    expect((await call(RO, 'autonomy', { action: 'set_level', level: 'AGGRESSIVE' })).body.code).toBe('READ_ONLY_KEY')
  }, 60_000)

  it('CONNECT-STATE: lists keys without their secrets', async () => {
    const keys = await ok(RO, 'connect', { action: 'list_api_keys' })
    const text = JSON.stringify(keys)
    expect(text).not.toContain(RW)
    expect(text).not.toContain(RO)
  }, 60_000)
})
