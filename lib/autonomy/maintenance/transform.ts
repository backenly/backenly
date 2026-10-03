/**
 * THE TRANSFORM VOCABULARY — one definition, two renderings
 * =========================================================
 *
 * A transform is rendered twice on the expand/contract ladder:
 *
 *   parameterised   reconciliation, comparing source against target
 *   literal         the dual-write trigger body, which cannot take parameters
 *
 * Both live here, because the property that makes reconciliation meaningful is
 * that it recomputes the value INDEPENDENTLY of the thing that wrote it while
 * agreeing with it exactly. Two implementations of `lower()` would satisfy the
 * first half and quietly lose the second: the day they disagree, the checker
 * reports a mismatch that is its own, or — far worse — agrees because both made
 * the same mistake.
 *
 * So the vocabulary is closed, typed, and defined once, and
 * `tests/unit/maintenance-transform.spec.ts` asserts the two renderings produce
 * the same SQL semantics for every kind. Adding a transform means adding a
 * branch to both and the test fails until you do.
 *
 * No raw SQL and no JavaScript, for the reason reconcile.ts states: a trigger
 * that could apply an arbitrary expression would force the independent check to
 * trust the expression it is supposed to be checking.
 */

/**
 * Every transform the ladder can apply and independently recompute.
 *
 * Re-exported by reconcile.ts, which owned it first.
 */
export type Transform =
  | { kind: 'identity' }
  | { kind: 'lower' }
  | { kind: 'upper' }
  | { kind: 'trim' }
  /** Explicit value mapping. Unlisted values are a mismatch, never passed through. */
  | { kind: 'value_map'; map: Record<string, string> }
  /** Replace NULL with a constant; non-null values pass through unchanged. */
  | { kind: 'null_to'; value: string }

export const TRANSFORM_KINDS = ['identity', 'lower', 'upper', 'trim', 'value_map', 'null_to'] as const

/**
 * Why this transform cannot be rendered, or null when it can.
 *
 * Checked by both callers before rendering, so neither renderer throws and
 * "could not compare" stays a decision the caller makes rather than an
 * exception crossing a module boundary.
 */
export function transformProblem(t: Transform): string | null {
  switch (t.kind) {
    case 'identity':
    case 'lower':
    case 'upper':
    case 'trim':
      return null
    case 'null_to':
      return typeof t.value === 'string' ? null : 'null_to transform declares no replacement value'
    case 'value_map': {
      const pairs = Object.entries(t.map ?? {})
      if (pairs.length === 0) return 'value_map transform declares no mappings'
      if (pairs.some(([from, to]) => typeof from !== 'string' || typeof to !== 'string')) {
        return 'value_map transform contains a non-string mapping'
      }
      return null
    }
  }
}

/**
 * The transform as SQL over `expr`, with values bound as parameters.
 *
 * `expr` is a whole expression — `"email"` when the query has one table in
 * scope, `t."email"` when it does not — matching `transformLiteralSql`. Both
 * renderers take an expression so that neither caller has to rewrite the other's
 * output to alias it, which is string surgery over generated SQL and fails
 * quietly when a transform grows a second identifier.
 *
 * `params` is appended to; the caller passes the same array to the query. Call
 * `transformProblem` first — an unrenderable transform returns `expr` unchanged
 * rather than throwing, and that is not a safe default to rely on.
 */
export function transformSql(t: Transform, expr: string, params: unknown[]): string {
  const src = expr
  switch (t.kind) {
    case 'identity':
      return src
    case 'lower':
      return `lower(${src})`
    case 'upper':
      return `upper(${src})`
    case 'trim':
      return `btrim(${src})`
    case 'null_to': {
      params.push(t.value)
      return `coalesce(${src}, $${params.length})`
    }
    case 'value_map': {
      // A CASE over the declared pairs. An unlisted value yields NULL, which
      // will not match a populated target — deliberately: silently passing an
      // unmapped value through would hide exactly the divergence this exists
      // to find.
      const whens: string[] = []
      for (const [from, to] of Object.entries(t.map)) {
        params.push(from)
        const p1 = `$${params.length}`
        params.push(to)
        const p2 = `$${params.length}`
        whens.push(`WHEN ${src} = ${p1} THEN ${p2}`)
      }
      if (whens.length === 0) return src
      return `CASE ${whens.join(' ')} ELSE NULL END`
    }
  }
}

/**
 * The transform applied to ONE value, in TypeScript.
 *
 * The third rendering of the same definition. `carry_constraints` needs the
 * target column's domain, which is the source column's declared domain with the
 * transform applied to each member — computed here rather than by asking the
 * database, so the answer can be compared against what the operator declared
 * BEFORE any constraint is written.
 *
 * ── Where this agrees with SQL, and where it must not be trusted ────────────
 *
 * `lower` and `upper` are locale- and collation-dependent in PostgreSQL and
 * Unicode-defined in JavaScript. They agree on ASCII and may not agree outside
 * it — Turkish dotless i is the standard counterexample. `asciiOnly` below is
 * how callers that depend on the agreement enforce their side of it, rather
 * than assuming a correspondence that holds for most inputs.
 *
 * `trim` removes spaces only, matching `btrim`'s default, NOT JavaScript's
 * `String.prototype.trim`, which also removes tabs and newlines.
 */
export function transformValue(t: Transform, value: string | null): string | null {
  switch (t.kind) {
    case 'identity':
      return value
    case 'lower':
      return value === null ? null : value.toLowerCase()
    case 'upper':
      return value === null ? null : value.toUpperCase()
    case 'trim':
      // Spaces only. btrim's default is ' ', not "whitespace".
      return value === null ? null : value.replace(/^ +| +$/g, '')
    case 'null_to':
      return value === null ? t.value : value
    case 'value_map':
      // An unlisted value yields NULL, exactly as the CASE does.
      return value === null ? null : (t.map[value] ?? null)
  }
}

/** True when every character is ASCII, so SQL and JS case folding agree. */
export function asciiOnly(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7F]*$/.test(value)
}

/**
 * A single-quoted SQL literal.
 *
 * Only ever applied to strings from a typed `Transform`, never to user input
 * reaching this module directly — but escaped anyway, because "the caller
 * validated it" is the assumption every injection post-mortem starts with.
 */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * The transform as SQL over `expr`, with values inlined.
 *
 * For PL/pgSQL trigger bodies, which are compiled text and cannot carry bind
 * parameters. `expr` is a whole expression (`NEW."email"`), not a bare column
 * name, which is the only difference in shape from the parameterised form.
 */
export function transformLiteralSql(t: Transform, expr: string): string {
  switch (t.kind) {
    case 'identity':
      return expr
    case 'lower':
      return `lower(${expr})`
    case 'upper':
      return `upper(${expr})`
    case 'trim':
      return `btrim(${expr})`
    case 'null_to':
      return `coalesce(${expr}, ${sqlLiteral(t.value)})`
    case 'value_map': {
      const whens = Object.entries(t.map).map(
        ([from, to]) => `WHEN ${expr} = ${sqlLiteral(from)} THEN ${sqlLiteral(to)}`,
      )
      if (whens.length === 0) return expr
      return `CASE ${whens.join(' ')} ELSE NULL END`
    }
  }
}
