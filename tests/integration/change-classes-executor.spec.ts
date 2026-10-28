/**
 * EVERY CLASS OF SCHEMA CHANGE, THROUGH THE REAL EXECUTOR, RESTORED AND REAPPLIED
 * ===============================================================================
 *
 * change-recovery.spec.ts proves lib/changes against hand-written DDL. This
 * suite holds the same promise against what agents and the dashboard actually
 * run: apply_migration's parser and the typed executor actions it dispatches
 * (lib/mcp/apply-migration.ts → lib/ai/brain/tools.ts → lib/ai/minimal-executor.ts),
 * with every helper function, index, policy and trigger those executors bring
 * along, against a real database. For each class of change:
 *
 *   it is a governed change, recorded healthy with its verification confirmed;
 *   restoring the state before it is previewed with the safety its data calls for;
 *   the restore puts every table it touched back to its exact prior structure
 *   (tableSignature, lib/changes/catalog.ts) with every row intact;
 *   reapplying brings the change back exactly as it left things.
 *
 * Data moved between columns goes through the typed data migrations
 * (split_column, merge_columns), each one governed change. Nothing moves rows
 * between tables inside a schema change: apply_migration refuses DML, so a
 * table split is a sequence of governed changes (the new table, the rows
 * written into it, the moved columns dropped with their values kept), and is
 * restored newest first.
 *
 * Statements apply_migration refuses (RENAME TABLE, ALTER COLUMN TYPE, DROP
 * COLUMN, DROP TABLE, CREATE TYPE, CREATE VIEW, INSERT, UPDATE, DELETE) are
 * asserted refused with nothing applied and nothing recorded. Where the executor still has a real path
 * for one of those classes, that path is exercised instead: the dashboard's
 * column delete (lib/services/tableLifecycle.ts), a drop_table a person approves
 * from the review queue (lib/mcp/approvals.ts), and the executor's own
 * ALTER_COLUMN_TYPE action. Enums and views have no executor path at all.
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
import { withChangeAttribution } from '@/lib/changes/attribution'
import { applyMigrationToMain, type MigrationSuccess } from '@/lib/mcp/apply-migration'
import { previewRecovery, recoverChange } from '@/lib/changes/recovery'
import { closeChangeLockPool, readCatalogOn, withChangeLock } from '@/lib/changes/lock'
import { tableSignature, type CatalogSnapshot } from '@/lib/changes/catalog'
import type { ChangeSource, RiskClass } from '@/lib/changes/types'
import { forgetProtection } from '@/lib/branches/protection'
import { executeAction } from '@/lib/ai/minimal-executor'
import { dropWorkspaceColumn } from '@/lib/services/tableLifecycle'
import { createApprovalRequest, decideApproval } from '@/lib/mcp/approvals'
import { withGovernedChange } from '@/lib/changes/ledger'
import { keepColumnValues } from '@/lib/changes/preserve'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

let ownerId: string
let projectId: string
let schema: string

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

// ── Harness ──────────────────────────────────────────────────────────────────

const T = (table: string) => `"${schema}"."${table}"`
const exec = (sql: string) => prisma.$executeRawUnsafe(sql)
const query = <R = any>(sql: string) => prisma.$queryRawUnsafe<R[]>(sql)
const record = (id: string) => prisma.backendChange.findUniqueOrThrow({ where: { id } })
const catalog = (): Promise<CatalogSnapshot> => withChangeLock(projectId, (client) => readCatalogOn(client, schema))
const signature = (cat: CatalogSnapshot, table: string) => (cat.tables[table] ? tableSignature(cat.tables[table]) : null)

/** As a person in the dashboard: who made every change below unless a test says otherwise. */
const asPerson = <R>(fn: () => Promise<R>) => withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, fn)

/** apply_migration on main, as the dashboard and the MCP route call it. */
const migrate = (sql: string) =>
  asPerson(() => applyMigrationToMain(projectId, ownerId, sql, { agentSurface: false, workspaceSchema: schema }))

/** A migration that must apply as one healthy, verified change. Returns the change's id. */
async function migrated(sql: string): Promise<string> {
  const out = await migrate(sql)
  if (!out.ok) throw new Error(`apply_migration did not apply "${sql}": ${JSON.stringify(out)}`)
  const change = (out as MigrationSuccess).change
  if (!change) throw new Error(`apply_migration recorded no change for "${sql}"`)
  expect(change).toMatchObject({ status: 'healthy', verified: true })
  return change.id
}

/** A person's manual restore (or, given a recovery's id, its reapply). */
const restore = (id: string, acknowledged?: Record<string, number> | null) =>
  recoverChange(projectId, id, { mode: 'manual', actorUserId: ownerId, acknowledged: acknowledged ?? null })

/** Stable text for a value as the driver returns it (Date, bigint, Decimal). */
function canonical(v: unknown): unknown {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'bigint' || typeof v === 'number') return String(v)
  if (typeof v === 'object' && typeof (v as any).toFixed === 'function') return String(v)
  return v
}

let reads = 0

/**
 * Every row of a table in a stable order, or null when the table is not there.
 * "updatedAt" is left out: the executor's set_updated_at() trigger stamps it on
 * every UPDATE, including the ones a restore uses to put values back.
 */
async function rowsOf(table: string): Promise<Array<Record<string, unknown>> | null> {
  const present = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${schema}' AND c.relname = '${table}' AND c.relkind = 'r'`,
  )
  if (present[0].n === 0) return null
  // A fresh statement each time: Prisma caches prepared statements by their
  // text, and a cached SELECT * fails once the change under test alters the table.
  const rows = await query<Record<string, unknown>>(`SELECT * FROM ${T(table)} ORDER BY id /* read ${++reads} */`)
  return rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) if (k !== 'updatedAt') out[k] = canonical(v)
    return out
  })
}

async function columnsOf(table: string): Promise<string[]> {
  const r = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${table}' ORDER BY column_name`,
  )
  return r.map((x) => x.column_name)
}

/** The structure and rows of some tables at one moment. */
interface Moment {
  cat: CatalogSnapshot
  rows: Record<string, Array<Record<string, unknown>> | null>
}

async function moment(tables: string[]): Promise<Moment> {
  const cat = await catalog()
  const rows: Moment['rows'] = {}
  for (const t of tables) rows[t] = await rowsOf(t)
  return { cat, rows }
}

/** Each table has exactly the structure, and the rows, it had at `then`. */
async function expectState(then: Moment, tables: string[], opts: { rows?: boolean } = {}) {
  const now = await moment(tables)
  for (const t of tables) {
    expect({ table: t, structure: signature(now.cat, t) }).toEqual({ table: t, structure: signature(then.cat, t) })
    if (opts.rows !== false) expect({ table: t, rows: now.rows[t] }).toEqual({ table: t, rows: then.rows[t] })
  }
}

/** The newest change this project recorded. */
async function latestChangeId(): Promise<string> {
  const row = await prisma.backendChange.findFirstOrThrow({ where: { projectId, kind: 'change' }, orderBy: { seq: 'desc' } })
  return row.id
}

// ── One class of change, held to the whole contract ──────────────────────────

interface ClassSpec {
  /** The tables the change touches, compared by structure and rows. */
  tables: string[]
  /** Builds what the change applies to. These are changes of their own, not the one under test. */
  arrange?: () => Promise<void>
  /** Makes the change through the executor. Returns the change's id. */
  act: () => Promise<string>
  risk: RiskClass
  source?: ChangeSource
  /** More checks on the record: its footprint, the data it kept. */
  recorded?: (row: Awaited<ReturnType<typeof record>>, after: Moment) => void | Promise<void>
  /** More checks once restored, and once reapplied. */
  restored?: () => Promise<void>
  reapplied?: () => Promise<void>
}

