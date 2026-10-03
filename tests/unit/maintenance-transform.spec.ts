/**
 * THE TRANSFORM VOCABULARY — one definition, two renderings that must agree
 * =========================================================================
 *
 * A transform is rendered twice on the expand/contract ladder: parameterised
 * for reconciliation, literal for the dual-write trigger body, which cannot
 * carry bind parameters.
 *
 * Reconciliation is only meaningful because it recomputes the value
 * INDEPENDENTLY of whatever wrote it while agreeing with it exactly. Two
 * renderings satisfy the first half by construction and can lose the second
 * silently — and the day they disagree, the checker either reports a mismatch
 * that is its own or, worse, agrees because both were wrong the same way.
 *
 * So these tests pin the coupling: the same operator, the same argument order,
 * the same NULL behaviour, for every kind in the closed vocabulary. Adding a
 * transform fails here until both renderers know about it.
 *
 * Pure: the SQL is compared as text. Whether PostgreSQL agrees that the two
 * forms evaluate identically is asserted against a real engine in
 * tests/integration/maintenance-phase6b.spec.ts.
 */

import {
  sqlLiteral,
  TRANSFORM_KINDS,
  transformLiteralSql,
  transformProblem,
  transformSql,
  type Transform,
} from '@/lib/autonomy/maintenance/transform'

/** One representative of every kind, so the sweep below cannot miss one. */
const SAMPLES: Record<(typeof TRANSFORM_KINDS)[number], Transform> = {
  identity: { kind: 'identity' },
  lower: { kind: 'lower' },
  upper: { kind: 'upper' },
  trim: { kind: 'trim' },
  value_map: { kind: 'value_map', map: { active: 'ACTIVE', archived: 'ARCHIVED' } },
  null_to: { kind: 'null_to', value: 'unknown' },
}

describe('the vocabulary is closed and complete', () => {
  it('has a sample for every kind, and every kind is renderable', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...TRANSFORM_KINDS].sort())
    for (const kind of TRANSFORM_KINDS) {
      expect(transformProblem(SAMPLES[kind])).toBeNull()
    }
  })

  it('refuses a transform that declares nothing to apply', () => {
    // An empty map would render as "return the source unchanged", which is a
    // different transform from the one the plan named. Reconciliation would
    // then agree with a dual-write that copied values it was told to map.
    expect(transformProblem({ kind: 'value_map', map: {} })).toMatch(/no mappings/)
  })
})

describe('the two renderings agree', () => {
  it.each(TRANSFORM_KINDS)('renders %s with the same operator and argument order', kind => {
    const t = SAMPLES[kind]
    const params: unknown[] = []
    const parameterised = transformSql(t, '"email"', params)
    const literal = transformLiteralSql(t, '"email"')

    // Substituting each parameter back into the parameterised form must produce
    // the literal form exactly. That is the property: same shape, same order,
    // only the binding differs.
    const substituted = parameterised.replace(/\$(\d+)/g, (_m, n) => sqlLiteral(String(params[Number(n) - 1])))
    expect(substituted).toBe(literal)
  })

  it('takes an expression, not a bare column, on both sides', () => {
    // The backfill aliases its table, so it renders `t."email"`. Both renderers
    // must accept that unchanged: the alternative was rewriting one renderer's
    // output with a regex, which is string surgery over generated SQL.
    const t = SAMPLES.lower
    expect(transformSql(t, 't."email"', [])).toBe('lower(t."email")')
    expect(transformLiteralSql(t, 't."email"')).toBe('lower(t."email")')
  })

  it('maps an unlisted value to NULL in both forms, never passing it through', () => {
    // Passing an unmapped value through would hide exactly the divergence the
    // reconciliation exists to find, on both sides at once.
    const t = SAMPLES.value_map
    expect(transformSql(t, '"status"', [])).toMatch(/ELSE NULL END$/)
    expect(transformLiteralSql(t, '"status"')).toMatch(/ELSE NULL END$/)
  })
})

describe('literal rendering escapes', () => {
  it('doubles a quote rather than ending the string', () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'")
    const t: Transform = { kind: 'null_to', value: "'; DROP TABLE users; --" }
    const rendered = transformLiteralSql(t, '"name"')
    // The payload survives as data inside one literal: no unescaped quote ends
    // it, so nothing after it is ever parsed as SQL.
    expect(rendered).toBe(`coalesce("name", '''; DROP TABLE users; --')`)
    expect(rendered.match(/'/g)!.length % 2).toBe(0)
  })

  it('escapes both halves of a value_map pair', () => {
    const t: Transform = { kind: 'value_map', map: { "a'b": "c'd" } }
    expect(transformLiteralSql(t, '"x"')).toBe(`CASE WHEN "x" = 'a''b' THEN 'c''d' ELSE NULL END`)
  })
})
