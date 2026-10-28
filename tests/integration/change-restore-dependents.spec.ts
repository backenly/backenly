/**
 * WHAT READS A TABLE THAT A CHANGE OR A RESTORE MOVES ASIDE, AGAINST A REAL DATABASE
 * ===============================================================================
 *
 * Moving a table into a vault takes its own indexes, constraints and policies
 * with it, but not the objects other people built on it. PostgreSQL tracks
 * those by oid, so before this was enforced each one followed the table into
 * the vault and kept working against it, reported as nothing, and the vault's
 * purge dropped it from the live schema weeks later:
 *
 *   a view over a table a change created     restoring the change left the view
 *                                            serving the restore's vault
 *   a view over a table a governed drop      the drop left the view serving the
 *   moved aside                              rows it had just "dropped"
 *   a policy on another table that reads it  restoring the change left access
 *   (the org_members rule reads              decided by rows nobody could change,
 *   organization_members)                    and the purge dropped the policy,
 *                                            opening the table
 *
 * Now a restore with a reader is blocked and names it and the change that made
 * it, a drop with a reader is refused with nothing changed, and a vault that a
 * live object still reads is kept past its window instead of purged.
 *
 * Beside those, three smaller restore defects: a restore of a reapply record
 * undid a change that stayed reported as in effect; a change that created an
 * enum type and a column of it on an existing table could not be restored; and
 * an automatic recovery of a change that took away the API's privileges reported
 * "restored and verified" with the privileges still gone.
 */

// The plan's restore window, in days. One block shortens it to past.
const retention = { days: 7 }
jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'SANDBOX', logRetentionDays: retention.days }) }
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

import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { expectEffect, withGovernedChange, withChangeAttribution } from '@/lib/changes/ledger'
import { archiveTable } from '@/lib/changes/preserve'
import { previewRecovery, recoverChange, recoverRejectedRepair } from '@/lib/changes/recovery'
import { purgeExpiredVaults } from '@/lib/changes/retention'
import { VAULT_GRACE_DAYS } from '@/lib/changes/policy'
import { listChanges } from '@/lib/changes/history'
import { closeChangeLockPool } from '@/lib/changes/lock'
import { revertAutoFix } from '@/lib/core/auto-fix-engine'
import { createApprovalRequest, decideApproval } from '@/lib/mcp/approvals'
import { hashApiKey } from '@/lib/auth/apiKeyAuth'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE
const DAY = 24 * 60 * 60 * 1000
const WINDOW_DAYS = 7

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)
const record = (id: string) => prisma.backendChange.findUniqueOrThrow({ where: { id } })

/** The schema a relation is in now, among this project's workspace and vaults. */
async function schemaOf(name: string): Promise<string | null> {
  const r = await rows<{ nspname: string }>(
    `SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = '${name}' AND n.nspname LIKE 'workspace_${projectId}%'`,
  )
  return r[0]?.nspname ?? null
}

async function policiesOn(table: string): Promise<string[]> {
  const r = await rows<{ polname: string }>(`SELECT polname FROM pg_policy WHERE polrelid = '${T(table)}'::regclass ORDER BY 1`)
  return r.map((x) => x.polname)
}

async function change(title: string, fn: () => Promise<unknown>, source: 'dashboard' | 'mcp' = 'dashboard') {
  const attr = source === 'dashboard' ? { source: 'dashboard' as const, actorUserId: ownerId } : { source: 'mcp' as const }
  const { change: closed } = await withChangeAttribution(attr, () => withGovernedChange({ projectId, title }, async () => { await fn() }))
  if (!closed) throw new Error(`"${title}" recorded nothing`)
  return closed
}

const restore = (id: string) => recoverChange(projectId, id, { mode: 'manual', actorUserId: ownerId, acknowledged: null })