interface ClassContext {
  id: () => string
  before: () => Moment
  after: () => Moment
}

function changeClass(title: string, spec: ClassSpec, more?: (ctx: ClassContext) => void) {
  describe(title, () => {
    let id: string
    let before: Moment
    let after: Moment

    beforeAll(async () => {
      await spec.arrange?.()
      before = await moment(spec.tables)
      id = await spec.act()
      after = await moment(spec.tables)
    }, 120_000)

    it('is a governed change: recorded healthy, its protected verification confirmed', async () => {
      const row = await record(id)
      expect(row).toMatchObject({ kind: 'change', status: 'healthy', source: spec.source ?? 'dashboard', actorUserId: ownerId, risk: spec.risk })
      expect((row.verification as any).outcome).toBe('confirmed')
      expect(row.checkpointHash).toMatch(/^[0-9a-f]{64}$/)
      await spec.recorded?.(row, after)
    })

    it('previews its restore as lossless, changing nothing', async () => {
      const p = (await previewRecovery(projectId, id))!
      expect({ action: p.action, safety: p.safety, reason: p.reason }).toEqual({ action: 'restore', safety: 'lossless', reason: null })
      expect(p.checks.map((c) => [c.id, c.ok])).toEqual([['restore_point', true], ['current_state', true], ['plan', true], ['data', true]])
      await expectState(after, spec.tables)
    })

    it('restores the exact structure before it, every row intact, verified', async () => {
      const p = await previewRecovery(projectId, id)
      const out = await restore(id, p?.acknowledgement)
      expect(out).toMatchObject({ ok: true, status: 'restored' })
      const done = out as Extract<typeof out, { ok: true }>
      expect(done.verification.outcome).toBe('confirmed')
      await expectState(before, spec.tables)
      expect(await record(id)).toMatchObject({ status: 'restored', recoveredById: done.recoveryId })
      expect(await record(done.recoveryId)).toMatchObject({ kind: 'recovery', recoversId: id, status: 'healthy', source: 'dashboard', actorUserId: ownerId })
      await spec.restored?.()
    })

    it('previews reapplying it as lossless: nothing was written since the restore', async () => {
      const recoveryId = (await record(id)).recoveredById!
      const p = (await previewRecovery(projectId, recoveryId))!
      expect({ action: p.action, safety: p.safety, reason: p.reason }).toEqual({ action: 'reapply', safety: 'lossless', reason: null })
    })

    it('reapplying brings the change back exactly as it left things, verified', async () => {
      const recoveryId = (await record(id)).recoveredById!
      const p = await previewRecovery(projectId, recoveryId)
      const out = await restore(recoveryId, p?.acknowledgement)
      expect(out).toMatchObject({ ok: true })
      expect((out as Extract<typeof out, { ok: true }>).verification.outcome).toBe('confirmed')
      await expectState(after, spec.tables)
      expect((await record(id)).status).toBe('healthy')
      expect((await record(recoveryId)).status).toBe('restored')
      await spec.reapplied?.()
    })

    more?.({ id: () => id, before: () => before, after: () => after })
  })
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()
  ownerId = (await prisma.user.create({
    data: { email: `change-classes-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'Ada Owner' },
  })).id
  const project = await createProvisionedProject({ name: 'change-classes', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
  // Production is migrated directly here, as a person in the dashboard does.
  await prisma.project.update({ where: { id: projectId }, data: { protectedProduction: false } })
  forgetProtection(projectId)
}, 180_000)

afterAll(async () => {
  const vaults = await query<{ nspname: string }>(`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'workspace_${projectId}_r%'`).catch(() => [])
  for (const v of vaults) await exec(`DROP SCHEMA IF EXISTS "${v.nspname}" CASCADE`).catch(() => {})
  if (schema) await exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  // The guard allows deleting a project's changes only once the project is gone.
  if (projectId) await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  await closeChangeLockPool()
  process.env.BACKENLY_EDITION = originalEdition
  process.env.ENGINE_MODE = originalEngineMode
})

// ── CREATE TABLE: the project's first table, and a second that shares its helpers ──

describe('CREATE TABLE: the first table brings shared helpers, a second reuses them, restoring only the first keeps them', () => {
  const TABLES = ['notebooks', 'journals']
  const HELPERS = ['backenly_jwt_claim(claim text)', 'set_updated_at()']
  let first: string
  let second: string
  let empty: Moment
  let withFirst: Moment
  let withBoth: Moment

  beforeAll(async () => {
    empty = await moment(TABLES)
    // An owner column, so the table also gets row-level security and the claim reader its policies call.
    first = await migrated('CREATE TABLE notebooks (title text NOT NULL, pages integer DEFAULT 0, user_id uuid)')
    withFirst = await moment(TABLES)
    second = await migrated('CREATE TABLE journals (title text, user_id uuid)')
    await exec(`INSERT INTO ${T('journals')} (title) VALUES ('day one'), ('day two')`)
    withBoth = await moment(TABLES)
  }, 120_000)

  it('the first table is a governed change that brings set_updated_at() and backenly_jwt_claim()', async () => {
    expect(Object.keys(empty.cat.objects ?? {})).toEqual([])
    const row = await record(first)
    expect(row).toMatchObject({ status: 'healthy', risk: 'additive', source: 'dashboard', actorUserId: ownerId })
    expect((row.verification as any).outcome).toBe('confirmed')
    const footprint = row.footprint as any[]
    expect(footprint.map((c) => `${c.kind}:${c.object ?? 'table'}:${c.after}`).sort()).toEqual([
      'added:function:backenly_jwt_claim(claim text)',
      'added:function:set_updated_at()',
      'added:table:notebooks',
    ])
    const nb = withFirst.cat.tables.notebooks
    expect(nb.rls).toEqual({ enabled: true, forced: true })
    expect(nb.triggers.map((g) => g.name)).toEqual(['trg_set_updated_at_notebooks'])
    expect(nb.policies.every((p) => /backenly_jwt_claim\(/.test(`${p.using ?? ''}${p.check ?? ''}`))).toBe(true)
  })

  it('the second table reuses them: its change names only its own table', async () => {
    const row = await record(second)
    expect(row).toMatchObject({ status: 'healthy', risk: 'additive' })
    expect((row.verification as any).outcome).toBe('confirmed')
    expect((row.footprint as any[]).map((c) => `${c.kind}:${c.object ?? 'table'}:${c.after}`)).toEqual(['added:table:journals'])
    const jn = withBoth.cat.tables.journals
    expect(jn.triggers[0].definition).toMatch(/EXECUTE FUNCTION .*set_updated_at\(\)/)
    expect(jn.policies.length).toBeGreaterThan(0)
    expect(jn.policies.every((p) => /backenly_jwt_claim\(/.test(`${p.using ?? ''}${p.check ?? ''}`))).toBe(true)
    for (const h of HELPERS) expect(withBoth.cat.objects?.[h]?.definition).toBe(withFirst.cat.objects?.[h]?.definition)
  })

  it('restoring only the first is previewed lossless, and its plan leaves the shared helpers alone', async () => {
    const p = (await previewRecovery(projectId, first))!
    expect({ safety: p.safety, reason: p.reason }).toEqual({ safety: 'lossless', reason: null })
    expect(p.details.steps.some((s) => /DROP FUNCTION/i.test(s.sql))).toBe(false)
    expect(p.details.steps.some((s) => /journals/.test(s.sql))).toBe(false)
  })

  it('restores the state before the first table, keeping the helpers the second table still uses', async () => {
    const out = await restore(first)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    const done = out as Extract<typeof out, { ok: true }>
    expect(done.verification.outcome).toBe('confirmed')
    const kept = done.verification.checks.filter((c) => /kept:/.test(c.detail)).map((c) => [c.label, c.detail])
    expect(kept).toEqual(expect.arrayContaining([
      ['set_updated_at()', expect.stringMatching(/kept: trigger trg_set_updated_at_journals on journals uses it/)],
      ['backenly_jwt_claim(claim text)', expect.stringMatching(/kept: policy .* on journals uses it/)],
    ]))

    const now = await catalog()
    expect(now.tables.notebooks).toBeUndefined()
    for (const h of HELPERS) expect(now.objects?.[h]?.definition).toBe(withBoth.cat.objects?.[h]?.definition)
    // The second table is untouched, structure and rows.
    await expectState(withBoth, ['journals'])
    // The platform's registry follows the schema.
    expect(await prisma.table.count({ where: { projectId, name: 'notebooks' } })).toBe(0)
    expect(await prisma.table.count({ where: { projectId, name: 'journals' } })).toBe(1)
  })

  it("the second table's updatedAt trigger still fires on UPDATE", async () => {
    await exec(`INSERT INTO ${T('journals')} (title, "updatedAt") VALUES ('trigger probe', '2000-01-01T00:00:00Z')`)
    await exec(`UPDATE ${T('journals')} SET title = 'trigger probe, edited' WHERE title = 'trigger probe'`)
    const r = await query<{ stamped: boolean }>(
      `SELECT "updatedAt" > now() - interval '1 hour' AS stamped FROM ${T('journals')} WHERE title = 'trigger probe, edited'`,
    )
    expect(r).toEqual([{ stamped: true }])
    await exec(`DELETE FROM ${T('journals')} WHERE title = 'trigger probe, edited'`)
  })

  it("the second table's row-level security helper still answers", async () => {
    const [, claim] = await prisma.$transaction([
      prisma.$queryRawUnsafe(`SELECT set_config('request.jwt.claims', '{"sub":"end-user-1"}', true)`),
      prisma.$queryRawUnsafe<Array<{ sub: string }>>(`SELECT "${schema}".backenly_jwt_claim('sub') AS sub`),
    ])
    expect(claim).toEqual([{ sub: 'end-user-1' }])
  })

  it('previews reapplying the first table as lossless', async () => {
    const recoveryId = (await record(first)).recoveredById!
    const p = (await previewRecovery(projectId, recoveryId))!
    expect({ action: p.action, safety: p.safety, reason: p.reason }).toEqual({ action: 'reapply', safety: 'lossless', reason: null })
  })

  it('reapplying the first table brings it back exactly as it was, beside the second', async () => {
    const recoveryId = (await record(first)).recoveredById!
    const p = await previewRecovery(projectId, recoveryId)
    const out = await restore(recoveryId, p?.acknowledgement)
    expect(out).toMatchObject({ ok: true })
    await expectState(withFirst, ['notebooks'])
    await expectState(withBoth, ['journals'])
    const now = await catalog()
    for (const h of HELPERS) expect(now.objects?.[h]?.definition).toBe(withFirst.cat.objects?.[h]?.definition)
    expect((await record(first)).status).toBe('healthy')
    expect((await record(second)).status).toBe('healthy')
    expect(await prisma.table.count({ where: { projectId, name: 'notebooks' } })).toBe(1)
  })
})

// ── ADD COLUMN ───────────────────────────────────────────────────────────────

changeClass('ADD COLUMN with a default', {
  tables: ['shelves'],
  arrange: async () => {
    await migrated('CREATE TABLE shelves (label text NOT NULL)')
    await exec(`INSERT INTO ${T('shelves')} (label) VALUES ('top'), ('middle'), ('bottom')`)
  },
  act: () => migrated(`ALTER TABLE shelves ADD COLUMN status text NOT NULL DEFAULT 'open'`),
  risk: 'additive',
  recorded: (row) => {
    const footprint = row.footprint as any[]
    expect(footprint.map((c) => `${c.kind}:${c.after}`)).toEqual(['modified:shelves'])
    expect(footprint[0].details).toEqual([`+ column status text NOT NULL DEFAULT 'open'::text`])
  },
  restored: async () => {
    expect(await columnsOf('shelves')).not.toContain('status')
  },
  reapplied: async () => {
    expect((await query(`SELECT DISTINCT status FROM ${T('shelves')}`)).map((r) => r.status)).toEqual(['open'])
  },
})

// ── RENAME COLUMN ────────────────────────────────────────────────────────────

changeClass('RENAME COLUMN', {
  tables: ['pantry'],
  arrange: async () => {
    await migrated('CREATE TABLE pantry (item text NOT NULL, qty integer)')
    await exec(`INSERT INTO ${T('pantry')} (item, qty) VALUES ('rice', 2), ('beans', NULL), ('salt', 1)`)
  },
  act: () => migrated('ALTER TABLE pantry RENAME COLUMN qty TO quantity'),
  risk: 'transforming',
  recorded: (row) => {
    expect((row.footprint as any[])[0].details).toEqual(['column qty renamed to quantity'])
  },
  restored: async () => {
    expect(await columnsOf('pantry')).toContain('qty')
    expect(await columnsOf('pantry')).not.toContain('quantity')
  },
})

// ── ALTER COLUMN TYPE: apply_migration refuses it; the executor's own action ──

/** The executor's ALTER_COLUMN_TYPE action, as a person's planned retype runs it. Returns the change's id. */
async function retype(tableName: string, columnName: string, newType: string): Promise<string> {
  const result = await asPerson(() =>
    executeAction({ action: 'ALTER_COLUMN_TYPE', params: { tableName, columnName, newType } } as any, projectId, undefined, 0, undefined, false))
  if (!result.success) throw new Error(`ALTER_COLUMN_TYPE failed: ${result.message}`)
  const change = (result as any).change
  if (!change) throw new Error('ALTER_COLUMN_TYPE recorded no change')
  expect(change.status).toBe('healthy')
  return change.id
}

changeClass('ALTER COLUMN TYPE integer → bigint (the executor\'s ALTER_COLUMN_TYPE; apply_migration refuses it)', {
  tables: ['meters'],
  arrange: async () => {
    await migrated('CREATE TABLE meters (label text NOT NULL, reading integer)')
    await exec(`INSERT INTO ${T('meters')} (label, reading) VALUES ('hall', 120), ('attic', NULL), ('cellar', 2147483647)`)
  },
  act: () => retype('meters', 'reading', 'BIGINT'),
  risk: 'transforming',
  recorded: (row, after) => {
    expect(after.cat.tables.meters.columns.find((c) => c.name === 'reading')!.type).toBe('bigint')
    const entry = ((row.preserved as any).entries as any[]).find((e) => e.reason === 'retyped')
    expect(entry).toMatchObject({ kind: 'column', table: 'meters', column: 'reading', keyColumns: ['id'], afterColumn: '__bkn_after', rows: 2 })
  },
  restored: async () => {
    const cat = await catalog()
    expect(cat.tables.meters.columns.find((c) => c.name === 'reading')!.type).toBe('integer')
  },
})

changeClass('ALTER COLUMN TYPE numeric → integer, a lossy cast (the executor\'s ALTER_COLUMN_TYPE)', {
  tables: ['scales'],
  arrange: async () => {
    await migrated('CREATE TABLE scales (label text NOT NULL, weight numeric)')
    await exec(`INSERT INTO ${T('scales')} (label, weight) VALUES ('flour', 10.25), ('sugar', 20.5), ('salt', 0.333)`)
  },
  act: () => retype('scales', 'weight', 'INTEGER'),
  risk: 'transforming',
  recorded: async () => {
    // The cast rounded; the originals are in the vault.
    expect((await query(`SELECT weight FROM ${T('scales')} ORDER BY label`)).map((r) => r.weight)).toEqual([10, 0, 21])
  },
  restored: async () => {
    expect((await query(`SELECT weight::text AS w FROM ${T('scales')} ORDER BY label`)).map((r) => r.w)).toEqual(['10.25', '0.333', '20.5'])
  },
})

// ── DROP COLUMN: apply_migration refuses it; the dashboard's column delete ───

changeClass('DROP COLUMN, from the dashboard (apply_migration refuses it): its values are kept and come back', {
  tables: ['contacts'],
  arrange: async () => {
    await migrated('CREATE TABLE contacts (name text NOT NULL, phone text)')
    await exec(`INSERT INTO ${T('contacts')} (name, phone) VALUES ('ada', '111'), ('alan', NULL), ('grace', '333')`)
  },
  act: async () => {
    // DELETE /api/database/schema/columns: the person confirmed in the dialog.
    const result = await asPerson(() => dropWorkspaceColumn(projectId, { tableName: 'contacts', columnName: 'phone' }))
    expect(result.success).toBe(true)
    expect(result.message).toMatch(/Its 2 values are kept/)
    return (result as any).change.id
  },
  risk: 'destructive',
  recorded: async (row) => {
    const entries = (row.preserved as any).entries as any[]
    expect(entries).toEqual([expect.objectContaining({ kind: 'column', table: 'contacts', column: 'phone', reason: 'dropped', keyColumns: ['id'], rows: 2 })])
    const kept = await query(`SELECT phone FROM "${entries[0].vault}"."${entries[0].vaultTable}" ORDER BY phone`)
    expect(kept.map((r) => r.phone)).toEqual(['111', '333'])
    expect(await columnsOf('contacts')).not.toContain('phone')
  },
  restored: async () => {
    expect(await query(`SELECT name, phone FROM ${T('contacts')} ORDER BY name`)).toEqual([
      { name: 'ada', phone: '111' }, { name: 'alan', phone: null }, { name: 'grace', phone: '333' },
    ])
  },
  reapplied: async () => {
    expect(await columnsOf('contacts')).not.toContain('phone')
  },
})

// ── DROP TABLE: apply_migration refuses it; a drop a person approves ─────────

changeClass('DROP TABLE, approved from the review queue (apply_migration refuses it): its rows come back', {
  tables: ['archive_box'],
  source: 'approval',
  arrange: async () => {
    await migrated('CREATE TABLE archive_box (label text NOT NULL)')
    await exec(`INSERT INTO ${T('archive_box')} (label) SELECT 'item ' || g FROM generate_series(1, 5) g`)
  },
  act: async () => {
    // What backend_chat parks for a drop, and a person approves: the exact call, run verbatim.
    const parked = await createApprovalRequest({
      projectId,
      userId: ownerId,
      message: 'Drop the archive_box table',
      danger: { tool: 'drop_table', target: 'Drop table archive_box (5 rows)', rowCount: 5, reversible: true },
      toolArgs: { tableName: 'archive_box' },
    })
    const decided = await decideApproval({ projectId, approvalId: parked.id, approverUserId: ownerId, decision: 'approve' })
    expect(decided).toMatchObject({ ok: true, status: 'executed' })
    expect(decided.resultSummary).toMatch(/Its 5 rows are kept/)
    return latestChangeId()
  },
  risk: 'destructive',
  recorded: async (row) => {
    expect(row.title).toBe('DROP_TABLE archive_box')
    const entries = (row.preserved as any).entries as any[]
    expect(entries).toEqual([expect.objectContaining({ kind: 'table', table: 'archive_box', rows: 5 })])
    const kept = await query<{ n: number }>(`SELECT count(*)::int AS n FROM "${entries[0].vault}"."${entries[0].vaultTable}"`)
    expect(kept[0].n).toBe(5)
    expect(await prisma.table.count({ where: { projectId, name: 'archive_box' } })).toBe(0)
  },
  restored: async () => {
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${T('archive_box')}`))[0].n).toBe(5)
    expect(await prisma.table.count({ where: { projectId, name: 'archive_box' } })).toBe(1)
  },
  reapplied: async () => {
    expect(await prisma.table.count({ where: { projectId, name: 'archive_box' } })).toBe(0)
  },
})

