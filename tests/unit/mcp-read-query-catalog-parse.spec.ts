/**
 * ── run_query reads a statement the way PostgreSQL will ────────────────────
 *
 * The system catalogs are readable by PUBLIC and describe every project in the
 * database, so for catalog METADATA the statement itself is the boundary (see
 * lib/mcp/read-query.ts). The text check it relied on blanked double-quoted
 * identifiers like string literals, and `SELECT proname, prosrc FROM "pg_proc"`
 * read every project's function source. A pattern over text cannot see the
 * other routes either: a unicode-escaped name, an object id cast to an OID
 * alias type, or a query handed to a function as a string.
 *
 * These run the real parser (libpg-query, PostgreSQL 16's grammar as
 * WebAssembly) and no database. Each route is asserted against the parser
 * alone (inspectReadQuery), so a refusal cannot be the text check's doing, and
 * against the full admission run_query applies (admitReadQuery). Every refusal
 * group is paired with reads that must keep working, so the suite cannot pass by
 * refusing everything.
 */

import { admitReadQuery, runReadQuery, ReadQueryError, MAX_SQL_LENGTH } from '@/lib/mcp/read-query'
import { inspectReadQuery, parseSql } from '@/lib/mcp/read-query-ast'

const PROJECT = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'
const OWN = `workspace_${PROJECT}`
const OTHER = 'workspace_0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d'

/** The full admission run_query applies: the parser first, the text checks second. */
async function admit(sql: string): Promise<ReadQueryError | null> {
  try {
    await admitReadQuery(sql, PROJECT)
    return null
  } catch (err) {
    return err as ReadQueryError
  }
}

/** The parser alone, with no text check behind it. */
const parsedAlone = (sql: string) => inspectReadQuery(sql, OWN)

async function refusedBoth(sql: string, code: string): Promise<void> {
  expect(await parsedAlone(sql)).toMatchObject({ code })
  expect(await admit(sql)).toMatchObject({ code })
}

describe('the parser is the PostgreSQL 16 grammar the server runs', () => {
  it('reports a PostgreSQL 16 parse tree', async () => {
    const tree = (await parseSql('SELECT 1')) as { version: number }
    expect(Math.floor(tree.version / 10000)).toBe(16)
  })
})

describe('the reported bypass: a double-quoted catalog', () => {
  it.each([
    ['the query that read every project\'s function source', 'SELECT proname, prosrc FROM "pg_proc"'],
    ['every project\'s schema, hence its id', 'SELECT nspname FROM "pg_namespace"'],
    ['both names quoted', 'SELECT * FROM "pg_catalog"."pg_proc"'],
    ['information_schema quoted', 'SELECT * FROM "information_schema"."columns"'],
    ['information_schema with its relation bare', 'SELECT * FROM "information_schema".columns'],
    ['TABLE', 'TABLE "pg_proc"'],
    ['a join', 'SELECT * FROM posts p JOIN "pg_class" c ON c.relname = p.title'],
    ['a CTE', 'WITH x AS (SELECT * FROM "pg_proc") SELECT * FROM x'],
    ['a scalar subquery', 'SELECT (SELECT count(*) FROM "pg_proc") AS n'],
    ['EXPLAIN', 'EXPLAIN SELECT * FROM "pg_proc"'],
  ])('refuses %s', async (_label, sql) => {
    await refusedBoth(sql, 'CATALOG_NOT_READABLE')
  })

  it('says where to go instead', async () => {
    const err = await admit('SELECT proname, prosrc FROM "pg_proc"')
    expect(err?.hint).toMatch(/read_backend_state|get_table_schema/)
    expect(err?.message).toMatch(/pg_proc/)
  })

  it('refuses before run_query opens a connection', async () => {
    // tests/unit has no database. Had the check not run first, this would fail
    // trying to connect, with some other error.
    await expect(runReadQuery(PROJECT, 'SELECT proname, prosrc FROM "pg_proc"')).rejects.toMatchObject({
      code: 'CATALOG_NOT_READABLE',
    })
  })
})

