/**
 * DROPPING OR RETYPING A COLUMN IN A MIGRATION
 * ============================================
 *
 * apply_migration refused DROP COLUMN as DESTRUCTIVE_REFUSED and every ALTER
 * COLUMN … TYPE as unsupported, pointing at backend_chat, which on a protected
 * production (Cloud's default) only builds a branch and hands back. On
 * production on 2026-11-09 an agent that needed `refunded_at` to be timestamptz
 * renamed columns around the problem instead.
 *
 * Pinned here on a real provisioned project, through the MCP route as an agent
 * calls it:
 *
 *  1. On a branch, DROP COLUMN and ALTER COLUMN … TYPE … USING run, and
 *     production is untouched.
 *  2. The merge a person approves carries them to production: the declared
 *     type exactly, the values converted, the values before kept with the
 *     change, and restoring puts all of it back.
 *  3. With protection off, an agent's drop or retype waits for a person in the
 *     approval queue, exactly as sent; approving runs it, rejecting changes
 *     nothing. A person's own migration runs it.
 *  4. The declared type is created exactly and becomes what the intent ledger
 *     holds; a conversion PostgreSQL cannot make by itself is left to USING; a
 *     USING expression calls built-ins only, whatever another schema defines.
 *  5. DROP COLUMN runs as written: a row policy that depends on the column
 *     stops it, and is named. IF EXISTS on a missing column is done. A primary
 *     key column is never dropped or retyped.
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
import { createBranch } from '@/lib/branches/engine'
import { decideApproval } from '@/lib/mcp/approvals'
import { forgetProtection } from '@/lib/branches/protection'
import { withChangeAttribution } from '@/lib/changes/attribution'
import { applyMigrationToMain, type MigrationFailure, type MigrationSuccess } from '@/lib/mcp/apply-migration'
import { previewRecovery, recoverChange } from '@/lib/changes/recovery'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { checkIntentConformance } from '@/lib/autonomy/intent-conformance'

let ownerId: string
let projectId: string
let mainSchema: string
let mcpKey: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

async function call(tool: string, args: Record<string, unknown> = {}) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

/** A person's own migration on main, as the dashboard runs it. */
const migrate = (sql: string) =>
  withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    applyMigrationToMain(projectId, ownerId, sql, { agentSurface: false, workspaceSchema: mainSchema }),
  )

async function migrated(sql: string): Promise<MigrationSuccess> {
  const out = await migrate(sql)
  if (!out.ok) throw new Error(`"${sql}" did not apply: ${JSON.stringify(out)}`)
  return out as MigrationSuccess
}

/** Each column of a table, with its type as PostgreSQL prints it. */
async function columnTypes(schema: string, table = 'orders'): Promise<Record<string, string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string; type: string }>>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
    `"${schema}"."${table}"`,
  )
  return Object.fromEntries(rows.map((r) => [r.name, r.type]))
}

/** A column's values on production, as text, in order. */
async function valuesOf(expression: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ v: string | null }>>(
    `SELECT (${expression})::text AS v FROM "${mainSchema}"."orders" ORDER BY 1`,
  )
  return rows.map((r) => r.v as string)
}

async function latestChange() {
  return prisma.backendChange.findFirstOrThrow({ where: { projectId }, orderBy: { seq: 'desc' } })
}

async function restore(changeId: string) {
  const preview = (await previewRecovery(projectId, changeId))!
  return recoverChange(projectId, changeId, { mode: 'manual', actorUserId: ownerId, acknowledged: preview.acknowledgement ?? null })
}

