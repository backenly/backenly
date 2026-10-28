/**
 * A BRANCH MERGE IS ONE GOVERNED CHANGE, AGAINST A REAL DATABASE
 * ==============================================================
 *
 * A merge replays the branch's logged statements onto production inside
 * withGovernedChange (lib/branches/engine.ts replayMerge), so production gets
 * all of the branch, checkpointed and verified, or none of it:
 *
 *   a merge that adds a table and a column is ONE change, recorded as the
 *   merge (source branch_merge), checkpointed, applied and verified, and the
 *   merge result names it; the per-statement changes it dispatches join it
 *   instead of opening their own;
 *   a person can restore the state before the merge: what the branch brought
 *   is gone from production, and rows written since are kept in the restore's
 *   vault, never deleted;
 *   a merge whose result fails protected verification (here: a rename that
 *   breaks end-user sign-in) is recovered automatically, the merge reports the
 *   failure, and the branch stays open;
 *   a merge that fails part-way, on production rows the empty branch never
 *   had, is recovered the same way: none of the branch reaches production;
 *   an agent's merge that a person approves is the same one change, recorded
 *   as the person approving the agent's request.
 *
 * A migration that turns row-level security off cannot be used to build the
 * verification failure: apply_migration's parser refuses every statement that
 * changes row-level security (ALTER TABLE … ROW LEVEL SECURITY, CREATE POLICY)
 * on a branch exactly as on main, and a merge replays only the branch's log,
 * which records only statements that fully applied. That refusal is asserted.
 *
 * Only PostgREST's schema registry is stubbed: it is a list in an external
 * service's configuration, absent from a test database. Every schema, table,
 * policy, row, change record and vault here is real.
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
import { createBranch, diffBranch, mergeBranch } from '@/lib/branches/engine'
import { withChangeAttribution } from '@/lib/changes/ledger'
import { previewRecovery, recoverChange } from '@/lib/changes/recovery'
import { listChanges } from '@/lib/changes/history'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { decideApproval } from '@/lib/mcp/approvals'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let ownerEmail: string
let projectId: string
let schema: string
let mcpKey: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)
const record = (id: string) => prisma.backendChange.findUniqueOrThrow({ where: { id } })
const events = async (id: string) =>
  (await prisma.backendChangeEvent.findMany({ where: { changeId: id }, orderBy: { at: 'asc' } })).map((e) => e.type)
const changeCount = () => prisma.backendChange.count({ where: { projectId } })
const lastSeq = async () =>
  (await prisma.backendChange.findFirst({ where: { projectId }, orderBy: { seq: 'desc' }, select: { seq: true } }))?.seq ?? 0

async function call(tool: string, args: Record<string, unknown> = {}) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

async function columnsOf(sch: string, table: string): Promise<string[]> {
  const r = await rows<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = '${sch}' AND table_name = '${table}' ORDER BY column_name`,
  )
  return r.map((x) => x.column_name)
}

async function tableExists(sch: string, table: string): Promise<boolean> {
  const r = await rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${sch}' AND c.relname = '${table}' AND c.relkind IN ('r', 'p')`,
  )
  return r[0].n > 0
}

async function constraintCount(sch: string, name: string): Promise<number> {
  const r = await rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = '${sch}' AND c.conname = '${name}'`,
  )
  return r[0].n
}

async function schemaExists(sch: string): Promise<boolean> {
  const r = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = '${sch}'`)
  return r[0].n > 0
}

/** Create a branch and build on it the way a coding agent does: apply_migration { branchId }. */
async function branchWith(name: string, sql: string) {
  const made = await createBranch(projectId, ownerId, name)
  if (!made.ok) throw new Error(`createBranch failed: ${(made as any).error}`)
  const branch = (made as any).branch as { id: string; schemaName: string }
  const applied = await call('apply_migration', { branchId: branch.id, sql })
  if (applied.status !== 200) throw new Error(`apply_migration on the branch failed: ${JSON.stringify(applied.body)}`)
  return branch
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  // jest.setup.js points the executor at an in-memory graph that skips DDL;
  // the replay onto main must run the kernel as the product does.
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()

  ownerEmail = `branch-merge-${crypto.randomBytes(6).toString('hex')}@example.test`
  ownerId = (await prisma.user.create({ data: { email: ownerEmail, password: 'not-a-real-hash', name: 'Ada Owner' } })).id
  const project = await createProvisionedProject({ name: 'branch-merge-governed', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema

  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'Claude Code', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })

  // Production's starting point, built by a person in the dashboard through
  // the kernel (protection does not apply to a person), with rows in it.
  const made = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    dispatchTool('create_table', {
      tableName: 'orders',
      columns: [{ name: 'total', type: 'integer' }, { name: 'customer', type: 'text' }],
    }, { projectId, userId: ownerId, createdThisTurn: new Set<string>() }))
  if (!made.ok) throw new Error(`setup create_table failed: ${made.summary}`)
  await ddl(`INSERT INTO ${T('orders')} (total, customer) VALUES (10, 'ada'), (20, 'alan'), (30, 'grace')`)
}, 180_000)