// ── CREATE INDEX ─────────────────────────────────────────────────────────────

changeClass('CREATE INDEX and CREATE UNIQUE INDEX', {
  tables: ['lookups'],
  arrange: async () => {
    await migrated('CREATE TABLE lookups (code text NOT NULL, region text)')
    await exec(`INSERT INTO ${T('lookups')} (code, region) VALUES ('a', 'eu'), ('a', 'us'), ('b', 'eu')`)
  },
  act: () => migrated('CREATE INDEX lookups_code_idx ON lookups (code);\nCREATE UNIQUE INDEX lookups_code_region_key ON lookups (code, region)'),
  risk: 'additive',
  recorded: (row, after) => {
    expect((row.footprint as any[])[0].details).toEqual(['+ index lookups_code_idx', '+ index lookups_code_region_key'])
    const unique = after.cat.tables.lookups.indexes.find((i) => i.name === 'lookups_code_region_key')!
    expect(unique.unique).toBe(true)
    expect(unique.definition).toMatch(/WHERE \(deleted_at IS NULL\)/)
  },
  restored: async () => {
    const names = (await catalog()).tables.lookups.indexes.map((i) => i.name)
    expect(names).not.toContain('lookups_code_idx')
    expect(names).not.toContain('lookups_code_region_key')
  },
})

