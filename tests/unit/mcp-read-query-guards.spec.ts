/**
 * Guards for governed read-only SQL.
 *
 * These are DEFENCE IN DEPTH, not the security boundary — the boundary is the
 * `bkn_ro_` role's grants, proven separately in tests/probes/read-query-isolation.
 * They exist to refuse statement smuggling and to return an error an agent can
 * act on. Every rejection case below is paired with an acceptance case, so the
 * suite can never pass by rejecting everything.
 */

import {
  assertReadOnlySql,
  stripSqlNoise,
  redactRows,
  capped,
  ReadQueryError,
} from '@/lib/mcp/read-query'

const rejects = (sql: string, code?: string) => {
  let thrown: unknown
  try { assertReadOnlySql(sql) } catch (e) { thrown = e }
  expect(thrown).toBeInstanceOf(ReadQueryError)
  if (code) expect((thrown as ReadQueryError).code).toBe(code)
}

describe('assertReadOnlySql — accepts real read work', () => {
  it.each([
    ['plain select', 'SELECT * FROM posts'],
    ['aggregate + group by', 'SELECT status, count(*) FROM orders GROUP BY status'],
    ['join', 'SELECT p.title, u.email FROM posts p JOIN users u ON u.id = p.author_id'],
    ['CTE', 'WITH recent AS (SELECT * FROM orders WHERE created_at > now() - interval \'7 days\') SELECT count(*) FROM recent'],
    ['window function', 'SELECT id, row_number() OVER (PARTITION BY status ORDER BY created_at) FROM orders'],
    ['explain', 'EXPLAIN SELECT * FROM posts WHERE id = 1'],
    ['trailing semicolon', 'SELECT 1;'],
    ['leading comment', '-- find the totals\nSELECT sum(amount) FROM payments'],
  ])('accepts %s', (_label, sql) => {
    expect(() => assertReadOnlySql(sql)).not.toThrow()
  })
})

describe('assertReadOnlySql — refuses writes and smuggling', () => {
  it('refuses a bare mutation', () => rejects('DELETE FROM users', 'NOT_READ_ONLY'))
  it('refuses DDL', () => rejects('DROP TABLE users', 'NOT_READ_ONLY'))
  it('refuses GRANT', () => rejects('GRANT SELECT ON users TO public', 'NOT_READ_ONLY'))

  it('refuses a data-modifying CTE that opens with WITH', () => {
    // Begins with WITH and would pass a naive "starts with a read verb" check.
    rejects('WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone', 'NOT_READ_ONLY')
  })

  it('refuses a second statement smuggled after a valid one', () => {
    rejects('SELECT 1; DROP TABLE users', 'MULTI_STATEMENT')
  })

  it('refuses EXPLAIN ANALYZE, which executes the statement', () => {
    rejects('EXPLAIN ANALYZE SELECT * FROM posts', 'NOT_READ_ONLY')
  })

  it('refuses EXPLAIN ANALYSE, the same option in its British spelling', () => {
    rejects('EXPLAIN ANALYSE SELECT * FROM posts', 'NOT_READ_ONLY')
  })

  it('refuses an empty query', () => rejects('   ', 'EMPTY_QUERY'))
})

describe('stripSqlNoise — keyword checks must not read string contents', () => {
  it('does not see a write verb inside a string literal', () => {
    // The row VALUE contains "delete"; the STATEMENT is a plain select.
    const sql = "SELECT * FROM audit WHERE action = 'delete'"
    expect(stripSqlNoise(sql)).not.toMatch(/delete/i)
    expect(() => assertReadOnlySql(sql)).not.toThrow()
  })

  it('does not see a semicolon inside a string literal', () => {
    const sql = "SELECT * FROM notes WHERE body = 'a; b'"
    expect(() => assertReadOnlySql(sql)).not.toThrow()
  })

  it('does not see a write verb inside a comment', () => {
    expect(() => assertReadOnlySql('SELECT 1 /* do not DROP TABLE */')).not.toThrow()
  })

  it('handles escaped quotes without losing track of the string', () => {
    expect(() => assertReadOnlySql("SELECT * FROM t WHERE s = 'it''s fine'")).not.toThrow()
  })

  it('still catches a real write verb outside any string', () => {
    rejects("SELECT * FROM t WHERE a = 'x'; DELETE FROM t")
  })

  it('reads nested block comments the way PostgreSQL does', () => {
    // `/* /* */ show */` is ONE comment in PostgreSQL. Ending it at the first
    // `*/` left ` show */ SELECT ...`, which read as a SHOW.
    expect(stripSqlNoise('/* /* */ show */ SELECT 1').trim()).toBe('SELECT 1')
    expect(stripSqlNoise('SELECT 1 /* a /* b */ c */ + 2')).toBe('SELECT 1   + 2')
  })
})

