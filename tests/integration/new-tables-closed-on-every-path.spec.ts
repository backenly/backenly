/**
 * A NEW TABLE STARTS CLOSED ON EVERY PATH THAT CREATES ONE
 * ========================================================
 * A table Backenly creates whose owner it cannot infer starts closed: row-level
 * security on, service-role keys only (admin_only), with the creator told why
 * and how to open it. __tests__/database/new-tables-closed-by-default.test.ts
 * pins the rule on create_table. This file pins it on each door a table comes
 * through:
 *
 *   apply_migration on production, SQL as written: closed, the notice whole in
 *     what the agent reads, and a later migration that shows the owner opening
 *     it as one verified change, not one Backenly restores as weakened;
 *   apply_migration on a preview branch, and the merge that replays it onto
 *     production;
 *   backend_chat building on a preview branch while production is protected;
 *   generate_api and add_column, which create a table they do not find, and a
 *     junction table;
 *   a restore from History of a dropped table, which brings it back closed.
 *
 * And what an agent does next: its first set_rls naming some commands gives
 * those commands its rule and keeps the rest service-role only, and History
 * still restores the change that created the table after direct access's sync
 * has given it a read policy.
 *
 * And the tables it leaves as they are, because they may already serve an app:
 * one adopted from the database (REGISTER_TABLE), and one that was there when a
 * create ran again.
 *
 * Reads and writes run as the REST API's own roles with production's grants.
 * Real schemas, the real executor, MCP route, branch engine, change ledger and
 * restore; only PostgREST's schema registry and the Cloud plan are stubbed.
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
import { execFileSync } from 'child_process'
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
import { withChangeAttribution, withGovernedChange } from '@/lib/changes/ledger'
import { archiveTable } from '@/lib/changes/preserve'
import { recoverChange } from '@/lib/changes/recovery'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { closedByDefaultTables } from '@/lib/services/workspace-rls'
import { readOnlyLogin, revokeDirectAccess, syncDirectAccessGrants } from '@/lib/services/direct-access'
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

const run = (action: string, params: Record<string, unknown>) =>
  executeAction({ action, params } as any, projectId, undefined, 0, undefined, false)

async function setProtected(on: boolean) {
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: on } })
  forgetProtection(projectId)
}

/** Row-level security and the policies on a table, read from the catalog. */
async function rules(sch: string, table: string): Promise<{ rls: boolean; policies: string[] }> {
  const [r] = await prisma.$queryRawUnsafe<Array<{ rls: boolean; policies: string[] }>>(
    `SELECT c.relrowsecurity AS rls,
            ARRAY(SELECT p.policyname::text FROM pg_policies p WHERE p.schemaname = $1 AND p.tablename = $2 ORDER BY 1) AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2`,
    sch,
    table,
  )
  return r
}

async function columnsOf(sch: string, table: string): Promise<string[]> {
  const r = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY 1`,
    sch,
    table,
  )
  return r.map((x) => x.column_name)
}

/** Production's grants to the REST API roles (scripts/sql/postgrest-ddl-sync.sql), for every table in a schema. */
async function grantRestRoles(sch: string): Promise<void> {
  await ddl(`GRANT USAGE ON SCHEMA "${sch}" TO anon, authenticated, service_role`)
  await ddl(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${sch}" TO authenticated, service_role`)
  await ddl(`GRANT SELECT ON ALL TABLES IN SCHEMA "${sch}" TO anon`)
}

