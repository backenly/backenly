/**
 * CARRYING A DOMAIN ACROSS A TRANSFORM
 * ====================================
 *
 * The rung exists because expand/contract otherwise replaces a constrained
 * column with an unconstrained one and reports success. Its one hard property
 * is that the target's domain is the source's domain TRANSFORMED, never copied:
 * the target holds `transform(source)`, so under `upper` a verbatim copy of
 * `status IN ('active',...)` rejects every value the dual-write trigger writes
 * — silently, because that trigger swallows its own exceptions.
 *
 * These cover the two pure halves: reading a domain out of PostgreSQL's own
 * rendering of a CHECK, and applying a transform to one value. The database
 * halves — the violation scan and the ADD_CONSTRAINT — are exercised against a
 * real engine by the production acceptance run.
 */

import { enumerableDomain } from '@/lib/autonomy/maintenance/primitives/carry-constraints'
import { transformValue, asciiOnly, type Transform } from '@/lib/autonomy/maintenance/transform'

describe('reading a domain out of a CHECK', () => {
  // How PostgreSQL actually renders `CHECK (status IN ('active','archived'))`.
  // Not how it was typed — pg_get_constraintdef normalises it, and parsing the
  // typed form would find nothing.
  const rendered =
    "CHECK ((((status)::text = ANY ((ARRAY['active'::character varying, " +
    "'archived'::character varying, 'pending'::character varying])::text[]))))"

  it('reads the members in order', () => {
    expect(enumerableDomain(rendered)).toEqual(['active', 'archived', 'pending'])
  })

  it('reads a single-member domain', () => {
    expect(enumerableDomain("CHECK (((s)::text = ANY ((ARRAY['only'::text])::text[])))"))
      .toEqual(['only'])
  })

  it('unescapes a doubled quote', () => {
    expect(enumerableDomain("CHECK (((s)::text = ANY ((ARRAY['it''s'::text])::text[])))"))
      .toEqual(["it's"])
  })

  it('returns null for a domain that is not a list', () => {
    // A range, a regex and a function call are all real CHECKs and none of them
    // enumerate. Refusing is the point: a domain that cannot be enumerated
    // cannot be transformed member by member.
    expect(enumerableDomain('CHECK ((n > 0))')).toBeNull()
    expect(enumerableDomain("CHECK (((s)::text ~ '^a'::text))")).toBeNull()
    expect(enumerableDomain('CHECK ((length(s) < 10))')).toBeNull()
  })
})

describe('applying a transform to one value', () => {
  const cases: Array<[Transform, string | null, string | null]> = [
    [{ kind: 'identity' }, 'active', 'active'],
    [{ kind: 'upper' }, 'active', 'ACTIVE'],
    [{ kind: 'lower' }, 'ACTIVE', 'active'],
    [{ kind: 'trim' }, '  active  ', 'active'],
    [{ kind: 'null_to', value: 'unknown' }, null, 'unknown'],
    [{ kind: 'null_to', value: 'unknown' }, 'active', 'active'],
    [{ kind: 'value_map', map: { a: 'A' } }, 'a', 'A'],
    // Unlisted maps to NULL, exactly as the generated CASE does. Passing it
    // through would hide the divergence the transform exists to surface.
    [{ kind: 'value_map', map: { a: 'A' } }, 'b', null],
  ]

  it.each(cases)('%j applied to %j gives %j', (t, input, expected) => {
    expect(transformValue(t, input)).toBe(expected)
  })

  it('trims spaces only, like btrim, not like String.prototype.trim', () => {
    // btrim's default set is ' '. JavaScript's trim also takes tabs and
    // newlines, and the two renderings have to agree.
    expect(transformValue({ kind: 'trim' }, '\tactive\n')).toBe('\tactive\n')
    expect(transformValue({ kind: 'trim' }, ' active ')).toBe('active')
  })

  it('leaves NULL alone for every transform that is not null_to', () => {
    for (const t of [
      { kind: 'identity' }, { kind: 'upper' }, { kind: 'lower' }, { kind: 'trim' },
    ] as Transform[]) {
      expect(transformValue(t, null)).toBeNull()
    }
  })
})

describe('where SQL and JavaScript case folding may disagree', () => {
  it('recognises ASCII, which is where they agree', () => {
    expect(asciiOnly('active')).toBe(true)
    expect(asciiOnly('ACTIVE_1-2')).toBe(true)
  })

  it('recognises what it cannot vouch for', () => {
    // PostgreSQL's upper/lower are collation-dependent; JavaScript's are
    // Unicode-defined. Turkish dotless i is the standard counterexample. The
    // rung refuses rather than assuming a correspondence that usually holds.
    expect(asciiOnly('ıstanbul')).toBe(false)
    expect(asciiOnly('café')).toBe(false)
  })
})
