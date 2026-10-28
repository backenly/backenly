/**
 * GOVERNED CHANGES AND RESTORING THEM, AGAINST A REAL DATABASE
 * ============================================================
 *
 * The change ledger and recovery engine end to end (lib/changes), with no part
 * of the database stubbed. Each block is one class of change:
 *
 *   additive      checkpointed, applied, verified; restoring it is lossless and
 *                 reapplying brings it back
 *   writes since  rows and values written after a change are never silently
 *                 removed: the restore needs approval, runs only within what
 *                 was approved, and keeps what it sets aside for a reapply
 *   destructive   a dropped table or column comes back value for value
 *   renames       a column and a table rename come back
 *   retypes       untouched rows get their original value back; rows changed
 *                 since keep theirs
 *   data rewrite  a data migration's rewrite is undone row by row, without
 *                 overwriting rows changed since
 *   ordering      a later change to the same table blocks a restore and is
 *                 named; an unrelated one does not
 *   integrity     a tampered restore point or kept data is refused
 *   the record    status edges, write-once evidence and append-only events are
 *                 enforced by the database itself
 *   backups       the backup role can read every vault, read only, so a
 *                 deployment recovery bundle still dumps
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
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { withGovernedChange, withChangeAttribution } from '@/lib/changes/ledger'
import { archiveTable, keepColumnValues } from '@/lib/changes/preserve'
import { availabilityOf, previewRecovery, recoverChange } from '@/lib/changes/recovery'
import { listChanges, getChange } from '@/lib/changes/history'
import { closeChangeLockPool, readCatalogOn, withChangeLock } from '@/lib/changes/lock'
import { tableSignature, type CatalogSnapshot } from '@/lib/changes/catalog'
import { executeDataMigration } from '@/lib/execution/data-migration'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string

const BACKUP = 'backenly_backup'
let createdBackupRole = false

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

const T = (table: string) => `"${schema}"."${table}"`
const ddl = (sql: string) => prisma.$executeRawUnsafe(sql)
const rows = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)

async function catalog(): Promise<CatalogSnapshot> {
  return withChangeLock(projectId, (client) => readCatalogOn(client, schema))
}

async function columnsOf(table: string): Promise<string[]> {
  const r = await rows<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY column_name`,
  )
  return r.map((x) => x.column_name)
}

async function exists(sch: string, table: string): Promise<boolean> {
  const r = await rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${sch}' AND c.relname = '${table}'`,
  )
  return r[0].n > 0
}

const record = (id: string) => prisma.backendChange.findUniqueOrThrow({ where: { id } })
const events = async (id: string) =>
  (await prisma.backendChangeEvent.findMany({ where: { changeId: id }, orderBy: { at: 'asc' } })).map((e) => e.type)

/** Run DDL as one governed change, as a person in the dashboard, and return its record. */
async function change(title: string, fn: () => Promise<unknown>) {
  const { change: closed } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
    withGovernedChange({ projectId, title }, async () => { await fn() }))
  if (!closed) throw new Error(`"${title}" recorded nothing`)
  return closed
}