/** The moment a change's vault is past its window and grace. */
async function pastRetention(changeId: string): Promise<Date> {
  const r = await record(changeId)
  return new Date(r.createdAt.getTime() + (WINDOW_DAYS + VAULT_GRACE_DAYS) * DAY + 60_000)
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  // The data plane's roles, as the PostgREST install leaves them.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    if ((await rows(`SELECT 1 FROM pg_roles WHERE rolname = '${role}'`)).length === 0) await ddl(`CREATE ROLE ${role} NOLOGIN`)
  }
  ownerId = (await prisma.user.create({
    data: { email: `dependents-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'change-restore-dependents', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 120_000)

afterAll(async () => {
  const vaults = await rows<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

// ── A view over a table a change created ─────────────────────────────────────

describe('a view made outside Backenly over a table a change created', () => {
  let changeId: string

  beforeAll(async () => {
    changeId = (await change('create v_orders', async () => {
      await ddl(`CREATE TABLE ${T('v_orders')} (id serial PRIMARY KEY, total int NOT NULL)`)
    })).id
    // A developer's read-write connection, with no rows written yet.
    await ddl(`CREATE VIEW ${T('v_order_totals')} AS SELECT id, total FROM ${T('v_orders')}`)
  })

  it('blocks the restore, naming the view, and the proof changes nothing', async () => {
    const p = (await previewRecovery(projectId, changeId))!
    expect(p.safety).toBe('blocked')
    expect(p.reason).toBe('view v_order_totals reads table v_orders and was created after this change')
    expect(p.checks.find((c) => c.id === 'plan')).toMatchObject({ ok: false })
    expect(await schemaOf('v_orders')).toBe(schema)
  })

  it('refuses to restore, and nothing changes', async () => {
    const out = await restore(changeId)
    expect(out).toMatchObject({ ok: false, code: 'CONFLICT', status: 'healthy' })
    expect((out as any).error).toMatch(/view v_order_totals reads table v_orders/)
    expect((await record(changeId)).status).toBe('healthy')
    expect(await schemaOf('v_orders')).toBe(schema)
    expect(await schemaOf('v_order_totals')).toBe(schema)
    expect(await rows(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`)).toEqual([])
  })

  it('restores once the view is gone', async () => {
    await ddl(`DROP VIEW ${T('v_order_totals')}`)
    const out = await restore(changeId)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
  })
})

// ── A view over a table a governed drop moves aside ──────────────────────────

describe('a view over a table that a governed drop would move into the vault', () => {
  beforeAll(async () => {
    await ddl(`CREATE TABLE ${T('d_items')} (id serial PRIMARY KEY, name text)`)
    await ddl(`INSERT INTO ${T('d_items')} (name) VALUES ('a'), ('b')`)
    await ddl(`CREATE VIEW ${T('d_item_names')} AS SELECT name FROM ${T('d_items')}`)
  })

  it('refuses the drop, naming the view, and changes nothing', async () => {
    let message = ''
    const { change: closed } = await withChangeAttribution({ source: 'approval', actorUserId: ownerId }, () =>
      withGovernedChange({ projectId, title: 'drop d_items' }, async () => {
        await archiveTable(projectId, schema, 'd_items').catch((err: Error) => { message = err.message; throw err })
      }).catch((err) => ({ change: null, err })))
    expect(closed).toBeNull()
    expect(message).toBe('d_items was not dropped, because other objects read it: view d_item_names reads table d_items. Remove or change them first, then drop d_items.')
    expect(await schemaOf('d_items')).toBe(schema)
    expect(await rows(`SELECT name FROM ${T('d_item_names')} ORDER BY name`)).toEqual([{ name: 'a' }, { name: 'b' }])
    const failed = await prisma.backendChange.findFirstOrThrow({ where: { projectId, title: 'drop d_items' } })
    expect(failed.status).toBe('failed')
  })

  it('drops, keeping the rows, once nothing reads it', async () => {
    await ddl(`DROP VIEW ${T('d_item_names')}`)
    const c = await change('drop d_items again', async () => {
      expect((await archiveTable(projectId, schema, 'd_items')).handled).toBe(true)
    }, 'dashboard')
    expect(c.status).toBe('healthy')
    expect(await schemaOf('d_items')).toBe(`workspace_${projectId}_r${c.seq}`)
  })
})

// ── A policy on another table that reads a table a change created ───────────