describe('unicode-escaped names, which no pattern over the text can read', () => {
  it.each([
    ['a relation', 'SELECT proname, prosrc FROM U&"\\0070g_proc"'],
    ['a relation with its own escape character', "SELECT nspname FROM U&\"!0070g_namespace\" UESCAPE '!'"],
    ['a schema', 'SELECT * FROM U&"\\0069nformation_schema".columns'],
    ['a schema and relation', 'SELECT * FROM U&"\\0070\\0067_catalog".U&"\\0070\\0067_proc"'],
    ['a function', "SELECT U&\"\\0071uery_to_xml\"('select 1', true, false, '')"],
    ['a type', 'SELECT 16400::U&"\\0072egnamespace"'],
  ])('refuses %s', async (_label, sql) => {
    await refusedBoth(sql, 'CATALOG_NOT_READABLE')
  })
})

describe('OID alias types, which turn any object id into its name', () => {
  it.each([
    ['::regnamespace', 'SELECT 16400::regnamespace'],
    ['CAST AS regclass', 'SELECT CAST(16400 AS regclass)'],
    ['a typed literal', "SELECT regclass '16400'"],
    ['::regproc after ::oid', 'SELECT 16400::oid::regproc'],
    ['::regprocedure', 'SELECT 16400::regprocedure'],
    ['::regtype', 'SELECT 16400::regtype'],
    ['::regrole', 'SELECT 16400::regrole'],
    ['::regoper', 'SELECT 16400::regoper'],
    ['::regoperator', 'SELECT 16400::regoperator'],
    ['::regconfig', 'SELECT 16400::regconfig'],
    ['::regdictionary', 'SELECT 16400::regdictionary'],
    ['::regcollation', 'SELECT 16400::regcollation'],
    ['an array of them', "SELECT '{16400,16401}'::regnamespace[]"],
    ['the array type by name', "SELECT '{16400}'::_regclass"],
    ['qualified with pg_catalog', 'SELECT 16400::pg_catalog.regnamespace'],
    ['quoted', 'SELECT x::"regnamespace" FROM t'],
    ['a function-style cast', 'SELECT regnamespace(16400::oid)'],
    ['the output function', 'SELECT regnamespaceout(16400::oid)'],
    ['column notation, which PostgreSQL reads as a cast', 'SELECT (16400).regclass'],
    ['a column definition list', "SELECT * FROM json_to_record('{\"a\":16400}') AS r(a regnamespace)"],
    [
      'an XMLTABLE column',
      "SELECT * FROM XMLTABLE('/r' PASSING xmlparse(document '<r><a>16400</a></r>') COLUMNS a regclass PATH 'a')",
    ],
  ])('refuses %s', async (_label, sql) => {
    await refusedBoth(sql, 'CATALOG_NOT_READABLE')
  })
})

