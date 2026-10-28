/**
 * PROTECTED VERIFICATION AND AUTOMATIC RECOVERY, AGAINST A REAL DATABASE
 * ======================================================================
 *
 * What happens after a change applies, with no part of the database stubbed:
 *
 *   a change that breaks production in a way nobody asked for (row-level
 *   security turned off by an agent, a view removed by a CASCADE, a step that
 *   did not take effect) fails verification and is recovered on the spot when
 *   that is provably lossless, and the recovery is itself verified;
 *   the same change made by a person in the dashboard is their decision;
 *   a recovery that would cost data waits for a person in the existing
 *   approvals inbox, with the impact Backenly measured, never anything else;
 *   approving runs it (admin only), declining keeps the change, and a restore
 *   from the console answers the pending request;
 *   a change that fails part-way is recovered too;
 *   a recovery that fails stops automation for the project until a person
 *   decides, and says so;
 *   work interrupted by a restart is settled from the catalog, never re-run;
 *   turning autonomy off does not turn any of this off;
 *   a restore whose connection is cut is rolled back and can run again, and a
 *   restore that ran but left production unlike its restore point is never
 *   reported as recovered.
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

import crypto from 'crypto'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { expectEffect, withChangeAttribution, withGovernedChange } from '@/lib/changes/ledger'
import { keepColumnValues } from '@/lib/changes/preserve'
import { keepChange, previewRecovery, recoverChange, reconcileChange } from '@/lib/changes/recovery'
import { claimRecovery } from '@/lib/changes/lifecycle'
import { listChanges } from '@/lib/changes/history'
import { closeChangeLockPool, readCatalogOn, withChangeLock } from '@/lib/changes/lock'
import { openChangeContext } from '@/lib/changes/context'
import { decideApproval } from '@/lib/mcp/approvals'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let strangerId: string
let projectId: string
let schema: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)
const record = (id: string) => prisma.backendChange.findUniqueOrThrow({ where: { id } })
const events = async (id: string) =>
  (await prisma.backendChangeEvent.findMany({ where: { changeId: id }, orderBy: { at: 'asc' } })).map((e) => e.type)

async function rlsOn(table: string): Promise<boolean> {
  const r = await rows<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE oid = '${T(table)}'::regclass`)
  return r[0].on
}

async function columnsOf(table: string): Promise<string[]> {
  const r = await rows<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY column_name`,
  )
  return r.map((x) => x.column_name)
}

/** A change as a coding agent's request makes it. */
function asAgent<T>(title: string, fn: () => Promise<T>) {
  return withChangeAttribution({ source: 'mcp' }, () => withGovernedChange({ projectId, title }, fn))
}

/** A table with row-level security on and a policy. */
async function protectedTable(name: string) {
  await ddl(`CREATE TABLE ${T(name)} (id serial PRIMARY KEY, owner text, body text)`)
  await ddl(`ALTER TABLE ${T(name)} ENABLE ROW LEVEL SECURITY`)
  await ddl(`CREATE POLICY ${name}_own ON ${T(name)} USING (owner = current_user)`)
}

/** Make a change that fails verification and whose recovery needs a person. */
async function escalated(name: string) {
  await protectedTable(name)
  await ddl(`ALTER TABLE ${T(name)} ADD COLUMN extra text`)
  await ddl(`INSERT INTO ${T(name)} (owner, body, extra) VALUES ('a', 'x', 'kept nowhere')`)
  // Dropping a column without keeping its values, and turning RLS off: the
  // second fails verification, the first makes recovering cost data.
  const { change } = await asAgent(`break ${name}`, async () => {
    await ddl(`ALTER TABLE ${T(name)} DROP COLUMN extra`)
    await ddl(`ALTER TABLE ${T(name)} DISABLE ROW LEVEL SECURITY`)
  })
  return change!
}

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  const hex = () => crypto.randomBytes(6).toString('hex')
  ownerId = (await prisma.user.create({ data: { email: `verify-${hex()}@example.test`, password: 'x', name: 'owner' } })).id
  strangerId = (await prisma.user.create({ data: { email: `stranger-${hex()}@example.test`, password: 'x', name: 'stranger' } })).id
  const project = await createProvisionedProject({ name: 'change-verification', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 120_000)

afterAll(async () => {
  const vaults = await rows<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId].filter(Boolean) } } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

// ── Recovered automatically ──────────────────────────────────────────────────