/** Run as a REST API role, with the claims PostgREST would set. */
async function as<R>(role: 'anon' | 'authenticated', userId: string | null, sql: string): Promise<R[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`)
    await tx.$executeRawUnsafe(`SELECT set_config('request.jwt.claims', $1, true)`, jwtClaimsJson({ userId }))
    return tx.$queryRawUnsafe<R[]>(sql)
  })
}

/**
 * Closed: only service-role keys read or write it, whatever the REST API's
 * roles are granted. `seed` puts a row in first, for a table whose columns all
 * have defaults or take NULL.
 */
async function expectClosed(sch: string, table: string, seed = true): Promise<void> {
  expect(await rules(sch, table)).toEqual({ rls: true, policies: ['backenly_admin_only'] })
  await grantRestRoles(sch)
  if (seed) await ddl(`INSERT INTO ${T(sch, table)} DEFAULT VALUES`)
  expect(await as('anon', null, `SELECT * FROM ${T(sch, table)}`)).toEqual([])
  expect(await as('authenticated', alice, `SELECT * FROM ${T(sch, table)}`)).toEqual([])
  await expect(as('authenticated', alice, `INSERT INTO ${T(sch, table)} DEFAULT VALUES`)).rejects.toThrow(/row-level security/)
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js runs the executor without DDL or the change ledger; these
  // paths run as the product runs them.
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  // Direct access's helpers, installed as an operator installs them.
  execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', 'scripts/setup-direct-access.sql', '-d', process.env.TEST_DATABASE_URL!], { stdio: 'pipe' })

  ownerEmail = `closed-paths-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, password: 'not-a-real-hash', name: 'Ada Owner' } })).id
  const project = await createProvisionedProject({ name: 'new-tables-closed-on-every-path', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  // Production unprotected, so an agent's apply_migration reaches it; the
  // backend_chat case protects it for its own turn.
  await setProtected(false)
  await ensureAuthUsersTable(projectId, { email: ownerEmail })

  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'Claude Code', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })
}, 180_000)