const restore = (id: string, acknowledged?: Record<string, number> | null) =>
  recoverChange(projectId, id, { mode: 'manual', actorUserId: ownerId, acknowledged: acknowledged ?? null })

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `recovery-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'change-recovery', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  // The backup role as scripts/setup-backup-role.ts leaves it: it reads the
  // workspace and every table created there later. Not the vaults, which do
  // not exist yet.
  if ((await rows(`SELECT 1 FROM pg_roles WHERE rolname = '${BACKUP}'`)).length === 0) {
    await ddl(`CREATE ROLE ${BACKUP} NOLOGIN BYPASSRLS`)
    createdBackupRole = true
  }
  await ddl(`GRANT USAGE ON SCHEMA "${schema}" TO ${BACKUP}`)
  await ddl(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT ON TABLES TO ${BACKUP}`)
  await ddl(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT ON SEQUENCES TO ${BACKUP}`)
}, 120_000)

afterAll(async () => {
  const vaults = await rows<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await ddl(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await ddl(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  // The guard allows deleting a project's changes only once the project is gone.
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  if (createdBackupRole) {
    await ddl(`DROP OWNED BY ${BACKUP}`).catch(() => {})
    await ddl(`DROP ROLE IF EXISTS ${BACKUP}`).catch(() => {})
  }
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

// ── Additive ─────────────────────────────────────────────────────────────────

describe('an additive migration', () => {
  let before: CatalogSnapshot
  let changeId: string

  beforeAll(async () => {
    await ddl(`CREATE TABLE ${T('orders')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), total integer NOT NULL, note text)`)
    await ddl(`INSERT INTO ${T('orders')} (total, note) VALUES (10, 'first'), (20, 'second'), (30, NULL)`)
    before = await catalog()
    const closed = await change('refunds, order status, an index', async () => {
      await ddl(`CREATE TABLE ${T('refunds')} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid REFERENCES ${T('orders')}(id), amount integer NOT NULL)`)
      await ddl(`ALTER TABLE ${T('orders')} ADD COLUMN status text NOT NULL DEFAULT 'new'`)
      await ddl(`CREATE INDEX orders_status_idx ON ${T('orders')} (status)`)
    })
    changeId = closed.id
  }, 60_000)

  it('is checkpointed, applied and verified, with its evidence sealed', async () => {
    const r = await record(changeId)
    expect(r.status).toBe('healthy')
    expect(r.kind).toBe('change')
    expect(r.source).toBe('dashboard')
    expect(r.actorUserId).toBe(ownerId)
    expect(r.risk).toBe('additive')
    expect(r.checkpointHash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.completedAt).not.toBeNull()
    expect((r.verification as any).outcome).toBe('confirmed')
    const footprint = r.footprint as any[]
    expect(footprint.map((c) => `${c.kind}:${c.after ?? c.before}`).sort()).toEqual(['added:refunds', 'modified:orders'])
    expect(await events(changeId)).toEqual(['checkpointed', 'applied', 'verified'])
  })

  it('says in one sentence what it did', async () => {
    const r = await record(changeId)
    expect(r.summary).toMatch(/refunds/)
    expect(r.summary).toMatch(/orders/)
  })

  it('previews as lossless, with all four checks passing', async () => {
    const p = (await previewRecovery(projectId, changeId))!
    expect(p.safety).toBe('lossless')
    expect(p.action).toBe('restore')
    expect(p.checks.map((c) => [c.id, c.ok])).toEqual([
      ['restore_point', true], ['current_state', true], ['plan', true], ['data', true],
    ])
    // The preview changed nothing.
    expect(await exists(schema, 'refunds')).toBe(true)
  })

  it('restores the state before it, verified, and records how it ended', async () => {
    const out = await restore(changeId)
    expect(out.ok).toBe(true)
    const done = out as Extract<typeof out, { ok: true }>
    expect(done.status).toBe('restored')
    expect(done.verification.outcome).toBe('confirmed')

    const now = await catalog()
    expect(tableSignature(now.tables.orders)).toBe(tableSignature(before.tables.orders))
    expect(await exists(schema, 'refunds')).toBe(false)
    expect((await rows(`SELECT total FROM ${T('orders')} ORDER BY total`)).map((r) => r.total)).toEqual([10, 20, 30])

    const r = await record(changeId)
    expect(r.status).toBe('restored')
    expect(r.recoveredById).toBe(done.recoveryId)
    const rec = await record(done.recoveryId)
    expect(rec.kind).toBe('recovery')
    expect(rec.recoversId).toBe(changeId)
    expect(rec.status).toBe('healthy')
    expect(await events(changeId)).toEqual(['checkpointed', 'applied', 'verified', 'recovery_started', 'recovery_verified', 'restored'])
  })

  it('lists the restore as how the change ended, not as a row of its own', async () => {
    const { changes } = await listChanges(projectId)
    const entry = changes.find((c) => c.id === changeId)!
    expect(entry.outcome.state).toBe('restored')
    expect(entry.outcome.by?.userId).toBe(ownerId)
    expect(entry.action).toMatchObject({ kind: 'reapply', available: true })
    expect(changes.some((c) => /Restored the state before/.test(c.summary))).toBe(false)
    const detail = (await getChange(projectId, changeId))!
    expect(detail.recoveries).toHaveLength(1)
    expect(detail.recoveries[0].verification?.outcome).toBe('confirmed')
  })

  it('a second restore of the same change is refused, and changes nothing', async () => {
    const again = await restore(changeId)
    expect(again.ok).toBe(false)
    expect((again as any).code).toBe('NOT_AVAILABLE')
  })

  it('reapplying brings the change back, verified', async () => {
    const r = await record(changeId)
    const out = await restore(r.recoveredById!)
    expect(out.ok).toBe(true)
    expect(await exists(schema, 'refunds')).toBe(true)
    expect(await columnsOf('orders')).toContain('status')
    expect((await record(changeId)).status).toBe('healthy')
    expect(await events(changeId)).toContain('reapplied')
  })
})

// ── Writes since ─────────────────────────────────────────────────────────────

describe('a change with data written since', () => {
  let changeId: string

  beforeAll(async () => {
    await ddl(`CREATE TABLE ${T('posts')} (id serial PRIMARY KEY, title text NOT NULL)`)
    await ddl(`INSERT INTO ${T('posts')} (title) VALUES ('a'), ('b')`)
    const closed = await change('comments and a likes column', async () => {
      await ddl(`CREATE TABLE ${T('comments')} (id serial PRIMARY KEY, body text NOT NULL)`)
      await ddl(`ALTER TABLE ${T('posts')} ADD COLUMN likes integer NOT NULL DEFAULT 0`)
    })
    changeId = closed.id
    // The app keeps working.
    await ddl(`INSERT INTO ${T('comments')} (body) VALUES ('first!'), ('second')`)
    await ddl(`UPDATE ${T('posts')} SET likes = 5 WHERE title = 'a'`)
  }, 60_000)

  it('needs approval, and says exactly what would be set aside', async () => {
    const p = (await previewRecovery(projectId, changeId))!
    expect(p.safety).toBe('needs_approval')
    expect(p.checks.find((c) => c.id === 'data')!.ok).toBe(false)
    const items = p.impact!.items.filter((i) => i.needsApproval).map((i) => [i.effect, i.table, i.column ?? null, i.count])
    expect(items).toEqual(expect.arrayContaining([
      ['rows_set_aside', 'comments', null, 2],
      ['values_set_aside', 'posts', 'likes', 1],
    ]))
    expect(p.acknowledgement).toEqual({ 'rows_set_aside:comments:': 2, 'values_set_aside:posts:likes': 1 })
  })

  it('is refused without that approval, and nothing changes', async () => {
    const out = await restore(changeId)
    expect(out.ok).toBe(false)
    expect((out as any).code).toBe('NEEDS_APPROVAL')
    expect(await exists(schema, 'comments')).toBe(true)
    expect((await record(changeId)).status).toBe('healthy')
  })

  it('is refused when more was written after the approval was given', async () => {
    const p = (await previewRecovery(projectId, changeId))!
    await ddl(`INSERT INTO ${T('comments')} (body) VALUES ('third')`)
    const out = await restore(changeId, p.acknowledgement)
    expect(out.ok).toBe(false)
    expect((out as any).code).toBe('IMPACT_CHANGED')
    expect(await exists(schema, 'comments')).toBe(true)
  })

  it('runs with the approval it needs, and keeps what it set aside', async () => {
    const p = (await previewRecovery(projectId, changeId))!
    const out = await restore(changeId, p.acknowledgement)
    expect(out.ok).toBe(true)
    const done = out as Extract<typeof out, { ok: true }>
    expect(await exists(schema, 'comments')).toBe(false)
    expect(await columnsOf('posts')).toEqual(['id', 'title'])
    const rec = await record(done.recoveryId)
    const kept = (rec.preserved as any).entries as any[]
    const table = kept.find((e) => e.kind === 'table' && e.table === 'comments')
    expect(table.rows).toBe(3)
    expect(await exists(table.vault, table.vaultTable)).toBe(true)
  })

  it('reapplying brings back every row and value it set aside', async () => {
    const r = await record(changeId)
    const p = (await previewRecovery(projectId, r.recoveredById!))!
    expect(p.action).toBe('reapply')
    const out = await restore(r.recoveredById!, p.acknowledgement)
    expect(out.ok).toBe(true)
    expect((await rows(`SELECT body FROM ${T('comments')} ORDER BY id`)).map((x) => x.body)).toEqual(['first!', 'second', 'third'])
    expect((await rows(`SELECT title, likes FROM ${T('posts')} ORDER BY id`))).toEqual([{ title: 'a', likes: 5 }, { title: 'b', likes: 0 }])
  })
})

// ── Destructive ──────────────────────────────────────────────────────────────

describe('a change that dropped a table and a column', () => {
  let changeId: string

  beforeAll(async () => {
    await ddl(`CREATE TABLE ${T('archive_me')} (id serial PRIMARY KEY, v text)`)
    await ddl(`INSERT INTO ${T('archive_me')} (v) SELECT 'row ' || g FROM generate_series(1, 25) g`)
    await ddl(`CREATE TABLE ${T('people')} (id serial PRIMARY KEY, name text NOT NULL, phone text)`)
    await ddl(`INSERT INTO ${T('people')} (name, phone) VALUES ('ada', '111'), ('alan', NULL), ('grace', '333')`)
    const closed = await change('drop archive_me and people.phone', async () => {
      const t = await archiveTable(projectId, schema, 'archive_me')
      expect(t.handled).toBe(true)
      const c = await keepColumnValues(projectId, schema, 'people', 'phone', 'dropped', `ALTER TABLE ${T('people')} DROP COLUMN phone`)
      expect(c.handled).toBe(true)
    })
    changeId = closed.id
  }, 60_000)

  it('is classified destructive, with the data it removed kept', async () => {
    const r = await record(changeId)
    expect(r.risk).toBe('destructive')
    expect(r.status).toBe('healthy')
    const entries = (r.preserved as any).entries as any[]
    // A column's kept values are its non-null ones: alan had no phone.
    expect(entries.map((e) => `${e.kind}:${e.table}:${e.rows}`).sort()).toEqual(['column:people:2', 'table:archive_me:25'])
    expect(entries.every((e) => typeof e.checksum === 'string')).toBe(true)
    expect(await exists(schema, 'archive_me')).toBe(false)
  })

  it('restores both, value for value, losslessly', async () => {
    const p = (await previewRecovery(projectId, changeId))!
    expect(p.safety).toBe('lossless')
    const out = await restore(changeId)
    expect(out.ok).toBe(true)
    expect((await rows(`SELECT count(*)::int AS n FROM ${T('archive_me')}`))[0].n).toBe(25)
    expect(await rows(`SELECT name, phone FROM ${T('people')} ORDER BY id`)).toEqual([
      { name: 'ada', phone: '111' }, { name: 'alan', phone: null }, { name: 'grace', phone: '333' },
    ])
  })
})

describe('a dropped required column with rows written since', () => {
  let changeId: string

  beforeAll(async () => {
    await ddl(`CREATE TABLE ${T('accounts')} (id serial PRIMARY KEY, email text NOT NULL)`)
    await ddl(`INSERT INTO ${T('accounts')} (email) VALUES ('a@x'), ('b@x')`)
    const closed = await change('drop accounts.email', async () => {
      await keepColumnValues(projectId, schema, 'accounts', 'email', 'dropped', `ALTER TABLE ${T('accounts')} DROP COLUMN email`)
    })
    changeId = closed.id
    await ddl(`INSERT INTO ${T('accounts')} DEFAULT VALUES`)
  }, 60_000)

  it('cannot be restored while a row has no value for it, and says what to do', async () => {
    const p = (await previewRecovery(projectId, changeId))!
    expect(p.safety).toBe('blocked')
    expect(p.reason).toMatch(/no value for email/)
    const out = await restore(changeId, { anything: 1 })
    expect(out.ok).toBe(false)
    expect((out as any).code).toBe('BLOCKED')
    expect(await columnsOf('accounts')).toEqual(['id'])
  })
})

// ── Renames ──────────────────────────────────────────────────────────────────

describe('renames', () => {
  it('a renamed column and a renamed table come back under their old names', async () => {
    await ddl(`CREATE TABLE ${T('invoices')} (id serial PRIMARY KEY, amt integer)`)
    await ddl(`INSERT INTO ${T('invoices')} (amt) VALUES (1), (2)`)
    const closed = await change('rename', async () => {
      await ddl(`ALTER TABLE ${T('invoices')} RENAME COLUMN amt TO amount`)
      await ddl(`ALTER TABLE ${T('invoices')} RENAME TO bills`)
    })
    expect((await record(closed.id)).risk).toBe('transforming')
    await ddl(`INSERT INTO ${T('bills')} (amount) VALUES (3)`)
    const p = (await previewRecovery(projectId, closed.id))!
    expect(p.safety).toBe('lossless')
    expect((await restore(closed.id)).ok).toBe(true)
    expect(await exists(schema, 'bills')).toBe(false)
    expect((await rows(`SELECT amt FROM ${T('invoices')} ORDER BY id`)).map((r) => r.amt)).toEqual([1, 2, 3])
  })
})

// ── Retypes ──────────────────────────────────────────────────────────────────

describe('a lossy retype with writes since', () => {
  let changeId: string

  beforeAll(async () => {
    await ddl(`CREATE TABLE ${T('prices')} (id serial PRIMARY KEY, amount numeric(10,2))`)
    await ddl(`INSERT INTO ${T('prices')} (amount) VALUES (10.25), (20.50), (30.75)`)
    const closed = await change('amount to integer', async () => {
      await keepColumnValues(projectId, schema, 'prices', 'amount', 'retyped', `ALTER TABLE ${T('prices')} ALTER COLUMN amount TYPE integer USING round(amount)::integer`)
    })
    changeId = closed.id
    await ddl(`UPDATE ${T('prices')} SET amount = 99 WHERE id = 2`)
  }, 60_000)

  it('keeps the original values and the values it produced', async () => {
    const r = await record(changeId)
    const entry = ((r.preserved as any).entries as any[]).find((e) => e.reason === 'retyped')
    expect(entry.afterColumn).toBe('__bkn_after')
    expect(entry.keyColumns).toEqual(['id'])
  })

  it('puts the original value back on untouched rows, and keeps the row changed since', async () => {
    const p = (await previewRecovery(projectId, changeId))!
    expect(p.impact!.items.find((i) => i.effect === 'writes_kept')?.count).toBe(1)
    expect(p.safety).toBe('lossless')
    expect((await restore(changeId)).ok).toBe(true)
    expect((await rows(`SELECT amount::text AS a FROM ${T('prices')} ORDER BY id`)).map((r) => r.a)).toEqual(['10.25', '99.00', '30.75'])
  })
})

// ── Data rewrite ─────────────────────────────────────────────────────────────

describe('a data migration that rewrote values', () => {
  let changeId: string

  beforeAll(async () => {
    await ddl(`CREATE TABLE ${T('tickets')} (id serial PRIMARY KEY, state text)`)
    await ddl(`INSERT INTO ${T('tickets')} (state) VALUES ('OPEN'), ('Open'), ('closed'), ('CLOSED')`)
    const { result, change: closed } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      withGovernedChange({ projectId, title: 'normalise ticket states' }, () =>
        executeDataMigration(projectId, [{ op: 'normalize_values', table: 'tickets', column: 'state', mapping: { OPEN: 'open', Open: 'open', CLOSED: 'closed' } }])))
    expect(result.success).toBe(true)
    changeId = closed!.id
    await ddl(`UPDATE ${T('tickets')} SET state = 'escalated' WHERE id = 1`)
  }, 60_000)

  it('is recorded as a data rewrite of the column it rewrote', async () => {
    const r = await record(changeId)
    expect(r.risk).toBe('data_rewrite')
    expect((r.footprint as any[]).some((c) => c.after === 'tickets' && c.details.some((d: string) => /values rewritten in state/.test(d)))).toBe(true)
  })

  it('restores the original values on rows nobody changed since, and keeps the one that was', async () => {
    const p = (await previewRecovery(projectId, changeId))!
    expect(p.safety).not.toBe('blocked')
    const out = await restore(changeId, p.acknowledgement)
    expect(out.ok).toBe(true)
    expect((await rows(`SELECT state FROM ${T('tickets')} ORDER BY id`)).map((r) => r.state)).toEqual(['escalated', 'Open', 'closed', 'CLOSED'])
  })

  it('the restore records the values it put back, as a rewrite of its own', async () => {
    const recoveryId = (await record(changeId)).recoveredById!
    const rec = await record(recoveryId)
    expect(rec.risk).toBe('data_rewrite')
    expect((rec.footprint as any[]).some((c) => c.after === 'tickets' && c.details.some((d: string) => /values rewritten in state/.test(d)))).toBe(true)
    const image = ((rec.preserved as any).entries as any[]).find((e) => e.table === 'tickets' && e.column === 'state')
    expect(image).toMatchObject({ kind: 'column', reason: 'rewritten', keyColumns: ['id'], afterColumn: '__bkn_after', rows: 4 })
  })

  it('reapplying brings the rewrite back on the rows nobody changed since the restore, and keeps the one that was', async () => {
    const recoveryId = (await record(changeId)).recoveredById!
    await ddl(`UPDATE ${T('tickets')} SET state = 'reopened' WHERE id = 2`)
    const p = (await previewRecovery(projectId, recoveryId))!
    expect({ action: p.action, safety: p.safety }).toEqual({ action: 'reapply', safety: 'lossless' })
    expect(p.impact!.items.map((i) => [i.effect, i.table, i.column, i.count, i.needsApproval])).toEqual([['writes_kept', 'tickets', 'state', 1, false]])
    const out = await restore(recoveryId, p.acknowledgement)
    expect(out).toMatchObject({ ok: true })
    expect((await rows(`SELECT state FROM ${T('tickets')} ORDER BY id`)).map((r) => r.state)).toEqual(['escalated', 'reopened', 'closed', 'closed'])
    expect((await record(changeId)).status).toBe('healthy')
  })

  it('restoring it again puts back what was there before it, keeping every write since', async () => {
    const p = (await previewRecovery(projectId, changeId))!
    expect(p.safety).toBe('lossless')
    expect((await restore(changeId, p.acknowledgement)).ok).toBe(true)
    expect((await rows(`SELECT state FROM ${T('tickets')} ORDER BY id`)).map((r) => r.state)).toEqual(['escalated', 'reopened', 'closed', 'CLOSED'])
  })
})

// ── Ordering ─────────────────────────────────────────────────────────────────

// ── Guarantees removed, keys moved, tables consolidated ──────────────────────
//
// No agent path does any of these: apply_migration refuses DROP CONSTRAINT,
// DROP INDEX and every primary-key change (change-classes-executor.spec.ts),
// and moves no rows between tables. A person's governed change still can, and
// its restore must put each back exactly, or refuse where today's rows would
// break what it puts back. Never offered as lossless and then failed.

describe('a dropped CHECK, UNIQUE and FOREIGN KEY constraint', () => {
  let changeId: string
  let before: CatalogSnapshot

  beforeAll(async () => {
    await ddl(`CREATE TABLE ${T('ticket_owners')} (id serial PRIMARY KEY)`)
    await ddl(`INSERT INTO ${T('ticket_owners')} DEFAULT VALUES`)
    await ddl(`CREATE TABLE ${T('triage_tickets')} (id serial PRIMARY KEY,
      priority integer CONSTRAINT triage_priority_range CHECK (priority BETWEEN 1 AND 5),
      code text CONSTRAINT triage_code_key UNIQUE,
      owner_id integer CONSTRAINT triage_owner_fkey REFERENCES ${T('ticket_owners')}(id) ON DELETE SET NULL)`)
    await ddl(`INSERT INTO ${T('triage_tickets')} (priority, code, owner_id) VALUES (1, 'a', 1), (5, 'b', NULL)`)
    before = await catalog()
    const closed = await change('drop the triage constraints', async () => {
      await ddl(`ALTER TABLE ${T('triage_tickets')} DROP CONSTRAINT triage_priority_range, DROP CONSTRAINT triage_code_key, DROP CONSTRAINT triage_owner_fkey`)
    })
    changeId = closed.id
  }, 60_000)

  it('is transforming: it removes no data, and creates nothing', async () => {
    expect(await record(changeId)).toMatchObject({ status: 'healthy', risk: 'transforming' })
    expect((await catalog()).tables.triage_tickets.constraints.map((c) => c.name)).toEqual(['triage_tickets_pkey'])
  })

  it('restores all three exactly, losslessly', async () => {
    const p = (await previewRecovery(projectId, changeId))!
    expect(p.safety).toBe('lossless')
    const out = await restore(changeId)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    expect(tableSignature((await catalog()).tables.triage_tickets)).toEqual(tableSignature(before.tables.triage_tickets))
  })
})

describe('a dropped constraint that a row written since would break', () => {
  it.each([
    ['a CHECK', 'gauges', 'level integer CONSTRAINT gauges_level_range CHECK (level BETWEEN 0 AND 10)', null, 'gauges_level_range', '(level) VALUES (42)'],
    ['a UNIQUE', 'badges', 'code text CONSTRAINT badges_code_key UNIQUE', "(code) VALUES ('x')", 'badges_code_key', "(code) VALUES ('x')"],
    ['a FOREIGN KEY', 'loans', 'owner_id integer CONSTRAINT loans_owner_fkey REFERENCES "%s"."ticket_owners"(id)', null, 'loans_owner_fkey', '(owner_id) VALUES (999)'],
  ])('%s: never offered as lossless, and the restore is refused and changes nothing', async (_label, table, column, seed, constraint, violation) => {
    await ddl(`CREATE TABLE ${T(table)} (id serial PRIMARY KEY, ${column.replace('%s', schema)})`)
    if (seed) await ddl(`INSERT INTO ${T(table)} ${seed}`)
    const closed = await change(`drop ${constraint}`, async () => {
      await ddl(`ALTER TABLE ${T(table)} DROP CONSTRAINT ${constraint}`)
    })
    await ddl(`INSERT INTO ${T(table)} ${violation}`)
    const shape = tableSignature((await catalog()).tables[table])
    const count = async () => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM ${T(table)}`))[0].n
    const rowsNow = await count()

    const p = (await previewRecovery(projectId, closed.id))!
    expect(p.safety).toBe('blocked')
    expect(p.reason).toMatch(new RegExp(`${constraint}|violat|would fail`, 'i'))
    // Run anyway, the proof runs for real inside the restore's transaction and is
    // rolled back: the change stays in effect, untouched, and nothing escalates.
    const out = await restore(closed.id, { anything: 1 })
    expect(out).toMatchObject({ ok: false, code: 'RECOVERY_FAILED', status: 'healthy' })
    expect((out as any).error).toMatch(/nothing was changed/)
    expect(tableSignature((await catalog()).tables[table])).toEqual(shape)
    expect(await count()).toBe(rowsNow)
    expect((await record(closed.id)).status).toBe('healthy')
  })
})

