/**
 * The slow-query index parser, proved without a database.
 *
 * This function's output becomes a CREATE INDEX that the loop applies without
 * asking, so the expensive direction is a confident wrong answer. An index on a
 * column nobody filters costs write throughput on every insert and update for as
 * long as it exists, and nothing ever surfaces it — this repo has already paid
 * for that once, in a hot-table detector that emitted SQL naming a column the
 * table did not have.
 *
 * The parser is therefore allowed to give up (null) as often as it likes, and
 * the tests below spend most of their effort pinning the cases where it MUST.
 * Catalog verification in detectSlowQueryMissingIndexes is the second net; this
 * is the first.
 */

import { extractIndexCandidate } from '@/lib/ai/infra-intelligence'

const SCHEMA = 'workspace_abc123'

describe('extractIndexCandidate — recognises the shape it is sure about', () => {
  it('reads a qualified equality predicate', () => {
    const q = `SELECT "orders"."id" FROM "${SCHEMA}"."orders" WHERE "orders"."status" = $1`
    expect(extractIndexCandidate(q, SCHEMA)).toEqual({ table: 'orders', column: 'status' })
  })

  it('reads a bare equality predicate', () => {
    const q = `SELECT * FROM "${SCHEMA}"."invoices" WHERE "customer_ref" = $1 LIMIT $2`
    expect(extractIndexCandidate(q, SCHEMA)).toEqual({ table: 'invoices', column: 'customer_ref' })
  })

  it('reads an IN predicate', () => {
    const q = `SELECT * FROM "${SCHEMA}"."events" WHERE "events"."kind" IN ($1, $2)`
    expect(extractIndexCandidate(q, SCHEMA)).toEqual({ table: 'events', column: 'kind' })
  })

  it('handles UPDATE as well as SELECT', () => {
    const q = `UPDATE "${SCHEMA}"."sessions" SET "revoked" = $1 WHERE "token_hash" = $2`
    expect(extractIndexCandidate(q, SCHEMA)).toEqual({ table: 'sessions', column: 'token_hash' })
  })
})

describe('extractIndexCandidate — refuses to guess', () => {
  it('returns null for another tenant schema', () => {
    // The whole cross-tenant safety property. pg_stat_statements is per-database
    // and every project shares one, so an unqualified match here would propose an
    // index on a table belonging to somebody else.
    const q = `SELECT * FROM "workspace_someoneelse"."orders" WHERE "status" = $1`
    expect(extractIndexCandidate(q, SCHEMA)).toBeNull()
  })

  it('returns null for an unqualified table name', () => {
    const q = `SELECT * FROM orders WHERE status = $1`
    expect(extractIndexCandidate(q, SCHEMA)).toBeNull()
  })

  it('returns null when there is no WHERE clause', () => {
    const q = `SELECT count(*) FROM "${SCHEMA}"."orders"`
    expect(extractIndexCandidate(q, SCHEMA)).toBeNull()
  })

  it('returns null for a range predicate', () => {
    // A btree index may or may not help a range scan, and proposing one on that
    // basis is cargo cult rather than measurement.
    const q = `SELECT * FROM "${SCHEMA}"."orders" WHERE "total" > $1`
    expect(extractIndexCandidate(q, SCHEMA)).toBeNull()
  })

  it('returns null for a leading-wildcard LIKE', () => {
    const q = `SELECT * FROM "${SCHEMA}"."users" WHERE "email" LIKE $1`
    expect(extractIndexCandidate(q, SCHEMA)).toBeNull()
  })

  it('returns null for the primary key, which is already indexed', () => {
    const q = `SELECT * FROM "${SCHEMA}"."orders" WHERE "orders"."id" = $1`
    expect(extractIndexCandidate(q, SCHEMA)).toBeNull()
  })

  it('does not attribute a joined table column to the wrong table', () => {
    // The qualifier names `users`, but the FROM matched `orders`. Emitting
    // {table: orders, column: email} would create an index on a column orders
    // does not have — the exact defect the catalog check exists to catch, caught
    // one layer earlier.
    const q = `SELECT * FROM "${SCHEMA}"."orders" JOIN "${SCHEMA}"."users" ON true WHERE "users"."email" = $1`
    const got = extractIndexCandidate(q, SCHEMA)
    expect(got).not.toEqual({ table: 'orders', column: 'email' })
  })

  it('returns null on empty or missing input', () => {
    expect(extractIndexCandidate('', SCHEMA)).toBeNull()
    expect(extractIndexCandidate(`SELECT 1`, '')).toBeNull()
  })

  it('treats regex metacharacters in the schema name literally', () => {
    // The schema name is interpolated into a RegExp. An unescaped `.` would
    // match any character and let a neighbouring tenant's schema through.
    const q = `SELECT * FROM "workspaceXabc"."orders" WHERE "status" = $1`
    expect(extractIndexCandidate(q, 'workspace.abc')).toBeNull()
  })
})