afterAll(async () => {
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await ddl(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  const vaults = await rows<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  // The guard allows deleting a project's changes only once the project is gone.
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
}, 180_000)

// ── A successful merge ───────────────────────────────────────────────────────

describe('a merge that adds a table and a column', () => {
  let branch: { id: string; schemaName: string }
  let merged: any
  let changesBefore: number
  let seqBefore: number

  beforeAll(async () => {
    branch = await branchWith(
      'add-refunds',
      'CREATE TABLE refunds (amount integer NOT NULL, reason text); ALTER TABLE orders ADD COLUMN note text',
    )
    // Production is untouched until the merge.
    expect(await tableExists(schema, 'refunds')).toBe(false)
    expect(await columnsOf(schema, 'orders')).not.toContain('note')
    changesBefore = await changeCount()
    seqBefore = await lastSeq()
    merged = await mergeBranch(projectId, ownerId, branch.id)
  }, 180_000)

  it('succeeds, and its result names the change it became', () => {
    expect(merged).toMatchObject({ ok: true, branch: 'add-refunds', fullyMerged: true })
    expect(merged.applied).toEqual([
      'Applied to production: CREATE TABLE refunds (amount integer NOT NULL, reason text)',
      'Applied to production: ALTER TABLE orders ADD COLUMN note text',
    ])
    expect(merged.change).toEqual({ id: expect.any(String), seq: seqBefore + 1, status: 'healthy' })
  })

  it('is ONE governed change: the statements it replays join it instead of opening their own', async () => {
    expect(await changeCount()).toBe(changesBefore + 1)
    const r = await record(merged.change.id)
    expect(r).toMatchObject({
      kind: 'change',
      source: 'branch_merge',
      actorUserId: ownerId,
      apiKeyId: null,
      status: 'healthy',
      risk: 'additive',
      title: 'Merge branch "add-refunds" (2 statements)',
    })
    expect(r.checkpointHash).toMatch(/^[0-9a-f]{64}$/)
    expect((r.footprint as any[]).filter((c) => !c.object).map((c) => `${c.kind}:${c.after ?? c.before}`).sort())
      .toEqual(['added:refunds', 'modified:orders'])
    expect((r.steps as any[]).map((s) => [s.statement, s.ok])).toEqual([
      ['CREATE TABLE refunds (amount integer NOT NULL, reason text)', true],
      ['ALTER TABLE orders ADD COLUMN note text', true],
    ])
    expect(await events(r.id)).toEqual(['checkpointed', 'applied', 'verified'])
  })

  it('was verified by Backenly, against what each replayed step reported doing', async () => {
    const v = (await record(merged.change.id)).verification as any
    expect(v.outcome).toBe('confirmed')
    expect(v.checks.map((c: any) => [c.id, c.outcome])).toEqual([
      ['expected_effects', 'confirmed'], ['collateral', 'confirmed'], ['rls', 'confirmed'], ['credentials', 'confirmed'],
      ['api_access', 'confirmed'], ['auth', 'confirmed'], ['indexes', 'confirmed'], ['queryable', 'confirmed'],
    ])
    // The CREATE_TABLE and ADD_COLUMN the replay dispatched reported into the
    // merge's change, so verification checked them against the catalog.
    expect(v.checks.find((c: any) => c.id === 'expected_effects').detail).toMatch(/^[2-9]\d* steps checked against the schema$/)
  })

  it('put the branch on production and closed the branch', async () => {
    expect(await columnsOf(schema, 'refunds')).toEqual(expect.arrayContaining(['id', 'amount', 'reason']))
    expect(await columnsOf(schema, 'orders')).toContain('note')
    expect(await prisma.table.count({ where: { projectId, name: 'refunds' } })).toBe(1)
    const b = await prisma.workspaceBranch.findUniqueOrThrow({ where: { id: branch.id } })
    expect(b.status).toBe('merged')
    expect(await schemaExists(branch.schemaName)).toBe(false)
  })

  it('is listed in the change history as the person\'s merge', async () => {
    const { changes } = await listChanges(projectId)
    const entry = changes.find((c) => c.id === merged.change.id)!
    expect(entry).toBeDefined()
    expect(entry.outcome.state).toBe('healthy')
    expect(entry.actor).toMatchObject({ type: 'person', label: 'Ada Owner', userId: ownerId })
  })

  // ── Restoring it ───────────────────────────────────────────────────────────

  describe('restored by a person after the app wrote to it', () => {
    let preview: any
    let restored: any

    beforeAll(async () => {
      // The app keeps working on what the merge brought.
      await ddl(`INSERT INTO ${T('refunds')} (amount, reason) VALUES (5, 'damaged'), (7, 'late')`)
      await ddl(`UPDATE ${T('orders')} SET note = 'gift wrap' WHERE customer = 'ada'`)
      await ddl(`INSERT INTO ${T('orders')} (total, customer, note) VALUES (40, 'barbara', 'leave at door')`)
      preview = await previewRecovery(projectId, merged.change.id)
    }, 120_000)

    it('previews as needing approval, naming exactly what would be set aside', () => {
      expect(preview).toMatchObject({ changeId: merged.change.id, action: 'restore', safety: 'needs_approval' })
      expect(preview.impact.items.filter((i: any) => i.needsApproval).map((i: any) => [i.effect, i.table, i.column ?? null, i.count]))
        .toEqual(expect.arrayContaining([
          ['rows_set_aside', 'refunds', null, 2],
          ['values_set_aside', 'orders', 'note', 2],
        ]))
      expect(preview.acknowledgement).toEqual({ 'rows_set_aside:refunds:': 2, 'values_set_aside:orders:note': 2 })
    })

    it('is refused without that approval, and nothing changes', async () => {
      const out = await recoverChange(projectId, merged.change.id, { mode: 'manual', actorUserId: ownerId })
      expect(out).toMatchObject({ ok: false, code: 'NEEDS_APPROVAL' })
      expect(await tableExists(schema, 'refunds')).toBe(true)
      expect((await record(merged.change.id)).status).toBe('healthy')
    }, 60_000)

    it('runs with it: what the branch brought is gone from production', async () => {
      restored = await recoverChange(projectId, merged.change.id, { mode: 'manual', actorUserId: ownerId, acknowledged: preview.acknowledgement })
      expect(restored).toMatchObject({ ok: true, status: 'restored' })
      expect(restored.verification.outcome).toBe('confirmed')

      expect(await tableExists(schema, 'refunds')).toBe(false)
      expect(await columnsOf(schema, 'orders')).not.toContain('note')
      // Every order is still there, including the one written after the merge.
      expect((await rows(`SELECT customer FROM ${T('orders')} ORDER BY total`)).map((r) => r.customer))
        .toEqual(['ada', 'alan', 'grace', 'barbara'])
      // The platform registry follows the schema.
      expect(await prisma.table.count({ where: { projectId, name: 'refunds' } })).toBe(0)

      const r = await record(merged.change.id)
      expect(r.status).toBe('restored')
      expect(r.recoveredById).toBe(restored.recoveryId)
      // The refused attempt above is on record too: started, planned, withdrawn.
      expect(await events(r.id)).toEqual([
        'checkpointed', 'applied', 'verified',
        'recovery_started', 'recovery_planned',
        'recovery_started', 'recovery_verified', 'restored',
      ])
      const rec = await record(restored.recoveryId)
      expect(rec).toMatchObject({ kind: 'recovery', recoversId: merged.change.id, status: 'healthy', source: 'dashboard', actorUserId: ownerId })
    }, 120_000)

    it('keeps every row and value written since in the restore\'s vault', async () => {
      const rec = await record(restored.recoveryId)
      const preserved = rec.preserved as any
      expect(preserved.vault).toBe(`workspace_${projectId}_r${restored.recoverySeq}`)
      const table = preserved.entries.find((e: any) => e.kind === 'table' && e.table === 'refunds')
      const column = preserved.entries.find((e: any) => e.kind === 'column' && e.table === 'orders' && e.column === 'note')
      expect(table).toMatchObject({ vault: preserved.vault, rows: 2 })
      expect(column).toMatchObject({ vault: preserved.vault, rows: 2 })

      const keptRows = await rows(`SELECT amount, reason FROM "${table.vault}"."${table.vaultTable}" ORDER BY amount`)
      expect(keptRows).toEqual([{ amount: 5, reason: 'damaged' }, { amount: 7, reason: 'late' }])
      const keptValues = await rows(`SELECT * FROM "${column.vault}"."${column.vaultTable}"`)
      expect(keptValues.map((v) => v.note).sort()).toEqual(['gift wrap', 'leave at door'])
    })
  })
})

// ── A merge that fails protected verification ────────────────────────────────

describe('a merge whose result fails protected verification', () => {
  let branch: { id: string; schemaName: string }
  let merged: any

  beforeAll(async () => {
    // Production has end-user sign-in: the auth table the auth routes create
    // on a project's first sign-up, with a user in it.
    await ensureAuthUsersTable(projectId, { email: ownerEmail })
    await ddl(`INSERT INTO ${T('users')} (email, password) VALUES ('end-user@example.test', 'hash')`)

    // On the branch the rename is harmless: nobody signs in there.
    branch = await branchWith('rename-login', 'ALTER TABLE users RENAME COLUMN email TO login_email')
    expect(await columnsOf(branch.schemaName, 'users')).toContain('login_email')
    merged = await mergeBranch(projectId, ownerId, branch.id)
  }, 180_000)

  it('reports the failure, says production was put back, and names the change', () => {
    expect(merged).toMatchObject({ ok: false, code: 'MERGE_FAILED', applied: [], remaining: [] })
    expect(merged.error).toMatch(/applied, then failed production verification/)
    expect(merged.error).toMatch(/end-user sign-in keeps working/i)
    expect(merged.error).toMatch(/Nothing reached production: Backenly restored the state before it and verified it/)
    expect(merged.error).toMatch(/The branch stays open/)
    expect(merged.change).toEqual({ id: expect.any(String), seq: expect.any(Number), status: 'recovered' })
  })

  it('was recovered automatically, and the recovery was itself verified', async () => {
    const r = await record(merged.change.id)
    expect(r).toMatchObject({ source: 'branch_merge', status: 'recovered', actorUserId: ownerId })
    const v = r.verification as any
    expect(v.outcome).toBe('contradicted')
    expect(v.checks.find((c: any) => c.id === 'auth')).toMatchObject({ outcome: 'contradicted', detail: expect.stringMatching(/users lost a column sign-in needs/) })
    expect(await events(r.id)).toEqual([
      'checkpointed', 'applied', 'verification_failed', 'recovery_started', 'recovery_verified', 'recovery_completed',
    ])
    const rec = await record(r.recoveredById!)
    expect(rec).toMatchObject({ kind: 'recovery', recoversId: r.id, source: 'system', status: 'healthy' })
    expect((rec.verification as any).outcome).toBe('confirmed')
  })

  it('left production as it was, and sign-in data with it', async () => {
    const cols = await columnsOf(schema, 'users')
    expect(cols).toContain('email')
    expect(cols).not.toContain('login_email')
    expect(await rows(`SELECT email FROM ${T('users')}`)).toEqual([{ email: 'end-user@example.test' }])
  })

  it('left the branch open, with its schema and its log, ready to fix', async () => {
    const b = await prisma.workspaceBranch.findUniqueOrThrow({ where: { id: branch.id } })
    expect(b.status).toBe('active')
    expect(b.mergedAt).toBeNull()
    expect(await schemaExists(branch.schemaName)).toBe(true)
    expect(await columnsOf(branch.schemaName, 'users')).toContain('login_email')
    const d = (await diffBranch(projectId, branch.id)) as any
    expect(d).toMatchObject({ ok: true, migrations: ['ALTER TABLE users RENAME COLUMN email TO login_email'], conflicts: [] })
    const audit = await prisma.auditLog.findFirst({ where: { projectId, action: 'BRANCH_MERGE_FAILED' }, orderBy: { timestamp: 'desc' } })
    expect(JSON.parse(audit!.details!)).toMatchObject({ branch: 'rename-login', verificationFailed: true, recovered: true })
  }, 60_000)

  it('cannot be built from a statement that turns row-level security off: the branch refuses it and logs nothing', async () => {
    const log = async () => (await prisma.workspaceBranchMigration.findMany({ where: { branchId: branch.id }, orderBy: { seq: 'asc' } }))
      .flatMap((m) => m.statements as string[])
    const before = await log()
    for (const sql of [
      'ALTER TABLE orders DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE orders NO FORCE ROW LEVEL SECURITY',
      'CREATE POLICY open_orders ON orders USING (true)',
    ]) {
      const r = await call('apply_migration', { branchId: branch.id, sql })
      expect({ sql, status: r.status, ok: r.body.ok, applied: r.body.applied }).toEqual({ sql, status: 400, ok: false, applied: [] })
    }
    // A merge replays the log and nothing else, so none of these can reach production by a merge.
    expect(await log()).toEqual(before)
  }, 60_000)
})

// ── A merge that fails part-way ──────────────────────────────────────────────

describe('a merge that fails part-way on production data the branch never had', () => {
  let branch: { id: string; schemaName: string }
  let merged: any

  beforeAll(async () => {
    // The branch is empty (no rows are copied by default), so the CHECK holds
    // there; production has an order of 10.
    branch = await branchWith(
      'big-orders',
      'CREATE TABLE gift_cards (code text NOT NULL); ALTER TABLE orders ADD CONSTRAINT orders_total_big CHECK (total > 15)',
    )
    merged = await mergeBranch(projectId, ownerId, branch.id)
  }, 180_000)

  it('reports where it stopped, and that nothing it ran is still in effect', () => {
    expect(merged).toMatchObject({ ok: false, code: 'MERGE_FAILED', applied: [], remaining: [] })
    expect(merged.error).toMatch(/stopped at: ALTER TABLE orders ADD CONSTRAINT orders_total_big CHECK \(total > 15\)/)
    expect(merged.error).toMatch(/Nothing reached production: the 1 statement\(s\) applied before it were restored to the checkpoint automatically/)
    expect(merged.change).toEqual({ id: expect.any(String), seq: expect.any(Number), status: 'recovered' })
  })

  it('is one change, recovered automatically: production has none of the branch', async () => {
    const r = await record(merged.change.id)
    expect(r).toMatchObject({ source: 'branch_merge', status: 'recovered' })
    expect(await events(r.id)).toEqual(expect.arrayContaining(['partially_applied', 'recovery_started', 'recovery_verified', 'recovery_completed']))
    expect(await tableExists(schema, 'gift_cards')).toBe(false)
    expect(await prisma.table.count({ where: { projectId, name: 'gift_cards' } })).toBe(0)
    expect(await constraintCount(schema, 'orders_total_big')).toBe(0)
  })

  it('leaves the branch open, as it was built', async () => {
    const b = await prisma.workspaceBranch.findUniqueOrThrow({ where: { id: branch.id } })
    expect(b.status).toBe('active')
    expect(await tableExists(branch.schemaName, 'gift_cards')).toBe(true)
    expect(await constraintCount(branch.schemaName, 'orders_total_big')).toBe(1)
  })
})

// ── An agent's merge, approved by a person ───────────────────────────────────

describe('an agent\'s merge, approved by a person', () => {
  it('is the same one governed change, recorded as the person approving the agent\'s request', async () => {
    const branch = await branchWith('add-coupons', 'CREATE TABLE coupons (code text NOT NULL, percent integer)')
    const parked = await call('branch', { action: 'merge', branchId: branch.id })
    expect(parked.body).toMatchObject({ ok: true, status: 'awaiting_approval' })
    expect(await tableExists(schema, 'coupons')).toBe(false)

    const before = await changeCount()
    const decided = await decideApproval({ projectId, approvalId: parked.body.approval.id, approverUserId: ownerId, decision: 'approve' })
    expect(decided).toMatchObject({ ok: true, status: 'executed' })
    expect(await changeCount()).toBe(before + 1)

    const r = await prisma.backendChange.findFirstOrThrow({ where: { projectId }, orderBy: { seq: 'desc' } })
    const key = await prisma.apiKey.findFirstOrThrow({ where: { projectId, scope: 'mcp' } })
    expect(r).toMatchObject({
      title: 'Merge branch "add-coupons" (1 statement)',
      source: 'branch_merge',
      actorUserId: ownerId,
      apiKeyId: key.id,
      status: 'healthy',
    })
    expect((r.verification as any).outcome).toBe('confirmed')
    expect(await tableExists(schema, 'coupons')).toBe(true)
    const { changes } = await listChanges(projectId)
    expect(changes.find((c) => c.id === r.id)!.actor.label).toBe("Ada Owner, approving Claude Code's request")
  }, 180_000)
})