describe('functions that run SQL given as text', () => {
  it.each([
    ['query_to_xml', "SELECT query_to_xml('select nspname from pg_namespace', true, false, '')"],
    ['query_to_xmlschema', "SELECT query_to_xmlschema('select 1', true, false, '')"],
    ['query_to_xml_and_xmlschema', "SELECT query_to_xml_and_xmlschema('select 1', true, false, '')"],
    ['cursor_to_xml', "SELECT cursor_to_xml(c, 10, true, false, '') FROM t"],
    ['cursor_to_xmlschema', "SELECT cursor_to_xmlschema(c, true, false, '') FROM t"],
    ['table_to_xml', "SELECT table_to_xml('pg_proc', true, false, '')"],
    ['table_to_xmlschema', "SELECT table_to_xmlschema('pg_proc', true, false, '')"],
    ['table_to_xml_and_xmlschema', "SELECT table_to_xml_and_xmlschema('pg_proc', true, false, '')"],
    ['schema_to_xml', "SELECT schema_to_xml('pg_catalog', true, false, '')"],
    ['schema_to_xmlschema', "SELECT schema_to_xmlschema('pg_catalog', true, false, '')"],
    ['schema_to_xml_and_xmlschema', "SELECT schema_to_xml_and_xmlschema('pg_catalog', true, false, '')"],
    ['database_to_xml', "SELECT database_to_xml(true, false, '')"],
    ['database_to_xmlschema', "SELECT database_to_xmlschema(true, false, '')"],
    ['database_to_xml_and_xmlschema', "SELECT database_to_xml_and_xmlschema(true, false, '')"],
    ['in FROM', "SELECT * FROM query_to_xml('select 1', true, false, '') AS x"],
    ['ts_stat, which runs its argument', "SELECT * FROM ts_stat('select to_tsvector(prosrc) from pg_proc')"],
    ['ts_rewrite, which runs its second argument', "SELECT ts_rewrite('a'::tsquery, 'select 1')"],
    ['ts_stat in column notation', "SELECT ('select to_tsvector(prosrc) from pg_proc'::text).ts_stat"],
    ['dblink', "SELECT * FROM dblink('dbname=x', 'select nspname from pg_namespace') AS t(n text)"],
    ['dblink_exec', "SELECT dblink_exec('select 1')"],
    ['dblink_connect', "SELECT dblink_connect('dbname=x')"],
    ['crosstab', "SELECT * FROM crosstab('select 1') AS t(a int)"],
  ])('refuses %s', async (_label, sql) => {
    await refusedBoth(sql, 'CATALOG_NOT_READABLE')
  })
})

describe('catalog comments, probes by name or id, settings and large objects', () => {
  it.each([
    ['obj_description', "SELECT obj_description(16400, 'pg_namespace')"],
    ['obj_description, one argument', 'SELECT obj_description(16400)'],
    ['col_description', 'SELECT col_description(16400, 1)'],
    ['shobj_description', "SELECT shobj_description(1, 'pg_database')"],
    ['obj_description in column notation', 'SELECT (16400::oid).obj_description'],
    ['to_regclass', "SELECT to_regclass('x')"],
    ['to_regcollation', "SELECT to_regcollation('x')"],
    ['to_regnamespace', "SELECT to_regnamespace('x')"],
    ['to_regoper', "SELECT to_regoper('x')"],
    ['to_regoperator', "SELECT to_regoperator('x')"],
    ['to_regproc', "SELECT to_regproc('x')"],
    ['to_regprocedure', "SELECT to_regprocedure('x')"],
    ['to_regrole', "SELECT to_regrole('x')"],
    ['to_regtype', "SELECT to_regtype('x')"],
    ['to_regclass in column notation', "SELECT ('x'::text).to_regclass"],
    ['has_table_privilege', "SELECT has_table_privilege('x', 'select')"],
    ['has_schema_privilege', "SELECT has_schema_privilege('x', 'usage')"],
    ['has_any_column_privilege', "SELECT has_any_column_privilege(16400, 'select')"],
    ['has_column_privilege', "SELECT has_column_privilege(16400, 1::int2, 'select')"],
    ['has_database_privilege', "SELECT has_database_privilege('x', 'connect')"],
    ['has_foreign_data_wrapper_privilege', "SELECT has_foreign_data_wrapper_privilege('x', 'usage')"],
    ['has_function_privilege', "SELECT has_function_privilege(16400, 'execute')"],
    ['has_language_privilege', "SELECT has_language_privilege('sql', 'usage')"],
    ['has_parameter_privilege', "SELECT has_parameter_privilege('work_mem', 'set')"],
    ['has_sequence_privilege', "SELECT has_sequence_privilege(16400, 'usage')"],
    ['has_server_privilege', "SELECT has_server_privilege('x', 'usage')"],
    ['has_tablespace_privilege', "SELECT has_tablespace_privilege('x', 'create')"],
    ['has_type_privilege', "SELECT has_type_privilege(16400, 'usage')"],
    ['pg_has_role', "SELECT pg_has_role('x', 'member')"],
    ['row_security_active', 'SELECT row_security_active(16400)'],
    ['set_config', "SELECT set_config('search_path', 'information_schema', true)"],
    ['lo_get', 'SELECT lo_get(16400)'],
    ['lo_get in FROM', 'SELECT * FROM lo_get(16400)'],
    ['lo_open', 'SELECT lo_open(16400, 262144)'],
    ['loread', 'SELECT loread(0, 100)'],
    ['lowrite', "SELECT lowrite(0, 'x')"],
    ['lo_import', "SELECT lo_import('/etc/passwd')"],
    ['lo_export', "SELECT lo_export(16400, '/tmp/x')"],
    ['lo_from_bytea', "SELECT lo_from_bytea(0, 'x')"],
    ['lo_creat', 'SELECT lo_creat(-1)'],
    ['lo_unlink', 'SELECT lo_unlink(16400)'],
    ['lo_put', "SELECT lo_put(16400, 0, 'x')"],
    ['lo_lseek64', 'SELECT lo_lseek64(0, 0, 0)'],
  ])('refuses %s', async (_label, sql) => {
    await refusedBoth(sql, 'CATALOG_NOT_READABLE')
  })
})

