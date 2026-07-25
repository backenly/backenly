/**
 * The closed grammar for expressions that reach raw DDL.
 *
 * ── Why this boundary cannot be an escape ────────────────────────────────────
 *
 * A CHECK constraint, a partial index's WHERE clause and an RLS predicate are all
 * DDL, so they cannot be parameterised — `ADD CONSTRAINT x CHECK ($1)` is not
 * valid SQL. The expression has to land in the statement text, and quoting it as a
 * literal would destroy the only thing that makes it useful.
 *
 * So the boundary is a validator, and it must be CLOSED: anything not recognised
 * is refused. That direction is not negotiable. A refusal costs an agent one call
 * and names the alternative; a false accept is arbitrary SQL execution wearing a
 * constraint definition.
 *
 * This became load-bearing when multi-column CHECKs and custom RLS predicates
 * were opened up (defects #3 and #11) — before that, no caller-supplied
 * expression reached DDL at all, because CHECK bodies were being silently thrown
 * away. Widening the surface and widening the guarantee are the same change.
 *
 * Both halves are tested, and the second matters as much as the first: a
 * validator that refuses `status IN ('a','b')` is not secure, it is broken, and it
 * would push authors straight back to the workarounds this replaced.
 */

import { validateBooleanExpression, referencedColumns, SAFE_IDENT } from '@/lib/db/sql-expression'

function reject(expr: string) {
  const r = validateBooleanExpression(expr)
  if (r.kind === 'ok') throw new Error(`Expected a rejection for: ${expr}`)
  return r
}

function accept(expr: string) {
  const r = validateBooleanExpression(expr)
  if (r.kind !== 'ok') throw new Error(`Expected acceptance for: ${expr} — got: ${r.reason}`)
  return r
}

describe('refuses anything that could smuggle SQL into DDL', () => {
  const attacks: Array<[string, string]> = [
    ['statement chaining', `1=1); DROP TABLE users; --`],
    ['a trailing comment', `price > 0 -- and anything`],
    ['a block comment', `price /* nope */ > 0`],
    ['a subquery', `id IN (SELECT id FROM users)`],
    ['an EXISTS subquery', `EXISTS (SELECT 1 FROM users WHERE id = user_id)`],
    ['a function that reads the filesystem', `x = pg_read_file('/etc/passwd')`],
    ['a function that blocks', `pg_sleep(10) IS NULL`],
    ['a catalog function', `x = current_setting('is_superuser')`],
    ['dollar-quoting', `$$x$$ = a`],
    ['a DDL keyword', `price > 0 AND (ALTER TABLE t)`],
    ['a GRANT', `price > 0 OR GRANT ALL`],
    ['unbalanced parens', `(price > 0`],
    ['an unterminated literal', `status = 'open`],
    ['a quoted function call', `"evil"(x) > 0`],
  ]

  for (const [label, expr] of attacks) {
    it(`refuses ${label}`, () => {
      const r = reject(expr)
      expect(r.reason.length).toBeGreaterThan(5)
      // A refusal without a way forward costs a whole turn of blind retrying.
      expect(r.hint.length).toBeGreaterThan(10)
    })
  }

  it('refuses an expression that constrains nothing', () => {
    expect(reject('1 = 1').reason).toMatch(/column/i)
  })

  it('refuses an empty or non-string expression', () => {
    expect(reject('').reason).toMatch(/empty/)
    expect(validateBooleanExpression(undefined).kind).toBe('rejected')
    expect(validateBooleanExpression(42 as any).kind).toBe('rejected')
  })

  it('refuses an expression long enough to be a payload', () => {
    expect(reject(`a > 0 AND ${'b > 0 AND '.repeat(300)}c > 0`).reason).toMatch(/characters/)
  })
})

describe('accepts the predicates real schemas need', () => {
  const valid = [
    'price > 0',
    'price >= 0 AND price <= 1000000',
    "status IN ('pending','accepted','declined')",
    "status NOT IN ('deleted')",
    'length(title) BETWEEN 1 AND 200',
    'char_length(bio) <= 500',
    'lower(email) = email',
    'starts_at < ends_at',
    'requester_id <> addressee_id',
    'user_a < user_b',
    'rating >= 1 AND rating <= 5',
    'cardinality(tags) <= 10',
    'array_length(tags, 1) <= 10',
    'discount IS NULL OR discount < total',
    'quantity * unit_price = line_total',
    'coalesce(nickname, name) IS NOT NULL',
    "kind = 'a' OR (kind = 'b' AND parent_id IS NOT NULL)",
    'deleted_at IS NULL',
    "email LIKE '%@%'",
    'total = round(subtotal + tax, 2)',
  ]

  for (const expr of valid) {
    it(`accepts: ${expr}`, () => {
      expect(accept(expr).expression).toBe(expr)
    })
  }

  it('tolerates a trailing semicolon rather than treating it as an attack', () => {
    // A habit, not an injection. Stripping one and evaluating the rest is the
    // difference between a usable tool and one that refuses on a typo.
    expect(accept('price > 0;').expression).toBe('price > 0')
  })

  it('allows a bare predicate with no column when the caller permits it', () => {
    // An RLS policy may legitimately be `true` — a CHECK may not.
    expect(validateBooleanExpression('true', { requireColumn: false }).kind).toBe('ok')
    expect(validateBooleanExpression('true', { requireColumn: true }).kind).toBe('rejected')
  })

  it('accepts an RLS predicate against the claim helper', () => {
    const r = validateBooleanExpression(
      "owner_id::text = backenly_jwt_claim('sub') OR is_public",
      { requireColumn: false },
    )
    // backenly_jwt_claim is Backenly's own SECURITY-DEFINER-free reader and must
    // be callable, or `custom` RLS cannot reference the calling user at all.
    if (r.kind !== 'ok') {
      expect(`rejected: ${r.reason}`).toBe('accepted')
    }
  })
})

describe('column extraction', () => {
  it('does not count string literals as columns', () => {
    expect(referencedColumns("status IN ('draft','live')")).toEqual(['status'])
  })

  it('does not count function names as columns', () => {
    expect(referencedColumns('length(title) > 0')).toEqual(['title'])
  })

  it('does not count casts as columns', () => {
    expect(referencedColumns("owner_id::text = 'x'")).toEqual(['owner_id'])
  })

  it('returns every column of a multi-column predicate, in order', () => {
    expect(referencedColumns('starts_at < ends_at')).toEqual(['starts_at', 'ends_at'])
    expect(referencedColumns('requester_id <> addressee_id')).toEqual(['requester_id', 'addressee_id'])
  })

  it('de-duplicates a column named twice', () => {
    expect(referencedColumns('price > 0 AND price < 100')).toEqual(['price'])
  })

  it('preserves the case of a quoted identifier', () => {
    expect(referencedColumns('"createdAt" IS NOT NULL')).toEqual(['createdAt'])
  })

  it('does not treat numbers as columns', () => {
    expect(referencedColumns('rating >= 1 AND rating <= 5')).toEqual(['rating'])
  })
})

describe('SAFE_IDENT', () => {
  it('accepts ordinary identifiers', () => {
    for (const id of ['users', 'user_id', 'createdAt', '_internal', 'a1']) {
      expect(SAFE_IDENT.test(id)).toBe(true)
    }
  })

  it('rejects anything that could break out of an identifier position', () => {
    for (const id of ['user id', 'user"id', 'user;drop', 'user-id', '1users', '', 'a'.repeat(64), 'sch.table']) {
      expect(SAFE_IDENT.test(id)).toBe(false)
    }
  })
})
