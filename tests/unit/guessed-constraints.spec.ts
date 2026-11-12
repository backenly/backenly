/**
 * The name rules, and how a rule they made is told from one a request asked for.
 *
 * Pure: the catalog rows and History steps are given here as PostgreSQL and
 * the change ledger write them. The database-backed half, a real project with
 * tables made the old way, is tests/integration/guessed-constraints.spec.ts.
 */

import {
  STATUS_DOMAIN_MAP,
  checkNameFor,
  isPostgresConstraintName,
  postgresConstraintName,
  statusValuesFor,
  uniqueByName,
} from '@/lib/db/name-rules'
import { guessedCandidate, inListOf, recordedRequests, type CatalogConstraint } from '@/lib/autonomy/guessed-constraints'
import { classifyFix } from '@/lib/core/fix-classifier'
import { buildFixAction, getManualRemediationHint } from '@/lib/core/fix-actions'
import { decisionLabels, summariseFinding } from '@/lib/core/finding-summaries'

const ORDER_STATES = "CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'shipped'::text, 'delivered'::text, 'cancelled'::text, 'refunded'::text])))"

describe('the name rules, as they have stood since 2026-07-23', () => {
  it('gives UNIQUE to any column with email, username or slug in its name', () => {
    for (const c of ['email', 'customer_email', 'notifyEmail', 'username', 'slug', 'email_verified']) expect(uniqueByName(c)).toBe(true)
    for (const c of ['notify_to', 'contact', 'name', 'status']) expect(uniqueByName(c)).toBe(false)
  })

  it('gives a CHECK list by the table\'s name, the first rule that matches', () => {
    expect(statusValuesFor('orders', 'status')).toEqual(['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'])
    expect(statusValuesFor('orders', 'payment_status')).toEqual(['pending', 'paid', 'failed', 'refunded', 'disputed'])
    expect(statusValuesFor('render_jobs', 'status')).toEqual(['queued', 'processing', 'completed', 'failed', 'cancelled'])
    expect(statusValuesFor('posts', 'status')).toEqual(['draft', 'published', 'archived', 'scheduled'])
    expect(statusValuesFor('shop_orders', 'status')).toBeNull()
    expect(statusValuesFor('orders', 'state')).toBeNull()
    // Eight rules; a changed list changes what is recognised on old tables.
    expect(STATUS_DOMAIN_MAP).toHaveLength(8)
  })

  it('names a UNIQUE on a column as PostgreSQL does, shortening the longer name first', () => {
    expect(postgresConstraintName('orders', 'email', 'key')).toBe('orders_email_key')
    const long = postgresConstraintName('customer_contact_preferences_for_marketing_and_billing', 'secondary_contact_email_address', 'key')
    // What PostgreSQL 16 named it (tests/integration/guessed-constraints.spec.ts creates it).
    expect(long).toBe('customer_contact_preferences__secondary_contact_email_addre_key')
    expect(Buffer.byteLength(long)).toBe(63)
    expect(isPostgresConstraintName('orders_email_key1', 'orders', 'email', 'key')).toBe(true)
    expect(isPostgresConstraintName('orders_email_unique', 'orders', 'email', 'key')).toBe(false)
    expect(checkNameFor('orders', 'status')).toBe('chk_orders_status')
  })
})