describe('a change that breaks production, recovered automatically', () => {
  it('an agent turning row-level security off fails verification and is put back, verified', async () => {
    await protectedTable('secrets')
    const { change } = await asAgent('add a note column', async () => {
      await ddl(`ALTER TABLE ${T('secrets')} ADD COLUMN note text`)
      await ddl(`ALTER TABLE ${T('secrets')} DISABLE ROW LEVEL SECURITY`)
    })
    expect(change!.verification!.checks.find((c) => c.id === 'rls')).toMatchObject({ outcome: 'contradicted' })
    expect(change!.status).toBe('recovered')
    expect(change!.recovery).toMatchObject({ status: 'recovered', verified: true })

    expect(await rlsOn('secrets')).toBe(true)
    expect(await columnsOf('secrets')).toEqual(['body', 'id', 'owner'])
    expect(await events(change!.id)).toEqual([
      'checkpointed', 'applied', 'verification_failed', 'recovery_started', 'recovery_verified', 'recovery_completed',
    ])
    const rec = await record((await record(change!.id)).recoveredById!)
    expect(rec).toMatchObject({ kind: 'recovery', status: 'healthy', source: 'system' })
    expect((rec.verification as any).outcome).toBe('confirmed')

    const audit = await prisma.auditLog.findFirst({ where: { projectId, action: 'ROLLBACK_CHANGE_RECOVERED' }, orderBy: { timestamp: 'desc' } })
    expect(JSON.parse(audit!.details!).summary).toMatch(/Recovered automatically/)

    const { changes } = await listChanges(projectId)
    const entry = changes.find((c) => c.id === change!.id)!
    expect(entry.outcome.state).toBe('recovered')
    expect(entry.outcome.note).toBe('Row-level security turned off on secrets')
  })

  it('a change made by work a finished change left running is recovered on the lock it took', async () => {
    await protectedTable('late_secrets')
    // Work a finished change left running still carries that change's context
    // (lib/changes/context.ts). The change it makes is its own, and so is the
    // lock: its recovery re-enters it instead of waiting 30 s for itself.
    const leftOver = { projectId, finished: true }
    const startedAt = Date.now()
    const { change } = await openChangeContext.run(leftOver, () => asAgent('late: turn row-level security off', async () => {
      await ddl(`ALTER TABLE ${T('late_secrets')} DISABLE ROW LEVEL SECURITY`)
    }))
    expect(change!.status).toBe('recovered')
    expect(change!.recovery).toMatchObject({ status: 'recovered', verified: true })
    expect(await rlsOn('late_secrets')).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(30_000)
  }, 90_000)

  it('the same thing from a person in the dashboard is their decision, and stays', async () => {
    await protectedTable('open_on_purpose')
    const { change } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      withGovernedChange({ projectId, title: 'open it' }, async () => {
        await ddl(`ALTER TABLE ${T('open_on_purpose')} DISABLE ROW LEVEL SECURITY`)
      }))
    expect(change!.status).toBe('healthy')
    expect(await rlsOn('open_on_purpose')).toBe(false)
  })

  it('a view removed by a CASCADE nobody named is caught and comes back', async () => {
    await ddl(`CREATE TABLE ${T('sales')} (id serial PRIMARY KEY, region text, amount integer)`)
    await ddl(`INSERT INTO ${T('sales')} (region, amount) VALUES ('eu', 1), ('us', 2)`)
    await ddl(`CREATE VIEW ${T('sales_by_region')} AS SELECT region, sum(amount) AS total FROM ${T('sales')} GROUP BY region`)
    const { change } = await asAgent('drop sales.region', async () => {
      await keepColumnValues(projectId, schema, 'sales', 'region', 'dropped', `ALTER TABLE ${T('sales')} DROP COLUMN region CASCADE`)
    })
    expect(change!.verification!.checks.find((c) => c.id === 'collateral')).toMatchObject({ outcome: 'contradicted' })
    expect(change!.status).toBe('recovered')
    expect((await rows(`SELECT region, total::int AS total FROM ${T('sales_by_region')} ORDER BY region`))).toEqual([
      { region: 'eu', total: 1 }, { region: 'us', total: 2 },
    ])
  })

  it('a step that reported success and did not take effect fails verification', async () => {
    await ddl(`CREATE TABLE ${T('ghosts')} (id serial PRIMARY KEY)`)
    const { change } = await asAgent('add two columns', async () => {
      await ddl(`ALTER TABLE ${T('ghosts')} ADD COLUMN seen text`)
      expectEffect(projectId, { action: 'ADD_COLUMN', table: 'ghosts', column: 'seen' })
      expectEffect(projectId, { action: 'ADD_COLUMN', table: 'ghosts', column: 'unseen' })
    })
    expect(change!.verification!.checks.find((c) => c.id === 'expected_effects')!.detail).toMatch(/ghosts.unseen was reported added/)
    expect(change!.status).toBe('recovered')
    expect(await columnsOf('ghosts')).toEqual(['id'])
  })

  it('a change that fails part-way is recovered, and the failure still reaches the caller', async () => {
    await ddl(`CREATE TABLE ${T('halfway')} (id serial PRIMARY KEY)`)
    await expect(asAgent('two steps, the second fails', async () => {
      await ddl(`ALTER TABLE ${T('halfway')} ADD COLUMN first_step text`)
      await ddl(`ALTER TABLE ${T('halfway')} ADD COLUMN broken nosuchtype`)
    })).rejects.toThrow(/nosuchtype/)
    const r = await prisma.backendChange.findFirstOrThrow({ where: { projectId, title: 'two steps, the second fails' } })
    expect(r.status).toBe('recovered')
    expect(await events(r.id)).toEqual(expect.arrayContaining(['partially_applied', 'recovery_completed']))
    expect(await columnsOf('halfway')).toEqual(['id'])
  })

  it('a change that failed before changing anything is recorded as failed, and not listed', async () => {
    await expect(asAgent('fails at once', async () => {
      await ddl(`ALTER TABLE ${T('no_such_table')} ADD COLUMN x text`)
    })).rejects.toThrow()
    const r = await prisma.backendChange.findFirstOrThrow({ where: { projectId, title: 'fails at once' } })
    expect(r.status).toBe('failed')
    const { changes } = await listChanges(projectId)
    expect(changes.some((c) => c.id === r.id)).toBe(false)
  })

  it('turning autonomy off does not turn verification or recovery off', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { autonomyLevel: 'OFF' } })
    await protectedTable('still_guarded')
    const { change } = await asAgent('with autonomy off', async () => {
      await ddl(`ALTER TABLE ${T('still_guarded')} DISABLE ROW LEVEL SECURITY`)
    })
    expect(change!.status).toBe('recovered')
    expect(await rlsOn('still_guarded')).toBe(true)
  })
})