afterAll(async () => {
  if (projectId) await revokeDirectAccess(projectId, 'READ_ONLY').catch(() => {})
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await ddl(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  // The ledger's guard allows deleting a project's changes only once the project is gone.
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
}, 180_000)

describe('apply_migration on production', () => {
  let created: { status: number; body: any }

  beforeAll(async () => {
    created = await call('apply_migration', { sql: 'CREATE TABLE notes (title text, body text)' })
  }, 120_000)

  it('creates a table nobody can be shown to own closed', async () => {
    expect(created.status).toBe(200)
    expect(created.body.data.change.status).toBe('healthy')
    await expectClosed(schema, 'notes')
  })

  it('says so, whole, in what the agent reads', () => {
    expect(created.body.summary).toContain('"notes" is closed: only service-role keys can read or write it')
    expect(created.body.summary).toContain('set_rls naming all four commands')
    // The notice's last sentence: the tool result's 800-character clip left it whole.
    expect(created.body.summary).toContain('shows who owns a row.')
  })

  it('opens it when a later migration shows who owns a row, as a verified change', async () => {
    const shown = await call('apply_migration', { sql: 'ALTER TABLE notes ADD COLUMN user_id uuid REFERENCES users(id)' })
    expect(shown.status).toBe(200)
    expect(shown.body.data.change.status).toBe('healthy')
    expect(await columnsOf(schema, 'notes')).toContain('user_id')
    const now = await rules(schema, 'notes')
    expect(now.policies).toContain('backenly_own_rows_select')
    expect(now.policies).not.toContain('backenly_admin_only')
    expect((await closedByDefaultTables(projectId, schema)).has('notes')).toBe(false)
  }, 120_000)
})

describe('a preview branch, and the merge that brings it to production', () => {
  let branch: { id: string; schemaName: string }
  let applied: { status: number; body: any }

  beforeAll(async () => {
    const made = await createBranch(projectId, ownerId, 'drafts')
    if (!made.ok) throw new Error(`createBranch failed: ${(made as any).error}`)
    branch = (made as any).branch
    applied = await call('apply_migration', { branchId: branch.id, sql: 'CREATE TABLE drafts (body text)' })
  }, 180_000)

  it('creates the table closed on the branch, and says so', async () => {
    expect(applied.status).toBe(200)
    expect(applied.body.summary).toContain('"drafts" is closed: only service-role keys can read or write it')
    await expectClosed(branch.schemaName, 'drafts')
  })

  it('brings it to production closed', async () => {
    const merged: any = await mergeBranch(projectId, ownerId, branch.id)
    expect(merged).toMatchObject({ ok: true, fullyMerged: true })
    expect(merged.change.status).toBe('healthy')
    await expectClosed(schema, 'drafts')
  }, 180_000)
})

describe('backend_chat building on a preview branch while production is protected', () => {
  afterAll(() => setProtected(false))

  it('creates the table closed on the branch, and says so', async () => {
    await setProtected(true)
    const buildBranch = new BuildBranch(projectId, ownerId, 'add wishlists')
    const r = await dispatchTool(
      'create_table',
      { tableName: 'wishlists', columns: [{ name: 'title', type: 'text' }] },
      { projectId, userId: ownerId, agentSurface: true, buildBranch, createdThisTurn: new Set<string>() },
    )
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('"wishlists" is closed: only service-role keys can read or write it')
    await expectClosed(buildBranch.current!.schemaName, 'wishlists')
  }, 180_000)
})

describe('a table created by a call that did not find it', () => {
  it('generate_api: closed, and it says so', async () => {
    // The dependency resolver creates the table (CREATE_TABLE) before generating its API.
    const r = await run('GENERATE_API', { tableName: 'ledger_entries' })
    expect(r.success).toBe(true)
    expect(r.message).toContain('"ledger_entries" is closed: only service-role keys can read or write it')
    await expectClosed(schema, 'ledger_entries')
  }, 120_000)

  it('add_column on a table it has no record of: closed, and it says so', async () => {
    // The dependency resolver creates the table (CREATE_TABLE) before adding the column.
    const r = await run('ADD_COLUMN', { tableName: 'scores', columnName: 'points', columnType: 'INTEGER' })
    expect(r.success).toBe(true)
    expect(r.message).toContain('"scores" is closed: only service-role keys can read or write it')
    await expectClosed(schema, 'scores')
  }, 120_000)

  it('add_column on a table it has a record of and the database does not: closed, and it says so', async () => {
    // add_column creates this one itself, with only id and timestamps, before adding the column.
    await prisma.table.create({ data: { projectId, name: 'tallies', schema, description: 'record without a table' } })
    const r = await run('ADD_COLUMN', { tableName: 'tallies', columnName: 'count', columnType: 'INTEGER' })
    expect(r.success).toBe(true)
    expect(r.message).toContain('"tallies" is closed: only service-role keys can read or write it')
    await expectClosed(schema, 'tallies')
  }, 120_000)

  it('add_column of a column naming the owner: the owner\'s rows', async () => {
    const r = await run('ADD_COLUMN', { tableName: 'bookmarks', columnName: 'user_id', columnType: 'UUID' })
    expect(r.success).toBe(true)
    const now = await rules(schema, 'bookmarks')
    expect(now.rls).toBe(true)
    expect(now.policies).toContain('backenly_own_rows_select')
    expect(now.policies).not.toContain('backenly_admin_only')
  }, 120_000)

  it('a junction table between two tables nobody owns: closed', async () => {
    const r = await run('CREATE_JUNCTION_TABLE', { tableA: 'scores', tableB: 'ledger_entries' })
    expect(r.success).toBe(true)
    expect(r.message).toContain('"ledger_entries_scores" is closed')
    // Its two keys are required, so no row is seeded; the insert is refused by the rule first.
    await expectClosed(schema, 'ledger_entries_scores', false)
  }, 120_000)
})

describe('a dropped table restored from History', () => {
  it('comes back closed', async () => {
    expect((await run('CREATE_TABLE', { tableName: 'invoices_archive', columns: [{ name: 'total', type: 'INTEGER' }] })).success).toBe(true)
    await ddl(`INSERT INTO ${T(schema, 'invoices_archive')} (total) VALUES (120)`)
    const { change: dropped } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      withGovernedChange({ projectId, title: 'drop invoices_archive' }, async () => {
        expect((await archiveTable(projectId, schema, 'invoices_archive')).handled).toBe(true)
      }))
    expect(await columnsOf(schema, 'invoices_archive')).toEqual([])

    const out = await recoverChange(projectId, dropped!.id, { mode: 'manual', actorUserId: ownerId })
    expect(out.ok).toBe(true)
    await expectClosed(schema, 'invoices_archive')
  }, 180_000)
})