describe('redactRows — agent context is not a psql prompt', () => {
  it('redacts secret-bearing columns but keeps the shape', () => {
    const { rows, redactedColumns } = redactRows([
      { id: 1, email: 'a@b.c', password_hash: '$2b$10$realhash', api_key: 'sk_live_x' },
    ])
    expect(redactedColumns).toEqual(expect.arrayContaining(['password_hash', 'api_key']))
    expect(rows[0].password_hash).toBe('[redacted]')
    expect(rows[0].api_key).toBe('[redacted]')
    // Non-secret data must survive, or the tool is useless.
    expect(rows[0].email).toBe('a@b.c')
    expect(rows[0].id).toBe(1)
  })

  it('leaves ordinary rows untouched', () => {
    const { rows, redactedColumns } = redactRows([{ id: 1, title: 'hello' }])
    expect(redactedColumns).toEqual([])
    expect(rows[0].title).toBe('hello')
  })

  it('preserves null rather than masking absence as a secret', () => {
    const { rows } = redactRows([{ token: null }])
    expect(rows[0].token).toBeNull()
  })
})

describe('capped — the row cap is enforced in Postgres', () => {
  it('wraps a select so the database applies the limit', () => {
    const out = capped('SELECT * FROM big', 200, 'select')
    expect(out).toMatch(/LIMIT 201/)
    expect(out).toMatch(/_bkn_read_query/)
  })

  it('asks for one extra row so truncation can be reported honestly', () => {
    expect(capped('SELECT 1', 5, 'select')).toMatch(/LIMIT 6/)
  })

  it('strips a trailing semicolon before wrapping (else the wrap is invalid SQL)', () => {
    expect(capped('SELECT 1;', 10, 'select')).not.toMatch(/;\s*\n\)/)
  })

  it('does not wrap EXPLAIN or SHOW, which cannot be subqueried', () => {
    expect(capped('EXPLAIN SELECT 1', 10, 'explain')).toBe('EXPLAIN SELECT 1')
    expect(capped('SHOW search_path', 10, 'show')).toBe('SHOW search_path')
  })

  it('wraps by what the parser said the statement is, never by how its text begins', () => {
    // The parse tree of this is a SELECT; its text begins with a comment that a
    // text reading once ended early, leaving "show" first, so it ran unwrapped
    // and materialised every row.
    const out = capped('/* /* */ show */ SELECT g FROM generate_series(1, 3000000) g', 10, 'select')
    expect(out).toMatch(/^SELECT \* FROM \(/)
    expect(out).toMatch(/LIMIT 11$/)
  })
})

/**
 * ── System catalogs are instance-wide, so run_query refuses them ─────────────
 *
 * The tool description claimed run_query "cannot read another project". For
 * tenant ROWS that is true and is enforced by Postgres grants. For the
 * CATALOGS it was not: `pg_catalog` is readable by PUBLIC and spans the whole
 * instance, so a plain `SELECT proname, prosrc FROM pg_proc` from one project's
 * read-only role returned the source of ~10 other tenants' functions, and
 * `pg_namespace` enumerates every customer's schema — hence every customer's
 * project id.
 *
 * There is no proportionate grant fix: revoking the catalogs from PUBLIC
 * instance-wide breaks `pg_dump` and `\d` for the read-only credentials this
 * platform deliberately hands out. So this boundary IS syntactic, the docs now
 * say so, and these tests are what hold it.
 */