// ── ADD CONSTRAINT ───────────────────────────────────────────────────────────

changeClass('ADD CONSTRAINT … UNIQUE', {
  tables: ['badges'],
  arrange: async () => {
    await migrated('CREATE TABLE badges (code text NOT NULL, points integer)')
    await exec(`INSERT INTO ${T('badges')} (code, points) VALUES ('gold', 30), ('silver', 20)`)
  },
  act: () => migrated('ALTER TABLE badges ADD CONSTRAINT badges_code_key UNIQUE (code)'),
  risk: 'additive',
  recorded: (row, after) => {
    // A soft-delete table gets the uniqueness as a partial unique index (lib/ai/minimal-executor.ts).
    const idx = after.cat.tables.badges.indexes.find((i) => i.name === 'badges_code_key')!
    expect(idx).toMatchObject({ unique: true })
    expect(idx.definition).toMatch(/\(code\) WHERE \(deleted_at IS NULL\)/)
  },
})

changeClass('ADD CONSTRAINT … CHECK', {
  tables: ['scores'],
  arrange: async () => {
    await migrated('CREATE TABLE scores (player text NOT NULL, points integer)')
    await exec(`INSERT INTO ${T('scores')} (player, points) VALUES ('p1', 3), ('p2', 0)`)
  },
  act: () => migrated('ALTER TABLE scores ADD CONSTRAINT scores_points_nonneg CHECK (points >= 0)'),
  risk: 'additive',
  recorded: (row, after) => {
    expect(after.cat.tables.scores.constraints.find((c) => c.name === 'scores_points_nonneg')).toMatchObject({ type: 'c', definition: 'CHECK ((points >= 0))' })
  },
  restored: async () => {
    // The constraint is gone, so a negative value is accepted again; take it back out.
    await exec(`INSERT INTO ${T('scores')} (player, points) VALUES ('probe', -1)`)
    await exec(`DELETE FROM ${T('scores')} WHERE player = 'probe'`)
  },
  reapplied: async () => {
    await expect(exec(`INSERT INTO ${T('scores')} (player, points) VALUES ('probe', -1)`)).rejects.toThrow(/scores_points_nonneg/)
  },
})

// ── ADD FOREIGN KEY ──────────────────────────────────────────────────────────

