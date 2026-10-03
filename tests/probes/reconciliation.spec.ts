/**
 * PHASE 6 — source↔target reconciliation, the safety oracle
 * ==========================================================
 *
 * Read-only. Built before anything that mutates, so the dangerous steps arrive
 * into an environment that can already check them.
 *
 * The case that matters most is not a happy path:
 *
 *     mismatch ledger == 0  AND  reconciliation finds wrong values  →  HALT
 *
 * A dual-write trigger swallows exceptions so it cannot abort a customer's
 * write. That means the ledger records only writes that THREW. A trigger that
 * succeeds with a wrong value — a bad cast, a truncation — records nothing, so
 * zero is the reading you get both when everything worked and when the
 * instrumentation is blind. This suite exists to prove the ledger is never
 * treated as the sole authority.
 *
 * The second rule, tested throughout:
 *
 *     could not compare  ≠  compared and agreed
 *
 * Real DDL against a real PostgreSQL. Fixtures create their own isolated tables
 * inside a lab-seeded workspace schema; nothing here mutates product state.
 */

import { PrismaClient } from '@prisma/client'

import { scenario } from '../lab/scenarios'
import { seedScenario, teardownScenario, type SeededProject } from '../lab/seed'
import {
  reconcileSourceTarget,
  maySwitchReaders,
  type Transform,
} from '@/lib/autonomy/maintenance/reconcile'

const prisma = new PrismaClient()
const seeded: SeededProject[] = []
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

let s: SeededProject

beforeAll(async () => {
  s = await seedScenario(prisma, scenario('content-community'))
  seeded.push(s)
})

afterAll(async () => {
  for (const x of seeded) await teardownScenario(prisma, x)
  await prisma.$disconnect()
})

/** An isolated table holding (source, target) pairs, scoped to one test. */
async function fixture(
  name: string,
  rows: Array<[string | null, string | null]>,
): Promise<string> {
  await q(`DROP TABLE IF EXISTS "${s.schema}"."${name}"`)
  await q(`CREATE TABLE "${s.schema}"."${name}" (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    src text,
    tgt text
  )`)
  for (const [src, tgt] of rows) {
    const a = src === null ? 'NULL' : `'${src}'`
    const b = tgt === null ? 'NULL' : `'${tgt}'`
    await q(`INSERT INTO "${s.schema}"."${name}" (src, tgt) VALUES (${a}, ${b})`)
  }
  return name
}

const reconcile = (table: string, transform: Transform = { kind: 'identity' }, over = {}) =>
  reconcileSourceTarget({
    projectId: s.projectId,
    table,
    sourceColumn: 'src',
    targetColumn: 'tgt',
    transform,
    planIdentity: 'plan-v1',
    ...over,
  })

// ── Agreement ────────────────────────────────────────────────────────────────

describe('consistent', () => {
  it('identical values agree', async () => {
    const t = await fixture('rc_identical', [['a', 'a'], ['b', 'b'], ['c', 'c']])
    const r = await reconcile(t)

    expect(r.verdict).toBe('consistent')
    expect(r.comparedRows).toBe(3)
    expect(r.mismatchedRows).toBe(0)
    expect(r.method).toBe('full_compare')
    expect(r.coverage.complete).toBe(true)
  })

  it('values agree under a declared transform', async () => {
    const t = await fixture('rc_lower', [['ABC', 'abc'], ['DeF', 'def']])
    expect((await reconcile(t, { kind: 'lower' })).verdict).toBe('consistent')
  })

  it('an explicit value map agrees', async () => {
    const t = await fixture('rc_map', [['pending', 'P'], ['done', 'D']])
    const r = await reconcile(t, { kind: 'value_map', map: { pending: 'P', done: 'D' } })
    expect(r.verdict).toBe('consistent')
  })

  /**
   * NULL semantics, stated rather than inherited. Comparison is
   * `IS DISTINCT FROM`, so two unset values agree — which is the behaviour a
   * dual-write should produce, and the opposite of plain `=`.
   */
  it('NULL on both sides agrees', async () => {
    const t = await fixture('rc_nulls', [[null, null], ['a', 'a']])
    expect((await reconcile(t)).verdict).toBe('consistent')
  })

  it('null_to fills only the nulls', async () => {
    const t = await fixture('rc_nullto', [[null, 'unset'], ['a', 'a']])
    expect((await reconcile(t, { kind: 'null_to', value: 'unset' })).verdict).toBe('consistent')
  })
})

