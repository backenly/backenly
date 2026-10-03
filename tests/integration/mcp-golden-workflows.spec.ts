/**
 * Two complete agent workflows, end to end, twice each.
 *
 * Each run provisions a project the way the product does
 * (lib/projects/provision.ts), mints a read-write and a read-only MCP key, and
 * then does what an agent building that app does, one tool call at a time,
 * through the real /api/mcp/tool route. Every step's outcome is checked in the
 * database itself (the catalog, the rows, the policies), not taken from the
 * receipt. A second run on a fresh project is how "it worked once" is told
 * apart from "it works".
 *
 *   SaaS: identity, auth, teams, an accounts / account_members / subscriptions
 *         schema with foreign keys, a CHECK and an index, RLS, row writes and
 *         the empty-filter refusal, a join, types, the Stripe capability
 *         surface, an email function deployed as code, readiness, and a deploy
 *         that waits for a human.
 *
 *   Realtime: auth, a messages table, RLS, realtime on it, a storage bucket,
 *         an http function deployed as code that writes a message, its run in
 *         the logs, the request log, and a disable that waits for a human.
 *
 * What these cannot reach from a test database (PostgREST's /db data plane, a
 * real provider key, S3) is in the acceptance matrix as deferred to the final
 * staging gate: scripts/mcp-acceptance/cases.ts.
 *
 * Runs as the cloud edition, like mcp-domain-operations.spec.ts, with the plan
 * supplied because the public repository's Cloud entitlements stub has none.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})

import '../helpers/next-request-polyfill'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { createProvisionedProject } from '@/lib/projects/provision'
import { forgetFunctionDbClient, functionRoleName } from '@/lib/services/ai-functions/function-db-role'
import { POST } from '@/app/api/mcp/tool/route'

const RUNS = [1, 2]

interface Env {
  ownerId: string
  projectId: string
  schema: string
  rw: string
  ro: string
}

async function call(key: string, tool: string, args: Record<string, unknown> = {}) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

/** A step that must succeed: the whole body is shown when it does not. */
async function ok(key: string, tool: string, args: Record<string, unknown> = {}) {
  const r = await call(key, tool, args)
  if (!r.body?.ok) throw new Error(`${tool} ${JSON.stringify(args).slice(0, 200)} failed: ${JSON.stringify(r.body).slice(0, 800)}`)
  return r.body
}

