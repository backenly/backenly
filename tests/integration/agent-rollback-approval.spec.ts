/**
 * AN AGENT CAN ASK FOR A RESTORE, AND ONLY A PERSON CAN APPROVE ONE
 * =================================================================
 *
 * Through the real /api/mcp/tool route with a real agent key, against a real
 * database:
 *
 *   a migration an agent applies is a governed change, recorded as that
 *   agent's, checkpointed, applied and verified, and the response says so;
 *   nothing the agent adds to its arguments skips or weakens verification;
 *   the agent reads the history with deploy { action: "changes" };
 *   deploy { action: "revert_change" } parks a request carrying only what
 *   Backenly measured, never what the agent sent, and changes nothing;
 *   calling the restore tool directly is refused, and the routes that decide
 *   or run a restore do not accept an agent's key at all;
 *   a person approves, and the restore runs, verified, recorded as the
 *   person's decision on the agent's request;
 *   a request that could never be carried out is answered at once;
 *   the agent cannot reach the change record through SQL;
 *   a migration that fails part-way is recovered automatically;
 *   an agent that turns the autonomy dial off and sends arguments meant to skip
 *   recovery still has its breaking change recovered;
 *   an agent's set_rls replacing a table's policies is verified as what it
 *   asked for, not recovered as a side effect.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', logRetentionDays: 7 }) }
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
import { POST as DECIDE } from '@/app/api/projects/[id]/agent-approvals/route'
import { POST as RESTORE } from '@/app/api/projects/[id]/changes/[changeId]/restore/route'
import { decideApproval } from '@/lib/mcp/approvals'
import { listChanges } from '@/lib/changes/history'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { forgetProtection } from '@/lib/branches/protection'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string
let mcpKey: string
let keyId: string

async function call(tool: string, args: Record<string, unknown> = {}) {
  const res = await POST(new NextRequest('https://backenly.test/api/mcp/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': mcpKey },
    body: JSON.stringify({ tool, args }),
  }))
  return { status: res.status, body: await res.json() as any }
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = ${table}`
  return rows[0].n > 0
}

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `agent-restore-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'Ada Owner' },
  })).id
  const project = await createProvisionedProject({ name: 'agent-restore', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  // The agent migrates main directly here; branches have their own suite.
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })
  forgetProtection(projectId)

  mcpKey = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
  keyId = (await prisma.apiKey.create({
    data: {
      name: 'Claude Code', keyPrefix: mcpKey.slice(0, 12), keyHash: hashApiKey(mcpKey),
      userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [],
    },
  })).id
}, 180_000)

afterAll(async () => {
  const vaults = await prisma.$queryRawUnsafe<Array<{ nspname: string }>>(
    `SELECT nspname FROM pg_namespace WHERE nspname LIKE $1`, `workspace_${projectId}_r%`,
  ).catch(() => [])
  for (const v of vaults) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

describe('an agent migration, restored on a person\'s say-so', () => {
  let changeId: string
  let changeSeq: number
  let approvalId: string

  it('is the agent\'s governed change: checkpointed, applied and verified', async () => {
    // Arguments that look like they switch something off reach nothing.
    const r = await call('apply_migration', {
      sql: 'CREATE TABLE invoices (number text NOT NULL, amount integer);\nCREATE INDEX invoices_number_idx ON invoices (number)',
      skipVerification: true, verify: false, autoRecover: false, checks: [],
    })
    expect(r.status).toBe(200)
    expect(r.body.data.change).toMatchObject({ status: 'healthy', verified: true })
    expect(r.body.summary).toMatch(/Recorded as change #\d+: checkpointed, applied and verified/)
    changeId = r.body.data.change.id
    changeSeq = r.body.data.change.seq

    const row = await prisma.backendChange.findUniqueOrThrow({ where: { id: changeId } })
    expect(row).toMatchObject({ source: 'mcp', apiKeyId: keyId, actorUserId: ownerId, status: 'healthy' })
    expect((row.verification as any).checks.map((c: any) => c.id)).toEqual([
      'expected_effects', 'collateral', 'rls', 'credentials', 'api_access', 'auth', 'indexes', 'queryable',
    ])
    // The table, and the updatedAt helper function a project's first table brings.
    expect((row.footprint as any[]).map((c) => c.after).sort()).toEqual(['invoices', 'set_updated_at()'])
    expect((row.steps as any[]).map((s) => s.statement)).toEqual([
      'CREATE TABLE invoices (number text NOT NULL, amount integer)',
      'CREATE INDEX invoices_number_idx ON invoices (number)',
    ])
  }, 120_000)

  it('lets the agent read the history', async () => {
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}".invoices (number, amount) VALUES ('INV-1', 100), ('INV-2', 250)`)
    const r = await call('deploy', { action: 'changes' })
    expect(r.status).toBe(200)
    const mine = r.body.data.changes.find((c: any) => c.changeId === changeId)
    expect(mine).toMatchObject({ seq: changeSeq, actor: 'Claude Code', outcome: 'healthy', canRestore: true })
  }, 60_000)

  it('parks the agent\'s request with only what Backenly measured, and changes nothing', async () => {
    const r = await call('deploy', {
      action: 'revert_change', changeId,
      // An agent trying to pre-approve the data loss, or to run it as Backenly.
      acknowledged: { 'rows_set_aside:invoices:': 1_000_000 }, mode: 'automatic', origin: 'backenly',
    })
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('awaiting_approval')
    approvalId = r.body.approval.id
    const parked = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: approvalId } })
    expect(parked).toMatchObject({ tool: 'revert_schema_change', status: 'pending', reversible: true, apiKeyId: keyId, rowCount: 2 })
    expect(parked.toolArgs).toEqual({ changeId, acknowledged: { 'rows_set_aside:invoices:': 2 } })
    expect(parked.target).toContain(`Restore the state before change #${changeSeq}`)
    expect(parked.target).toContain('2 rows in invoices')
    expect(await tableExists('invoices')).toBe(true)
  }, 60_000)

  it('refuses the restore tool when the agent calls it directly', async () => {
    const r = await call('revert_schema_change', { changeId })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('DESTRUCTIVE_NEEDS_APPROVAL')
    expect(await tableExists('invoices')).toBe(true)
  }, 60_000)

  it('gives the agent no way to approve its own request or run a restore', async () => {
    const decide = await DECIDE(new NextRequest(`https://backenly.test/api/projects/${projectId}/agent-approvals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': mcpKey, authorization: `Bearer ${mcpKey}` },
      body: JSON.stringify({ approvalId, decision: 'approve' }),
    }), { params: Promise.resolve({ id: projectId }) } as any)
    // A platform session or nothing. (Under jest the session lookup has no
    // request scope and answers 500; in production it is 401. Either way, no.)
    expect(decide.status).toBeGreaterThanOrEqual(400)

    const restore = await RESTORE(new NextRequest(`https://backenly.test/api/projects/${projectId}/changes/${changeId}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': mcpKey, authorization: `Bearer ${mcpKey}` },
      body: JSON.stringify({ seq: changeSeq, acknowledged: { 'rows_set_aside:invoices:': 2 } }),
    }), { params: Promise.resolve({ id: projectId, changeId }) } as any)
    expect(restore.status).toBeGreaterThanOrEqual(400)

    // No MCP tool decides an approval either.
    const tool = await call('approve', { id: approvalId })
    expect(tool.status).toBeGreaterThanOrEqual(400)
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('pending')
    expect(await tableExists('invoices')).toBe(true)
  }, 60_000)

  it('cannot reach the change record through SQL', async () => {
    const read = await call('run_query', { sql: 'SELECT id FROM public.backend_changes' })
    expect(read.body.ok).not.toBe(true)
    const write = await call('run_query', { sql: `UPDATE public.backend_changes SET status = 'healthy'` })
    expect(write.body.ok).not.toBe(true)
  }, 60_000)

  it('runs the restore once a person approves, verified, and records whose decision it was', async () => {
    const pending = await call('check_approval', { id: approvalId })
    expect(pending.body.data.status).toBe('pending')

    const decided = await decideApproval({ projectId, approvalId, approverUserId: ownerId, decision: 'approve' })
    expect(decided).toMatchObject({ ok: true, status: 'executed' })

    expect(await tableExists('invoices')).toBe(false)
    const original = await prisma.backendChange.findUniqueOrThrow({ where: { id: changeId } })
    expect(original.status).toBe('restored')
    const restore = await prisma.backendChange.findUniqueOrThrow({ where: { id: original.recoveredById! } })
    expect(restore).toMatchObject({ kind: 'recovery', source: 'approval', actorUserId: ownerId, apiKeyId: keyId, status: 'healthy' })
    expect((restore.verification as any).outcome).toBe('confirmed')

    // The rows the agent's table held are kept, not deleted.
    const entry = (restore.preserved as any).entries.find((e: any) => e.kind === 'table' && e.table === 'invoices')
    const kept = await prisma.$queryRawUnsafe<Array<{ number: string }>>(`SELECT number FROM "${entry.vault}"."${entry.vaultTable}" ORDER BY number`)
    expect(kept.map((k) => k.number)).toEqual(['INV-1', 'INV-2'])

    const { changes } = await listChanges(projectId)
    const shown = changes.find((c) => c.id === changeId)!
    expect(shown.outcome.state).toBe('restored')
    expect(shown.outcome.by).toMatchObject({ type: 'person', label: "Ada Owner, approving Claude Code's request" })

    const after = await call('check_approval', { id: approvalId })
    expect(after.body.data.status).toBe('executed')
  }, 120_000)

  it('answers a request it could never carry out at once instead of parking it', async () => {
    const again = await call('deploy', { action: 'revert_change', changeId })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('RESTORE_NOT_AVAILABLE')
    const unknown = await call('deploy', { action: 'revert_change', changeId: crypto.randomUUID() })
    expect(unknown.status).toBe(404)
    expect(await prisma.agentApprovalRequest.count({ where: { projectId, status: 'pending' } })).toBe(0)
  }, 60_000)
})

describe('a migration that fails part-way', () => {
  it('is recovered automatically, and says what ran and was put back', async () => {
    await call('apply_migration', { sql: 'CREATE TABLE ledger (entry text)' })
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}".ledger (entry) VALUES ('a much longer entry')`)
    const r = await call('apply_migration', {
      sql: 'CREATE TABLE ledger_tags (tag text);\nALTER TABLE ledger ADD CONSTRAINT ledger_short CHECK (length(entry) < 5)',
    })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ ok: false, code: 'MIGRATION_FAILED', applied: [], recovered: true })
    expect(r.body.rolledBack.map((a: any) => a.statement)).toEqual(['CREATE TABLE ledger_tags (tag text)'])
    expect(await tableExists('ledger_tags')).toBe(false)

    const failed = await prisma.backendChange.findUniqueOrThrow({ where: { id: r.body.change.id } })
    expect(failed.status).toBe('recovered')
    const recovery = await prisma.backendChange.findUniqueOrThrow({ where: { id: failed.recoveredById! } })
    expect(recovery).toMatchObject({ kind: 'recovery', source: 'system', status: 'healthy' })
    const { changes } = await listChanges(projectId)
    const shown = changes.find((c) => c.id === failed.id)!
    expect(shown.actor.label).toBe('Claude Code')
    expect(shown.outcome.state).toBe('recovered')
    // The recovery is how the change ended, not a row of its own.
    expect(changes.some((c) => c.id === recovery.id)).toBe(false)
  }, 120_000)
})

describe('an agent switching off what protects production', () => {
  it('turns the autonomy dial off and sends arguments meant to skip recovery: its breaking change is recovered anyway', async () => {
    const off = await call('autonomy', { action: 'set_level', level: 'OFF' })
    expect(off.status).toBe(200)
    expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { autonomyLevel: true } })).autonomyLevel).toBe('OFF')

    // End-user sign-in, with someone signed up.
    await ensureAuthUsersTable(projectId, { email: 'owner@example.test' })
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}".users (email, password) VALUES ('end-user@example.test', 'hash')`)

    const r = await call('apply_migration', {
      sql: 'ALTER TABLE users RENAME COLUMN email TO login_email',
      autoRecover: false, recover: false, skipRecovery: true, rollback: false, protect: false, autonomy: 'OFF',
    })
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ ok: false, code: 'VERIFICATION_FAILED', applied: [], recovered: true })
    expect(r.body.error).toMatch(/sign-in/i)

    const cols = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'users'`,
    )
    expect(cols.map((c) => c.column_name)).toContain('email')
    expect(cols.map((c) => c.column_name)).not.toContain('login_email')
    expect(await prisma.$queryRawUnsafe(`SELECT email FROM "${schema}".users`)).toEqual([{ email: 'end-user@example.test' }])

    const failed = await prisma.backendChange.findUniqueOrThrow({ where: { id: r.body.change.id } })
    expect(failed).toMatchObject({ source: 'mcp', apiKeyId: keyId, status: 'recovered' })
    expect((failed.verification as any).checks.find((c: any) => c.id === 'auth')).toMatchObject({ outcome: 'contradicted' })
    const recovery = await prisma.backendChange.findUniqueOrThrow({ where: { id: failed.recoveredById! } })
    expect(recovery).toMatchObject({ kind: 'recovery', source: 'system', status: 'healthy' })
    expect((recovery.verification as any).outcome).toBe('confirmed')
  }, 120_000)
})

describe('an agent setting a table\'s access rules', () => {
  it('replaces its policies as asked: verified as the request, not recovered as a side effect', async () => {
    await call('apply_migration', { sql: 'CREATE TABLE diary (author_id uuid NOT NULL, entry text)' })
    const policies = async () => (await prisma.$queryRawUnsafe<Array<{ policyname: string }>>(
      `SELECT policyname FROM pg_policies WHERE schemaname = '${schema}' AND tablename = 'diary' ORDER BY policyname`,
    )).map((p) => p.policyname)
    const before = await policies()
    expect(before.length).toBeGreaterThan(0)

    const owner = "author_id = (backenly_jwt_claim('sub'))::uuid"
    const r = await call('set_rls', { tableName: 'diary', select: { using: 'true' }, insert: { check: owner } })
    expect({ status: r.status, ok: r.body.ok }).toEqual({ status: 200, ok: true })

    const change = await prisma.backendChange.findFirstOrThrow({ where: { projectId, apiKeyId: keyId }, orderBy: { seq: 'desc' } })
    expect(change.status).toBe('healthy')
    const rls = (change.verification as any).checks.find((c: any) => c.id === 'rls')
    expect(rls).toMatchObject({ outcome: 'confirmed', detail: expect.stringMatching(/^access rules set as asked: .*diary/) })
    // The commands it named were replaced; the ones it did not name are untouched.
    const after = await policies()
    const named = before.filter((p) => /_(select|insert)$/.test(p))
    expect(named.length).toBeGreaterThan(0)
    for (const p of named) expect(after).not.toContain(p)
    for (const p of before.filter((x) => /_(update|delete)$/.test(x))) expect(after).toContain(p)
  }, 120_000)
})