// ── Waiting for a person ─────────────────────────────────────────────────────

describe('a recovery that would cost data', () => {
  let changeId: string
  let approvalId: string

  beforeAll(async () => {
    const c = await escalated('ledger_a')
    changeId = c.id
    expect(c.status).toBe('awaiting_approval')
    approvalId = c.recovery!.approvalId!
  }, 60_000)

  it('waits in the existing approvals inbox, with the impact Backenly measured', async () => {
    const a = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: approvalId } })
    expect(a).toMatchObject({ tool: 'revert_schema_change', status: 'pending', apiKeyId: null, reversible: true })
    expect(a.target).toMatch(/Restore the state before change #\d+/)
    expect(a.toolArgs).toMatchObject({ changeId, origin: 'backenly', acknowledged: { 'restore_incomplete:ledger_a:extra': 1 } })
    expect(await events(changeId)).toContain('recovery_escalated')
    const { changes } = await listChanges(projectId)
    expect(changes.find((c) => c.id === changeId)).toMatchObject({ outcome: { state: 'awaiting_approval' }, approvalId })
    // Production is as the change left it until a person decides.
    expect(await rlsOn('ledger_a')).toBe(false)
  })

  it('cannot be approved by someone who does not administer the project', async () => {
    const out = await decideApproval({ projectId, approvalId, approverUserId: strangerId, decision: 'approve' })
    expect(out).toMatchObject({ ok: false, status: 'forbidden' })
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('pending')
  })

  it('approving runs exactly what was approved, verified, and records whose decision it was', async () => {
    const out = await decideApproval({ projectId, approvalId, approverUserId: ownerId, decision: 'approve' })
    expect(out).toMatchObject({ ok: true, status: 'executed' })
    expect(await rlsOn('ledger_a')).toBe(true)
    expect(await columnsOf('ledger_a')).toContain('extra')
    const r = await record(changeId)
    expect(r.status).toBe('restored')
    const rec = await record(r.recoveredById!)
    expect(rec).toMatchObject({ source: 'approval', actorUserId: ownerId })
    // The latest start: the first was Backenly's own attempt, which found it needed a person.
    const starts = await prisma.backendChangeEvent.findMany({ where: { changeId, type: 'recovery_started' }, orderBy: { at: 'asc' } })
    expect(starts[0].data).toMatchObject({ mode: 'automatic', authorizedBy: { kind: 'backenly', policy: 'lossless_only' } })
    const started = starts[starts.length - 1]
    expect(started.data).toMatchObject({ mode: 'approved', authorizedBy: { kind: 'user', userId: ownerId, source: 'explicit_approval' } })
  })
})

