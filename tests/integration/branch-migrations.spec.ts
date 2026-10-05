/**
 * BUILD ON A BRANCH, MERGE TO PRODUCTION AFTER A HUMAN APPROVES
 * ============================================================
 *
 * The loop a coding agent follows on a protected project, end to end against a
 * real database, through the real /api/mcp/tool route and the real branch
 * engine:
 *
 *   production is protected by default on Cloud, so a migration on main is
 *   refused with BRANCH_REQUIRED, over apply_migration and over the schema
 *   tools a backend_chat run would call;
 *   apply_migration { branchId } changes the branch and nothing on main (not
 *   the catalog, not the metadata), and a table it creates gets the row
 *   security production would give it;
 *   the agent reads and seeds the branch;
 *   branch merge waits for a human, and approving it replays the logged
 *   statements onto production, closes the branch and drops its schema;
 *   a merge is refused when main changed a table the branch touched.
 *
 * Only PostgREST's schema registry is stubbed: it is a list in an external
 * service's configuration, installed by the operator and absent from a test
 * database. Every schema, table, policy and row here is real.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
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
import { createBranch, mergeBranch, diffBranch, discardBranch } from '@/lib/branches/engine'
import { branchSchemaName } from '@/lib/branches/diff'
import { profileForBranchSchema } from '@/lib/postgrest/gateway'
import { decideApproval } from '@/lib/mcp/approvals'
import { forgetProtection } from '@/lib/branches/protection'

let ownerId: string
let projectId: string
let mainSchema: string
let mcpKey: string

async function call(tool: string, args: Record<string, unknown> = {}) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

async function columns(schema: string, table: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${table}`
  return rows.map((r) => r.column_name).sort()
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  return (await columns(schema, table)).length > 0
}

async function schemaExists(schema: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = ${schema}`
  return rows[0].n > 0
}

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js points the executor at an in-memory graph that skips DDL;
  // the replay onto main must run the kernel as the product does.
  process.env.ENGINE_MODE = 'runtime'

  ownerId = (await prisma.user.create({
    data: { email: `branch-mig-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'branch-migrations', userId: ownerId })
  projectId = project.id
  mainSchema = project.postgresSchema

  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })

  // Production's starting point, built the way a human in the dashboard would:
  // the kernel, without the agent flag, so protection does not apply.
  const made = await dispatchTool('create_table', {
    tableName: 'orders',
    columns: [{ name: 'total', type: 'integer' }, { name: 'user_id', type: 'uuid' }],
  }, { projectId, userId: ownerId, createdThisTurn: new Set<string>() })
  if (!made.ok) throw new Error(`setup create_table failed: ${made.summary}`)
}, 180_000)

afterAll(async () => {
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  if (mainSchema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${mainSchema}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
}, 180_000)

describe('branch schema identifiers', () => {
  it.each(['release-preview', 'a'.repeat(31)])('creates and discards a branch named %s without identifier truncation', async (name) => {
    const result = await createBranch(projectId, ownerId, name)
    if (!result.ok) throw new Error((result as any).error)
    const branch = (result as any).branch
    try {
      expect(Buffer.byteLength(branch.schemaName, 'utf8')).toBeLessThanOrEqual(63)
      expect(await schemaExists(branch.schemaName)).toBe(true)
      expect(await columns(branch.schemaName, 'orders')).toContain('total')
      expect(profileForBranchSchema(projectId, branch.schemaName)).toBe(branch.schemaName)
      const stored = await prisma.workspaceBranch.findUnique({ where: { id: branch.id } })
      expect(stored?.schemaName).toBe(branch.schemaName)
    } finally {
      const discarded = await discardBranch(projectId, ownerId, branch.id)
      expect(discarded.ok).toBe(true)
    }
    expect(await schemaExists(branch.schemaName)).toBe(false)
  }, 120_000)

  it('refuses a collision without deleting a preexisting schema or its data', async () => {
    const name = 'release-preview'
    const schemaName = branchSchemaName(projectId, name)
    // A valid short name can occupy the same finite namespace as a long-name
    // hash. This also covers legacy hyphen/underscore aliases: collision must
    // fail safely even when there is no WorkspaceBranch row naming the schema.
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schemaName}"`)
    try {
      await prisma.$executeRawUnsafe(`CREATE TABLE "${schemaName}".sentinel (body text NOT NULL)`)
      await prisma.$executeRawUnsafe(`INSERT INTO "${schemaName}".sentinel VALUES ('keep this branch data')`)
      const result = await createBranch(projectId, ownerId, name)
      expect(result.ok).toBe(false)
      expect((result as any).error).toMatch(/already exists/)
      expect(await schemaExists(schemaName)).toBe(true)
      const rows = await prisma.$queryRawUnsafe<Array<{ body: string }>>(`SELECT body FROM "${schemaName}".sentinel`)
      expect(rows).toEqual([{ body: 'keep this branch data' }])
      expect(await prisma.workspaceBranch.count({ where: { projectId, name, status: 'active' } })).toBe(0)
    } finally {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    }
  }, 120_000)
})

describe('protected production', () => {
  it('is on for a new Cloud project', async () => {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { protectedProduction: true } })
    expect(p?.protectedProduction).toBe(true)
  })

  it('refuses an agent migration on main, and names the way through', async () => {
    const r = await call('apply_migration', { sql: 'ALTER TABLE orders ADD COLUMN sneaky text' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('BRANCH_REQUIRED')
    expect(r.body.hint).toMatch(/branchId/)
    expect(await columns(mainSchema, 'orders')).not.toContain('sneaky')
  }, 60_000)

  it('refuses the schema tools an agent reaches through backend_chat', async () => {
    const r = await dispatchTool('add_column', { tableName: 'orders', column: { name: 'sneaky', type: 'text' } }, {
      projectId, userId: ownerId, agentSurface: true, createdThisTurn: new Set<string>(),
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('BRANCH_REQUIRED')
    expect(await columns(mainSchema, 'orders')).not.toContain('sneaky')
  }, 60_000)
})

describe('building on a branch', () => {
  let branchId: string
  let branchSchema: string

  beforeAll(async () => {
    const res = await createBranch(projectId, ownerId, 'add-invoices')
    if (!res.ok) throw new Error(`createBranch failed: ${(res as any).error}`)
    branchId = (res as any).branch.id
    branchSchema = (res as any).branch.schemaName
  }, 120_000)

  it('records main as it was when the branch was cut', async () => {
    const row = await prisma.workspaceBranch.findUnique({ where: { id: branchId }, select: { baseSnapshot: true } })
    expect(JSON.stringify(row?.baseSnapshot)).toContain('orders')
  })

  it('applies a migration to the branch and leaves production untouched', async () => {
    const tablesBefore = (await prisma.table.findMany({ where: { projectId }, select: { name: true } })).map((t) => t.name).sort()
    const r = await call('apply_migration', {
      branchId,
      sql: 'CREATE TABLE invoices (amount integer NOT NULL, user_id uuid); ALTER TABLE orders ADD COLUMN note text',
    })
    expect(r.status).toBe(200)
    expect(r.body.data.branch).toBe('add-invoices')

    // The branch got the kernel's shape: its own columns plus the ones every
    // table is provisioned with.
    expect(await columns(branchSchema, 'invoices')).toEqual(
      expect.arrayContaining(['id', 'createdAt', 'updatedAt', 'deleted_at', 'amount', 'user_id']),
    )
    expect(await columns(branchSchema, 'orders')).toContain('note')

    // Production: no table, no column, no metadata row.
    expect(await tableExists(mainSchema, 'invoices')).toBe(false)
    expect(await columns(mainSchema, 'orders')).not.toContain('note')
    const tablesAfter = (await prisma.table.findMany({ where: { projectId }, select: { name: true } })).map((t) => t.name).sort()
    expect(tablesAfter).toEqual(tablesBefore)

    const log = await prisma.workspaceBranchMigration.findMany({ where: { branchId }, orderBy: { seq: 'asc' } })
    expect(log.flatMap((l) => l.statements as string[])).toEqual([
      'CREATE TABLE invoices (amount integer NOT NULL, user_id uuid)',
      'ALTER TABLE orders ADD COLUMN note text',
    ])
  }, 120_000)

  it('gives a table created on the branch the row security production would', async () => {
    const rls = await prisma.$queryRaw<Array<{ relrowsecurity: boolean }>>`
      SELECT relrowsecurity FROM pg_class
       WHERE relname = 'invoices' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ${branchSchema})`
    expect(rls[0]?.relrowsecurity).toBe(true)
    const pols = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = ${branchSchema} AND tablename = 'invoices'`
    expect(pols[0].n).toBeGreaterThan(0)
    // Main's policy metadata is not written for a branch table.
    expect(await prisma.permissionPolicy.count({ where: { projectId, tableName: 'invoices' } })).toBe(0)
  })

  it('refuses a statement on a table the branch does not have', async () => {
    const r = await call('apply_migration', { branchId, sql: 'ALTER TABLE ghosts ADD COLUMN x text' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('TABLE_NOT_FOUND')
    expect(r.body.error).toMatch(/on branch "add-invoices"/)
  }, 60_000)

  it('seeds and reads the branch, and only the branch', async () => {
    const ins = await call('db_insert', { table: 'invoices', row: { amount: 1200 }, branchId })
    expect(ins.body.ok).toBe(true)
    const read = await call('db_query', { table: 'invoices', branchId })
    expect(read.body.data.count).toBe(1)
    const onMain = await call('db_query', { table: 'invoices' })
    expect(onMain.body.ok).toBe(false)
  }, 60_000)

  it('reads the branch schema when asked, and refuses other sections with a branch', async () => {
    const schema = await call('read_backend_state', { section: 'schema', branchId })
    expect(schema.body.ok).toBe(true)
    expect(schema.body.data.tables.map((t: any) => t.name)).toEqual(expect.arrayContaining(['invoices', 'orders']))
    const other = await call('read_backend_state', { section: 'tables', branchId })
    expect(other.body.code).toBe('BRANCH_SECTION_UNSUPPORTED')
  }, 60_000)

  it('diffs as the migrations a merge would replay, with no conflict', async () => {
    const d = await diffBranch(projectId, branchId)
    expect(d.ok).toBe(true)
    const full = d as any
    expect(full.migrations).toHaveLength(2)
    expect(full.conflicts).toEqual([])
    expect(full.diff.addedTables.map((t: any) => t.tableName)).toEqual(['invoices'])
  }, 60_000)

  it('parks an agent merge for a human, changing nothing yet', async () => {
    const r = await call('branch', { action: 'merge', branchId })
    expect(r.body.ok).toBe(true)
    expect(r.body.status).toBe('awaiting_approval')
    const approval = await prisma.agentApprovalRequest.findUnique({ where: { id: r.body.approval.id } })
    expect(approval?.tool).toBe('merge_branch')
    expect(approval?.toolArgs).toEqual({ branchId })
    expect(approval?.message).toContain('CREATE TABLE invoices')
    expect(await tableExists(mainSchema, 'invoices')).toBe(false)

    // Approving replays the branch onto production.
    const decided = await decideApproval({ projectId, approvalId: r.body.approval.id, approverUserId: ownerId, decision: 'approve' })
    expect({ status: decided.status, summary: decided.resultSummary }).toEqual({ status: 'executed', summary: expect.any(String) })

    expect(await columns(mainSchema, 'invoices')).toEqual(
      expect.arrayContaining(['id', 'createdAt', 'updatedAt', 'deleted_at', 'amount', 'user_id']),
    )
    expect(await columns(mainSchema, 'orders')).toContain('note')
    // Production got the kernel's metadata, as a direct migration would give it.
    expect(await prisma.table.count({ where: { projectId, name: 'invoices' } })).toBe(1)

    const branch = await prisma.workspaceBranch.findUnique({ where: { id: branchId } })
    expect(branch?.status).toBe('merged')
    expect(await schemaExists(branchSchema)).toBe(false)
  }, 240_000)

  it('lets the same branch name be used again once merged', async () => {
    const again = await createBranch(projectId, ownerId, 'add-invoices')
    expect(again.ok).toBe(true)
  }, 120_000)
})

describe('a merge that would land on a schema nobody tested', () => {
  it('is refused when main changed a table the branch touched', async () => {
    const res = await createBranch(projectId, ownerId, 'add-priority')
    if (!res.ok) throw new Error((res as any).error)
    const branchId = (res as any).branch.id

    const onBranch = await call('apply_migration', { branchId, sql: 'ALTER TABLE orders ADD COLUMN priority integer' })
    expect(onBranch.status).toBe(200)

    // Main moves on `orders` after the branch was cut (a human's change).
    const human = await dispatchTool('add_column', { tableName: 'orders', column: { name: 'channel', type: 'text' } }, {
      projectId, userId: ownerId, createdThisTurn: new Set<string>(),
    })
    expect(human.ok).toBe(true)

    const d = (await diffBranch(projectId, branchId)) as any
    expect(d.conflicts).toEqual(['orders'])

    const park = await call('branch', { action: 'merge', branchId })
    expect(park.status).toBe(409)
    expect(park.body.code).toBe('MERGE_CONFLICT')

    const merged = await mergeBranch(projectId, ownerId, branchId)
    expect(merged.ok).toBe(false)
    expect((merged as any).code).toBe('MERGE_CONFLICT')
    expect(await columns(mainSchema, 'orders')).not.toContain('priority')
  }, 240_000)
})

describe('with protection off', () => {
  it('lets an agent migrate main directly', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })
    forgetProtection(projectId)
    const r = await call('apply_migration', { sql: 'ALTER TABLE orders ADD COLUMN direct text' })
    expect(r.status).toBe(200)
    expect(await columns(mainSchema, 'orders')).toContain('direct')
  }, 60_000)
})