describe('a rule the name rules made', () => {
  const rule = (c: Partial<CatalogConstraint>): CatalogConstraint => ({
    table: 'orders', name: 'orders_email_key', kind: 'u', columns: ['email'], definition: 'UNIQUE (email)', ...c,
  })

  it('is recognised by its exact name and definition', () => {
    expect(guessedCandidate(rule({}))).toMatchObject({ rule: 'unique_by_name', column: 'email', constraintName: 'orders_email_key' })
    expect(guessedCandidate(rule({ kind: 'c', name: 'chk_orders_status', columns: ['status'], definition: ORDER_STATES })))
      .toMatchObject({ rule: 'check_by_table_name', values: ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'] })
    // A varchar column renders the list with casts on both sides.
    const varchar =
      "CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'processing'::character varying, 'shipped'::character varying, " +
      "'delivered'::character varying, 'cancelled'::character varying, 'refunded'::character varying])::text[])))"
    expect(guessedCandidate(rule({ kind: 'c', name: 'chk_orders_status', columns: ['status'], definition: varchar }))).not.toBeNull()
  })

  it('is not anything else', () => {
    // Another name: one a person or the parser chose.
    expect(guessedCandidate(rule({ name: 'orders_email_unique' }))).toBeNull()
    // Not a name the rule reads.
    expect(guessedCandidate(rule({ name: 'orders_contact_key', columns: ['contact'], definition: 'UNIQUE (contact)' }))).toBeNull()
    // Two columns, or a different definition.
    expect(guessedCandidate(rule({ columns: ['email', 'total'], definition: 'UNIQUE (email, total)' }))).toBeNull()
    expect(guessedCandidate(rule({ definition: 'UNIQUE NULLS NOT DISTINCT (email)' }))).toBeNull()
    // The agent's own CHECK on status: another name, another list.
    const own = "CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text])))"
    expect(guessedCandidate(rule({ kind: 'c', name: 'chk_orders_status_1a2b3c4d', columns: ['status'], definition: own }))).toBeNull()
    expect(guessedCandidate(rule({ kind: 'c', name: 'chk_orders_status', columns: ['status'], definition: own }))).toBeNull()
    // The rule's list, reordered, is not the rule's.
    const reordered = ORDER_STATES.replace("'pending'::text, 'processing'::text", "'processing'::text, 'pending'::text")
    expect(guessedCandidate(rule({ kind: 'c', name: 'chk_orders_status', columns: ['status'], definition: reordered }))).toBeNull()
    // A CHECK that is not a plain list.
    expect(inListOf('CHECK ((total > 0))')).toBeNull()
    expect(inListOf("CHECK (((status = ANY (ARRAY['a'::text])) AND (total > 0)))")).toBeNull()
  })
})

describe('what History recorded about a request', () => {
  it('reads the SQL that made a table, the columns it added and the rules it declared', async () => {
    const recorded = await recordedRequests([
      { tool: 'create_table', ok: true, statement: "CREATE TABLE orders (email text, status text CHECK (status IN ('pending', 'paid')), total int)" },
      { tool: 'add_constraint', ok: true, statement: "CREATE TABLE orders (email text, status text CHECK (status IN ('pending', 'paid')), total int) → CHECK (status IN ('pending', 'paid'))" },
      { tool: 'add_column', ok: true, statement: 'ALTER TABLE orders ADD COLUMN coupon text UNIQUE' },
      { tool: 'add_column', ok: false, statement: 'ALTER TABLE orders ADD COLUMN ghost_email text UNIQUE' },
      { tool: 'CREATE_TABLE', ok: true, statement: 'CREATE_TABLE posts' },
    ])
    const orders = recorded.get('orders')!
    expect(orders.madeBy).toBe('sql')
    expect([...orders.sqlColumns].sort()).toEqual(['coupon', 'email', 'status', 'total'])
    expect([...orders.declaredUnique]).toEqual(['coupon'])
    expect(orders.declaredChecks.get('status')).toEqual([['pending', 'paid']])
    expect(recorded.get('posts')!.madeBy).toBe('typed')
  })

  it('starts over when the table is made again', async () => {
    const recorded = await recordedRequests([
      { tool: 'create_table', statement: 'CREATE TABLE orders (email text UNIQUE)' },
      { tool: 'CREATE_TABLE', statement: 'CREATE_TABLE orders' },
    ])
    expect(recorded.get('orders')).toMatchObject({ madeBy: 'typed' })
    expect(recorded.get('orders')!.declaredUnique.size).toBe(0)
  })
})

describe('the finding', () => {
  const details = {
    tableName: 'orders', columnName: 'status', constraintName: 'chk_orders_status', rule: 'check_by_table_name',
    evidence: 'unrecorded', allowedValues: ['draft', 'published'],
  }

  it('says what the rule does, plainly', () => {
    expect(summariseFinding('guessed_constraint', details)).toBe(
      "Backenly's name rules added a CHECK on orders.status that allows only draft and published, because the table is named orders. " +
        'Nothing recorded shows the request asked for it, and it refuses any other status. Remove it?',
    )
    expect(getManualRemediationHint('guessed_constraint', details)).toContain('ALTER TABLE orders DROP CONSTRAINT chk_orders_status;')
  })

  it('waits for a person, and their approval drops exactly the rule it names', () => {
    expect(classifyFix('guessed_constraint', details).decision).toBe('approval')
    expect(buildFixAction('guessed_constraint', details)).toEqual({
      action: 'DROP_CONSTRAINT',
      params: { tableName: 'orders', constraintName: 'chk_orders_status' },
    })
    // Without the rule's name there is nothing to drop, never a guess at one.
    expect(buildFixAction('guessed_constraint', { ...details, constraintName: undefined })).toBeNull()
    expect(decisionLabels('guessed_constraint')).toEqual({ approve: 'Remove it', busy: 'Removing…', dismiss: 'Keep it' })
    expect(decisionLabels('missing_rls')).toBeNull()
  })
})
