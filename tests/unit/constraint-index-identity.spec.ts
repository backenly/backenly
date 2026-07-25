/**
 * "Already exists" must be true before it is reported as success.
 *
 * ── The defect being locked down ─────────────────────────────────────────────
 *
 * `executeAddConstraint` named every constraint `chk_<table>_<column>`, so a
 * table needing two constraints on the same column could hold only one. The
 * second attempt hit PostgreSQL's duplicate-NAME error, and the handler was
 *
 *     if (error.message.includes('already exists'))
 *       return { success: true, message: '✅ Constraint already exists' }
 *
 * So the call that should have installed a value domain instead reported that it
 * was already installed — while the only constraint on the column was a different
 * one the platform had synthesised. Reported as defect #2, and it is what made
 * defect #1 unrecoverable: the obvious repair confirmed the lie.
 *
 * Two things had to become true, and both are pure functions tested here:
 *
 *   1. Distinct constraints get distinct NAMES, derived from the definition
 *      rather than from the column alone — so the collision does not arise.
 *   2. When a name IS already taken, the existing definition is COMPARED against
 *      the requested one. Equal → genuinely idempotent. Different → a reported
 *      conflict, never a success.
 *
 * The comparison has to normalise, because `pg_get_constraintdef` rewrites what
 * it is given: an `IN` list comes back as `= ANY (ARRAY[…::text])`. A byte
 * comparison would call an identical constraint "different" and refuse to
 * re-apply a migration that was already correct.
 */

import {
  sameConstraint,
  normalizeConstraintDef,
  derivedConstraintName,
  defaultIndexName,
  indexDefColumns,
} from '@/lib/ai/minimal-executor'

describe('constraint identity — idempotency must be earned, not assumed', () => {
  it('recognises a CHECK that Postgres rewrote as the same constraint', () => {
    // Submitted by an author vs. read back from pg_get_constraintdef.
    const submitted = `CHECK (status IN ('pending','accepted','declined'))`
    const readBack = `CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'accepted'::character varying, 'declined'::character varying])::text[])))`
    // Both directions, since the caller compares in whichever order it holds them.
    expect(sameConstraint(readBack, submitted)).toBe(true)
    expect(sameConstraint(submitted, readBack)).toBe(true)
  })

  it('recognises a simple predicate across quoting and spacing differences', () => {
    expect(sameConstraint('CHECK (price > 0)', 'CHECK ((price > 0))')).toBe(true)
    expect(sameConstraint('CHECK (price>0)', 'CHECK ( price > 0 )')).toBe(true)
    expect(sameConstraint('UNIQUE (email)', 'UNIQUE ("email")')).toBe(true)
  })

  it('does NOT confuse the author CHECK with the platform NOT-NULL one', () => {
    // These two are the whole defect. `CHECK (status IS NOT NULL)` is what the
    // broken synthesis installed; `status IN (…)` is what was asked for. Treating
    // them as the same constraint is what let "already exists" be reported.
    const wanted = `CHECK (status IN ('pending','accepted','declined'))`
    const installed = `CHECK ((status IS NOT NULL))`
    expect(sameConstraint(wanted, installed)).toBe(false)
  })

  it('does not confuse two different predicates on the same column', () => {
    expect(sameConstraint('CHECK (price > 0)', 'CHECK (price > 100)')).toBe(false)
    expect(sameConstraint('CHECK (price > 0)', 'CHECK (price < 0)')).toBe(false)
    expect(sameConstraint('UNIQUE (email)', 'UNIQUE (username)')).toBe(false)
    expect(sameConstraint('UNIQUE (a)', 'UNIQUE (a, b)')).toBe(false)
  })

  it('normalisation is stable — the same input always yields the same key', () => {
    const def = `CHECK (status IN ('a','b'))`
    expect(normalizeConstraintDef(def)).toBe(normalizeConstraintDef(def))
    expect(normalizeConstraintDef(def).length).toBeGreaterThan(0)
  })

  it('tolerates a null or undefined definition without throwing', () => {
    expect(() => normalizeConstraintDef(undefined as any)).not.toThrow()
    expect(normalizeConstraintDef(undefined as any)).toBe('')
  })
})

describe('constraint names — two different rules cannot collide', () => {
  it('gives two different CHECKs on the same column different names', () => {
    const a = derivedConstraintName('connections', 'check', ['status'], `CHECK (status IN ('a','b'))`)
    const b = derivedConstraintName('connections', 'check', ['status'], `CHECK (status <> '')`)
    expect(a).not.toBe(b)
  })

  it('is DETERMINISTIC, so re-running the same migration is genuinely idempotent', () => {
    // Not merely accidentally so. A random or time-based suffix would make every
    // replay add another copy of the same constraint.
    const def = `CHECK (price > 0)`
    expect(derivedConstraintName('items', 'check', ['price'], def))
      .toBe(derivedConstraintName('items', 'check', ['price'], def))
  })

  it('respects PostgreSQL\'s 63-byte identifier limit', () => {
    const longTable = 'a'.repeat(50)
    const name = derivedConstraintName(longTable, 'check', ['b'.repeat(40)], 'CHECK (x > 0)')
    expect(name.length).toBeLessThanOrEqual(63)
  })

  it('distinguishes a UNIQUE from a CHECK by prefix', () => {
    expect(derivedConstraintName('u', 'unique', ['email'], 'UNIQUE (email)')).toMatch(/^uq_/)
    expect(derivedConstraintName('u', 'check', ['email'], 'CHECK (email <> \'\')')).toMatch(/^chk_/)
  })
})

describe('index names and definitions', () => {
  it('encodes every column, so two indexes on the same leading column differ', () => {
    // `idx_<table>_<col>` was the same string for both, and `IF NOT EXISTS` then
    // made the second a silent no-op.
    const a = defaultIndexName('conversations', ['user_a'], false)
    const b = defaultIndexName('conversations', ['user_a', 'user_b'], false)
    expect(a).not.toBe(b)
  })

  it('distinguishes a unique index from a plain one', () => {
    expect(defaultIndexName('t', ['c'], true)).not.toBe(defaultIndexName('t', ['c'], false))
    expect(defaultIndexName('t', ['c'], true)).toMatch(/^uniq_/)
    expect(defaultIndexName('t', ['c'], false)).toMatch(/^idx_/)
  })

  it('respects the 63-byte identifier limit', () => {
    const name = defaultIndexName('t'.repeat(40), ['c'.repeat(40), 'd'.repeat(40)], true)
    expect(name.length).toBeLessThanOrEqual(63)
  })

  it('reads the column tuple back out of a pg_indexes definition', () => {
    expect(indexDefColumns(
      'CREATE UNIQUE INDEX uniq_conversations_user_a_user_b ON workspace_x.conversations USING btree (user_a, user_b)',
    )).toEqual(['user_a', 'user_b'])
  })

  it('strips quoting and sort modifiers when reading columns back', () => {
    expect(indexDefColumns(
      'CREATE INDEX i ON s.t USING btree ("createdAt" DESC, author_id)',
    )).toEqual(['createdat', 'author_id'])
  })

  it('returns an empty list rather than throwing on an unparseable definition', () => {
    expect(indexDefColumns('not an index definition')).toEqual([])
  })
})