describe('declining a recovery', () => {
  it('keeps the change as it is, on record, and it can still be restored later', async () => {
    const c = await escalated('ledger_b')
    const out = await decideApproval({ projectId, approvalId: c.recovery!.approvalId!, approverUserId: ownerId, decision: 'reject' })
    expect(out).toMatchObject({ ok: true, status: 'rejected' })
    expect((await record(c.id)).status).toBe('kept')
    expect(await events(c.id)).toContain('kept')
    const { changes } = await listChanges(projectId)
    const entry = changes.find((x) => x.id === c.id)!
    expect(entry.outcome.state).toBe('kept')
    expect(entry.action).toMatchObject({ kind: 'restore', available: true })
    expect(await rlsOn('ledger_b')).toBe(false)
  })

  it('from the console, answers the pending request too', async () => {
    const c = await escalated('ledger_c')
    const out = await keepChange(projectId, c.id, ownerId)
    expect(out.ok).toBe(true)
    expect((await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: c.recovery!.approvalId! } })).status).toBe('rejected')
    // Only a change waiting on a decision can be kept.
    expect(await keepChange(projectId, c.id, ownerId)).toMatchObject({ ok: false, code: 'NOT_PENDING' })
  })

  it('a restore from the console answers the pending request instead', async () => {
    const c = await escalated('ledger_d')
    const p = (await previewRecovery(projectId, c.id))!
    expect(p.safety).toBe('needs_approval')
    const out = await recoverChange(projectId, c.id, { mode: 'manual', actorUserId: ownerId, acknowledged: p.acknowledgement })
    expect(out.ok).toBe(true)
    const a = await prisma.agentApprovalRequest.findUniqueOrThrow({ where: { id: c.recovery!.approvalId! } })
    expect(a.status).toBe('executed')
    expect(a.resultSummary).toMatch(/Already done from History/)
  })
})

// ── When recovery itself fails ───────────────────────────────────────────────

describe('a recovery that fails', () => {
  let stuckId: string

  it('stops, says why, and leaves the change for a person', async () => {
    await protectedTable('contended')
    // Another session holds the table, so the recovery cannot get its lock
    // (it waits 5 s, then gives up rather than queue production behind it).
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    try {
      const { change } = await asAgent('break contended', async () => {
        await ddl(`ALTER TABLE ${T('contended')} DISABLE ROW LEVEL SECURITY`)
        await blocker.query('BEGIN')
        await blocker.query(`LOCK TABLE ${T('contended')} IN ACCESS SHARE MODE`)
      })
      stuckId = change!.id
      expect(change!.status).toBe('manual_intervention_required')
      expect(change!.recovery!.explanation).toMatch(/lock timeout/i)
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await blocker.end()
    }
    expect(await events(stuckId)).toEqual(expect.arrayContaining(['recovery_failed', 'manual_intervention_required']))
    expect(await rlsOn('contended')).toBe(false)
    const audit = await prisma.auditLog.findFirst({ where: { projectId, action: 'CHANGE_RECOVERY_NEEDS_ATTENTION' } })
    expect(audit).not.toBeNull()
  }, 60_000)

  it('pauses automatic recovery for the project until a person decides', async () => {
    await protectedTable('paused_one')
    const { change } = await asAgent('break paused_one', async () => {
      await ddl(`ALTER TABLE ${T('paused_one')} DISABLE ROW LEVEL SECURITY`)
    })
    expect(change!.status).toBe('awaiting_approval')
    expect(change!.recovery!.explanation).toMatch(/paused while change #\d+ needs attention/)
    expect(await rlsOn('paused_one')).toBe(false)
  })

  it('once a person decides, automatic recovery resumes', async () => {
    expect((await keepChange(projectId, stuckId, ownerId)).ok).toBe(true)
    await protectedTable('resumed')
    const { change } = await asAgent('break resumed', async () => {
      await ddl(`ALTER TABLE ${T('resumed')} DISABLE ROW LEVEL SECURITY`)
    })
    expect(change!.status).toBe('recovered')
  })

  it('a person restoring a change that cannot get its locks changes nothing', async () => {
    await ddl(`CREATE TABLE ${T('busy')} (id serial PRIMARY KEY)`)
    const { change } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      withGovernedChange({ projectId, title: 'busy.a' }, async () => { await ddl(`ALTER TABLE ${T('busy')} ADD COLUMN a text`) }))
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    await blocker.query(`LOCK TABLE ${T('busy')} IN ACCESS SHARE MODE`)
    try {
      const out = await recoverChange(projectId, change!.id, { mode: 'manual', actorUserId: ownerId })
      expect(out).toMatchObject({ ok: false, code: 'RECOVERY_FAILED' })
      expect((out as any).error).toMatch(/nothing was changed/i)
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
    }
    expect((await record(change!.id)).status).toBe('healthy')
    expect(await columnsOf('busy')).toEqual(['a', 'id'])
  }, 60_000)
})

