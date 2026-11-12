/**
 * STRIPE'S SYNC READS WHAT STRIPE SENDS AND WRITES WHAT A COLUMN TAKES (#610)
 * ==========================================================================
 * The pure parts of lib/integrations/stripe-sync.ts:
 *
 *   - Stripe API 2025-03-31.basil moved a subscription's current period onto
 *     its items and an invoice's subscription under parent.subscription_details.
 *     The sync read the old top-level fields only, so it wrote NULL periods and
 *     never found an invoice's subscription on current versions.
 *   - Stripe spells a cancelled subscription `canceled`; create_table's CHECK
 *     on subscriptions.status spells it `cancelled`. A status is written in the
 *     spelling the column's CHECK lists, read from PostgreSQL's own rendering.
 *   - What is not applied goes to the project's logs, which are kept at home
 *     whatever the project's region, so that line carries names, ids and
 *     SQLSTATE codes, never a CHECK's values or the database's words.
 */
import {
  checkListValues,
  chooseValue,
  databaseError,
  invoiceSubscriptionId,
  logMessage,
  problemText,
  statusCandidates,
  subscriptionPeriod,
  syncReply,
  type SyncOutcome,
} from '@/lib/integrations/stripe-sync'

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000)

describe("a subscription's current period", () => {
  it('is read from its items, where Stripe puts it from 2025-03-31.basil', () => {
    const sub = {
      id: 'sub_1',
      items: { data: [{ current_period_start: at('2026-11-01T00:00:00Z'), current_period_end: at('2026-12-01T00:00:00Z') }] },
    }
    expect(subscriptionPeriod(sub)).toEqual({ start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' })
  })

  it('covers every item when items differ: the earliest start and the latest end', () => {
    const sub = {
      items: {
        data: [
          { current_period_start: at('2026-11-01T00:00:00Z'), current_period_end: at('2026-12-01T00:00:00Z') },
          { current_period_start: at('2026-10-15T00:00:00Z'), current_period_end: at('2027-10-15T00:00:00Z') },
        ],
      },
    }
    expect(subscriptionPeriod(sub)).toEqual({ start: '2026-10-15T00:00:00.000Z', end: '2027-10-15T00:00:00.000Z' })
  })

  it('is read from the subscription itself on API versions before basil', () => {
    const sub = { current_period_start: at('2026-01-01T00:00:00Z'), current_period_end: at('2026-02-01T00:00:00Z'), items: { data: [{}] } }
    expect(subscriptionPeriod(sub)).toEqual({ start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' })
  })

  it('is null when neither shape carries it, so nothing is written over the stored one', () => {
    expect(subscriptionPeriod({ id: 'sub_1', items: { data: [] } })).toEqual({ start: null, end: null })
    expect(subscriptionPeriod({})).toEqual({ start: null, end: null })
  })
})

describe("an invoice's subscription", () => {
  it('is read from parent.subscription_details, where Stripe puts it from 2025-03-31.basil', () => {
    const invoice = { parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_new' } } }
    expect(invoiceSubscriptionId(invoice)).toBe('sub_new')
  })

  it('is read when that subscription is expanded into an object', () => {
    const invoice = { parent: { type: 'subscription_details', subscription_details: { subscription: { id: 'sub_expanded' } } } }
    expect(invoiceSubscriptionId(invoice)).toBe('sub_expanded')
  })

  it('is read from the top-level field on API versions before basil', () => {
    expect(invoiceSubscriptionId({ subscription: 'sub_old' })).toBe('sub_old')
  })

  it('is null for an invoice that is not for a subscription', () => {
    expect(invoiceSubscriptionId({ parent: null })).toBeNull()
    expect(invoiceSubscriptionId({ parent: { type: 'quote_details', quote_details: { quote: 'qt_1' } } })).toBeNull()
  })
})

describe('the status written is one the column takes', () => {
  // As PostgreSQL renders the CHECK create_table puts on subscriptions.status.
  const CREATE_TABLE_CHECK =
    "CHECK ((status = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text, 'cancelled'::text, 'unpaid'::text, 'paused'::text])))"

  it("reads the values of create_table's CHECK", () => {
    expect(checkListValues(CREATE_TABLE_CHECK, 'status')).toEqual(['active', 'trialing', 'past_due', 'cancelled', 'unpaid', 'paused'])
  })

  // The rest as PostgreSQL 14 renders them (pg_get_constraintdef).
  it('reads a list that also allows NULL, a quoted column name with a quote in a value, and a varchar column', () => {
    expect(checkListValues("CHECK (((status = ANY (ARRAY['a'::text, 'b'::text])) OR (status IS NULL)))", 'status')).toEqual(['a', 'b'])
    expect(checkListValues(`CHECK (("payState" = ANY (ARRAY['paid'::text, 'it''s'::text])))`, 'payState')).toEqual(['paid', "it's"])
    expect(
      checkListValues("CHECK (((vc)::text = ANY ((ARRAY['x'::character varying, 'y'::character varying])::text[])))", 'vc'),
    ).toEqual(['x', 'y'])
  })

  it('reads nothing from a CHECK that is not a list of what is allowed', () => {
    expect(checkListValues("CHECK ((status <> 'deleted'::text))", 'status')).toBeNull()
    expect(checkListValues("CHECK ((length(status) > 0))", 'status')).toBeNull()
    expect(checkListValues(CREATE_TABLE_CHECK, 'plan')).toBeNull()
  })

  it("writes Stripe's canceled as cancelled where the column spells it so, and as Stripe does where nothing constrains it", () => {
    const candidates = statusCandidates('canceled')
    expect(candidates).toEqual(['canceled', 'cancelled'])
    expect(chooseValue({ allowed: checkListValues(CREATE_TABLE_CHECK, 'status') }, candidates)).toBe('cancelled')
    expect(chooseValue({ allowed: null }, candidates)).toBe('canceled')
  })

  it('finds no value when the column lists none of them', () => {
    expect(chooseValue({ allowed: ['active', 'cancelled'] }, statusCandidates('incomplete_expired'))).toBeNull()
    expect(chooseValue({ allowed: null }, [])).toBeNull()
  })
})

describe('what is not applied is said, and where', () => {
  const outcome = (over: Partial<SyncOutcome> = {}): SyncOutcome => ({
    eventId: 'evt_610',
    eventType: 'customer.subscription.updated',
    duplicate: false,
    recorded: true,
    applied: ['`subscriptions`: 1 row updated (current_period_end, updatedAt)'],
    notes: [],
    problems: [
      {
        table: 'subscriptions',
        why: "no column of `subscriptions` takes Stripe's status incomplete_expired",
        detail: 'status allows active, trialing, past_due, cancelled, unpaid, paused',
      },
      {
        table: 'notifications',
        why: 'adding a row to `notifications` failed (SQLSTATE 22P02)',
        detail: 'invalid input syntax for type uuid: "someone@example.com"',
      },
    ],
    ...over,
  })

  it("the project's logs get names, ids and codes, and never a column's values or the database's words", () => {
    const line = logMessage(outcome())
    expect(line).toContain('customer.subscription.updated evt_610 was not fully applied')
    expect(line).toContain("no column of `subscriptions` takes Stripe's status incomplete_expired")
    expect(line).toContain('SQLSTATE 22P02')
    expect(line).toContain('payment_events')
    expect(line).not.toContain('trialing')
    expect(line).not.toContain('someone@example.com')
    expect(line).not.toContain('invalid input syntax')
  })

  it('payment_events and the reply to Stripe get the details too', () => {
    expect(problemText(outcome().problems[0])).toBe(
      "no column of `subscriptions` takes Stripe's status incomplete_expired: status allows active, trialing, past_due, cancelled, unpaid, paused",
    )
    expect(syncReply(outcome())).toEqual({
      result: 'partly applied',
      changes: ['`subscriptions`: 1 row updated (current_period_end, updatedAt)'],
      notApplied: [
        "no column of `subscriptions` takes Stripe's status incomplete_expired: status allows active, trialing, past_due, cancelled, unpaid, paused",
        'adding a row to `notifications` failed (SQLSTATE 22P02): invalid input syntax for type uuid: "someone@example.com"',
      ],
      notes: [],
    })
  })

  it('the reply says plainly when it was applied, not applied, or already recorded', () => {
    expect(syncReply(outcome({ problems: [] })).result).toBe('applied')
    expect(syncReply(outcome({ applied: [] })).result).toBe('not applied')
    expect(syncReply(outcome({ duplicate: true, applied: [], problems: [] })).result).toBe(
      'already recorded in payment_events, so not applied again',
    )
    expect(syncReply(outcome({ eventType: 'customer.created', applied: [], problems: [] })).result).toBe(
      'recorded only: the sync does not apply this event type',
    )
  })

  it("reads a Prisma raw-query error's SQLSTATE and the database's words", () => {
    const prismaError = Object.assign(new Error('Invalid `prisma.$queryRawUnsafe()` invocation: Raw query failed.'), {
      code: 'P2010',
      meta: { code: '23514', message: 'new row for relation "subscriptions" violates check constraint "chk_subscriptions_status"' },
    })
    expect(databaseError(prismaError)).toEqual({
      code: '23514',
      message: 'new row for relation "subscriptions" violates check constraint "chk_subscriptions_status"',
    })
    expect(databaseError(new Error('Raw query failed. Code: `42703`. Message: `column "updated_at" does not exist`'))).toEqual({
      code: '42703',
      message: 'column "updated_at" does not exist',
    })
    // Prisma's own code looks like a SQLSTATE and is not one; PL/pgSQL's P0001 is.
    expect(databaseError(Object.assign(new Error('Raw query failed.'), { code: 'P2010' })).code).toBeNull()
    expect(databaseError(Object.assign(new Error('raised by a trigger'), { code: 'P0001' })).code).toBe('P0001')
  })
})