changeClass('ADD FOREIGN KEY', {
  tables: ['memberships', 'crews'],
  arrange: async () => {
    await migrated('CREATE TABLE crews (name text NOT NULL)')
    // squad_id names no table by convention, so nothing wires it up on its own.
    await migrated('CREATE TABLE memberships (squad_id uuid, role_name text)')
    await exec(`INSERT INTO ${T('crews')} (name) VALUES ('red'), ('blue')`)
    await exec(`INSERT INTO ${T('memberships')} (squad_id, role_name) SELECT id, 'captain' FROM ${T('crews')}`)
  },
  act: () => migrated('ALTER TABLE memberships ADD CONSTRAINT memberships_squad_fkey FOREIGN KEY (squad_id) REFERENCES crews(id)'),
  risk: 'additive',
  recorded: (row, after) => {
    expect((row.footprint as any[]).map((c) => `${c.kind}:${c.after}`)).toEqual(['modified:memberships'])
    const fk = after.cat.tables.memberships.constraints.filter((c) => c.type === 'f')
    expect(fk).toHaveLength(1)
    expect(fk[0]).toMatchObject({ refTable: 'crews', columns: ['squad_id'] })
  },
  restored: async () => {
    expect((await catalog()).tables.memberships.constraints.filter((c) => c.type === 'f')).toEqual([])
  },
})

// ── NOT NULL ─────────────────────────────────────────────────────────────────

changeClass('ALTER COLUMN … SET NOT NULL', {
  tables: ['chores'],
  arrange: async () => {
    await migrated('CREATE TABLE chores (title text, effort integer)')
    await exec(`INSERT INTO ${T('chores')} (title, effort) VALUES ('dishes', 1), ('laundry', NULL)`)
  },
  act: () => migrated('ALTER TABLE chores ALTER COLUMN title SET NOT NULL'),
  risk: 'transforming',
  recorded: (row) => {
    expect((row.footprint as any[])[0].details).toEqual(['~ column title: now NOT NULL'])
  },
  restored: async () => {
    expect((await catalog()).tables.chores.columns.find((c) => c.name === 'title')!.notNull).toBe(false)
  },
})

changeClass('ALTER COLUMN … DROP NOT NULL', {
  tables: ['errands'],
  arrange: async () => {
    await migrated('CREATE TABLE errands (title text NOT NULL, effort integer NOT NULL DEFAULT 1)')
    await exec(`INSERT INTO ${T('errands')} (title, effort) VALUES ('post office', 2), ('bank', 1)`)
  },
  act: () => migrated('ALTER TABLE errands ALTER COLUMN effort DROP NOT NULL'),
  risk: 'transforming',
  recorded: (row) => {
    expect((row.footprint as any[])[0].details).toEqual(['~ column effort: now nullable'])
  },
  restored: async () => {
    expect((await catalog()).tables.errands.columns.find((c) => c.name === 'effort')!.notNull).toBe(true)
  },
}, ({ id }) => {
  it('a NULL written since cannot be restored over: the restore is blocked and changes nothing', async () => {
    await exec(`INSERT INTO ${T('errands')} (title, effort) VALUES ('pharmacy', NULL)`)
    const before = await moment(['errands'])
    const p = (await previewRecovery(projectId, id()))!
    expect(p.safety).toBe('blocked')
    expect(p.reason).toMatch(/effort/)
    const out = await restore(id(), { anything: 1 })
    expect(out.ok).toBe(false)
    await expectState(before, ['errands'])
    expect((await record(id())).status).toBe('healthy')
  })
})

// ── SET DEFAULT / DROP DEFAULT ───────────────────────────────────────────────

changeClass('ALTER COLUMN … SET DEFAULT and DROP DEFAULT', {
  tables: ['tallies'],
  arrange: async () => {
    await migrated(`CREATE TABLE tallies (hits integer DEFAULT 0, label text DEFAULT 'untitled')`)
    await exec(`INSERT INTO ${T('tallies')} (hits) VALUES (4)`)
  },
  act: () => migrated('ALTER TABLE tallies ALTER COLUMN hits SET DEFAULT 5;\nALTER TABLE tallies ALTER COLUMN label DROP DEFAULT'),
  risk: 'transforming',
  recorded: (row) => {
    expect((row.footprint as any[])[0].details).toEqual([
      '~ column hits: default 0 → 5',
      `~ column label: default 'untitled'::text → none`,
    ])
  },
})

// ── Several classes in one migration ─────────────────────────────────────────

changeClass('a migration of several statements is one change, restored and reapplied as one', {
  tables: ['postcards', 'stamps'],
  arrange: async () => {
    await migrated('CREATE TABLE postcards (caption text NOT NULL)')
    await exec(`INSERT INTO ${T('postcards')} (caption) VALUES ('greetings'), ('wish you were here')`)
  },
  act: () => migrated([
    'CREATE TABLE stamps (motif text NOT NULL)',
    'ALTER TABLE postcards ADD COLUMN stamp_count integer NOT NULL DEFAULT 0',
    'ALTER TABLE postcards ADD CONSTRAINT postcards_stamp_count_nonneg CHECK (stamp_count >= 0)',
    'CREATE INDEX postcards_caption_idx ON postcards (caption)',
  ].join(';\n')),
  risk: 'additive',
  recorded: (row) => {
    expect((row.steps as any[]).map((s) => s.tool)).toEqual(['create_table', 'add_column', 'add_constraint', 'create_index'])
    expect((row.footprint as any[]).map((c) => `${c.kind}:${c.after}`)).toEqual(['modified:postcards', 'added:stamps'])
  },
})

// ── Data moved between columns: typed data migrations ────────────────────────

/** A person's typed data migration, as RUN_DATA_MIGRATION runs it once confirmed. Returns the change's id. */
async function dataMigration(operations: unknown[]): Promise<string> {
  const result = await asPerson(() =>
    executeAction({ action: 'RUN_DATA_MIGRATION', params: { operations, confirmed: true } } as any, projectId, undefined, 0, undefined, false))
  if (!result.success) throw new Error(`RUN_DATA_MIGRATION failed: ${result.message}`)
  const change = (result as any).change
  if (!change) throw new Error('RUN_DATA_MIGRATION recorded no change')
  expect(change.status).toBe('healthy')
  return change.id
}

changeClass('values moved into new columns: split_column (a typed data migration)', {
  tables: ['people'],
  arrange: async () => {
    await migrated('CREATE TABLE people (full_name text)')
    await exec(`INSERT INTO ${T('people')} (full_name) VALUES ('Ada Lovelace'), ('Alan Turing'), (NULL)`)
  },
  act: () => dataMigration([{ op: 'split_column', table: 'people', source: 'full_name', separator: ' ', targets: ['first_name', 'last_name'] }]),
  risk: 'data_rewrite',
  recorded: async (row) => {
    expect(await query(`SELECT full_name, first_name, last_name FROM ${T('people')} ORDER BY full_name NULLS LAST`)).toEqual([
      { full_name: 'Ada Lovelace', first_name: 'Ada', last_name: 'Lovelace' },
      { full_name: 'Alan Turing', first_name: 'Alan', last_name: 'Turing' },
      { full_name: null, first_name: null, last_name: null },
    ])
    const images = ((row.preserved as any).entries as any[]).filter((e) => e.reason === 'rewritten').map((e) => e.column).sort()
    expect(images).toEqual(['first_name', 'last_name'])
  },
  restored: async () => {
    expect(await columnsOf('people')).not.toContain('first_name')
    expect(await columnsOf('people')).not.toContain('last_name')
  },
})

changeClass('values moved out of several columns into one: merge_columns (a typed data migration)', {
  tables: ['postal'],
  arrange: async () => {
    await migrated('CREATE TABLE postal (street text, city text)')
    await exec(`INSERT INTO ${T('postal')} (street, city) VALUES ('1 Loop', 'London'), ('2 Park', NULL)`)
  },
  act: () => dataMigration([{ op: 'merge_columns', table: 'postal', sources: ['street', 'city'], target: 'line', separator: ', ' }]),
  risk: 'data_rewrite',
  recorded: async () => {
    expect((await query(`SELECT line FROM ${T('postal')} ORDER BY line`)).map((r) => r.line)).toEqual(['1 Loop, London', '2 Park'])
  },
  restored: async () => {
    expect(await columnsOf('postal')).not.toContain('line')
  },
})