// ── Interrupted work ─────────────────────────────────────────────────────────

describe('work a restart interrupted', () => {
  it('a recovery whose worker died is settled from the catalog, never re-run', async () => {
    await ddl(`CREATE TABLE ${T('orphaned')} (id serial PRIMARY KEY)`)
    const { change } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      withGovernedChange({ projectId, title: 'orphaned.a' }, async () => { await ddl(`ALTER TABLE ${T('orphaned')} ADD COLUMN a text`) }))
    const claim = await claimRecovery(change!.id, ['healthy'])
    expect(claim).not.toBeNull()
    // A duplicate job finds it claimed.
    expect(await claimRecovery(change!.id, ['healthy'])).toBeNull()
    // The worker never finished. Within the lease nothing is touched...
    expect(await reconcileChange(projectId, change!.id)).toBeNull()
    expect((await record(change!.id)).status).toBe('recovering')
    // ...after it, the catalog decides: nothing was restored, so it goes back.
    await prisma.backendChangeEvent.create({ data: { changeId: change!.id, projectId, type: 'recovery_started', data: { mode: 'manual', from: 'healthy' } } })
    const later = new Date(Date.now() + 16 * 60_000)
    expect(await reconcileChange(projectId, change!.id, later)).toBe('healthy')
    expect(await events(change!.id)).toContain('reconciled')
    expect(await columnsOf('orphaned')).toEqual(['a', 'id'])
  })

  it('a change still applying long after it began needs a person', async () => {
    // As a process that died mid-change leaves it: the row, its checkpoint,
    // nothing else.
    const checkpoint = await withChangeLock(projectId, (client) => readCatalogOn(client, schema))
    const last = await prisma.backendChange.findFirstOrThrow({ where: { projectId }, orderBy: { seq: 'desc' } })
    const stale = await prisma.backendChange.create({
      data: {
        projectId, seq: last.seq + 1, kind: 'change', source: 'mcp', title: 'interrupted', status: 'applying',
        parentId: last.id, checkpoint: { database: checkpoint } as any, createdAt: new Date(Date.now() - 60 * 60_000),
      },
    })
    expect(await reconcileChange(projectId, stale.id)).toBe('manual_intervention_required')
    const r = await record(stale.id)
    expect(r.error).toMatch(/stopped before it finished/)
    // It now needs a person; clear it so automation is not left paused.
    expect((await keepChange(projectId, stale.id, ownerId)).ok).toBe(true)
  })
})

// ── When the world misbehaves ────────────────────────────────────────────────

