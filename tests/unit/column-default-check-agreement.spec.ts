/**
 * A column's DEFAULT must satisfy its own CHECK constraint.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 *
 * Two code paths in lib/ai/minimal-executor.ts picked these independently:
 *
 *   applyConstraintsToColumn  — any column named `*status*` → DEFAULT 'active'
 *   STATUS_DOMAIN_MAP         — orders.payment_status → CHECK IN
 *                               ('pending','paid','failed','refunded','disputed')
 *
 * 'active' is not in that list, so every `orders` table Backenly generated was
 * un-insertable through its own default: omit payment_status and Postgres
 * rejects the row with SQLSTATE 23514. `orders.status` had the same defect
 * (DEFAULT 'active' against pending|processing|shipped|delivered|cancelled|
 * refunded) and only survived because callers tended to set status explicitly.
 *
 * Reported from a real e-commerce build on 2026-07-22. Not an edge case — it
 * broke every project that created an orders table, at the first INSERT.
 *
 * ── What is asserted ────────────────────────────────────────────────────────
 *
 * Not "the two lists agree" — two lists that must agree will disagree again.
 * The default is now DERIVED from the permitted values, so the property under
 * test is that the derivation can only ever produce a permitted value. The
 * exhaustive case below is the real guard: it holds for value sets that do not
 * exist yet.
 */

import { initialStateFor, normalizeDefaultExpression } from '@/lib/ai/minimal-executor'

/** Every state set the executor's STATUS_DOMAIN_MAP can attach to a column. */
const DOMAIN_VALUE_SETS: Array<{ where: string; values: string[] }> = [
  { where: '*_jobs.status', values: ['queued', 'processing', 'completed', 'failed', 'cancelled'] },
  { where: 'orders.status', values: ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'] },
  { where: 'orders.payment_status', values: ['pending', 'paid', 'failed', 'refunded', 'disputed'] },
  { where: 'subscriptions.status', values: ['active', 'trialing', 'past_due', 'cancelled', 'unpaid', 'paused'] },
  { where: 'users.status', values: ['active', 'suspended', 'deactivated', 'pending_verification'] },
  { where: 'posts.status', values: ['draft', 'published', 'archived', 'scheduled'] },
  { where: 'tickets.status', values: ['open', 'in_progress', 'resolved', 'closed', 'on_hold'] },
  { where: 'tasks.status', values: ['todo', 'in_progress', 'done', 'cancelled'] },
]

describe('a derived default always satisfies its CHECK', () => {
  it.each(DOMAIN_VALUE_SETS)('$where', ({ values }) => {
    const initial = initialStateFor(values)
    expect(initial).toBeDefined()
    expect(values).toContain(initial)
  })

  it('picks an initial state, not merely a permitted one', () => {
    // The specific regression: 'active' is a permitted value for subscriptions
    // and a nonsensical one for a fresh order.
    expect(initialStateFor(['pending', 'paid', 'failed', 'refunded', 'disputed'])).toBe('pending')
    expect(initialStateFor(['draft', 'published', 'archived'])).toBe('draft')
    expect(initialStateFor(['queued', 'processing', 'completed'])).toBe('queued')
    expect(initialStateFor(['todo', 'in_progress', 'done'])).toBe('todo')
  })

  it('falls back to the first value when no state reads as initial', () => {
    expect(initialStateFor(['active', 'trialing', 'past_due'])).toBe('active')
  })

  it('never returns a value outside the set, for ANY set', () => {
    // The property, not the cases. A value set added next year is covered.
    const sets = [
      ['a'], ['z', 'y', 'x'], ['open'], ['shipped', 'pending'],
      ['completed', 'queued'], ['archived', 'draft', 'live'],
      ...DOMAIN_VALUE_SETS.map(d => d.values),
    ]
    for (const values of sets) {
      expect(values).toContain(initialStateFor(values))
    }
  })

  it('returns nothing for an empty set rather than inventing a state', () => {
    expect(initialStateFor([])).toBeUndefined()
  })
})

/**
 * The declared-DEFAULT allowlist.
 *
 * This value is interpolated into a DEFAULT clause inside CREATE TABLE — it
 * cannot be parameterised, and quoting it as a literal would break
 * `DEFAULT NOW()`. So it is matched against a closed set and anything
 * unrecognised is DROPPED. A permissive fallback here would be arbitrary DDL
 * execution wearing a column definition.
 */
describe('normalizeDefaultExpression', () => {
  it('accepts the literal forms a default legitimately takes', () => {
    expect(normalizeDefaultExpression(true)).toBe('true')
    expect(normalizeDefaultExpression(false)).toBe('false')
    expect(normalizeDefaultExpression(0)).toBe('0')
    expect(normalizeDefaultExpression(42)).toBe('42')
    expect(normalizeDefaultExpression(-1.5)).toBe('-1.5')
    expect(normalizeDefaultExpression("'pending'")).toBe("'pending'")
    expect(normalizeDefaultExpression('pending')).toBe("'pending'")
    expect(normalizeDefaultExpression('true')).toBe('true')
    expect(normalizeDefaultExpression('null')).toBe('null')
  })

  it('accepts the zero-argument functions, normalised', () => {
    expect(normalizeDefaultExpression('now()')).toBe('NOW()')
    expect(normalizeDefaultExpression('NOW()')).toBe('NOW()')
    expect(normalizeDefaultExpression('CURRENT_TIMESTAMP')).toBe('CURRENT_TIMESTAMP')
    expect(normalizeDefaultExpression('gen_random_uuid()')).toBe('gen_random_uuid()')
    expect(normalizeDefaultExpression('uuid_generate_v4()')).toBe('gen_random_uuid()')
  })

  it('re-quotes a string literal from its inner text', () => {
    // A crafted value must not be able to terminate the literal early.
    expect(normalizeDefaultExpression("'it''s'")).toBe("'it''s'")
    expect(normalizeDefaultExpression("o'brien")).toBeUndefined() // not a bare word
  })

  it('DROPS anything it does not recognise rather than interpolating it', () => {
    const hostile = [
      "'x'); DROP TABLE users; --",
      'some_function(1)',
      '(SELECT max(id) FROM users)',
      'nextval(\'seq\')',
      '1; DELETE FROM orders',
      "''||(SELECT password FROM users LIMIT 1)||''",
      'CASE WHEN true THEN 1 ELSE 2 END',
    ]
    for (const v of hostile) {
      expect(normalizeDefaultExpression(v)).toBeUndefined()
    }
  })

  it('drops empties and non-strings', () => {
    expect(normalizeDefaultExpression('')).toBeUndefined()
    expect(normalizeDefaultExpression('   ')).toBeUndefined()
    expect(normalizeDefaultExpression(undefined)).toBeUndefined()
    expect(normalizeDefaultExpression(null)).toBeUndefined()
    expect(normalizeDefaultExpression({})).toBeUndefined()
    expect(normalizeDefaultExpression(NaN)).toBeUndefined()
  })
})