// Every Backenly table has a PL/pgSQL updatedAt trigger. One that fired earlier
// in a transaction keeps returning rows of the table's old shape, so a write
// after the table changed shape in that transaction loses or garbles values.
// Data migrations write, then change shape, then write; a restore can too.

changeClass('a data migration that writes a table, then adds columns to it and fills them: no value is lost', {
  tables: ['signups'],
  arrange: async () => {
    await migrated('CREATE TABLE signups (full_name text)')
    await exec(`INSERT INTO ${T('signups')} (full_name) VALUES ('Ada Lovelace'), (NULL)`)
  },
  act: () => dataMigration([
    { op: 'backfill', table: 'signups', column: 'full_name', value: 'Grace Hopper', onlyNull: true },
    { op: 'split_column', table: 'signups', source: 'full_name', separator: ' ', targets: ['first_name', 'last_name'] },
  ]),
  risk: 'data_rewrite',
  recorded: async () => {
    expect(await query(`SELECT full_name, first_name, last_name FROM ${T('signups')} ORDER BY full_name`)).toEqual([
      { full_name: 'Ada Lovelace', first_name: 'Ada', last_name: 'Lovelace' },
      { full_name: 'Grace Hopper', first_name: 'Grace', last_name: 'Hopper' },
    ])
  },
})

changeClass('a data migration that writes, retypes, then writes the same table: every value intact', {
  tables: ['tickets_dm'],
  arrange: async () => {
    await migrated('CREATE TABLE tickets_dm (code text, state text)')
    await exec(`INSERT INTO ${T('tickets_dm')} (code, state) VALUES ('5', 'OPEN'), (NULL, 'closed')`)
  },
  act: () => dataMigration([
    { op: 'backfill', table: 'tickets_dm', column: 'code', value: '7', onlyNull: true },
    { op: 'cast_column', table: 'tickets_dm', column: 'code', toType: 'integer', onError: 'fail' },
    { op: 'normalize_values', table: 'tickets_dm', column: 'state', mapping: { OPEN: 'open' } },
  ]),
  risk: 'data_rewrite',
  recorded: async () => {
    expect(await query(`SELECT code, state FROM ${T('tickets_dm')} ORDER BY code`)).toEqual([
      { code: 5, state: 'open' }, { code: 7, state: 'closed' },
    ])
  },
})

changeClass('one change that drops a column and retypes another on the same table: restored in one transaction, exactly', {
  tables: ['kiosks'],
  arrange: async () => {
    await migrated('CREATE TABLE kiosks (label text NOT NULL, note text, level integer)')
    await exec(`INSERT INTO ${T('kiosks')} (label, note, level) VALUES ('north', 'by the door', 3), ('south', NULL, 4)`)
  },
  act: async () => {
    const { change } = await asPerson(() => withGovernedChange({ projectId, title: 'kiosks: drop note, widen level' }, async () => {
      await keepColumnValues(projectId, schema, 'kiosks', 'note', 'dropped', `ALTER TABLE ${T('kiosks')} DROP COLUMN note`)
      await keepColumnValues(projectId, schema, 'kiosks', 'level', 'retyped', `ALTER TABLE ${T('kiosks')} ALTER COLUMN level TYPE bigint`)
    }))
    return change!.id
  },
  risk: 'destructive',
  restored: async () => {
    expect(await query(`SELECT label, note, level FROM ${T('kiosks')} ORDER BY label`)).toEqual([
      { label: 'north', note: 'by the door', level: 3 }, { label: 'south', note: null, level: 4 },
    ])
  },
})

// ── A table split ────────────────────────────────────────────────────────────