describe('a primary key moved to another column', () => {
  let before: CatalogSnapshot

  it('restores the original key exactly, losslessly', async () => {
    await ddl(`CREATE TABLE ${T('serials')} (id serial PRIMARY KEY, code text NOT NULL)`)
    await ddl(`INSERT INTO ${T('serials')} (code) VALUES ('a'), ('b')`)
    before = await catalog()
    const closed = await change('key serials by code', async () => {
      await ddl(`ALTER TABLE ${T('serials')} DROP CONSTRAINT serials_pkey`)
      await ddl(`ALTER TABLE ${T('serials')} ADD CONSTRAINT serials_code_pkey PRIMARY KEY (code)`)
    })
    expect(await record(closed.id)).toMatchObject({ status: 'healthy', risk: 'transforming' })
    const p = (await previewRecovery(projectId, closed.id))!
    expect(p.safety).toBe('lossless')
    const out = await restore(closed.id)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    expect(tableSignature((await catalog()).tables.serials)).toEqual(tableSignature(before.tables.serials))
    expect(await rows(`SELECT id, code FROM ${T('serials')} ORDER BY id`)).toEqual([{ id: 1, code: 'a' }, { id: 2, code: 'b' }])
  })

  it('with a row written since that repeats an id, the restore is refused and changes nothing', async () => {
    await ddl(`CREATE TABLE ${T('vouchers')} (id serial PRIMARY KEY, code text NOT NULL)`)
    await ddl(`INSERT INTO ${T('vouchers')} (code) VALUES ('a')`)
    const closed = await change('key vouchers by code', async () => {
      await ddl(`ALTER TABLE ${T('vouchers')} DROP CONSTRAINT vouchers_pkey`)
      await ddl(`ALTER TABLE ${T('vouchers')} ADD CONSTRAINT vouchers_code_pkey PRIMARY KEY (code)`)
    })
    // Legal now that the key is code: the same id again.
    await ddl(`INSERT INTO ${T('vouchers')} (id, code) VALUES (1, 'b')`)
    const shape = tableSignature((await catalog()).tables.vouchers)
    const p = (await previewRecovery(projectId, closed.id))!
    expect(p.safety).toBe('blocked')
    const out = await restore(closed.id, { anything: 1 })
    expect(out).toMatchObject({ ok: false, code: 'RECOVERY_FAILED', status: 'healthy' })
    expect((out as any).error).toMatch(/nothing was changed/)
    expect(tableSignature((await catalog()).tables.vouchers)).toEqual(shape)
    expect((await record(closed.id)).status).toBe('healthy')
    expect(await rows(`SELECT id, code FROM ${T('vouchers')} ORDER BY code`)).toEqual([{ id: 1, code: 'a' }, { id: 1, code: 'b' }])
  })
})

