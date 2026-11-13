/**
 * THE NAME RULES HOLD WHAT BACKENLY WRITES
 * ========================================
 *
 * Production QA (2026-11-09), report 7, inside Backenly's own designs. A table
 * Backenly designs gets a CHECK value list from its name (lib/db/name-rules.ts),
 * and Backenly's own code wrote values that list refused: "paid" and
 * "awaiting_payment" into orders.status (the Stripe wiring, POST
 * /stripe/session), "pending" into a job table's or a tasks table's status (the
 * job endpoints the build generates), and Stripe's own subscription statuses
 * into subscriptions.status. Each refusal is a write of Backenly's own that
 * fails.
 *
 * Pure: the rules as data. The tables themselves, made through Backenly's typed
 * doors and written to, are tests/integration/designed-tables-hold-their-values.spec.ts.
 */

import { STATUS_DOMAIN_MAP, ruleChecksFor, statusValuesFor } from '@/lib/db/name-rules'
import { initialStateFor } from '@/lib/ai/minimal-executor'

/** What Backenly itself writes into a column a rule constrains, and who writes it. */
const WRITTEN: Array<{ table: string; column: string; values: string[]; by: string }> = [
  { table: 'orders', column: 'status', values: ['pending'], by: 'POST /checkout' },
  { table: 'orders', column: 'status', values: ['awaiting_payment'], by: 'POST /stripe/session' },
  { table: 'orders', column: 'status', values: ['paid', 'refunded'], by: 'the Stripe wiring' },
  { table: 'orders', column: 'status', values: ['paid', 'failed', 'refunded'], by: "the build's Stripe handler" },
  { table: 'orders', column: 'payment_status', values: ['paid', 'failed'], by: 'the checkout flow' },
  { table: 'generation_jobs', column: 'status', values: ['pending', 'cancelled'], by: 'the job endpoints' },
  { table: 'render_jobs', column: 'status', values: ['pending', 'cancelled'], by: 'the job endpoints' },
  { table: 'tasks', column: 'status', values: ['pending', 'cancelled'], by: 'the job endpoints' },
  { table: 'subscriptions', column: 'status', values: ['active', 'cancelled'], by: 'the subscription endpoints' },
  // Stripe's subscription statuses (API reference, Subscription object), with
  // its `canceled` as this list spells it.
  {
    table: 'subscriptions',
    column: 'status',
    values: ['incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'cancelled', 'unpaid', 'paused'],
    by: 'Stripe',
  },
]

describe('a table Backenly designs holds what Backenly writes into it', () => {
  it.each(WRITTEN)('$column of $table holds what $by writes', ({ table, column, values }) => {
    const allowed = statusValuesFor(table, column)
    expect(allowed).not.toBeNull()
    expect(values.filter((v) => !allowed!.includes(v))).toEqual([])
  })

  it('starts a row where it started before the lists grew', () => {
    expect(STATUS_DOMAIN_MAP.map((r) => r.initial)).toEqual(['queued', 'pending', 'pending', 'active', 'active', 'draft', 'open', 'todo'])
    for (const rule of STATUS_DOMAIN_MAP) {
      expect(rule.values).toContain(rule.initial)
      // The state the list as it was gave a row, so a value added to a list
      // never moves the default of the tables made after it.
      expect(initialStateFor([...(rule.before?.[0] ?? rule.values)])).toBe(rule.initial)
      // An older list is never the current one.
      for (const old of rule.before ?? []) expect(old).not.toEqual(rule.values)
    }
  })
})

describe('the CHECKs the rules give a designed table', () => {
  it('one per rule for a column the design has, the first rule per column', () => {
    expect(ruleChecksFor('orders', [{ name: 'status' }, { name: 'payment_status' }, { name: 'total' }])).toEqual([
      { columnName: 'status', values: [...statusValuesFor('orders', 'status')!], initial: 'pending' },
      { columnName: 'payment_status', values: [...statusValuesFor('orders', 'payment_status')!], initial: 'pending' },
    ])
    // By name, in any case, as the executor matched it.
    expect(ruleChecksFor('render_jobs', [{ name: 'Status' }]).map((c) => c.initial)).toEqual(['queued'])
    expect(ruleChecksFor('shop_orders', [{ name: 'status' }])).toEqual([])
  })

  it('none for a column the design marks check: false, or whose CHECK it states', () => {
    // Stripe's subscription statuses are Stripe's to add to.
    expect(ruleChecksFor('subscriptions', [{ name: 'status', check: false }])).toEqual([])
    expect(ruleChecksFor('orders', [{ name: 'status', check: false }, { name: 'payment_status' }]).map((c) => c.columnName))
      .toEqual(['payment_status'])
    expect(ruleChecksFor('orders', [{ name: 'status' }, { name: 'payment_status' }], new Set(['payment_status'])).map((c) => c.columnName))
      .toEqual(['status'])
    // Only `false` turns it off.
    expect(ruleChecksFor('tasks', [{ name: 'status', check: 'no' }])).toHaveLength(1)
  })
})