/**
 * Not in the report, found while closing it: built-in functions that take an
 * object id and hand back, or put in their error, the object's name.
 * currval(16400) answers '"orders" is not a sequence' for any relation's id;
 * format_type qualifies a type with its schema, another project's id.
 */
describe('other functions that turn an object id into its name', () => {
  it.each([
    ['format_type', 'SELECT format_type(16400, NULL)'],
    ['currval', 'SELECT currval(16400)'],
    ['nextval', "SELECT nextval('orders_id_seq')"],
    ['setval', "SELECT setval('orders_id_seq', 1)"],
    ['satisfies_hash_partition', 'SELECT satisfies_hash_partition(16400, 2, 0, 1)'],
    ['makeaclitem', "SELECT makeaclitem(10, 10, 'SELECT', false)"],
    ['acldefault', "SELECT acldefault('r', 10)"],
    ['enum_in', "SELECT enum_in('x', 16400)"],
    ['domain_in', "SELECT domain_in('x', 16400, -1)"],
    ['record_in', "SELECT record_in('()', 16400, -1)"],
    ['array_in', "SELECT array_in('{}', 16400, -1)"],
    ['ts_debug', "SELECT * FROM ts_debug('english', 'x')"],
    ['brin_summarize_new_values', 'SELECT brin_summarize_new_values(16400)'],
    ['gin_clean_pending_list', 'SELECT gin_clean_pending_list(16400)'],
    ['fmgr_sql_validator', 'SELECT fmgr_sql_validator(16400)'],
    ['pg_get_functiondef', 'SELECT pg_get_functiondef(16400)'],
    ['pg_read_file', "SELECT pg_read_file('postgresql.conf')"],
    ['a pg_ type', 'SELECT x::pg_lsn FROM t'],
    ['a catalog\'s row type', 'SELECT NULL::pg_proc'],
    ['aclitem', "SELECT 'x=r/y'::aclitem"],
    ['a pg_ column', 'SELECT pg_x FROM t'],
  ])('refuses %s', async (_label, sql) => {
    await refusedBoth(sql, 'CATALOG_NOT_READABLE')
  })
})