describe('a policy on another table that reads a table a change created (the org_members rule)', () => {
  let membersChange: string
  let rulesChange: { id: string; seq: number }

  beforeAll(async () => {
    await ddl(`CREATE TABLE ${T('p_invoices')} (id serial PRIMARY KEY, organization_id int, amount int)`)
    membersChange = (await change('create p_members', async () => {
      await ddl(`CREATE TABLE ${T('p_members')} (organization_id int, user_id text)`)
    })).id
    const rules = await change('only members read p_invoices', async () => {
      await ddl(`ALTER TABLE ${T('p_invoices')} ENABLE ROW LEVEL SECURITY`)
      await ddl(`CREATE POLICY p_members_only ON ${T('p_invoices')} AS RESTRICTIVE FOR SELECT TO PUBLIC USING (organization_id IN (SELECT organization_id FROM ${T('p_members')}))`)
      await ddl(`CREATE POLICY p_read ON ${T('p_invoices')} FOR SELECT TO PUBLIC USING (true)`)
    })
    rulesChange = { id: rules.id, seq: rules.seq }
  })

  it('blocks the restore, naming the policy and the change that made it', async () => {
    const p = (await previewRecovery(projectId, membersChange))!
    expect(p.safety).toBe('blocked')
    expect(p.reason).toBe('policy p_members_only on table p_invoices reads table p_members and was created after this change')
    expect(p.blockedBy.map((b) => b.seq)).toEqual([rulesChange.seq])
    const out = await restore(membersChange)
    expect(out).toMatchObject({ ok: false, code: 'CONFLICT' })
    expect((out as any).blockedBy.map((b: { seq: number }) => b.seq)).toEqual([rulesChange.seq])
    expect(await schemaOf('p_members')).toBe(schema)
    expect(await policiesOn('p_invoices')).toEqual(['p_members_only', 'p_read'])
  })

  it('restoring the later change first clears the way', async () => {
    expect(await restore(rulesChange.id)).toMatchObject({ ok: true })
    expect(await policiesOn('p_invoices')).toEqual([])
    expect(await restore(membersChange)).toMatchObject({ ok: true, status: 'restored' })
  })
})

// ── The purge never cascades into the live schema ────────────────────────────

describe('a vault that a live object reads (left by a restore made before this was enforced)', () => {
  let changeId: string
  let vault: string

  beforeAll(async () => {
    await ddl(`CREATE TABLE ${T('k_docs')} (id serial PRIMARY KEY, team int)`)
    await ddl(`CREATE TABLE ${T('k_teams')} (team int)`)
    const c = await change('drop k_teams', async () => {
      expect((await archiveTable(projectId, schema, 'k_teams')).handled).toBe(true)
    })
    changeId = c.id
    vault = `workspace_${projectId}_r${c.seq}`
    // What an earlier restore could leave: a live policy reading a vaulted table.
    await ddl(`ALTER TABLE ${T('k_docs')} ENABLE ROW LEVEL SECURITY`)
    await ddl(`CREATE POLICY k_team_only ON ${T('k_docs')} AS RESTRICTIVE FOR SELECT TO PUBLIC USING (team IN (SELECT team FROM "${vault}"."k_teams"))`)
    await ddl(`CREATE POLICY k_read ON ${T('k_docs')} FOR SELECT TO PUBLIC USING (true)`)
  })

  it('is kept past its window, with the reader named, and the live policy survives', async () => {
    const { purged, kept } = await purgeExpiredVaults(projectId, await pastRetention(changeId))
    expect(purged).not.toContain(vault)
    expect(kept).toEqual([{ vault, readers: [{ dependent: 'policy k_team_only on table k_docs', reads: 'table k_teams', owner: 'k_docs' }] }])
    expect(await policiesOn('k_docs')).toEqual(['k_read', 'k_team_only'])
    expect((await record(changeId)).preserved).not.toHaveProperty('purgedAt')
  })

  it('is purged once nothing outside reads it', async () => {
    await ddl(`DROP POLICY k_team_only ON ${T('k_docs')}`)
    const { purged, kept } = await purgeExpiredVaults(projectId, await pastRetention(changeId))
    expect(purged).toContain(vault)
    expect(kept).toEqual([])
    expect(await policiesOn('k_docs')).toEqual(['k_read'])
  })
})

// ── Reapply only from the change itself ──────────────────────────────────────

