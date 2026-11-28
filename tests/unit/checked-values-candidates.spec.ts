/**
 * THE VALUES A TEST ROW TRIES FOR A COLUMN
 * ========================================
 * Production QA, 2026-11-21, N1: Backenly's own test row put 0 into a rating
 * that must be 1 to 5, and the store could not be published. Values are no
 * longer guessed from what a rule seems to mean: candidates are listed
 * (lib/ai/checked-values.ts) and PostgreSQL says which of them the rule
 * accepts. This pins the list: what comes first, and that a rule's own numbers
 * and texts are in it. That PostgreSQL's answer is taken is pinned against a
 * real database in tests/integration/verifier-meets-check-rules.spec.ts.
 */

import { candidateValues, ownChecks, type CheckedColumn, type TableCheck } from '@/lib/ai/checked-values'

const column = (name: string, typname: string, category: string, extra: Partial<CheckedColumn> = {}): CheckedColumn => ({
  name,
  type: typname,
  typname,
  category,
  ...extra,
})
const check = (name: string, expression: string, ...columns: string[]): TableCheck => ({ name, expression, columns })

describe('a column under no rule of its own', () => {
  it('gets 1 for a number, never 0', () => {
    expect(candidateValues(column('quantity', 'int4', 'N'), [], 'ab12')[0]).toBe('1')
    expect(candidateValues(column('price', 'numeric', 'N'), [], 'ab12')[0]).toBe('1')
  })

  it('gets a text that names the test, and an address when it is an email', () => {
    expect(candidateValues(column('title', 'text', 'S'), [], 'ab12')[0]).toBe('__bv_probe_ab12')
    expect(candidateValues(column('customer_email', 'text', 'S'), [], 'ab12')[0]).toBe('bv-probe-ab12@example.com')
  })

  it("gets a value of its own type first, whatever a rule over several columns mentions", () => {
    const spanning = [check('window', "((ends_on > starts_on) OR (note = 'open-ended'::text))", 'ends_on', 'starts_on', 'note')]
    const first = candidateValues(column('ends_on', 'date', 'D'), spanning, 'ab12')[0]
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(candidateValues(column('ends_on', 'date', 'D'), spanning, 'ab12')).not.toContain('open-ended')
  })
})

describe("a column under a rule of its own", () => {
  it("tries the rule's bounds and the numbers beside them", () => {
    const rules = [check('reviews_rating_check', '((rating >= 1) AND (rating <= 5))', 'rating')]
    const tried = candidateValues(column('rating', 'int4', 'N'), rules, 'ab12')
    for (const value of ['1', '2', '4', '5', '6', '0']) expect(tried).toContain(value)
  })

  it('tries a bound far from the usual values', () => {
    const rules = [check('min_order', '(amount_cents >= 2500)', 'amount_cents')]
    const tried = candidateValues(column('amount_cents', 'int4', 'N'), rules, 'ab12')
    expect(tried).toContain('2500')
    expect(tried).toContain('2501')
  })

  it('tries no fraction for a whole number, and tries them for any other', () => {
    const rules = [check('ratio', '((share > 0.25) AND (share < 0.75))', 'share')]
    expect(candidateValues(column('share', 'int4', 'N'), rules, 'ab12').every((v) => /^-?\d+$/.test(v))).toBe(true)
    expect(candidateValues(column('share', 'numeric', 'N'), rules, 'ab12')).toContain('0.75')
    expect(candidateValues(column('share', 'numeric', 'N'), rules, 'ab12')).toContain('0.5')
  })

  it('tries each text the rule lists, in the order it lists them', () => {
    const rules = [check('orders_status_check', "(status = ANY (ARRAY['pending'::text, 'paid'::text, 'shipped'::text]))", 'status')]
    const tried = candidateValues(column('status', 'text', 'S'), rules, 'ab12')
    expect(tried.indexOf('pending')).toBeGreaterThan(-1)
    expect(tried.indexOf('pending')).toBeLessThan(tried.indexOf('paid'))
    expect(tried.indexOf('paid')).toBeLessThan(tried.indexOf('shipped'))
  })

  it('reads a quote inside a listed text, and takes no number from inside one', () => {
    const rules = [check('label', "(label = ANY (ARRAY['it''s 37 o''clock'::text, 'noon'::text]))", 'label')]
    expect(candidateValues(column('label', 'text', 'S'), rules, 'ab12')).toContain("it's 37 o'clock")
    expect(candidateValues(column('label', 'int4', 'N'), rules, 'ab12')).not.toContain('37')
  })

  it('tries texts of the shapes patterns ask for', () => {
    const rules = [check('slug_shape', "(slug ~ '^[a-z0-9-]+$'::text)", 'slug')]
    const tried = candidateValues(column('slug', 'text', 'S'), rules, 'ab12')
    // The pattern is a candidate too; the rule itself turns it down.
    expect(tried).toContain('^[a-z0-9-]+$')
    expect(tried.some((v) => /^[a-z0-9-]+$/.test(v))).toBe(true)
    expect(tried.some((v) => /^[A-Z]{3}$/.test(v))).toBe(true)
    expect(tried.some((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v))).toBe(true)
    expect(tried.some((v) => /^https?:\/\//.test(v))).toBe(true)
    expect(tried.some((v) => /^\+[1-9]\d{6,14}$/.test(v))).toBe(true)
  })

  it("tries only an enum's own labels", () => {
    const tried = candidateValues(column('tier', 'tier', 'E', { enumLabels: ['free', 'pro'] }), [check('c', "(tier <> 'free'::tier)", 'tier')], 'ab12')
    expect(tried).toEqual(['free', 'pro'])
  })

  it('never repeats a value', () => {
    const rules = [check('c', '((n >= 1) AND (n <= 2) AND (n <> 0))', 'n')]
    const tried = candidateValues(column('n', 'int4', 'N'), rules, 'ab12')
    expect(new Set(tried).size).toBe(tried.length)
  })
})

describe("a column's own rules", () => {
  it('are those that read it and no other column', () => {
    const rules = [
      check('one', '(rating >= 1)', 'rating'),
      check('two', '(ends_at > starts_at)', 'ends_at', 'starts_at'),
      check('three', '(char_length(body) >= 3)', 'body'),
    ]
    expect(ownChecks('rating', rules).map((c) => c.name)).toEqual(['one'])
    expect(ownChecks('ends_at', rules)).toEqual([])
  })
})
