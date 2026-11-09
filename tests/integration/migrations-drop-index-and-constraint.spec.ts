/**
 * DROPPING AN INDEX OR A CONSTRAINT IN A MIGRATION
 * ================================================
 *
 * apply_migration refused every DROP as DESTRUCTIVE_REFUSED and pointed at
 * backend_chat, which on a protected production (Cloud's default) only builds
 * a branch and hands back. An agent could not remove a rule at all, not even a
 * UNIQUE index Backenly had added that nobody asked for, so it renamed columns
 * around it.
 *
 * Dropping an index or a constraint removes a rule, never a row. Pinned here
 * on a real provisioned project, through the MCP route as an agent calls it:
 *
 *  1. On a branch, DROP INDEX (unique ones included) and ALTER TABLE … DROP
 *     CONSTRAINT run, and production is untouched.
 *  2. The merge a person approves carries them to production.
 *  3. With protection off, an agent's drop on production is refused with the
 *     branch route; a person's own migration runs it as a governed change that
 *     restoring puts back.
 *  4. The primary key is never dropped; a unique index named as a constraint
 *     says to use DROP INDEX; a missing index fails unless IF EXISTS.
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

async function indexes(schema: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
    SELECT indexname FROM pg_indexes WHERE schemaname = ${schema} AND tablename = 'orders'`
  return rows.map((r) => r.indexname).sort()
}

async function constraints(schema: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
    SELECT c.conname FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = ${schema} AND t.relname = 'orders'`
  return rows.map((r) => r.conname).sort()
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'

  ownerId = (await prisma.user.create({
    data: { email: `drop-rules-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'migrations-drop-index-and-constraint', userId: ownerId })
  projectId = project.id
  mainSchema = project.postgresSchema

  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'agent', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })

  // Production's starting point, made by a person: a CHECK, a plain index and
  // a UNIQUE index like the ones Backenly adds on its own.
  await migrated('CREATE TABLE orders (total integer NOT NULL, coupon text, contact text)')
  await migrated('ALTER TABLE orders ADD CONSTRAINT total_positive CHECK (total > 0)')
  await migrated('CREATE INDEX orders_total_idx ON orders (total)')
  await migrated('CREATE UNIQUE INDEX orders_coupon_key ON orders (coupon)')
}, 240_000)

afterAll(async () => {
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
    const res = await createBranch(projectId, ownerId, 'drop-rules')
    if (!res.ok) throw new Error(`createBranch failed: ${(res as any).error}`)
    branchId = (res as any).branch.id
    branchSchema = (res as any).branch.schemaName
  }, 120_000)

  it('drops an index, a unique index and a constraint, and leaves production as it was', async () => {
    const r = await call('apply_migration', {
      branchId,
      sql: 'DROP INDEX orders_total_idx; DROP INDEX orders_coupon_key; ALTER TABLE orders DROP CONSTRAINT total_positive',
    })
    expect({ status: r.status, code: r.body.code, detail: r.body.detail }).toEqual({ status: 200, code: undefined, detail: undefined })
    // The clone named the unique index's copy by Postgres's rules; the drop found it anyway.
    expect(JSON.stringify(r.body.data.applied)).toMatch(/its copy there is named/)

    expect(await indexes(branchSchema)).not.toEqual(expect.arrayContaining(['orders_total_idx']))
    expect(await indexes(branchSchema)).not.toEqual(expect.arrayContaining(['orders_coupon_key']))
    expect(await constraints(branchSchema)).not.toContain('total_positive')

    expect(await indexes(mainSchema)).toEqual(expect.arrayContaining(['orders_total_idx', 'orders_coupon_key']))
    expect(await constraints(mainSchema)).toContain('total_positive')
  }, 120_000)

  it('carries them to production through the merge a person approves', async () => {
    const parked = await call('branch', { action: 'merge', branchId })
    expect(parked.body.status).toBe('awaiting_approval')
    expect(await indexes(mainSchema)).toEqual(expect.arrayContaining(['orders_total_idx']))

    const decided = await decideApproval({ projectId, approvalId: parked.body.approval.id, approverUserId: ownerId, decision: 'approve' })
    expect(decided.status).toBe('executed')

    expect(await indexes(mainSchema)).not.toEqual(expect.arrayContaining(['orders_total_idx']))
    expect(await indexes(mainSchema)).not.toEqual(expect.arrayContaining(['orders_coupon_key']))
    expect(await constraints(mainSchema)).not.toContain('total_positive')
  }, 240_000)
})

describe('on an unprotected production', () => {
  beforeAll(async () => {
    await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })
    forgetProtection(projectId)
    await migrated('ALTER TABLE orders ADD CONSTRAINT total_positive CHECK (total > 0)')
    await migrated('CREATE INDEX orders_total_idx ON orders (total)')
  }, 120_000)

  it('refuses an agent\'s drop with the branch route, changing nothing', async () => {
    const r = await call('apply_migration', { sql: 'DROP INDEX orders_total_idx' })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ ok: false, code: 'DROP_NEEDS_REVIEW', applied: [] })
    expect(r.body.hint).toMatch(/branch \{ action: "merge", branchId \}/)
    expect(await indexes(mainSchema)).toEqual(expect.arrayContaining(['orders_total_idx']))
  }, 60_000)

  it('runs a person\'s drop as a governed change that restoring puts back', async () => {
    const out = await migrated('ALTER TABLE orders DROP CONSTRAINT total_positive')
    expect(out.change).toMatchObject({ status: 'healthy', verified: true })
    expect(await constraints(mainSchema)).not.toContain('total_positive')

    const preview = (await previewRecovery(projectId, out.change!.id))!
    expect({ action: preview.action, safety: preview.safety }).toEqual({ action: 'restore', safety: 'lossless' })
    const restored = await recoverChange(projectId, out.change!.id, { mode: 'manual', actorUserId: ownerId, acknowledged: preview.acknowledgement ?? null })
    expect(restored).toMatchObject({ ok: true, status: 'restored' })
    expect(await constraints(mainSchema)).toContain('total_positive')
  }, 120_000)

  it('never drops the primary key', async () => {
    const pkey = (await constraints(mainSchema)).find((c) => c.endsWith('_pkey'))!
    const changes = await prisma.backendChange.count({ where: { projectId } })
    const out = await migrate(`ALTER TABLE orders DROP CONSTRAINT ${pkey}`)
    expect(out).toMatchObject({ ok: false, code: 'PRIMARY_KEY', applied: [] })
    expect(await constraints(mainSchema)).toContain(pkey)
    // Refused before anything ran: nothing recorded either.
    expect(await prisma.backendChange.count({ where: { projectId } })).toBe(changes)
  }, 60_000)

  it('names a unique index asked for as a constraint, and DROP INDEX removes it', async () => {
    await migrated('CREATE UNIQUE INDEX orders_contact_key ON orders (contact)')
    const asConstraint = await migrate('ALTER TABLE orders DROP CONSTRAINT orders_contact_key')
    expect(asConstraint.ok).toBe(false)
    expect((asConstraint as MigrationFailure).detail).toMatch(/is a unique index, not a constraint\. Drop it with DROP INDEX orders_contact_key/)

    await migrated('DROP INDEX orders_contact_key')
    expect(await indexes(mainSchema)).not.toEqual(expect.arrayContaining(['orders_contact_key']))
  }, 120_000)

  it('fails on a missing index unless IF EXISTS', async () => {
    const strict = await migrate('DROP INDEX no_such_index')
    expect(strict.ok).toBe(false)
    expect((strict as MigrationFailure).detail).toMatch(/There is no index named "no_such_index"/)
    await migrated('DROP INDEX IF EXISTS no_such_index')
  }, 60_000)
})