describe('restore, reapply, then the reapply record named directly', () => {
  it('is not available, so the change is never reported in effect while undone', async () => {
    const c = await change('add r_t', async () => { await ddl(`CREATE TABLE ${T('r_t')} (id int PRIMARY KEY)`) })
    const first = await restore(c.id)
    expect(first.ok).toBe(true)
    const reapplied = await restore((first as any).recoveryId)
    expect(reapplied.ok).toBe(true)
    const reapplyRecord = (reapplied as any).recoveryId as string
    expect((await record(c.id)).status).toBe('healthy')

    const p = (await previewRecovery(projectId, reapplyRecord))!
    expect(p.safety).toBe('unavailable')
    expect(p.reason).toBe('Only the latest restore of a change can be reapplied, from that change.')
    expect(await restore(reapplyRecord)).toMatchObject({ ok: false, code: 'NOT_AVAILABLE' })
    expect(await schemaOf('r_t')).toBe(schema)

    // The way back is the change itself, as the history offers it.
    const listed = (await listChanges(projectId)).changes.find((x) => x.id === c.id)!
    expect(listed.action).toMatchObject({ kind: 'restore', recordId: c.id, available: true })
    expect(await restore(c.id)).toMatchObject({ ok: true, status: 'restored' })
    expect((await record(c.id)).status).toBe('restored')
  })
})

// ── An enum type and a column of it on a table that stays ────────────────────