describe('system catalogs are refused', () => {
  const refuse = (sql: string) => {
    let err: any = null
    try { assertReadOnlySql(sql) } catch (e) { err = e }
    expect(err).toBeTruthy()
    expect(err.code).toBe('CATALOG_NOT_READABLE')
    return err
  }

  it('refuses the exact query that leaked other tenants\' function source', () => {
    refuse('SELECT proname, prosrc FROM pg_proc')
  })

  it('refuses schema enumeration', () => {
    refuse('SELECT nspname FROM pg_namespace')
    refuse('SELECT schema_name FROM information_schema.schemata')
  })

  it('refuses every catalog spelling — qualified, joined, subselected, CTE', () => {
    refuse('SELECT * FROM pg_catalog.pg_proc')
    refuse('SELECT * FROM posts p JOIN pg_class c ON c.relname = p.title')
    refuse('SELECT (SELECT count(*) FROM pg_policy) AS n')
    refuse('WITH x AS (SELECT * FROM pg_tables) SELECT * FROM x')
    refuse('SELECT * FROM information_schema.columns')
    refuse('SELECT * FROM PG_PROC')
    refuse('SELECT * FROM pg_roles')
    refuse('SELECT * FROM pg_stat_activity')
    refuse('SELECT * FROM pg_settings')
  })

  it('covers catalogs that do not exist yet, via the pg_ prefix', () => {
    // Every catalog schema and every relation in pg_catalog begins with pg_, so
    // "starts with pg_" is exhaustive over the catalogs. PostgreSQL reserves the
    // prefix only for schema, tablespace and role names: a project's own table
    // named pg_foo is legal, and is refused too.
    refuse('SELECT * FROM pg_some_future_catalog')
  })

  it('names where to go instead, so the refusal costs one call not a turn', () => {
    const err = refuse('SELECT * FROM pg_proc')
    expect(err.hint).toMatch(/read_backend_state|get_table_schema/)
  })

  it('does NOT trip on a row whose text merely contains a catalog name', () => {
    // stripSqlNoise removes string literals before the check.
    expect(() => assertReadOnlySql("SELECT * FROM posts WHERE title = 'pg_proc internals'")).not.toThrow()
    expect(() => assertReadOnlySql("SELECT * FROM logs WHERE msg = 'information_schema'")).not.toThrow()
  })

  it('does NOT trip on a column whose name merely starts similarly', () => {
    expect(() => assertReadOnlySql('SELECT information_schema_notes FROM docs')).not.toThrow()
    expect(() => assertReadOnlySql('SELECT pgp_note FROM docs')).not.toThrow()
  })

  it('leaves ordinary tenant queries alone', () => {
    expect(() => assertReadOnlySql('SELECT * FROM orders WHERE status = $1')).not.toThrow()
    expect(() =>
      assertReadOnlySql(
        'SELECT u.id, count(o.id) FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id',
      ),
    ).not.toThrow()
  })
})

/**
 * ── A quoted identifier names what the bare word names ───────────────────────
 *
 * stripSqlNoise blanked `"..."` exactly as it blanks `'...'`, so the catalog
 * check never saw `"pg_proc"`, and `SELECT proname, prosrc FROM "pg_proc"` ran
 * and read every project's function source: the 2026-07-22 leak again, one pair
 * of quotes away. A string literal is data; a quoted identifier is a name.
 *
 * The parser in lib/mcp/read-query-ast.ts decides this first now
 * (tests/unit/mcp-read-query-catalog-parse.spec.ts); these pin the text check,
 * which stays behind it as an independent second layer.
 */
describe('the text check sees quoted identifiers', () => {
  const refuse = (sql: string) => rejects(sql, 'CATALOG_NOT_READABLE')

  it('refuses the double-quoted catalog that read every project\'s function source', () => {
    refuse('SELECT proname, prosrc FROM "pg_proc"')
  })

  it('refuses every quoted spelling of a catalog', () => {
    refuse('SELECT nspname FROM "pg_namespace"')
    refuse('SELECT * FROM "pg_catalog"."pg_proc"')
    refuse('SELECT * FROM "pg_catalog".pg_proc')
    refuse('SELECT * FROM pg_catalog."pg_proc"')
    refuse('SELECT * FROM "information_schema"."columns"')
    refuse('SELECT * FROM "information_schema".columns')
    refuse('TABLE "pg_proc"')
    refuse('SELECT * FROM posts p JOIN "pg_class" c ON c.relname = p.title')
  })

  it('still reads string literals as data', () => {
    expect(() => assertReadOnlySql("SELECT * FROM posts WHERE title = 'pg_proc'")).not.toThrow()
    expect(() => assertReadOnlySql("SELECT * FROM logs WHERE msg = '\"pg_proc\"'")).not.toThrow()
  })

  it('does not trip on a quoted name that merely contains pg_ inside a word', () => {
    expect(() => assertReadOnlySql('SELECT "user_pg_notes" FROM "Docs"')).not.toThrow()
  })

  it('keeps quoted identifiers out of the keyword checks, as before', () => {
    // A column named "delete" or "comment" is a name, not a verb.
    expect(() => assertReadOnlySql('SELECT "delete", "comment" FROM audit')).not.toThrow()
    expect(() => assertReadOnlySql('SELECT "a;b" FROM t')).not.toThrow()
  })

  it('stripSqlNoise keeps an identifier\'s text only when asked', () => {
    expect(stripSqlNoise('SELECT * FROM "pg_proc"')).not.toMatch(/pg_proc/)
    expect(stripSqlNoise('SELECT * FROM "pg_proc"', { keepIdentifiers: true })).toMatch(/\bpg_proc\b/)
    // A doubled quote inside an identifier is one quote.
    expect(stripSqlNoise('SELECT "a""b" FROM t', { keepIdentifiers: true })).toMatch(/a"b/)
    // String literals are blanked either way.
    expect(stripSqlNoise("SELECT 'pg_proc'", { keepIdentifiers: true })).not.toMatch(/pg_proc/)
  })
})