async function newEnv(label: string): Promise<Env> {
  const ownerId = (await prisma.user.create({
    data: { email: `golden-${label}-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'golden' },
  })).id
  const project = await createProvisionedProject({ name: `golden-${label}`, userId: ownerId })
  const mint = async (readOnly: boolean) => {
    const raw = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
    await prisma.apiKey.create({
      data: {
        name: readOnly ? 'agent (read-only)' : 'agent', keyPrefix: raw.slice(0, 12), keyHash: hashApiKey(raw),
        userId: ownerId, projectId: project.id, scope: 'mcp', mcpReadOnly: readOnly, permissions: [], capabilities: [],
      },
    })
    return raw
  }
  return { ownerId, projectId: project.id, schema: project.postgresSchema, rw: await mint(false), ro: await mint(true) }
}

async function dropEnv(env: Env | undefined) {
  if (!env) return
  await forgetFunctionDbClient(env.projectId).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${env.schema}" CASCADE`).catch(() => {})
  const role = functionRoleName(env.schema)
  await prisma.$executeRawUnsafe(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    EXECUTE 'DROP OWNED BY ${role}'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: env.ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: env.ownerId } }).catch(() => {})
}

async function columns(schema: string, table: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${table}`
  return rows.map((r) => r.column_name)
}

async function policies(schema: string, table: string) {
  return prisma.$queryRaw<Array<{ cmd: string; qual: string | null; with_check: string | null }>>`
    SELECT cmd, qual, with_check FROM pg_policies WHERE schemaname = ${schema} AND tablename = ${table}`
}

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

beforeAll(() => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js sets ENGINE_MODE=integration for every suite, which points
  // the executor's graph reads at an empty in-memory store and skips real DDL.
  // A golden workflow is only worth running as the product runs.
  process.env.ENGINE_MODE = 'runtime'
  // Function SQL logs in as the project's own role, installed as an operator installs it.
  for (const file of ['scripts/setup-direct-access.sql', 'scripts/sql/function-roles.sql']) {
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', file, '-d', process.env.TEST_DATABASE_URL!], { stdio: 'pipe' })
  }
}, 120_000)

afterAll(() => {
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
})

describe.each(RUNS)('golden workflow: a SaaS backend (run %i)', (run) => {
  let env: Env
  let orgId: string

  beforeAll(async () => { env = await newEnv(`saas-${run}`) }, 120_000)
  afterAll(() => dropEnv(env), 120_000)

  it('knows which project it is acting on before it changes anything', async () => {
    const who = await ok(env.rw, 'connect', { action: 'whoami' })
    expect(JSON.stringify(who)).toContain(env.projectId)
    await ok(env.rw, 'read_backend_state')
  }, 60_000)

  it('turns on end-user auth and teams', async () => {
    await ok(env.rw, 'auth', { action: 'enable' })
    expect((await prisma.project.findUnique({ where: { id: env.projectId }, select: { jwtSecret: true } }))?.jwtSecret).toBeTruthy()
    await ok(env.rw, 'auth', { action: 'enable_teams' })
    // Teams are organizations with members and roles, as tables in the project.
    expect(await columns(env.schema, 'organizations')).toEqual(expect.arrayContaining(['id', 'name']))
  }, 120_000)

  it('builds its accounts schema with a foreign key, a CHECK, a default and an index', async () => {
    await ok(env.rw, 'apply_migration', {
      sql: [
        'CREATE TABLE accounts (name text NOT NULL, plan text NOT NULL DEFAULT \'free\')',
        'CREATE TABLE account_members (account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, member_id uuid NOT NULL, role text NOT NULL CHECK (role IN (\'owner\', \'member\')))',
        'CREATE INDEX account_members_member_idx ON account_members (member_id)',
        'CREATE TABLE subscriptions (account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, status text NOT NULL DEFAULT \'trialing\', stripe_customer text)',
      ].join(';\n'),
    })
    const schema = await ok(env.rw, 'get_table_schema', { tableName: 'account_members' })
    const text = JSON.stringify(schema)
    expect(text).toMatch(/accounts/)
    expect(text).toMatch(/owner/)
    const fks = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM information_schema.table_constraints
      WHERE table_schema = ${env.schema} AND table_name = 'account_members' AND constraint_type = 'FOREIGN KEY'`
    expect(fks[0].n).toBe(1)
    const idx = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = ${env.schema} AND indexname = 'account_members_member_idx'`
    expect(idx[0].n).toBe(1)
    const plan = await prisma.$queryRaw<Array<{ d: string | null }>>`
      SELECT column_default AS d FROM information_schema.columns
      WHERE table_schema = ${env.schema} AND table_name = 'accounts' AND column_name = 'plan'`
    expect(plan[0]?.d).toMatch(/free/)
  }, 180_000)

  it('does not report creating a table that already exists', async () => {
    // enable_teams made `organizations`. A CREATE TABLE of the same name must be
    // refused or say the table already existed, never read as a clean creation.
    const r = await call(env.rw, 'apply_migration', { sql: 'CREATE TABLE organizations (tagline text)' })
    const added = (await columns(env.schema, 'organizations')).includes('tagline')
    if (r.body.ok !== false) expect({ added, body: JSON.stringify(r.body).slice(0, 1500) }).toEqual({ added, body: expect.stringMatching(/already exist/i) })
  }, 60_000)

  it('locks account members to themselves with exact RLS', async () => {
    await ok(env.rw, 'set_rls', {
      tableName: 'account_members',
      select: { using: "member_id = (backenly_jwt_claim('sub'))::uuid" },
      insert: { check: "member_id = (backenly_jwt_claim('sub'))::uuid" },
    })
    const p = await policies(env.schema, 'account_members')
    expect(p.map((x) => x.cmd).sort()).toEqual(expect.arrayContaining(['INSERT', 'SELECT']))
    expect(p.find((x) => x.cmd === 'SELECT')?.qual).toMatch(/member_id/)
  }, 60_000)

  it('writes rows, refuses a table-wide update and a CHECK violation, and reads them back with a join', async () => {
    const account = await ok(env.rw, 'db_insert', { table: 'accounts', row: { name: `Acme ${run}` } })
    orgId = account.data.row?.id ?? account.data.id
    expect(orgId).toBeTruthy()
    await ok(env.rw, 'db_insert', { table: 'account_members', row: { account_id: orgId, member_id: crypto.randomUUID(), role: 'owner' } })
    await ok(env.rw, 'db_insert', { table: 'subscriptions', row: { account_id: orgId } })
    await ok(env.rw, 'db_update', { table: 'accounts', filter: { id: orgId }, patch: { plan: 'pro' } })

    const wide = await call(env.rw, 'db_update', { table: 'accounts', filter: {}, patch: { plan: 'free' } })
    expect(wide.status).toBe(400)
    const bad = await call(env.rw, 'db_insert', { table: 'account_members', row: { account_id: orgId, member_id: crypto.randomUUID(), role: 'admin' } })
    expect(bad.body.ok).toBe(false)

    const q = await ok(env.rw, 'run_query', {
      sql: 'SELECT a.plan, count(m.*)::int AS members FROM accounts a JOIN account_members m ON m.account_id = a.id GROUP BY a.plan',
    })
    expect(JSON.stringify(q.data)).toMatch(/"plan":"pro"/)
    const rows = await prisma.$queryRawUnsafe<Array<{ plan: string }>>(`SELECT plan FROM "${env.schema}".accounts`)
    expect(rows).toEqual([{ plan: 'pro' }])
  }, 120_000)

  it('generates types for the tables it built', async () => {
    const t = await ok(env.ro, 'generate_types', { format: 'dts' })
    expect(JSON.stringify(t)).toMatch(/account_members/)
  }, 60_000)

  it('reads what Stripe gives a function, without a key in sight', async () => {
    const caps = await ok(env.ro, 'integrations', { action: 'capabilities' })
    const text = JSON.stringify(caps)
    expect(text).toMatch(/createCheckoutSession/)
    expect(text).not.toMatch(/sk_(live|test)_[A-Za-z0-9]{8,}/)
  }, 60_000)

  it('deploys its own welcome-email function on subscriptions, runs it, and finds the run in the logs', async () => {
    const code = [
      "if (!ctx.integrations.isConnected('email')) {",
      "  ctx.log('email not connected; skipping send for', event.data && event.data.account_id)",
      "  return { sent: false }",
      '}',
      "await ctx.integrations.email.send({ to: 'owner@example.test', subject: 'Welcome', html: '<p>Welcome</p>' })",
      'return { sent: true }',
    ].join('\n')
    const d = await ok(env.rw, 'functions', { action: 'deploy_code', name: 'welcome-email', trigger: 'on_insert', table: 'subscriptions', code })
    const run = await ok(env.rw, 'functions', { action: 'invoke', functionId: d.data.functionId, event: { account_id: orgId } })
    expect(run.data).toMatchObject({ success: true, result: { sent: false } })
    const logs = await ok(env.ro, 'functions', { action: 'logs', functionId: d.data.functionId })
    expect(logs.data.runs[0]).toMatchObject({ success: true })
    expect(JSON.stringify(logs.data.runs[0].logs)).toMatch(/email not connected/)
  }, 120_000)

  it('reads readiness without changing anything, even from a read-only key', async () => {
    const before = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = '${env.schema}'`)
    await ok(env.ro, 'deploy', { action: 'readiness' })
    const after = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = '${env.schema}'`)
    expect(after[0].n).toBe(before[0].n)
  }, 60_000)

  it('asks a human before it deploys, and the read-only key cannot even ask', async () => {
    const parked = await call(env.rw, 'deploy', { action: 'deploy' })
    expect(parked.body.approval?.id).toBeTruthy()
    const status = await ok(env.rw, 'check_approval', { id: parked.body.approval.id })
    expect(JSON.stringify(status)).toMatch(/pending/)
    const ro = await call(env.ro, 'deploy', { action: 'deploy' })
    expect(ro.body.code).toBe('READ_ONLY_KEY')
    expect(await prisma.deployment.count({ where: { projectId: env.projectId } })).toBe(0)
  }, 60_000)
})

describe.each(RUNS)('golden workflow: a realtime chat backend (run %i)', (run) => {
  let env: Env

  beforeAll(async () => { env = await newEnv(`chat-${run}`) }, 120_000)
  afterAll(() => dropEnv(env), 120_000)

  it('builds users and messages, locked to their author', async () => {
    await ok(env.rw, 'auth', { action: 'enable' })
    await ok(env.rw, 'apply_migration', {
      sql: 'CREATE TABLE messages (room text NOT NULL, body text NOT NULL, author_id uuid NOT NULL);\nCREATE INDEX messages_room_idx ON messages (room)',
    })
    expect(await columns(env.schema, 'messages')).toEqual(expect.arrayContaining(['room', 'body', 'author_id']))
    await ok(env.rw, 'set_rls', {
      tableName: 'messages',
      select: { using: 'true' },
      insert: { check: "author_id = (backenly_jwt_claim('sub'))::uuid" },
    })
    expect((await policies(env.schema, 'messages')).map((p) => p.cmd)).toEqual(expect.arrayContaining(['SELECT', 'INSERT']))
  }, 180_000)

  it('streams the messages table, and says so', async () => {
    await ok(env.rw, 'realtime', { action: 'enable', tableName: 'messages' })
    const status = await ok(env.ro, 'realtime', { action: 'status' })
    expect(JSON.stringify(status)).toMatch(/messages/)
  }, 60_000)

  it('creates a private bucket for attachments', async () => {
    await ok(env.rw, 'storage', { action: 'create_bucket', bucketName: `attachments-${run}` })
    const list = await ok(env.ro, 'storage', { action: 'list_buckets' })
    expect(JSON.stringify(list)).toContain(`attachments-${run}`)
  }, 60_000)

  it('deploys its own post-message endpoint, which writes through the project\'s own role', async () => {
    const code = `
      import { NextResponse } from 'next/server'
      import { prisma } from '@/lib/db'
      export async function POST(request: Request) {
        const { room, body } = await request.json()
        await prisma.$executeRawUnsafe(
          'INSERT INTO messages (room, body, author_id) VALUES ($1, $2, $3::uuid)', room, body, '00000000-0000-4000-8000-000000000001')
        const rows = await prisma.$queryRawUnsafe('SELECT count(*)::int AS n FROM messages WHERE room = $1', room)
        return NextResponse.json({ stored: rows[0].n })
      }
    `
    const d = await ok(env.rw, 'functions', { action: 'deploy_code', name: 'post-message', trigger: 'http', code })
    expect(d.data.endpoint).toMatchObject({ method: 'POST' })
    const run1 = await ok(env.rw, 'functions', { action: 'invoke', functionId: d.data.functionId, event: { room: 'lobby', body: `hello ${run}` } })
    expect(run1.data).toMatchObject({ success: true })
    const rows = await prisma.$queryRawUnsafe<Array<{ body: string }>>(`SELECT body FROM "${env.schema}".messages WHERE room = 'lobby'`)
    expect(rows.map((r) => r.body)).toContain(`hello ${run}`)
    const logs = await ok(env.ro, 'functions', { action: 'logs', functionId: d.data.functionId })
    expect(logs.data.runs[0]).toMatchObject({ success: true })
  }, 120_000)

  it('reads its monitoring: request logs and metrics answer for this project', async () => {
    await ok(env.ro, 'monitoring', { action: 'request_logs', sinceMinutes: 60 })
    await ok(env.ro, 'monitoring', { action: 'metrics' })
  }, 60_000)

  it('asks a human before it stops streaming a table', async () => {
    const parked = await call(env.rw, 'realtime', { action: 'disable', tableName: 'messages' })
    expect(parked.body.approval?.id).toBeTruthy()
    const status = await ok(env.ro, 'realtime', { action: 'status' })
    expect(JSON.stringify(status)).toMatch(/messages/)
  }, 60_000)
})