describe('two tables consolidated into one: rows moved between tables', () => {
  let changeId: string
  const people = (table: string) => rows<{ name: string; email: string | null }>(`SELECT name, email FROM ${T(table)} ORDER BY id`)
  let customers: Array<{ name: string; email: string | null }>
  let leads: Array<{ name: string; email: string | null }>

  beforeAll(async () => {
    await ddl(`CREATE TABLE ${T('customers')} (id serial PRIMARY KEY, name text NOT NULL, email text)`)
    await ddl(`CREATE TABLE ${T('leads')} (id serial PRIMARY KEY, name text NOT NULL, email text)`)
    await ddl(`INSERT INTO ${T('customers')} (name, email) VALUES ('ada', 'ada@x'), ('alan', NULL)`)
    await ddl(`INSERT INTO ${T('leads')} (name, email) VALUES ('grace', 'grace@x'), ('linus', 'linus@x')`)
    customers = await people('customers')
    leads = await people('leads')
    const closed = await change('consolidate customers and leads into contacts', async () => {
      await ddl(`CREATE TABLE ${T('contacts')} (id serial PRIMARY KEY, name text NOT NULL, email text, kind text NOT NULL)`)
      await ddl(
        `INSERT INTO ${T('contacts')} (name, email, kind)
         SELECT name, email, 'customer' FROM ${T('customers')} UNION ALL SELECT name, email, 'lead' FROM ${T('leads')}`,
      )
      for (const t of ['customers', 'leads']) expect((await archiveTable(projectId, schema, t)).handled).toBe(true)
    })
    changeId = closed.id
  }, 60_000)

  it('is destructive, with both source tables kept whole', async () => {
    const r = await record(changeId)
    expect(r).toMatchObject({ status: 'healthy', risk: 'destructive' })
    const entries = (r.preserved as any).entries as any[]
    expect(entries.map((e) => `${e.kind}:${e.table}:${e.rows}`).sort()).toEqual(['table:customers:2', 'table:leads:2'])
    expect(await exists(schema, 'customers')).toBe(false)
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM ${T('contacts')}`))[0].n).toBe(4)
  })

  it('restores both source tables value for value, and removes the consolidated one', async () => {
    const p = (await previewRecovery(projectId, changeId))!
    expect(p.safety).toBe('lossless')
    const out = await restore(changeId)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    expect(await people('customers')).toEqual(customers)
    expect(await people('leads')).toEqual(leads)
    expect(await exists(schema, 'contacts')).toBe(false)
  })

  it('reapplied, then written to: restoring again sets the new contact aside for approval, never dropping it', async () => {
    const recoveryId = (await record(changeId)).recoveredById!
    const again = await restore(recoveryId, (await previewRecovery(projectId, recoveryId))?.acknowledgement)
    expect(again).toMatchObject({ ok: true })
    await ddl(`INSERT INTO ${T('contacts')} (name, email, kind) VALUES ('margaret', 'm@x', 'lead')`)

    const p = (await previewRecovery(projectId, changeId))!
    expect(p.safety).toBe('needs_approval')
    // The whole consolidated table leaves the app, so all five of its rows are
    // what a person approves: the new one, and four whose values also come back
    // in the restored source tables. Counted in full, never fewer.
    expect(p.acknowledgement).toEqual({ 'rows_set_aside:contacts:': 5 })
    const out = await restore(changeId, p.acknowledgement)
    expect(out).toMatchObject({ ok: true })
    expect(await people('customers')).toEqual(customers)
    expect(await people('leads')).toEqual(leads)
    const kept = ((await record((out as any).recoveryId)).preserved as any).entries.find((e: any) => e.table === 'contacts')
    expect(kept.rows).toBe(5)
    expect(await rows(`SELECT name FROM "${kept.vault}"."${kept.vaultTable}" WHERE name = 'margaret'`)).toEqual([{ name: 'margaret' }])
  })
})

describe('changes in order', () => {
  it('a later change to the same table blocks a restore and is named; restoring it first clears the way', async () => {
    await ddl(`CREATE TABLE ${T('stack')} (id serial PRIMARY KEY)`)
    const first = await change('add a', async () => { await ddl(`ALTER TABLE ${T('stack')} ADD COLUMN a text`) })
    const second = await change('add b', async () => { await ddl(`ALTER TABLE ${T('stack')} ADD COLUMN b text`) })
    expect((await record(second.id)).parentId).toBe(first.id)

    const p = (await previewRecovery(projectId, first.id))!
    expect(p.safety).toBe('blocked')
    expect(p.blockedBy.map((b) => b.id)).toContain(second.id)
    const refused = await restore(first.id)
    expect((refused as any).code).toBe('CONFLICT')
    expect(await columnsOf('stack')).toEqual(['a', 'b', 'id'])

    expect((await restore(second.id)).ok).toBe(true)
    expect((await restore(first.id)).ok).toBe(true)
    expect(await columnsOf('stack')).toEqual(['id'])
  })

  it('an unrelated newer change does not stand in the way', async () => {
    await ddl(`CREATE TABLE ${T('left_side')} (id serial PRIMARY KEY)`)
    await ddl(`CREATE TABLE ${T('right_side')} (id serial PRIMARY KEY)`)
    const left = await change('left', async () => { await ddl(`ALTER TABLE ${T('left_side')} ADD COLUMN x text`) })
    await change('right', async () => { await ddl(`ALTER TABLE ${T('right_side')} ADD COLUMN y text`) })
    expect((await restore(left.id)).ok).toBe(true)
    expect(await columnsOf('right_side')).toEqual(['id', 'y'])
  })

  it('two changes at once each record only their own tables', async () => {
    const [one, two] = await Promise.all([
      change('one', async () => { await ddl(`CREATE TABLE ${T('par_one')} (id serial PRIMARY KEY)`) }),
      change('two', async () => { await ddl(`CREATE TABLE ${T('par_two')} (id serial PRIMARY KEY)`) }),
    ])
    expect((one.footprint).map((c) => c.after)).toEqual(['par_one'])
    expect((two.footprint).map((c) => c.after)).toEqual(['par_two'])
    expect(Math.abs(one.seq - two.seq)).toBe(1)
  })

  it('two restores of one change at once: exactly one runs', async () => {
    const c = await change('racy', async () => { await ddl(`CREATE TABLE ${T('racy')} (id serial PRIMARY KEY)`) })
    const outs = await Promise.all([restore(c.id), restore(c.id), restore(c.id)])
    expect(outs.filter((o) => o.ok)).toHaveLength(1)
    expect(outs.filter((o) => !o.ok).every((o) => ['IN_PROGRESS', 'NOT_AVAILABLE', 'CHANGE_IN_PROGRESS'].includes((o as any).code))).toBe(true)
    expect(await prisma.backendChange.count({ where: { projectId, recoversId: c.id, status: 'healthy' } })).toBe(1)
  })

  it('a change that altered nothing leaves no record', async () => {
    const before = await prisma.backendChange.count({ where: { projectId } })
    const { change: closed } = await withGovernedChange({ projectId, title: 'nothing' }, async () => {
      await ddl(`CREATE TABLE IF NOT EXISTS ${T('orders')} (id uuid)`)
    })
    expect(closed).toBeNull()
    expect(await prisma.backendChange.count({ where: { projectId } })).toBe(before)
  })
})

// ── Integrity ────────────────────────────────────────────────────────────────

describe('restore point integrity', () => {
  /** Tampering takes going around the guard, as only a superuser at psql could. */
  async function tamper(sql: string) {
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      prisma.$executeRawUnsafe(sql),
    ])
  }

  it('a restore point altered after it was sealed is refused', async () => {
    await ddl(`CREATE TABLE ${T('sealed')} (id serial PRIMARY KEY)`)
    const c = await change('add z', async () => { await ddl(`ALTER TABLE ${T('sealed')} ADD COLUMN z text`) })
    await tamper(`UPDATE backend_changes SET checkpoint = jsonb_set(checkpoint::jsonb, '{database,schema}', '"elsewhere"') WHERE id = '${c.id}'`)
    const p = (await previewRecovery(projectId, c.id))!
    expect(p.safety).toBe('unavailable')
    expect(p.reason).toMatch(/integrity/)
    const out = await restore(c.id)
    expect((out as any).code).toBe('INTEGRITY')
    expect(await columnsOf('sealed')).toEqual(['id', 'z'])
  })

  it('kept data altered after it was kept is refused', async () => {
    await ddl(`CREATE TABLE ${T('kept_one')} (id serial PRIMARY KEY, v text)`)
    await ddl(`INSERT INTO ${T('kept_one')} (v) VALUES ('x'), ('y')`)
    const c = await change('drop kept_one', async () => { await archiveTable(projectId, schema, 'kept_one') })
    const entry = ((await record(c.id)).preserved as any).entries[0]
    await ddl(`UPDATE "${entry.vault}"."${entry.vaultTable}" SET v = 'forged' WHERE v = 'x'`)
    const p = (await previewRecovery(projectId, c.id))!
    expect(p.checks[0]).toMatchObject({ id: 'restore_point', ok: false })
    const out = await restore(c.id)
    expect((out as any).code).toBe('INTEGRITY')
    expect(await exists(schema, 'kept_one')).toBe(false)
  })

  it('a restore point past its retention is not offered', () => {
    const created = new Date('2026-01-01T00:00:00Z')
    const fp = [{ kind: 'added' as const, before: null, after: 't', details: [] }]
    expect(availabilityOf({ kind: 'change', status: 'healthy', footprint: fp, createdAt: created, intact: true }, 7, { now: new Date('2026-01-05T00:00:00Z') }).available).toBe(true)
    const late = availabilityOf({ kind: 'change', status: 'healthy', footprint: fp, createdAt: created, intact: true }, 7, { now: new Date('2026-03-01T00:00:00Z') })
    expect(late).toMatchObject({ available: false, code: 'EXPIRED' })
    // An automatic recovery right after a failed change is not a retention question.
    expect(availabilityOf({ kind: 'change', status: 'verification_failed', footprint: fp, createdAt: created, intact: true }, 7, { now: new Date('2026-03-01T00:00:00Z'), mode: 'automatic' }).available).toBe(true)
  })
})

// ── The record ───────────────────────────────────────────────────────────────

describe('the record is enforced by the database', () => {
  let id: string

  beforeAll(async () => {
    await ddl(`CREATE TABLE ${T('audited')} (id serial PRIMARY KEY)`)
    id = (await change('add audited.a', async () => { await ddl(`ALTER TABLE ${T('audited')} ADD COLUMN a text`) })).id
  })

  it('refuses a status move the lifecycle does not have', async () => {
    await expect(ddl(`UPDATE backend_changes SET status = 'recovered' WHERE id = '${id}'`)).rejects.toThrow(/cannot move from healthy to recovered/)
  })

  it('refuses to rewrite sealed evidence', async () => {
    await expect(ddl(`UPDATE backend_changes SET verification = '{"outcome":"confirmed","checks":[]}' WHERE id = '${id}'`)).rejects.toThrow(/write-once/)
    await expect(ddl(`UPDATE backend_changes SET footprint = '[]' WHERE id = '${id}'`)).rejects.toThrow(/write-once/)
  })

  it('refuses to change who made it', async () => {
    await expect(ddl(`UPDATE backend_changes SET source = 'system', "actorUserId" = NULL WHERE id = '${id}'`)).rejects.toThrow(/immutable/)
  })

  it('refuses to delete it while the project exists', async () => {
    await expect(ddl(`DELETE FROM backend_changes WHERE id = '${id}'`)).rejects.toThrow()
  })

  it('refuses to edit or delete its events', async () => {
    await expect(ddl(`UPDATE backend_change_events SET type = 'verified' WHERE "changeId" = '${id}'`)).rejects.toThrow(/append-only/)
    await expect(ddl(`DELETE FROM backend_change_events WHERE "changeId" = '${id}'`)).rejects.toThrow(/append-only/)
    expect(await events(id)).toEqual(['checkpointed', 'applied', 'verified'])
  })
})

// ── Backups ──────────────────────────────────────────────────────────────────

describe('the vaults and the backup role', () => {
  // A deployment recovery bundle dumps every workspace_* schema as the backup
  // role, so a vault it cannot read fails the whole bundle: the self-host
  // qualification stopped at "permission denied for schema workspace_<id>_r2".
  it('can read every vault the changes and restores above made, and write none', async () => {
    const vaults = await rows<{ vault: string; usage: boolean; relations: number; unreadable: number; writable: number }>(`
      SELECT n.nspname AS vault,
             has_schema_privilege('${BACKUP}', n.oid, 'USAGE') AS usage,
             count(c.oid)::int AS relations,
             count(c.oid) FILTER (WHERE NOT has_table_privilege('${BACKUP}', c.oid, 'SELECT'))::int AS unreadable,
             count(c.oid) FILTER (WHERE c.relkind IN ('r', 'p')
               AND has_table_privilege('${BACKUP}', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE'))::int AS writable
        FROM pg_namespace n
        LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind IN ('r', 'p', 'S')
       WHERE n.nspname ~ '^workspace_${projectId}_r[0-9]+$'
       GROUP BY n.nspname, n.oid
       ORDER BY n.nspname`)
    // A change's own vault and a restore's: the drop above and the restore that set rows aside.
    expect(vaults.filter((v) => v.relations > 0).length).toBeGreaterThanOrEqual(2)
    for (const v of vaults) {
      expect({ vault: v.vault, usage: v.usage, unreadable: v.unreadable, writable: v.writable })
        .toEqual({ vault: v.vault, usage: true, unreadable: 0, writable: 0 })
    }
  })
})