describe('a table split, as the product makes one: each step its own change, restored newest first', () => {
  let before: Moment
  let created: string
  let droppedStreet: string
  let droppedCity: string

  beforeAll(async () => {
    await migrated('CREATE TABLE clients (name text NOT NULL, street text, city text)')
    await exec(`INSERT INTO ${T('clients')} (name, street, city) VALUES ('ada', '1 Loop', 'London'), ('alan', '2 Bletchley', 'Milton Keynes'), ('grace', NULL, 'Arlington')`)
    before = await moment(['clients'])
    // 1. The new table, through apply_migration.
    created = await migrated('CREATE TABLE client_addresses (client_id uuid, street text, city text)')
    // 2. The rows copied into it. That is data written, not a schema change
    //    (the app, or db_insert): apply_migration refuses DML.
    await exec(`INSERT INTO ${T('client_addresses')} (client_id, street, city) SELECT id, street, city FROM ${T('clients')}`)
    // 3. The moved columns dropped from the original, from the dashboard.
    droppedStreet = ((await asPerson(() => dropWorkspaceColumn(projectId, { tableName: 'clients', columnName: 'street' }))) as any).change.id
    droppedCity = ((await asPerson(() => dropWorkspaceColumn(projectId, { tableName: 'clients', columnName: 'city' }))) as any).change.id
  }, 120_000)

  it('is three governed changes, each recorded with what it did, the dropped values kept', async () => {
    expect(await record(created)).toMatchObject({ status: 'healthy', risk: 'additive' })
    for (const id of [droppedStreet, droppedCity]) {
      const r = await record(id)
      expect(r).toMatchObject({ status: 'healthy', risk: 'destructive' })
      expect(((r.preserved as any).entries as any[])[0]).toMatchObject({ kind: 'column', table: 'clients', reason: 'dropped', keyColumns: ['id'] })
    }
    expect(await columnsOf('clients')).not.toContain('street')
    expect(await columnsOf('clients')).not.toContain('city')
    expect(await rowsOf('client_addresses')).toHaveLength(3)
  })

  it('an older step is not restored over a newer one on the same table', async () => {
    const p = (await previewRecovery(projectId, droppedStreet))!
    expect(p.safety).toBe('blocked')
    expect(p.blockedBy.map((b) => b.id)).toContain(droppedCity)
  })

  it('restoring the drops, newest first, puts every moved value back on its row, lossless', async () => {
    for (const id of [droppedCity, droppedStreet]) {
      const p = (await previewRecovery(projectId, id))!
      expect(p.safety).toBe('lossless')
      expect(await restore(id)).toMatchObject({ ok: true, status: 'restored' })
    }
    await expectState(before, ['clients'])
  })

  it('restoring the new table waits for a person, because its rows were written after it, and keeps them', async () => {
    const p = (await previewRecovery(projectId, created))!
    expect(p.safety).toBe('needs_approval')
    expect(p.acknowledgement).toEqual({ 'rows_set_aside:client_addresses:': 3 })
    const out = await restore(created, p.acknowledgement)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    expect(await rowsOf('client_addresses')).toBeNull()
    const rec = await record((out as Extract<typeof out, { ok: true }>).recoveryId)
    const entry = ((rec.preserved as any).entries as any[]).find((e) => e.kind === 'table' && e.table === 'client_addresses')
    expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM "${entry.vault}"."${entry.vaultTable}"`))[0].n).toBe(3)
    // The original is exactly as it was before the split began.
    await expectState(before, ['clients'])
  })
})

// ── Writes since ─────────────────────────────────────────────────────────────

describe('a restore that would set aside data written since needs approval, and runs with exactly what was measured', () => {
  let tableChange: string
  let columnChange: string

  beforeAll(async () => {
    tableChange = await migrated('CREATE TABLE receipts (memo text NOT NULL)')
    await exec(`INSERT INTO ${T('receipts')} (memo) VALUES ('coffee'), ('lunch')`)
    await migrated('CREATE TABLE tabs (label text NOT NULL)')
    await exec(`INSERT INTO ${T('tabs')} (label) VALUES ('one'), ('two')`)
    columnChange = await migrated('ALTER TABLE tabs ADD COLUMN tip integer NOT NULL DEFAULT 0')
    await exec(`UPDATE ${T('tabs')} SET tip = 5 WHERE label = 'two'`)
  }, 120_000)

  it('rows written into an added table: previewed as needing approval, naming them', async () => {
    const p = (await previewRecovery(projectId, tableChange))!
    expect(p.safety).toBe('needs_approval')
    expect(p.checks.find((c) => c.id === 'data')!.ok).toBe(false)
    expect(p.impact!.items.filter((i) => i.needsApproval).map((i) => [i.effect, i.table, i.count])).toEqual([['rows_set_aside', 'receipts', 2]])
    expect(p.acknowledgement).toEqual({ 'rows_set_aside:receipts:': 2 })
  })

  it('is refused without that approval, and nothing changes', async () => {
    const out = await restore(tableChange)
    expect(out).toMatchObject({ ok: false, code: 'NEEDS_APPROVAL' })
    expect(await rowsOf('receipts')).toHaveLength(2)
    expect((await record(tableChange)).status).toBe('healthy')
  })

  it('runs with the acknowledgement, keeping the rows in its vault', async () => {
    const p = (await previewRecovery(projectId, tableChange))!
    const out = await restore(tableChange, p.acknowledgement)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    expect(await rowsOf('receipts')).toBeNull()
    const rec = await record((out as Extract<typeof out, { ok: true }>).recoveryId)
    const entry = ((rec.preserved as any).entries as any[]).find((e) => e.kind === 'table' && e.table === 'receipts')
    expect(entry.rows).toBe(2)
    expect((await query(`SELECT memo FROM "${entry.vault}"."${entry.vaultTable}" ORDER BY memo`)).map((r) => r.memo)).toEqual(['coffee', 'lunch'])
  })

  it('reapplying brings the rows back', async () => {
    const recoveryId = (await record(tableChange)).recoveredById!
    const p = (await previewRecovery(projectId, recoveryId))!
    expect({ action: p.action, safety: p.safety }).toEqual({ action: 'reapply', safety: 'lossless' })
    expect((await restore(recoveryId, p.acknowledgement)).ok).toBe(true)
    expect((await query(`SELECT memo FROM ${T('receipts')} ORDER BY memo`)).map((r) => r.memo)).toEqual(['coffee', 'lunch'])
  })

  it('a value written into an added column: needs approval for exactly that value, not the defaults', async () => {
    const p = (await previewRecovery(projectId, columnChange))!
    expect(p.safety).toBe('needs_approval')
    expect(p.acknowledgement).toEqual({ 'values_set_aside:tabs:tip': 1 })
    const out = await restore(columnChange, p.acknowledgement)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    expect(await columnsOf('tabs')).not.toContain('tip')
  })

  it('reapplying brings the value back', async () => {
    const recoveryId = (await record(columnChange)).recoveredById!
    const p = (await previewRecovery(projectId, recoveryId))!
    expect((await restore(recoveryId, p.acknowledgement)).ok).toBe(true)
    expect(await query(`SELECT label, tip FROM ${T('tabs')} ORDER BY label`)).toEqual([{ label: 'one', tip: 0 }, { label: 'two', tip: 5 }])
  })
})

// ── Reapplying after the app wrote since the restore ─────────────────────────

describe('reapplying after the app wrote since the restore: only those writes count', () => {
  let dropChange: string
  let retypeChange: string

  beforeAll(async () => {
    await migrated('CREATE TABLE inbox (subject text NOT NULL, label text)')
    await exec(`INSERT INTO ${T('inbox')} (subject, label) VALUES ('a', 'work'), ('b', 'home'), ('c', NULL)`)
    const dropped = await asPerson(() => dropWorkspaceColumn(projectId, { tableName: 'inbox', columnName: 'label' }))
    dropChange = (dropped as any).change.id
    expect((await restore(dropChange)).ok).toBe(true)
    await exec(`UPDATE ${T('inbox')} SET label = 'urgent' WHERE subject = 'a'`)
    await exec(`INSERT INTO ${T('inbox')} (subject, label) VALUES ('d', 'later')`)

    await migrated('CREATE TABLE gauges (label text NOT NULL, level integer)')
    await exec(`INSERT INTO ${T('gauges')} (label, level) VALUES ('north', 1), ('south', 2)`)
    retypeChange = await retype('gauges', 'level', 'BIGINT')
    expect((await restore(retypeChange)).ok).toBe(true)
    await exec(`INSERT INTO ${T('gauges')} (label, level) VALUES ('east', 3)`)
    await exec(`UPDATE ${T('gauges')} SET level = 20 WHERE label = 'south'`)
  }, 120_000)

  it('a dropped column brought back: the value changed since and the new one need approval, not the ones the restore put back', async () => {
    const recoveryId = (await record(dropChange)).recoveredById!
    const p = (await previewRecovery(projectId, recoveryId))!
    expect({ action: p.action, safety: p.safety }).toEqual({ action: 'reapply', safety: 'needs_approval' })
    expect(p.acknowledgement).toEqual({ 'values_set_aside:inbox:label': 2 })
    const out = await restore(recoveryId, p.acknowledgement)
    expect(out).toMatchObject({ ok: true })
    expect(await columnsOf('inbox')).not.toContain('label')
    // Every value goes into the reapply's vault, the restored ones with the new.
    const rec = await record((out as Extract<typeof out, { ok: true }>).recoveryId)
    const kept = ((rec.preserved as any).entries as any[]).find((e) => e.reason === 'dropped' && e.table === 'inbox')
    expect((await query(`SELECT label FROM "${kept.vault}"."${kept.vaultTable}" ORDER BY label`)).map((r) => r.label)).toEqual(['home', 'later', 'urgent'])
  })

  it('a retype converted back: the rows written since keep their values, the rest get theirs back, nothing to approve', async () => {
    const recoveryId = (await record(retypeChange)).recoveredById!
    const p = (await previewRecovery(projectId, recoveryId))!
    expect({ action: p.action, safety: p.safety, reason: p.reason }).toEqual({ action: 'reapply', safety: 'lossless', reason: null })
    expect(p.impact!.items.map((i) => [i.effect, i.column, i.count])).toEqual([['writes_kept', 'level', 2]])
    const out = await restore(recoveryId, p.acknowledgement)
    expect(out).toMatchObject({ ok: true })
    expect((await catalog()).tables.gauges.columns.find((c) => c.name === 'level')!.type).toBe('bigint')
    expect(await query(`SELECT label, level::text AS level FROM ${T('gauges')} ORDER BY label`)).toEqual([
      { label: 'east', level: '3' }, { label: 'north', level: '1' }, { label: 'south', level: '20' },
    ])
  })
})

// ── What apply_migration refuses ─────────────────────────────────────────────

// ── DROP INDEX: the executor's own action, as an approved unused-index finding runs it ──

changeClass('DROP INDEX, as an approved unused-index finding runs it: the index comes back exactly', {
  tables: ['catalogue'],
  arrange: async () => {
    await migrated('CREATE TABLE catalogue (title text, shelf text)')
    await migrated('CREATE INDEX catalogue_shelf ON catalogue (shelf)')
    await exec(`INSERT INTO ${T('catalogue')} (title, shelf) VALUES ('Dune', 'B2'), ('Emma', 'A1')`)
  },
  act: async () => {
    const r = await asPerson(() =>
      executeAction({ action: 'DROP_INDEX', params: { indexName: 'catalogue_shelf', tableName: 'catalogue', confirmed: true } } as any, projectId, undefined, 0, undefined, false))
    if (!r.success) throw new Error(`DROP_INDEX failed: ${r.message}`)
    return latestChangeId()
  },
  // It removes no data, and it creates nothing either: transforming, not additive.
  risk: 'transforming',
  recorded: (row, after) => {
    expect(after.cat.tables.catalogue.indexes.map((i) => i.name)).not.toContain('catalogue_shelf')
    expect((row.footprint as any[]).flatMap((c) => c.details)).toEqual(expect.arrayContaining([expect.stringMatching(/^− .*catalogue_shelf/)]))
  },
}, () => {
  it('a unique index is refused by the executor: nothing changes, and the history lists nothing new', async () => {
    await migrated('CREATE UNIQUE INDEX catalogue_title ON catalogue (title)')
    // A change that failed before changing anything is recorded as failed, and not listed.
    const listed = () => prisma.backendChange.count({ where: { projectId, status: { not: 'failed' } } })
    const before = await listed()
    const r = await asPerson(() =>
      executeAction({ action: 'DROP_INDEX', params: { indexName: 'catalogue_title', tableName: 'catalogue', confirmed: true } } as any, projectId, undefined, 0, undefined, false))
    expect(r.success).toBe(false)
    expect(await listed()).toBe(before)
    expect((await catalog()).tables.catalogue.indexes.map((i) => i.name)).toContain('catalogue_title')
  })
})

// ── A large table ─────────────────────────────────────────────────────────────

describe('a large table: 200,000 rows through a dropped column and a rewrite, each restored exactly', () => {
  const ROWS = 200_000
  /** Every value of a column, in id order, reduced to one digest: exact, without reading 200k rows into Node. */
  const fingerprint = async (column: string) => {
    const r = await query<{ n: number; digest: string }>(
      `SELECT count(*)::int AS n, md5(string_agg(coalesce("${column}"::text, '<null>'), ',' ORDER BY id)) AS digest FROM ${T('ledger_lines')}`,
    )
    return r[0]
  }
  let memo: { n: number; digest: string }
  let region: { n: number; digest: string }

  beforeAll(async () => {
    await migrated('CREATE TABLE ledger_lines (amount numeric, memo text, region text)')
    await exec(
      `INSERT INTO ${T('ledger_lines')} (amount, memo, region)
       SELECT (g % 997)::numeric / 7, 'memo ' || g, CASE g % 3 WHEN 0 THEN 'EU' WHEN 1 THEN 'us' ELSE 'APAC' END
         FROM generate_series(1, ${ROWS}) g`,
    )
    memo = await fingerprint('memo')
    region = await fingerprint('region')
    expect(memo.n).toBe(ROWS)
  }, 300_000)

  it('a dropped column keeps all 200,000 values, and its restore brings every one back', async () => {
    const dropped = await asPerson(() => dropWorkspaceColumn(projectId, { tableName: 'ledger_lines', columnName: 'memo' }))
    const id = (dropped as any).change.id as string
    const row = await record(id)
    expect(row).toMatchObject({ status: 'healthy', risk: 'destructive' })
    const kept = ((row.preserved as any).entries as any[]).find((e) => e.kind === 'column' && e.table === 'ledger_lines')
    expect(kept.rows).toBe(ROWS)
    expect(await columnsOf('ledger_lines')).not.toContain('memo')

    const p = (await previewRecovery(projectId, id))!
    expect(p.safety).toBe('lossless')
    const out = await restore(id, p.acknowledgement)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    expect((out as Extract<typeof out, { ok: true }>).verification.outcome).toBe('confirmed')
    expect(await fingerprint('memo')).toEqual(memo)
  }, 300_000)

  it('a rewrite of two thirds of the rows keeps its images, and its restore puts every original value back', async () => {
    const id = await dataMigration([{ op: 'normalize_values', table: 'ledger_lines', column: 'region', mapping: { EU: 'eu', APAC: 'apac' } }])
    expect(await query(`SELECT count(*)::int AS n FROM ${T('ledger_lines')} WHERE region IN ('EU', 'APAC')`)).toEqual([{ n: 0 }])
    expect((await record(id)).risk).toBe('data_rewrite')

    const p = (await previewRecovery(projectId, id))!
    expect({ safety: p.safety, reason: p.reason, proof: p.details.proof }).toEqual({ safety: 'lossless', reason: null, proof: expect.objectContaining({ ok: true }) })
    const out = await restore(id, p.acknowledgement)
    expect(out).toMatchObject({ ok: true, status: 'restored' })
    expect(await fingerprint('region')).toEqual(region)
  }, 300_000)
})

describe('statements apply_migration refuses: nothing applied, nothing recorded', () => {
  it.each([
    ['RENAME TABLE', 'ALTER TABLE pantry RENAME TO larder', 'UNSUPPORTED_STATEMENT'],
    ['ALTER COLUMN TYPE', 'ALTER TABLE meters ALTER COLUMN reading TYPE bigint', 'UNSUPPORTED_STATEMENT'],
    ['DROP COLUMN', 'ALTER TABLE contacts DROP COLUMN name', 'DESTRUCTIVE_REFUSED'],
    ['DROP TABLE', 'DROP TABLE shelves', 'DESTRUCTIVE_REFUSED'],
    ['CREATE TYPE … AS ENUM', "CREATE TYPE mood AS ENUM ('calm', 'busy')", 'UNSUPPORTED_STATEMENT'],
    ['an enum column', "ALTER TABLE shelves ADD COLUMN mood mood", 'UNSUPPORTED_TYPE'],
    ['CREATE VIEW', 'CREATE VIEW pantry_items AS SELECT item FROM pantry', 'UNSUPPORTED_STATEMENT'],
    // No agent path drops a constraint or an index, or changes a primary key,
    // which Backenly manages. The engine's handling of each is proved in
    // change-recovery.spec.ts, and a plain index's drop below.
    ['DROP CONSTRAINT', 'ALTER TABLE contacts DROP CONSTRAINT contacts_email_key', 'DESTRUCTIVE_REFUSED'],
    ['DROP INDEX', 'DROP INDEX pantry_item_idx', 'DESTRUCTIVE_REFUSED'],
    ['a primary key moved to another column', 'ALTER TABLE shelves ADD PRIMARY KEY (title)', 'UNSUPPORTED_CONSTRAINT'],
    ['the primary key dropped', 'ALTER TABLE shelves DROP CONSTRAINT shelves_pkey', 'DESTRUCTIVE_REFUSED'],
    ['a refused statement after a valid one', 'CREATE TABLE never_made (x text);\nDROP TABLE shelves', 'DESTRUCTIVE_REFUSED'],
    ['rows moved between tables (INSERT … SELECT)', 'INSERT INTO larder (item) SELECT item FROM pantry', 'DML_NOT_MIGRATION'],
    ['rows deleted (DELETE)', 'DELETE FROM pantry WHERE qty IS NULL', 'DML_NOT_MIGRATION'],
    ['rows rewritten (UPDATE)', "UPDATE pantry SET item = upper(item)", 'DML_NOT_MIGRATION'],
  ])('%s', async (_label, statement, code) => {
    const changes = await prisma.backendChange.count({ where: { projectId } })
    const before = await catalog()
    const out = await migrate(statement)
    expect(out).toMatchObject({ ok: false, code, applied: [] })
    expect(await prisma.backendChange.count({ where: { projectId } })).toBe(changes)
    const now = await catalog()
    expect(Object.keys(now.tables).sort()).toEqual(Object.keys(before.tables).sort())
    for (const t of Object.keys(before.tables)) expect([t, signature(now, t)]).toEqual([t, signature(before, t)])
    expect(Object.keys(now.objects ?? {}).sort()).toEqual(Object.keys(before.objects ?? {}).sort())
  })
})