describe('schemas other than the project\'s own', () => {
  it.each([
    ['the platform\'s public schema', 'SELECT * FROM public.users'],
    ['another project', `SELECT body FROM "${OTHER}".secrets`],
    ['a database-qualified name', 'SELECT * FROM backenly.public.users'],
    ['another project beside this one', `SELECT * FROM "${OWN}".orders o JOIN "${OTHER}".orders x ON true`],
    ['a function in public', 'SELECT public.similarity(a, b) FROM t'],
    ['a function in another project', `SELECT "${OTHER}".fn()`],
    ['a type in public', 'SELECT x::public.citext FROM t'],
    ['an operator in public', 'SELECT a OPERATOR(public.<->) b FROM t'],
    ['an ORDER BY operator in public', 'SELECT a FROM t ORDER BY a USING OPERATOR(public.<)'],
    ['a subquery operator in public', 'SELECT a OPERATOR(public.=) ANY (SELECT b FROM u) FROM t'],
    ['a collation in public', 'SELECT a COLLATE public."x" FROM t'],
    ['a TABLESAMPLE method in public', 'SELECT * FROM t TABLESAMPLE public.system_rows(10)'],
  ])('refuses %s', async (_label, sql) => {
    await refusedBoth(sql, 'OUTSIDE_PROJECT_SCHEMA')
  })

  it('refuses a catalog schema as a catalog, whatever it qualifies', async () => {
    await refusedBoth('SELECT information_schema._pg_truetypid(a, t) FROM x', 'CATALOG_NOT_READABLE')
    await refusedBoth('SELECT * FROM pg_toast.pg_toast_16400', 'CATALOG_NOT_READABLE')
  })

  it('tells the caller to leave names unqualified', async () => {
    const err = await admit('SELECT * FROM public.users')
    expect(err?.hint).toMatch(/unqualified/)
    expect(err?.message).toMatch(/public/)
  })
})

describe('one read statement, as before', () => {
  it.each([
    ['two statements', 'SELECT 1; SELECT 2', 'MULTI_STATEMENT'],
    ['a write after a read', 'SELECT 1; DROP TABLE users', 'MULTI_STATEMENT'],
    ['a data-modifying CTE', 'WITH gone AS (DELETE FROM users RETURNING *) SELECT * FROM gone', 'NOT_READ_ONLY'],
    ['an INSERT in a CTE', 'WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x', 'NOT_READ_ONLY'],
    ['an UPDATE in a CTE', 'WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x', 'NOT_READ_ONLY'],
    ['SELECT INTO, which creates a table', 'SELECT * INTO new_table FROM orders', 'NOT_READ_ONLY'],
    ['EXPLAIN ANALYZE', 'EXPLAIN ANALYZE SELECT 1', 'NOT_READ_ONLY'],
    ['EXPLAIN ANALYSE', 'EXPLAIN ANALYSE SELECT 1', 'NOT_READ_ONLY'],
    ['EXPLAIN (ANALYZE)', 'EXPLAIN (ANALYZE) SELECT 1', 'NOT_READ_ONLY'],
    ['EXPLAIN (ANALYSE false)', 'EXPLAIN (ANALYSE false, COSTS false) SELECT 1', 'NOT_READ_ONLY'],
    ['EXPLAIN of a write', 'EXPLAIN INSERT INTO t VALUES (1)', 'NOT_READ_ONLY'],
    ['DELETE', 'DELETE FROM users', 'NOT_READ_ONLY'],
    ['UPDATE', 'UPDATE t SET a = 1', 'NOT_READ_ONLY'],
    ['CREATE TABLE', 'CREATE TABLE x (id int)', 'NOT_READ_ONLY'],
    ['CALL', 'CALL p()', 'NOT_READ_ONLY'],
    ['DO', 'DO $$ BEGIN END $$', 'NOT_READ_ONLY'],
    ['COPY', 'COPY t TO STDOUT', 'NOT_READ_ONLY'],
    ['SET', 'SET search_path TO information_schema', 'NOT_READ_ONLY'],
    ['DECLARE', 'DECLARE c CURSOR FOR SELECT 1', 'NOT_READ_ONLY'],
    ['PREPARE', 'PREPARE p AS SELECT 1', 'NOT_READ_ONLY'],
    ['LISTEN', 'LISTEN x', 'NOT_READ_ONLY'],
    ['BEGIN', 'BEGIN', 'NOT_READ_ONLY'],
  ])('refuses %s', async (_label, sql, code) => {
    await refusedBoth(sql, code)
  })

  it('refuses a statement that does not parse, rather than running it', async () => {
    const err = await admit('SELECT * FORM t')
    expect(err).toMatchObject({ code: 'SYNTAX_ERROR' })
    expect(err?.message).toMatch(/syntax error/)
    expect(await admit("SELECT 'unterminated")).toMatchObject({ code: 'SYNTAX_ERROR' })
    expect(await admit('SELECT 1 /* unterminated')).toMatchObject({ code: 'SYNTAX_ERROR' })
  })

  it('refuses a NUL, which would end the statement early for the parser and the server', async () => {
    expect(await admit('SELECT 1\u0000; DROP TABLE users')).toMatchObject({ code: 'SYNTAX_ERROR' })
  })

  it('refuses a statement of only comments', async () => {
    expect(await admit('-- nothing here')).toMatchObject({ code: 'EMPTY_QUERY' })
    expect(await admit('   ')).toMatchObject({ code: 'EMPTY_QUERY' })
  })

  it('refuses a statement too long to parse safely, before parsing it', async () => {
    const sql = `SELECT ${'1+'.repeat(MAX_SQL_LENGTH / 2)}1`
    expect(sql.length).toBeGreaterThan(MAX_SQL_LENGTH)
    expect(await admit(sql)).toMatchObject({ code: 'QUERY_TOO_LONG' })
  })
})