describe('a recovery the world interferes with', () => {
  it('a restore whose database connection is cut while it waits is rolled back, says so, and runs again', async () => {
    await ddl(`CREATE TABLE ${T('flaky_net')} (id serial PRIMARY KEY)`)
    const { change } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      withGovernedChange({ projectId, title: 'flaky_net.a' }, async () => { await ddl(`ALTER TABLE ${T('flaky_net')} ADD COLUMN a text`) }))
    const blocker = new Client({ connectionString: process.env.DATABASE_URL })
    const watcher = new Client({ connectionString: process.env.DATABASE_URL })
    await blocker.connect()
    await watcher.connect()
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await blocker.query('BEGIN')
    await blocker.query(`LOCK TABLE ${T('flaky_net')} IN ACCESS SHARE MODE`)
    let out: Awaited<ReturnType<typeof recoverChange>>
    try {
      const running = recoverChange(projectId, change!.id, { mode: 'manual', actorUserId: ownerId })
      // The restore waits for its lock. Cut its connection, as a network drop would.
      let cut = false
      for (let i = 0; i < 100 && !cut; i++) {
        const waiting = await watcher.query(
          `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%flaky_net%' AND pid <> $1 AND pid <> pg_backend_pid()`,
          [blockerPid],
        )
        if (waiting.rows.length > 0) {
          await watcher.query('SELECT pg_terminate_backend($1)', [waiting.rows[0].pid])
          cut = true
        } else {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      expect(cut).toBe(true)
      out = await running
    } finally {
      await blocker.query('ROLLBACK').catch(() => {})
      await blocker.end()
      await watcher.end()
    }
    expect(out).toMatchObject({ ok: false, code: 'RECOVERY_FAILED' })
    expect((out as any).error).toMatch(/nothing was changed/i)
    expect((await record(change!.id)).status).toBe('healthy')
    expect(await columnsOf('flaky_net')).toEqual(['a', 'id'])
    expect(await events(change!.id)).toContain('recovery_failed')
    // Nothing half-made is left to surface later as a change needing a person.
    expect(await prisma.backendChange.count({
      where: { projectId, recoversId: change!.id, status: { notIn: ['healthy', 'failed'] } },
    })).toBe(0)

    // The next attempt gets a fresh connection, and the restore runs.
    const again = await recoverChange(projectId, change!.id, { mode: 'manual', actorUserId: ownerId })
    expect(again).toMatchObject({ ok: true, status: 'restored' })
    expect(await columnsOf('flaky_net')).toEqual(['id'])
  }, 60_000)

  it('a restore that ran, but left production unlike its restore point, is never reported as recovered', async () => {
    await protectedTable('drifty')
    // Something outside Backenly that alters a table whenever it is altered (an
    // operator's event trigger, an extension), here only for drifty, once.
    const fn = `bkn_test_drift_${crypto.randomBytes(4).toString('hex')}`
    await ddl(`CREATE FUNCTION public.${fn}() RETURNS event_trigger LANGUAGE plpgsql AS $f$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
          IF r.objid = to_regclass('${T('drifty')}') AND NOT EXISTS (
            SELECT 1 FROM pg_attribute WHERE attrelid = r.objid AND attname = 'sneaky' AND NOT attisdropped
          ) THEN
            EXECUTE 'ALTER TABLE ${T('drifty')} ADD COLUMN sneaky text';
          END IF;
        END LOOP;
      END $f$`)
    let change: Awaited<ReturnType<typeof asAgent>>['change']
    try {
      ;({ change } = await asAgent('break drifty', async () => {
        await ddl(`ALTER TABLE ${T('drifty')} DISABLE ROW LEVEL SECURITY`)
        // Armed once the change has applied, so only the recovery meets it.
        await ddl(`CREATE EVENT TRIGGER ${fn}_evt ON ddl_command_end WHEN TAG IN ('ALTER TABLE') EXECUTE FUNCTION public.${fn}()`)
      }))
    } finally {
      await ddl(`DROP EVENT TRIGGER IF EXISTS ${fn}_evt`)
      await ddl(`DROP FUNCTION IF EXISTS public.${fn}()`)
    }

    // The restore ran: row-level security is back on. But the table is not
    // what the restore point says, so it is not called recovered.
    expect(await rlsOn('drifty')).toBe(true)
    expect(await columnsOf('drifty')).toContain('sneaky')
    expect(change!.status).toBe('manual_intervention_required')
    expect(change!.recovery!.explanation).toMatch(/did not match the restore point/)
    const r = await record(change!.id)
    expect(r.status).toBe('manual_intervention_required')
    expect(r.recoveredById).toBeNull()
    expect(await events(change!.id)).toEqual(expect.arrayContaining(['verification_failed', 'recovery_started', 'recovery_failed', 'manual_intervention_required']))
    expect(await events(change!.id)).not.toContain('recovery_completed')
    const failedEvent = await prisma.backendChangeEvent.findFirstOrThrow({ where: { changeId: change!.id, type: 'recovery_failed' } })
    expect((failedEvent.data as any).phase).toBe('verification')
    const restore = await prisma.backendChange.findFirstOrThrow({ where: { projectId, recoversId: change!.id } })
    expect(restore.status).not.toBe('healthy')
    expect((restore.verification as any).outcome).toBe('contradicted')
    expect(JSON.stringify((restore.verification as any).checks)).toMatch(/sneaky/)
    const { changes } = await listChanges(projectId)
    expect(changes.find((c) => c.id === change!.id)!.outcome.state).not.toBe('recovered')

    // A person decides; automation resumes for the project.
    expect((await keepChange(projectId, change!.id, ownerId)).ok).toBe(true)
  }, 60_000)
})