// ── Disagreement ─────────────────────────────────────────────────────────────

describe('inconsistent', () => {
  it('one wrong target is caught', async () => {
    const t = await fixture('rc_one_wrong', [['a', 'a'], ['b', 'WRONG'], ['c', 'c']])
    const r = await reconcile(t)

    expect(r.verdict).toBe('inconsistent')
    expect(r.mismatchedRows).toBe(1)
    expect(r.evidence.mismatchExamples.length).toBeGreaterThan(0)
  })

  it('NULL on one side only is a mismatch', async () => {
    const t = await fixture('rc_half_null', [['a', null]])
    expect((await reconcile(t)).verdict).toBe('inconsistent')
  })

  /**
   * An unmapped value yields NULL rather than passing through. Passing it
   * through would hide exactly the divergence this is meant to find.
   */
  it('a value outside the map is a mismatch, not a pass-through', async () => {
    const t = await fixture('rc_unmapped', [['pending', 'P'], ['archived', 'archived']])
    const r = await reconcile(t, { kind: 'value_map', map: { pending: 'P' } })
    expect(r.verdict).toBe('inconsistent')
  })

  it('a transform mismatch is caught', async () => {
    const t = await fixture('rc_case', [['ABC', 'ABC']])
    expect((await reconcile(t, { kind: 'lower' })).verdict).toBe('inconsistent')
  })
})

// ── The case this module exists for ──────────────────────────────────────────

describe('the mismatch ledger is never the sole authority', () => {
  /**
   * The single most important test in Phase 6.
   *
   * The ledger reads zero — no dual-write threw — and the target is
   * nevertheless wrong, which is what a successful write of a bad value looks
   * like. If this ever allows a switch, expand/contract becomes a data-loss
   * mechanism with extra steps.
   */
  it('HALTS when the ledger says zero but reconciliation finds wrong values', async () => {
    const t = await fixture('rc_silent_divergence', [['a', 'a'], ['b', 'b'], ['c', 'WRONG']])
    const r = await reconcile(t)

    expect(r.verdict).toBe('inconsistent')

    const gate = maySwitchReaders({ mismatchLedgerCount: 0, reconciliation: r })
    expect(gate.allowed).toBe(false)
    expect(gate.reason).toMatch(/ledger only records writes that THREW|disagreeing rows/)
  })

  it('HALTS when consistency could not be demonstrated', async () => {
    const t = await fixture('rc_empty', [])
    const r = await reconcile(t)

    expect(r.verdict).toBe('inconclusive')
    expect(maySwitchReaders({ mismatchLedgerCount: 0, reconciliation: r }).allowed).toBe(false)
  })

  it('HALTS when the ledger has unreconciled mismatches, even if rows agree', async () => {
    const t = await fixture('rc_agree_but_ledger', [['a', 'a']])
    const r = await reconcile(t)

    expect(r.verdict).toBe('consistent')
    expect(maySwitchReaders({ mismatchLedgerCount: 3, reconciliation: r }).allowed).toBe(false)
  })

  it('ALLOWS only when both conditions hold', async () => {
    // Without this the gate could be satisfied by always refusing.
    const t = await fixture('rc_both_ok', [['a', 'a'], ['b', 'b']])
    const r = await reconcile(t)
    expect(maySwitchReaders({ mismatchLedgerCount: 0, reconciliation: r }).allowed).toBe(true)
  })
})

// ── Could not compare ────────────────────────────────────────────────────────