describe('a change that created an enum type and added a column of it to an existing table', () => {
  it('restores, keeping the type the kept column needs, and reapplies', async () => {
    await ddl(`CREATE TABLE ${T('e_tickets')} (id serial PRIMARY KEY, title text)`)
    await ddl(`INSERT INTO ${T('e_tickets')} (title) VALUES ('x')`)
    const c = await change('ticket status', async () => {
      await ddl(`CREATE TYPE ${T('e_status')} AS ENUM ('open', 'closed')`)
      await ddl(`ALTER TABLE ${T('e_tickets')} ADD COLUMN status ${T('e_status')}`)
    })
    expect((await previewRecovery(projectId, c.id))!.safety).toBe('lossless')
    const out = await restore(c.id)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    expect((out as any).verification.checks.find((x: { label: string }) => x.label === 'e_status').detail).toMatch(/kept: e_tickets\.status, kept in the recovery snapshot, uses it/)
    expect(await rows(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'e_tickets' ORDER BY 1`))
      .toEqual([{ column_name: 'id' }, { column_name: 'title' }])
    expect(await restore((out as any).recoveryId)).toMatchObject({ ok: true })
    expect(await rows(`SELECT status::text FROM ${T('e_tickets')}`)).toEqual([{ status: null }])
  })
})

// ── Privileges a change took away ────────────────────────────────────────────

describe("an agent change that took away the API's privileges on a table", () => {
  it('is recovered with the privileges back, and only those', async () => {
    await ddl(`CREATE TABLE ${T('g_posts')} (id serial PRIMARY KEY, title text)`)
    await ddl(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${T('g_posts')} TO authenticated, service_role`)
    const c = await change('agent edits g_posts', async () => {
      await ddl(`ALTER TABLE ${T('g_posts')} ADD COLUMN slug text`)
      await ddl(`REVOKE ALL ON ${T('g_posts')} FROM authenticated, service_role`)
      await ddl(`GRANT SELECT ON ${T('g_posts')} TO anon`)
    }, 'mcp')
    expect(c.verification!.checks.find((x) => x.id === 'api_access')).toMatchObject({ outcome: 'contradicted' })
    expect(c.status).toBe('recovered')
    const grants = await rows<{ grantee: string; privilege_type: string }>(
      `SELECT grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = '${schema}' AND table_name = 'g_posts' AND grantee IN ('anon', 'authenticated', 'service_role') ORDER BY 1, 2`,
    )
    expect(grants.map((g) => `${g.grantee}:${g.privilege_type}`)).toEqual([
      // What the change added is left: grants also move for reasons that are not the change's.
      'anon:SELECT',
      'authenticated:DELETE', 'authenticated:INSERT', 'authenticated:SELECT', 'authenticated:UPDATE',
      'service_role:DELETE', 'service_role:INSERT', 'service_role:SELECT', 'service_role:UPDATE',
    ])
  })
})

// ── A restore that needs approval can be given one ───────────────────────────

describe('a table dropped and created again under its name, its rows not kept', () => {
  it('needs approval for coming back empty, and runs with that approval', async () => {
    await ddl(`CREATE TABLE ${T('a_logs')} (id serial PRIMARY KEY, line text)`)
    await ddl(`INSERT INTO ${T('a_logs')} (line) VALUES ('one')`)
    // Outside preserve (a statement the ledger did not route through the vault).
    const c = await change('recreate a_logs', async () => {
      await ddl(`DROP TABLE ${T('a_logs')}`)
      await ddl(`CREATE TABLE ${T('a_logs')} (id serial PRIMARY KEY, line text, level int)`)
    })
    expect(c.footprint.map((f) => `${f.kind}:${f.after ?? f.before}`)).toEqual(['replaced:a_logs'])
    const p = (await previewRecovery(projectId, c.id))!
    expect(p.safety).toBe('needs_approval')
    expect(p.acknowledgement).toEqual({ 'restore_incomplete:a_logs:': 1 })
    expect(await recoverChange(projectId, c.id, { mode: 'manual', actorUserId: ownerId, acknowledged: {} })).toMatchObject({ ok: false, code: 'NEEDS_APPROVAL' })
    const out = await recoverChange(projectId, c.id, { mode: 'manual', actorUserId: ownerId, acknowledged: p.acknowledgement })
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    expect(await rows(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'a_logs' ORDER BY 1`))
      .toEqual([{ column_name: 'id' }, { column_name: 'line' }])
  })
})

// ── Undo of an applied fix whose restore point has expired ───────────────────

describe("Health's undo of a fix whose restore point has expired", () => {
  it('refuses and says why, instead of reporting the fix reverted', async () => {
    await ddl(`CREATE TABLE ${T('h_orders')} (id serial PRIMARY KEY, customer int)`)
    const c = await change('index h_orders.customer', async () => {
      await ddl(`CREATE INDEX h_orders_customer_idx ON ${T('h_orders')} (customer)`)
    })
    const finding = await prisma.healthFinding.create({
      data: {
        projectId,
        type: 'missing_fk_index',
        severity: 'warning',
        status: 'auto_fixed',
        autoFixed: true,
        details: { tableName: 'h_orders', rollbackData: { rollbackFormat: 3, schemaTouching: true, changeIds: [c.id], statements: [] } },
      },
    })
    retention.days = 1e-9
    try {
      const out = await revertAutoFix(finding.id, projectId)
      expect(out.success).toBe(false)
      expect(out.message).toMatch(/^Not undone: Restore points are kept for .* days on this plan, and this one has expired\./)
    } finally {
      retention.days = 7
    }
    expect((await record(c.id)).status).toBe('healthy')
    expect(await rows(`SELECT 1 FROM pg_indexes WHERE schemaname = '${schema}' AND indexname = 'h_orders_customer_idx'`)).toHaveLength(1)
  })
})

// ── A change that failed its checks is not reapplied as verified ─────────────

describe('a change that failed its checks, restored by a person', () => {
  it('is not offered for reapply, so it never comes back reported healthy', async () => {
    await ddl(`CREATE TABLE ${T('f_notes')} (id serial PRIMARY KEY, body text, extra text)`)
    await ddl(`INSERT INTO ${T('f_notes')} (body, extra) VALUES ('a', 'x'), ('b', 'y')`)
    await ddl(`ALTER TABLE ${T('f_notes')} ENABLE ROW LEVEL SECURITY`)
    // An agent turns row-level security off: verification fails, and the
    // recovery waits for a person (the column it dropped kept no values, so
    // recovering would bring it back empty).
    const c = await change('agent opens f_notes', async () => {
      await ddl(`ALTER TABLE ${T('f_notes')} DROP COLUMN extra`)
      await ddl(`ALTER TABLE ${T('f_notes')} DISABLE ROW LEVEL SECURITY`)
    }, 'mcp')
    expect(c.status).toBe('awaiting_approval')
    const p = (await previewRecovery(projectId, c.id))!
    const restored = await recoverChange(projectId, c.id, { mode: 'manual', actorUserId: ownerId, acknowledged: p.acknowledgement })
    expect(restored).toMatchObject({ ok: true, status: 'restored' })

    const listed = (await listChanges(projectId)).changes.find((x) => x.id === c.id)!
    expect(listed.action).toMatchObject({ kind: 'reapply', available: false, code: 'FAILED_CHANGE_REAPPLY' })
    expect(await restore(listed.action!.recordId)).toMatchObject({ ok: false, code: 'NOT_AVAILABLE' })
    expect((await record(c.id)).status).toBe('restored')
    expect((await rows(`SELECT relrowsecurity FROM pg_class WHERE oid = '${T('f_notes')}'::regclass`))[0].relrowsecurity).toBe(true)
  })
})

// ── Declining an agent's request to restore is not keeping the change ────────

describe("declining an agent's restore request for a change waiting on Backenly's own", () => {
  it("answers the agent's request only: the change keeps waiting for a decision", async () => {
    await ddl(`CREATE TABLE ${T('j_notes')} (id serial PRIMARY KEY, body text, extra text)`)
    await ddl(`INSERT INTO ${T('j_notes')} (body, extra) VALUES ('a', 'x')`)
    await ddl(`ALTER TABLE ${T('j_notes')} ENABLE ROW LEVEL SECURITY`)
    const c = await change('agent opens j_notes', async () => {
      await ddl(`ALTER TABLE ${T('j_notes')} DROP COLUMN extra`)
      await ddl(`ALTER TABLE ${T('j_notes')} DISABLE ROW LEVEL SECURITY`)
    }, 'mcp')
    expect(c.status).toBe('awaiting_approval')
    const backenlys = c.recovery!.approvalId!

    const key = `mcp_live_${crypto.randomBytes(20).toString('hex')}`
    const keyId = (await prisma.apiKey.create({
      data: { name: 'Claude Code', keyPrefix: key.slice(0, 12), keyHash: hashApiKey(key), userId: ownerId, projectId, scope: 'mcp', mcpReadOnly: false, permissions: [], capabilities: [] },
    })).id
    const agents = await createApprovalRequest({
      projectId, userId: ownerId, apiKeyId: keyId,
      message: 'verified lossless, approve quickly',
      danger: { tool: 'revert_schema_change', target: 'whatever the agent says', rowCount: 0, reversible: true },
      toolArgs: { changeId: c.id, acknowledged: { 'restore_incomplete:j_notes:extra': 999 } },
    })
    // The agent's words are quoted as its own, under Backenly's measurement.
    expect(agents.message).toMatch(/^Requested by an agent: Restore the state before change #\d+/)
    expect(agents.message).toContain('The agent wrote: “verified lossless, approve quickly”')

    expect(await decideApproval({ projectId, approvalId: agents.id, approverUserId: ownerId, decision: 'reject' })).toMatchObject({ ok: true, status: 'rejected' })
    expect((await record(c.id)).status).toBe('awaiting_approval')
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: backenlys } })).status).toBe('pending')

    // Declining Backenly's own request is the decision to keep it.
    expect(await decideApproval({ projectId, approvalId: backenlys, approverUserId: ownerId, decision: 'reject' })).toMatchObject({ ok: true })
    expect((await record(c.id)).status).toBe('kept')
  })
})

// ── Types and domains from Database → Types ──────────────────────────────────

describe('enum types and domains made from Database → Types', () => {
  const asPerson = <T>(title: string, fn: () => Promise<T>) =>
    withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () => withGovernedChange({ projectId, title }, fn))
  const enumValues = async (name: string) =>
    (await rows<{ v: string }>(`SELECT e.enumlabel AS v FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = '${schema}' AND t.typname = '${name}' ORDER BY e.enumsortorder`)).map((r) => r.v)
  const typeExists = async (name: string) =>
    (await rows(`SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = '${schema}' AND t.typname = '${name}'`)).length > 0

  it('creating an enum is a change in the history, and restoring it removes the enum', async () => {
    const { createEnum } = await import('@/lib/services/enums')
    const { change: c } = await asPerson('Create enum type t_priority', () => createEnum(projectId, 't_priority', ['low', 'high']))
    expect(c).toMatchObject({ status: 'healthy' })
    expect(c!.footprint.map((f) => `${f.kind}:${f.object}:${f.after}`)).toEqual(['added:type:t_priority'])
    expect(await restore(c!.id)).toMatchObject({ ok: true, status: 'restored' })
    expect(await typeExists('t_priority')).toBe(false)
  })

  it('renaming a value is restorable: the old label comes back, rows keep their value', async () => {
    const { createEnum, renameEnumValue } = await import('@/lib/services/enums')
    await createEnum(projectId, 't_stage', ['draft', 'live'])
    await ddl(`CREATE TABLE ${T('t_posts')} (id serial PRIMARY KEY, stage "${schema}".t_stage)`)
    await ddl(`INSERT INTO ${T('t_posts')} (stage) VALUES ('live')`)
    const { change: c } = await asPerson('Rename a value of enum type t_stage', () => renameEnumValue(projectId, 't_stage', 'live', 'published'))
    expect(c!.footprint.map((f) => `${f.kind}:${f.object}:${f.after}`)).toEqual(['modified:type:t_stage'])
    expect((await previewRecovery(projectId, c!.id))!.safety).toBe('lossless')
    expect(await restore(c!.id)).toMatchObject({ ok: true, status: 'restored' })
    expect(await enumValues('t_stage')).toEqual(['draft', 'live'])
    expect(await rows(`SELECT stage::text FROM ${T('t_posts')}`)).toEqual([{ stage: 'live' }])
  })

  it('adding a value is in the history, and says plainly that it cannot be taken back', async () => {
    const { addEnumValue } = await import('@/lib/services/enums')
    const { change: c } = await asPerson('Add a value to enum type t_stage', () => addEnumValue(projectId, 't_stage', 'archived'))
    expect(c).toMatchObject({ status: 'healthy' })
    const p = (await previewRecovery(projectId, c!.id))!
    expect(p.safety).toBe('blocked')
    expect(p.reason).toBe('values added to type t_stage cannot be removed again')
  })

  it('creating a domain is captured, and restoring it drops the domain', async () => {
    const { createDomain } = await import('@/lib/services/enums')
    const { change: c } = await asPerson('Create domain t_email', () =>
      createDomain(projectId, { name: 't_email', baseType: 'text', notNull: true, check: "VALUE LIKE '%@%'" }))
    expect(c!.footprint.map((f) => `${f.kind}:${f.object}:${f.after}`)).toEqual(['added:type:t_email'])
    expect(await restore(c!.id)).toMatchObject({ ok: true, status: 'restored' })
    expect(await typeExists('t_email')).toBe(false)
  })

  it('dropping an unused enum is restorable: the enum comes back with its values', async () => {
    const { createEnum, dropType } = await import('@/lib/services/enums')
    await createEnum(projectId, 't_size', ['s', 'm', 'l'])
    const { change: c } = await asPerson('Drop type t_size', () => dropType(projectId, 't_size'))
    expect(c!.footprint.map((f) => `${f.kind}:${f.object}:${f.before}`)).toEqual(['removed:type:t_size'])
    expect(await restore(c!.id)).toMatchObject({ ok: true, status: 'restored' })
    expect(await enumValues('t_size')).toEqual(['s', 'm', 'l'])
  })
})

// ── A change that only takes the API's privileges away ───────────────────────

describe("a change that only revokes the API's privileges on a table", () => {
  const granted = async (table: string) =>
    (await rows<{ g: string }>(`SELECT grantee || ':' || privilege_type AS g FROM information_schema.role_table_grants WHERE table_schema = '${schema}' AND table_name = '${table}' AND grantee IN ('anon','authenticated','service_role') ORDER BY 1`)).map((r) => r.g)

  it('by an agent: recorded, fails "API access kept", and is recovered with the privileges back', async () => {
    await ddl(`CREATE TABLE ${T('q_notes')} (id serial PRIMARY KEY)`)
    await ddl(`GRANT SELECT, INSERT ON ${T('q_notes')} TO authenticated, service_role`)
    const c = await change('agent revokes', async () => {
      await ddl(`REVOKE ALL ON ${T('q_notes')} FROM authenticated`)
    }, 'mcp')
    expect(c.footprint.map((f) => `${f.kind}:${f.after}`)).toEqual(['modified:q_notes'])
    expect(c.summary).toBe('Took away API access to q_notes')
    expect(c.verification!.checks.find((x) => x.id === 'api_access')).toMatchObject({ outcome: 'contradicted' })
    expect(c.status).toBe('recovered')
    expect(await granted('q_notes')).toEqual(['authenticated:INSERT', 'authenticated:SELECT', 'service_role:INSERT', 'service_role:SELECT'])
  })

  it('by a person: recorded as their decision, and restorable later', async () => {
    await ddl(`CREATE TABLE ${T('q_public')} (id serial PRIMARY KEY)`)
    await ddl(`GRANT SELECT ON ${T('q_public')} TO anon`)
    const c = await change('make q_public private', async () => {
      await ddl(`REVOKE SELECT ON ${T('q_public')} FROM anon`)
    })
    expect(c.status).toBe('healthy')
    expect(await granted('q_public')).toEqual([])
    expect(await restore(c.id)).toMatchObject({ ok: true, status: 'restored' })
    expect(await granted('q_public')).toEqual(['anon:SELECT'])
  })
})

// ── A column added with a volatile default ───────────────────────────────────

describe('a change that added a column with DEFAULT now() to a table with rows', () => {
  it('keeps what it filled in, so its failure is recovered automatically, losslessly', async () => {
    await ddl(`CREATE TABLE ${T('v_events')} (id serial PRIMARY KEY, name text)`)
    await ddl(`INSERT INTO ${T('v_events')} (name) VALUES ('a'), ('b'), ('c')`)
    await ddl(`ALTER TABLE ${T('v_events')} ENABLE ROW LEVEL SECURITY`)
    const c = await change('agent adds seen_at and opens v_events', async () => {
      await ddl(`ALTER TABLE ${T('v_events')} ADD COLUMN seen_at timestamptz DEFAULT now()`)
      await ddl(`ALTER TABLE ${T('v_events')} DISABLE ROW LEVEL SECURITY`)
    }, 'mcp')
    expect(c.status).toBe('recovered')
    expect(c.recovery).toMatchObject({ status: 'recovered', verified: true })
    expect((await rows(`SELECT relrowsecurity FROM pg_class WHERE oid = '${T('v_events')}'::regclass`))[0].relrowsecurity).toBe(true)
    expect(await rows(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = 'v_events' ORDER BY 1`))
      .toEqual([{ column_name: 'id' }, { column_name: 'name' }])
  })

  it('a write made after the change still needs a person, and is counted exactly', async () => {
    await ddl(`CREATE TABLE ${T('v_visits')} (id serial PRIMARY KEY, page text)`)
    await ddl(`INSERT INTO ${T('v_visits')} (page) VALUES ('/'), ('/docs')`)
    const c = await change('add seen_at to v_visits', async () => {
      await ddl(`ALTER TABLE ${T('v_visits')} ADD COLUMN seen_at timestamptz DEFAULT now()`)
    })
    expect((await previewRecovery(projectId, c.id))!.safety).toBe('lossless')
    await ddl(`UPDATE ${T('v_visits')} SET seen_at = '2020-01-01' WHERE page = '/docs'`)
    await ddl(`INSERT INTO ${T('v_visits')} (page) VALUES ('/new')`)
    const p = (await previewRecovery(projectId, c.id))!
    expect(p.safety).toBe('needs_approval')
    expect(p.acknowledgement).toEqual({ 'values_set_aside:v_visits:seen_at': 2 })
    expect(p.reason).toMatch(/^2 values in v_visits.seen_at were written since this change/)
  })
})

// ── A repair Backenly's own check rejected ───────────────────────────────────

describe("undoing a repair that Backenly's own check rejected", () => {
  it('goes through the change history: restored exactly, recorded as Backenly undoing its repair', async () => {
    await ddl(`CREATE TABLE ${T('r_docs')} (id serial PRIMARY KEY, owner text)`)
    await ddl(`ALTER TABLE ${T('r_docs')} ENABLE ROW LEVEL SECURITY`)
    await ddl(`CREATE POLICY r_open ON ${T('r_docs')} FOR SELECT TO PUBLIC USING (true)`)
    const { change: repair } = await withChangeAttribution({ source: 'autonomy' }, () =>
      withGovernedChange({ projectId, title: 'tighten r_docs' }, async () => {
        // As the SET_PERMISSION repair declares it: replacing this table's rules is what was asked.
        expectEffect(projectId, { action: 'SET_PERMISSION', table: 'r_docs' })
        await ddl(`DROP POLICY r_open ON ${T('r_docs')}`)
        await ddl(`CREATE POLICY r_owner ON ${T('r_docs')} FOR SELECT TO PUBLIC USING (owner = current_user)`)
      }))
    expect(repair!.status).toBe('healthy')

    const out = await recoverRejectedRepair(projectId, [repair!.id])
    expect(out.status).toBe('verified')
    expect(out.message).toBe(`Restored the state before #${repair!.seq} through the change history, verified.`)
    expect(await policiesOn('r_docs')).toEqual(['r_open'])
    const r = await record(repair!.id)
    expect(r.status).toBe('recovered')
    const undo = await prisma.backendChange.findUniqueOrThrow({ where: { id: r.recoveredById! } })
    expect(undo).toMatchObject({ kind: 'recovery', source: 'autonomy', title: `Undo Backenly's repair #${repair!.seq}`, status: 'healthy' })

    // Asked again: already back, nothing more to do.
    expect(await recoverRejectedRepair(projectId, [repair!.id])).toMatchObject({ status: 'not_needed' })
  })
})
