/**
 * MIGRATION RESIDUE — what a migration that did not finish leaves behind
 * ------------------------------------------------------------------------
 * "Detect failed migrations" cannot be built directly here, and the reason is
 * structural rather than an oversight: the event triggers that record external
 * DDL fire on `ddl_command_end` and `sql_drop`, and PostgreSQL raises both only
 * on SUCCESS. A statement that failed leaves no row anywhere the platform reads.
 *
 * So the fixtures below cause REAL failures and assert on what survives them.
 * The invalid index is produced by letting a `CREATE INDEX CONCURRENTLY UNIQUE`
 * fail against duplicate data — the actual mechanism, not a hand-set flag.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { detectMigrationResidue } from '@/lib/autonomy/migration-residue'
import { executeAction } from '@/lib/ai/minimal-executor'
import { classifyFix } from '@/lib/core/fix-classifier'
import { deriveTier, INVARIANTS } from '@/lib/autonomy/desired-state'
import { buildFixAction, getManualRemediationHint } from '@/lib/core/fix-actions'

let userId: string
let projectId: string
let schema: string
let pool: Pool
let findings: Awaited<ReturnType<typeof detectMigrationResidue>>

const of = (kind: string) =>
  findings.find(f => (f.details as any).residueKind === kind)

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `residue-${Date.now()}@example.test`, password: 'x', name: 'residue' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'migration-residue-test', userId } })
  projectId = project.id
  schema = `workspace_${projectId}`

  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  await pool.query(`CREATE SCHEMA "${schema}"`)
  await pool.query(`CREATE TABLE "${schema}"."t" (id serial primary key, k int, ref int)`)
  await pool.query(`INSERT INTO "${schema}"."t"(k, ref) SELECT i, i FROM generate_series(1, 2000) i`)
  // A duplicate, so the concurrent unique build below genuinely fails.
  await pool.query(`INSERT INTO "${schema}"."t"(k, ref) VALUES (1, 1)`)

  // The real mechanism: a failed CREATE INDEX CONCURRENTLY leaves the index in
  // place, invalid. Nothing here sets a flag by hand.
  await pool.query(`CREATE UNIQUE INDEX CONCURRENTLY uq_t_k ON "${schema}"."t"(k)`)
    .catch(() => { /* expected — the duplicate is the point */ })

  // Step one of the two-step constraint playbook, with step two never run.
  await pool.query(`CREATE TABLE "${schema}"."parent" (id int primary key)`)
  await pool.query(
    `ALTER TABLE "${schema}"."t" ADD CONSTRAINT fk_t_ref
       FOREIGN KEY (ref) REFERENCES "${schema}"."parent"(id) NOT VALID`,
  )

  findings = await detectMigrationResidue(projectId)
}, 120_000)