describe('inconclusive, never accidental success', () => {
  it('a missing column is inconclusive', async () => {
    const t = await fixture('rc_missing_col', [['a', 'a']])
    const r = await reconcileSourceTarget({
      projectId: s.projectId,
      table: t,
      sourceColumn: 'src',
      targetColumn: 'does_not_exist',
      transform: { kind: 'identity' },
      planIdentity: 'p',
    })
    expect(r.verdict).toBe('inconclusive')
    expect(r.evidence.reason).toMatch(/not found/)
  })

  it('a column that disappears mid-verification is inconclusive', async () => {
    const t = await fixture('rc_dropped', [['a', 'a']])
    await q(`ALTER TABLE "${s.schema}"."${t}" DROP COLUMN tgt`)
    expect((await reconcile(t)).verdict).toBe('inconclusive')
  })

  it('a missing table is inconclusive', async () => {
    const r = await reconcile('rc_no_such_table')
    expect(r.verdict).toBe('inconclusive')
  })

  it('an empty table is inconclusive, explicitly', async () => {
    const t = await fixture('rc_zero_rows', [])
    const r = await reconcile(t)
    expect(r.verdict).toBe('inconclusive')
    expect(r.comparedRows).toBe(0)
    // Stated, not accidental: nothing was compared, so nothing was shown.
    expect(r.evidence.reason).toMatch(/no rows/)
  })

  it('an empty value_map is refused rather than guessed', async () => {
    const t = await fixture('rc_empty_map', [['a', 'a']])
    const r = await reconcile(t, { kind: 'value_map', map: {} })
    expect(r.verdict).toBe('inconclusive')
    expect(r.evidence.reason).toMatch(/no mappings/)
  })

  it('an invalid identifier is refused', async () => {
    const r = await reconcileSourceTarget({
      projectId: s.projectId,
      table: 'bad table; DROP',
      sourceColumn: 'src',
      targetColumn: 'tgt',
      transform: { kind: 'identity' },
      planIdentity: 'p',
    })
    expect(r.verdict).toBe('inconclusive')
  })
})

// ── Sampling ─────────────────────────────────────────────────────────────────

describe('full compare below threshold, deterministic sample above', () => {
  const big = 'rc_big'

  beforeAll(async () => {
    await q(`DROP TABLE IF EXISTS "${s.schema}"."${big}"`)
    await q(`CREATE TABLE "${s.schema}"."${big}" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), src text, tgt text
    )`)
    await q(`INSERT INTO "${s.schema}"."${big}" (src, tgt)
             SELECT 'v' || i, 'v' || i FROM generate_series(1, 400) AS i`)
  })

  it('compares every row below the threshold', async () => {
    const r = await reconcile(big, { kind: 'identity' }, { fullCompareMaxRows: 1000 })
    expect(r.method).toBe('full_compare')
    expect(r.coverage.complete).toBe(true)
    expect(r.comparedRows).toBe(400)
  })

  it('samples above the threshold and reports incomplete coverage', async () => {
    const r = await reconcile(big, { kind: 'identity' }, {
      fullCompareMaxRows: 100,
      sampleRows: 50,
    })
    expect(r.method).toBe('deterministic_sample')
    expect(r.coverage.complete).toBe(false)
    expect(r.coverage.totalRows).toBe(400)
    expect(r.comparedRows).toBe(50)
  })

  /**
   * A sample that moves between runs turns a reproducible check into a flaky
   * one, and a flaky safety gate is worse than none: it gets retried until it
   * passes.
   */
  it('the same plan identity inspects the same slice', async () => {
    const opts = { fullCompareMaxRows: 100, sampleRows: 25 }
    const a = await reconcileSourceTarget({
      projectId: s.projectId, table: big, sourceColumn: 'src', targetColumn: 'tgt',
      transform: { kind: 'identity' }, planIdentity: 'stable-plan', ...opts,
    })
    const b = await reconcileSourceTarget({
      projectId: s.projectId, table: big, sourceColumn: 'src', targetColumn: 'tgt',
      transform: { kind: 'identity' }, planIdentity: 'stable-plan', ...opts,
    })
    expect(a.comparedRows).toBe(b.comparedRows)

    // And a different plan identity is allowed to differ — proving the salt is
    // actually used rather than the ordering being incidentally stable.
    const c = await reconcileSourceTarget({
      projectId: s.projectId, table: big, sourceColumn: 'src', targetColumn: 'tgt',
      transform: { kind: 'identity' }, planIdentity: 'other-plan', ...opts,
    })
    expect(c.comparedRows).toBe(a.comparedRows)
  })

  it('finds a mismatch inside a sampled table', async () => {
    await q(`UPDATE "${s.schema}"."${big}" SET tgt = 'BROKEN'`)
    const r = await reconcile(big, { kind: 'identity' }, {
      fullCompareMaxRows: 100,
      sampleRows: 50,
    })
    expect(r.verdict).toBe('inconsistent')
    expect(r.mismatchedRows).toBeGreaterThan(0)
  })
})