describe('an agent\'s first rule for a table Backenly closed', () => {
  it('names some commands: they get its rule, and the rest stay service-role only', async () => {
    expect((await call('apply_migration', { sql: 'CREATE TABLE memos (owner uuid NOT NULL, body text)' })).status).toBe(200)
    await expectClosed(schema, 'memos', false)

    const r = await call('set_rls', {
      tableName: 'memos',
      select: { using: "owner = (backenly_jwt_claim('sub'))::uuid" },
      insert: { check: "owner = (backenly_jwt_claim('sub'))::uuid" },
    })
    expect(r.body.ok).toBe(true)
    expect((await rules(schema, 'memos')).policies).toEqual([
      'backenly_custom_delete', 'backenly_custom_insert', 'backenly_custom_select', 'backenly_custom_update',
    ])
    expect((await closedByDefaultTables(projectId, schema)).has('memos')).toBe(false)

    await grantRestRoles(schema)
    await as('authenticated', alice, `INSERT INTO ${T(schema, 'memos')} (owner, body) VALUES ('${alice}', 'mine')`)
    expect(await as('authenticated', alice, `SELECT body FROM ${T(schema, 'memos')}`)).toEqual([{ body: 'mine' }])
    expect(await as('anon', null, `SELECT body FROM ${T(schema, 'memos')}`)).toEqual([])
    // UPDATE and DELETE were not named: as the closed table had them, service-role keys only.
    expect(await as('authenticated', alice, `UPDATE ${T(schema, 'memos')} SET body = 'changed' RETURNING body`)).toEqual([])
    expect(await as('authenticated', alice, `DELETE FROM ${T(schema, 'memos')} RETURNING body`)).toEqual([])
  }, 120_000)
})

describe('a change that created a closed table, after direct access synced it', () => {
  it('is restored from History', async () => {
    const made = await call('apply_migration', { sql: 'CREATE TABLE restorable (label text)' })
    expect(made.status).toBe(200)
    // The project's read-only login, and the sync the drift watch and run_query
    // run: each table with row-level security gets that login's read policy.
    await readOnlyLogin(projectId)
    await syncDirectAccessGrants(projectId)
    expect((await rules(schema, 'restorable')).policies).toEqual(['backenly_admin_only', 'bkn_direct_read'])

    const out = await recoverChange(projectId, made.body.data.change.id, { mode: 'manual', actorUserId: ownerId })
    expect(out.ok).toBe(true)
    expect(await columnsOf(schema, 'restorable')).toEqual([])
  }, 180_000)
})

describe('tables Backenly did not create', () => {
  it('one adopted from the database (REGISTER_TABLE) is left as it is', async () => {
    await ddl(`CREATE TABLE ${T(schema, 'imported')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text)`)
    expect((await run('REGISTER_TABLE', { tableName: 'imported' })).success).toBe(true)
    expect(await rules(schema, 'imported')).toEqual({ rls: false, policies: [] })
  }, 120_000)

  it('one that was there when a create ran again is left as it is', async () => {
    // generate_api creates a table it has no record of; this one exists in the
    // database, so CREATE TABLE IF NOT EXISTS finds it rather than creating it.
    await ddl(
      `CREATE TABLE ${T(schema, 'legacy')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, description text, status text, ` +
        `"createdAt" timestamptz DEFAULT now(), "updatedAt" timestamptz DEFAULT now())`,
    )
    expect((await run('GENERATE_API', { tableName: 'legacy' })).success).toBe(true)
    expect(await rules(schema, 'legacy')).toEqual({ rls: false, policies: [] })
  }, 120_000)
})