describe('reads that must keep working', () => {
  it.each([
    ['a plain select', 'SELECT * FROM posts'],
    ['a join', 'SELECT p.title, u.email FROM posts p JOIN users u ON u.id = p.author_id'],
    [
      'an aggregate with GROUP BY and HAVING',
      'SELECT u.id, count(o.id) FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id HAVING count(o.id) > 1',
    ],
    [
      'a recursive CTE',
      'WITH RECURSIVE tree AS (SELECT id, parent_id FROM categories WHERE parent_id IS NULL UNION ALL ' +
        'SELECT c.id, c.parent_id FROM categories c JOIN tree t ON c.parent_id = t.id) SELECT count(*) FROM tree',
    ],
    [
      'a CTE with an interval',
      "WITH recent AS (SELECT * FROM orders WHERE \"createdAt\" > now() - interval '7 days') " +
        'SELECT status, count(*) FROM recent GROUP BY status',
    ],
    [
      'FILTER, a cast and ROLLUP',
      'SELECT status, count(*) FILTER (WHERE amount > 100) AS big, avg(amount)::numeric(10,2) AS mean ' +
        'FROM orders GROUP BY ROLLUP (status)',
    ],
    [
      'window functions',
      'SELECT id, row_number() OVER w, lag(amount) OVER w, sum(amount) OVER (PARTITION BY status) ' +
        'FROM orders WINDOW w AS (ORDER BY "createdAt")',
    ],
    ['an ordered-set aggregate', 'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) FROM orders'],
    [
      'JSON operators',
      "SELECT data->>'name' AS name, data #>> '{address,city}' AS city FROM profiles " +
        "WHERE data @> '{\"active\": true}'::jsonb AND data ? 'email'",
    ],
    ['a LATERAL JSON function', "SELECT e.value->>'sku' AS sku FROM orders o, LATERAL jsonb_array_elements(o.items) AS e(value)"],
    ['JSON builders', "SELECT jsonb_build_object('id', id, 'tags', to_jsonb(tags)) FROM posts"],
    ['json_agg of a row', 'SELECT json_agg(t) FROM (SELECT id, title FROM posts) t'],
    [
      'casts to ordinary types',
      "SELECT id::text, price::numeric(10,2), \"createdAt\"::date, CAST(qty AS bigint), '7 days'::interval, " +
        "'2026-01-01'::timestamptz, ARRAY['a', 'b']::text[], external_id::uuid, payload::jsonb, flag::boolean, " +
        "1.5::double precision, 'x'::varchar(10), 'x'::char(1), 3::smallint, 1::oid FROM items",
    ],
    [
      'grammar that names pg_catalog itself',
      "SELECT EXTRACT(year FROM \"createdAt\") AS y, date_trunc('month', \"createdAt\") AS m, " +
        "\"createdAt\" AT TIME ZONE 'UTC' AS utc FROM orders",
    ],
    [
      'string functions and conditionals',
      "SELECT substring(name from 1 for 3), trim(both ' ' from name), position('a' in name), " +
        "overlay(name placing 'x' from 1 for 1), name similar to 'a%', name ILIKE '%x%', coalesce(nickname, name), " +
        "nullif(a, b), greatest(a, b), CASE WHEN a > 1 THEN 'big' ELSE 'small' END FROM people",
    ],
    [
      'quoted mixed-case identifiers of the project\'s own tables',
      'SELECT "firstName", "Last Name" FROM "UserProfiles" WHERE "isActive" ORDER BY "createdAt" DESC',
    ],
    ['the project\'s own schema, qualified', `SELECT * FROM "${OWN}"."UserProfiles"`],
    ['the project\'s own schema with an alias', `SELECT o.id FROM "${OWN}".orders o`],
    ['set operations', 'SELECT id FROM a UNION ALL SELECT id FROM b EXCEPT SELECT id FROM c'],
    [
      'IN and EXISTS subqueries',
      'SELECT * FROM posts WHERE author_id IN (SELECT id FROM users WHERE banned) ' +
        'AND EXISTS (SELECT 1 FROM comments c WHERE c.post_id = posts.id)',
    ],
    ['a set-returning function', 'SELECT n FROM generate_series(1, 10) AS g(n)'],
    ['TABLESAMPLE', 'SELECT * FROM orders TABLESAMPLE SYSTEM (10) REPEATABLE (42)'],
    [
      'DISTINCT ON, NULLS LAST, LIMIT and OFFSET',
      'SELECT DISTINCT ON (customer_id) * FROM orders ORDER BY customer_id, "createdAt" DESC NULLS LAST LIMIT 10 OFFSET 5',
    ],
    ['FETCH FIRST', 'SELECT * FROM orders ORDER BY id FETCH FIRST 5 ROWS ONLY'],
    ['VALUES', "VALUES (1, 'a'), (2, 'b')"],
    ['TABLE', 'TABLE orders'],
    ['SHOW', 'SHOW search_path'],
    ['EXPLAIN', 'EXPLAIN SELECT * FROM posts WHERE id = 1'],
    ['EXPLAIN with options', 'EXPLAIN (FORMAT JSON, VERBOSE) SELECT * FROM posts'],
    ['a parameter', 'SELECT * FROM orders WHERE status = $1'],
    [
      'full-text search with a configuration given by name',
      "SELECT id FROM posts WHERE to_tsvector('english', body) @@ plainto_tsquery('english', 'hello')",
    ],
    ['ordered aggregates', "SELECT string_agg(name, ', ' ORDER BY name), array_agg(DISTINCT tag) FROM tags"],
    ['columns named like refused functions', 'SELECT lo_bound, to_region, format_type, comment_count FROM ranges'],
    [
      'catalog names inside string literals',
      "SELECT * FROM posts WHERE title = 'pg_proc internals' OR body = $$information_schema$$",
    ],
    ['an escaped string', "SELECT E'it\\'s' AS s"],
    ['names that merely start like a catalog', 'SELECT information_schema_notes, pgp_note FROM docs'],
    ['a trailing semicolon', 'SELECT 1;'],
    ['a leading comment', '-- totals\nSELECT sum(amount) FROM payments'],
    ['a block comment', 'SELECT sum(amount) FROM payments /* monthly */'],
  ])('admits %s', async (_label, sql) => {
    expect(await admit(sql)).toBeNull()
  })
})