const ORIGINAL = { total: 'text', legacy_email: 'text', refunded_at: 'timestamp without time zone', note: 'character varying(20)' }

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'

  ownerId = (await prisma.user.create({
    data: { email: `drop-columns-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'migrations-drop-column-and-retype', userId: ownerId })
  projectId = project.id
  mainSchema = project.postgresSchema

  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })

  // Production's starting point, made by a person, with two orders in it.
  await migrated('CREATE TABLE orders (total text, legacy_email text, refunded_at timestamp, note varchar(20))')
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${mainSchema}"."orders" (total, legacy_email, refunded_at, note) VALUES
       ('12', 'a@example.test', '2026-11-09 10:00:00', 'First'),
       ('7',  'b@example.test', '2026-11-09 11:30:00', 'Second')`,
  )
}, 240_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS public.lower(character varying)').catch(() => {})
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`,
  ).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (mainSchema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${mainSchema}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  await closeChangeLockPool()
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
})

describe('on a branch of a protected production', () => {
  let branchId: string
  let branchSchema: string

  beforeAll(async () => {
    const res = await createBranch(projectId, ownerId, 'column-changes')
    if (!res.ok) throw new Error(`createBranch failed: ${(res as any).error}`)
    branchId = (res as any).branch.id
    branchSchema = (res as any).branch.schemaName
  }, 120_000)

  it('drops and retypes columns on the branch, and leaves production as it was', async () => {
    const r = await call('apply_migration', {
      branchId,
      sql:
        'ALTER TABLE orders DROP COLUMN legacy_email, ALTER COLUMN total TYPE integer USING total::integer; ' +
        "ALTER TABLE orders ALTER COLUMN refunded_at TYPE timestamptz USING refunded_at AT TIME ZONE 'UTC'",
    })
    expect({ status: r.status, code: r.body.code, detail: r.body.detail }).toEqual({ status: 200, code: undefined, detail: undefined })

    const onBranch = await columnTypes(branchSchema)
    expect(onBranch.legacy_email).toBeUndefined()
    expect(onBranch).toMatchObject({ total: 'integer', refunded_at: 'timestamp with time zone' })
    expect(await columnTypes(mainSchema)).toMatchObject(ORIGINAL)
  }, 120_000)

  it('carries them to production through the merge a person approves, and restoring puts all of it back', async () => {
    const parked = await call('branch', { action: 'merge', branchId })
    expect(parked.body.status).toBe('awaiting_approval')
    expect(await columnTypes(mainSchema)).toMatchObject(ORIGINAL)

    const decided = await decideApproval({ projectId, approvalId: parked.body.approval.id, approverUserId: ownerId, decision: 'approve' })
    expect(decided).toMatchObject({ ok: true, status: 'executed' })

    // The declared types exactly, and the values converted as written.
    const merged = await columnTypes(mainSchema)
    expect(merged.legacy_email).toBeUndefined()
    expect(merged).toMatchObject({ total: 'integer', refunded_at: 'timestamp with time zone' })
    expect(await valuesOf('total')).toEqual(['12', '7'])
    expect(await valuesOf(`refunded_at AT TIME ZONE 'UTC'`)).toEqual(['2026-11-09 10:00:00', '2026-11-09 11:30:00'])

    // The values before were kept with the change: restoring brings them back.
    const change = await latestChange()
    expect(change).toMatchObject({ source: 'branch_merge', status: 'healthy' })
    expect(await restore(change.id)).toMatchObject({ ok: true, status: 'restored' })
    expect(await columnTypes(mainSchema)).toMatchObject(ORIGINAL)
    expect(await valuesOf('legacy_email')).toEqual(['a@example.test', 'b@example.test'])
    expect(await valuesOf('total')).toEqual(['12', '7'])
    expect(await valuesOf('refunded_at')).toEqual(['2026-11-09 10:00:00', '2026-11-09 11:30:00'])
  }, 240_000)
})

describe('on an unprotected production', () => {
  beforeAll(async () => {
    await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })
    forgetProtection(projectId)
  }, 60_000)

  it('holds an agent\'s column drop for a person; approving drops it with its values kept, and restoring brings them back', async () => {
    const r = await call('apply_migration', { sql: 'ALTER TABLE orders DROP COLUMN legacy_email' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, status: 'awaiting_approval', data: { statements: ['ALTER TABLE orders DROP COLUMN legacy_email'] } })
    expect(r.body.summary).toMatch(/drops a column that apps may read or write/)
    expect((await columnTypes(mainSchema)).legacy_email).toBe('text')

    const request = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: r.body.approval.id } })
    expect(request).toMatchObject({ tool: 'apply_migration', toolArgs: { sql: 'ALTER TABLE orders DROP COLUMN legacy_email' } })
    expect(request.message).toContain('These statements will be applied to production, in order:\n  ALTER TABLE orders DROP COLUMN legacy_email')

    const decided = await decideApproval({ projectId, approvalId: request.id, approverUserId: ownerId, decision: 'approve' })
    expect(decided).toMatchObject({ ok: true, status: 'executed' })
    expect(decided.resultSummary).toMatch(/2 values are kept: restoring the state before change #\d+ brings the column back/)
    expect((await columnTypes(mainSchema)).legacy_email).toBeUndefined()

    const change = await latestChange()
    expect(change).toMatchObject({ source: 'approval', actorUserId: ownerId, status: 'healthy' })
    expect(await restore(change.id)).toMatchObject({ ok: true, status: 'restored' })
    expect(await valuesOf('legacy_email')).toEqual(['a@example.test', 'b@example.test'])
  }, 120_000)

  it('holds an agent\'s retype too, and rejecting it changes nothing', async () => {
    const r = await call('apply_migration', { sql: 'ALTER TABLE orders ALTER COLUMN note TYPE text' })
    expect(r.body).toMatchObject({ ok: true, status: 'awaiting_approval' })
    expect(r.body.summary).toMatch(/changes a column's type/)

    const decided = await decideApproval({ projectId, approvalId: r.body.approval.id, approverUserId: ownerId, decision: 'reject' })
    expect(decided.status).toBe('rejected')
    expect((await columnTypes(mainSchema)).note).toBe('character varying(20)')
  }, 60_000)

  it('creates the declared type exactly, and the intent ledger takes it as the request', async () => {
    const out = await migrated("ALTER TABLE orders ALTER COLUMN total TYPE numeric(10,2) USING NULLIF(total, '')::numeric(10,2)")
    expect(out.change).toMatchObject({ status: 'healthy', verified: true })
    expect((await columnTypes(mainSchema)).total).toBe('numeric(10,2)')
    expect(await valuesOf('total')).toEqual(['12.00', '7.00'])

    // Created as text, now numeric on purpose: not drift.
    const conformance = await checkIntentConformance(projectId)
    expect(conformance.findings.filter((f) => f.column === 'total')).toEqual([])

    expect(await restore(out.change!.id)).toMatchObject({ ok: true, status: 'restored' })
    expect((await columnTypes(mainSchema)).total).toBe('text')
    expect(await valuesOf('total')).toEqual(['12', '7'])
  }, 120_000)

  it('leaves a conversion PostgreSQL cannot make by itself to USING, and changes nothing', async () => {
    const out = await migrate('ALTER TABLE orders ALTER COLUMN total TYPE integer')
    expect(out.ok).toBe(false)
    expect((out as MigrationFailure).detail).toMatch(/cannot be cast automatically to type integer/)
    expect((out as MigrationFailure).detail).toMatch(/USING total::integer/)
    expect((await columnTypes(mainSchema)).total).toBe('text')
  }, 60_000)

  it('runs a USING expression with built-ins only, whatever another schema defines', async () => {
    // An exact-type function of the same name in a schema on the default search
    // path would win over pg_catalog's lower(text) for a varchar argument.
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION public.lower(character varying) RETURNS text LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'not a built-in'; END $$`,
    )
    try {
      await migrated('ALTER TABLE orders ALTER COLUMN note TYPE text USING lower(note)')
    } finally {
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS public.lower(character varying)')
    }
    expect((await columnTypes(mainSchema)).note).toBe('text')
    expect(await valuesOf('note')).toEqual(['first', 'second'])
  }, 120_000)

  it('drops a column as written: a row policy that depends on it stops the drop, and is named', async () => {
    await migrated('ALTER TABLE orders ADD COLUMN owner_ref text')
    await prisma.$executeRawUnsafe(
      `CREATE POLICY orders_by_owner ON "${mainSchema}"."orders" FOR SELECT USING (owner_ref = current_user)`,
    )
    const out = await migrate('ALTER TABLE orders DROP COLUMN owner_ref')
    expect(out.ok).toBe(false)
    expect((out as MigrationFailure).detail).toMatch(/policy orders_by_owner on table orders depends on it/)
    expect((await columnTypes(mainSchema)).owner_ref).toBe('text')
    const policies = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = $1 AND policyname = 'orders_by_owner'`,
      mainSchema,
    )
    expect(policies[0].n).toBe(1)
  }, 120_000)

  it('treats IF EXISTS on a missing column as done, and fails without it', async () => {
    await migrated('ALTER TABLE orders DROP COLUMN IF EXISTS no_such_column')
    const strict = await migrate('ALTER TABLE orders DROP COLUMN no_such_column')
    expect(strict.ok).toBe(false)
    expect((strict as MigrationFailure).detail).toMatch(/does not exist on `orders`/)
  }, 60_000)

  it('never drops or retypes a primary key column, refusing before anything is recorded', async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${mainSchema}"."codes" (code text PRIMARY KEY, label text)`)
    const changes = await prisma.backendChange.count({ where: { projectId } })
    expect(await migrate('ALTER TABLE codes DROP COLUMN code')).toMatchObject({ ok: false, code: 'PRIMARY_KEY', applied: [] })
    expect(await migrate('ALTER TABLE codes ALTER COLUMN code TYPE varchar(10)')).toMatchObject({ ok: false, code: 'PRIMARY_KEY' })
    expect(await prisma.backendChange.count({ where: { projectId } })).toBe(changes)
    expect((await columnTypes(mainSchema, 'codes')).code).toBe('text')
  }, 60_000)
})
