/**
 * Closes the one coverage gap the MCP harness cannot reach.
 *
 * `isPaymentTable` keys off an EXACT table name, so the integration harness
 * would have to create a table literally called `transactions` in a live
 * project to exercise it — colliding with real user tables. It is a pure
 * function, so it is tested directly here instead of being silently skipped.
 *
 * The defect being guarded: naming a table `transactions` produced
 * "⚠️ Payment integration required — paste your Stripe secret key" on an
 * expense tracker that will never take a payment.
 */

import { isPaymentTable } from '@/lib/ai/minimal-executor'

describe('isPaymentTable', () => {
  describe('unambiguous payment tables — name alone is enough', () => {
    for (const name of ['payments', 'payment', 'payment_methods', 'payment_events', 'checkouts']) {
      it(`prompts for "${name}" with no payment columns`, () => {
        expect(isPaymentTable(name, [{ name: 'user_id' }, { name: 'amount' }])).toBe(true)
      })
    }
  })

  describe('ambiguous names — require column evidence', () => {
    const ledgerColumns = [
      { name: 'user_id' }, { name: 'amount' }, { name: 'category_id' },
      { name: 'note' }, { name: 'occurred_at' },
    ]

    for (const name of ['transactions', 'transaction', 'orders', 'order', 'invoices', 'invoice']) {
      it(`does NOT prompt for "${name}" when it is plainly a ledger`, () => {
        expect(isPaymentTable(name, ledgerColumns)).toBe(false)
      })
    }

    it('DOES prompt for "transactions" once a Stripe column appears', () => {
      expect(isPaymentTable('transactions', [
        ...ledgerColumns, { name: 'stripe_charge_id' },
      ])).toBe(true)
    })

    it('recognises other processors, not just Stripe', () => {
      for (const col of ['paddle_txn_id', 'paypal_order_id', 'square_payment_id', 'adyen_psp_ref', 'braintree_id']) {
        expect(isPaymentTable('orders', [{ name: col }])).toBe(true)
      }
    })

    it('recognises processor-neutral evidence', () => {
      for (const col of ['payment_intent_id', 'checkout_session_id', 'charge_id', 'gateway', 'provider_id']) {
        expect(isPaymentTable('invoices', [{ name: col }])).toBe(true)
      }
    })
  })

  describe('unrelated tables are never payment tables', () => {
    for (const name of ['users', 'posts', 'categories', 'budgets', 'accounts', 'expenses']) {
      it(`ignores "${name}" even with a stripe_ column`, () => {
        expect(isPaymentTable(name, [{ name: 'stripe_customer_id' }])).toBe(false)
      })
    }
  })

  describe('robustness', () => {
    it('is case- and whitespace-insensitive on the table name', () => {
      expect(isPaymentTable('  Transactions  ', [{ name: 'stripe_charge_id' }])).toBe(true)
      expect(isPaymentTable('PAYMENTS')).toBe(true)
    })

    it('does not match a payment word merely contained in a longer column name', () => {
      // Guards the substring-collision family that produced 'star' -> INTEGER
      // and /account/ matching "g_accounts": evidence is anchored to the start.
      expect(isPaymentTable('orders', [{ name: 'internal_provider_notes' }])).toBe(false)
      expect(isPaymentTable('orders', [{ name: 'no_stripe_here' }])).toBe(false)
    })

    it('tolerates missing or malformed column lists', () => {
      expect(isPaymentTable('transactions')).toBe(false)
      expect(isPaymentTable('transactions', [])).toBe(false)
      expect(isPaymentTable('transactions', [{} as any, { name: undefined as any }])).toBe(false)
      expect(isPaymentTable('')).toBe(false)
    })
  })
})