afterAll(async () => {
  await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await pool?.end().catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('the loop runs this check', () => {
  test('it is registered in the invariant catalogue', () => {
    const inv = INVARIANTS.find(i => i.id === 'no_migration_was_left_half_finished')
    expect(inv).toBeDefined()
    expect(inv!.probe).toBe(detectMigrationResidue)
  })
})

describe('an index whose concurrent build did not finish', () => {
  test('the fixture really did leave an invalid index', async () => {
    // Asserted against the catalog directly. If the CREATE INDEX had somehow
    // succeeded, every assertion below would pass vacuously.
    const rows = await pool.query(
      `SELECT ix.indisvalid FROM pg_index ix
         JOIN pg_class i     ON i.oid = ix.indexrelid
         JOIN pg_namespace n ON n.oid = i.relnamespace
        WHERE n.nspname = $1 AND i.relname = 'uq_t_k'`,
      [schema],
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].indisvalid).toBe(false)
  })

  test('it is reported, with what makes it dangerous', () => {
    const f = of('invalid_index')
    expect(f).toBeDefined()
    const d = f!.details as any
    expect(d.indexName).toBe('uq_t_k')
    expect(d.tableName).toBe('t')
    // The point is that it is invisible: it looks like a working index and
    // costs a write on every insert while answering nothing.
    expect(d.reason).toMatch(/never use it to answer a query/i)
    expect(d.reason).toMatch(/looking exactly like a working index/i)
  })

  test('the repair is offered but gated, because it can fail the same way again', () => {
    const d = of('invalid_index')!.details as any
    const c = classifyFix('migration_residue', d)
    expect(c.decision).toBe('approval')
    expect(deriveTier('migration_residue', d)).toBe(2)
    expect(buildFixAction('migration_residue', d)).toEqual({
      action: 'REINDEX_INDEX',
      params: { tableName: 't', indexName: 'uq_t_k' },
    })
    expect(c.riskNote).toMatch(/fail again/i)
  })

  test('and rebuilding it does fail while the duplicate is still there', async () => {
    // The honest outcome. A repair that reported success here would be claiming
    // to have fixed something it could not.
    const res = await executeAction(
      { action: 'REINDEX_INDEX', params: { indexName: 'uq_t_k' } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(res.success).toBe(false)
    expect(res.message).toMatch(/could not/i)
  }, 60_000)
})

describe('a constraint added NOT VALID whose second step never ran', () => {
  test('it is reported as a guarantee the data was never held to', () => {
    const f = of('unvalidated_constraint')
    expect(f).toBeDefined()
    const d = f!.details as any
    expect(d.constraintName).toBe('fk_t_ref')
    expect(d.reason).toMatch(/never were|never checked/i)
    expect(d.definition).toMatch(/FOREIGN KEY/i)
  })

  test('validating it is one approved click', () => {
    const d = of('unvalidated_constraint')!.details as any
    expect(classifyFix('migration_residue', d).decision).toBe('approval')
    expect(buildFixAction('migration_residue', d)).toEqual({
      action: 'VALIDATE_CONSTRAINT',
      params: { tableName: 't', constraintName: 'fk_t_ref' },
    })
  })

  test('validation fails loudly when the existing rows violate it, naming why', async () => {
    // `parent` is empty, so every `ref` in `t` is an orphan. This is precisely
    // the discovery the check exists to make, so the database's own error has to
    // survive to the surface rather than becoming "could not apply".
    const res = await executeAction(
      { action: 'VALIDATE_CONSTRAINT', params: { tableName: 't', constraintName: 'fk_t_ref' } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(res.success).toBe(false)
    expect(res.message).toMatch(/does not satisfy it/i)
    expect(res.message).toMatch(/fk_t_ref/)
  }, 60_000)

  test('validation succeeds once the data is consistent, and says so', async () => {
    await pool.query(`INSERT INTO "${schema}"."parent"(id) SELECT DISTINCT ref FROM "${schema}"."t"`)
    const res = await executeAction(
      { action: 'VALIDATE_CONSTRAINT', params: { tableName: 't', constraintName: 'fk_t_ref' } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(res.success).toBe(true)
    expect(res.message).toMatch(/now actually true/i)

    // And the finding withdraws itself, because the probe reads the catalog.
    const after = await detectMigrationResidue(projectId)
    expect(after.find(f => (f.details as any).residueKind === 'unvalidated_constraint'))
      .toBeUndefined()
  }, 120_000)

  test('validating an already-valid constraint is a no-op success', async () => {
    const res = await executeAction(
      { action: 'VALIDATE_CONSTRAINT', params: { tableName: 't', constraintName: 'fk_t_ref' } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(res.success).toBe(true)
    expect(res.message).toMatch(/already validated/i)
  }, 30_000)

  test('a constraint that no longer exists is a success, not a failure', async () => {
    const res = await executeAction(
      { action: 'VALIDATE_CONSTRAINT', params: { tableName: 't', constraintName: 'gone_entirely' } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(res.success).toBe(true)
    expect(res.message).toMatch(/no longer exists/i)
  }, 30_000)

  test('refuses an identifier that is not one', async () => {
    const res = await executeAction(
      { action: 'VALIDATE_CONSTRAINT', params: { tableName: 't', constraintName: 'x"; DROP TABLE t; --' } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(res.success).toBe(false)
    expect(res.message).toMatch(/not a valid PostgreSQL identifier/i)
  }, 30_000)
})

describe('an abandoned prepared transaction', () => {
  const details = { residueKind: 'prepared_transaction', gid: 'migrate_42', ageMinutes: 90 }

  test('is notify_only — there is no safe default', () => {
    // Committing applies work the owner may not want; rolling back discards work
    // they may. An approval queue implies a repair waits behind a yes.
    expect(classifyFix('migration_residue', details).decision).toBe('notify_only')
    expect(deriveTier('migration_residue', details)).toBe(3)
    expect(buildFixAction('migration_residue', details)).toBeNull()
  })

  test('the hint gives both commands and refuses to choose', () => {
    const hint = getManualRemediationHint('migration_residue', details)!
    expect(hint).toContain('COMMIT PREPARED')
    expect(hint).toContain('ROLLBACK PREPARED')
    expect(hint).toContain('migrate_42')
    expect(hint).toMatch(/will not choose for you/i)
  })
})
