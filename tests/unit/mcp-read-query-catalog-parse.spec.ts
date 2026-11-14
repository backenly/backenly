/**
 * ── run_query reads a statement the way PostgreSQL will ────────────────────
 *
 * The system catalogs are readable by PUBLIC and describe every project in the
 * database, so for catalog METADATA the statement itself is the boundary (see
 * lib/mcp/read-query.ts). The text check it relied on blanked double-quoted
 * identifiers like string literals, and `SELECT proname, prosrc FROM "pg_proc"`
 * read every project's function source. A pattern over text cannot see the
 * other routes either: a unicode-escaped name, an object id cast to an OID
 * alias type, a query handed to a function as a string, or column notation,
 * where `g.regnamespace` is the call regnamespace(g).
 *
 * So the check parses the statement (libpg-query, PostgreSQL 16's grammar as
 * WebAssembly) and allows only listed functions, types and settings. These run
 * the real parser and no database. Each route is asserted against the parser
 * alone (inspectReadQuery), so a refusal cannot be the text check's doing, and
 * against the full admission run_query applies (admitReadQuery). The refusals
 * are paired with analytics reads that must keep working, so the suite cannot
 * pass by refusing everything.
 */

import { admitReadQuery, runReadQuery, ReadQueryError, MAX_SQL_LENGTH } from '@/lib/mcp/read-query'
import { checkReadQuery, inspectReadQuery, parseSql } from '@/lib/mcp/read-query-ast'

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

const CATALOG = 'CATALOG_NOT_READABLE'
const FUNCTION = 'FUNCTION_NOT_ALLOWED'
const TYPE = 'TYPE_NOT_ALLOWED'

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
    await refusedBoth(sql, CATALOG)
  })

  it('says where to go instead', async () => {
    const err = await admit('SELECT proname, prosrc FROM "pg_proc"')
    expect(err?.hint).toMatch(/read_backend_state|get_table_schema/)
    expect(err?.message).toMatch(/pg_proc/)
  })

  it('refuses before run_query opens a connection', async () => {
    // tests/unit has no database. Had the check not run first, this would fail
    // trying to connect, with some other error.
    await expect(runReadQuery(PROJECT, 'SELECT proname, prosrc FROM "pg_proc"')).rejects.toMatchObject({ code: CATALOG })
  })
})

describe('unicode-escaped names, which no pattern over the text can read', () => {
  it.each([
    ['a relation', 'SELECT proname, prosrc FROM U&"\\0070g_proc"', CATALOG],
    ['a relation with its own escape character', "SELECT nspname FROM U&\"!0070g_namespace\" UESCAPE '!'", CATALOG],
    ['a schema', 'SELECT * FROM U&"\\0069nformation_schema".columns', CATALOG],
    ['a schema and relation', 'SELECT * FROM U&"\\0070\\0067_catalog".U&"\\0070\\0067_proc"', CATALOG],
    ['a function', "SELECT U&\"\\0071uery_to_xml\"('select 1', true, false, '')", FUNCTION],
    ['a type', 'SELECT 16400::U&"\\0072egnamespace"', TYPE],
  ])('refuses %s', async (_label, sql, code) => {
    await refusedBoth(sql, code)
  })
})

describe('types: only the listed ones, so no OID alias turns an id into a name', () => {
  it.each([
    ['::regnamespace', 'SELECT 16400::regnamespace', TYPE],
    ['CAST AS regclass', 'SELECT CAST(16400 AS regclass)', TYPE],
    ['a typed literal', "SELECT regclass '16400'", TYPE],
    ['::regproc after ::oid', 'SELECT 16400::oid::regproc', TYPE],
    ['::oid', 'SELECT 16400::oid', TYPE],
    ['::oidvector', "SELECT '28030'::oidvector", TYPE],
    ['::regprocedure', 'SELECT 16400::regprocedure', TYPE],
    ['::regtype', 'SELECT 16400::regtype', TYPE],
    ['::regrole', 'SELECT 16400::regrole', TYPE],
    ['::regoper', 'SELECT 16400::regoper', TYPE],
    ['::regoperator', 'SELECT 16400::regoperator', TYPE],
    ['::regconfig', 'SELECT 16400::regconfig', TYPE],
    ['::regdictionary', 'SELECT 16400::regdictionary', TYPE],
    ['::regcollation', 'SELECT 16400::regcollation', TYPE],
    ['an array of them', "SELECT '{16400,16401}'::regnamespace[]", TYPE],
    ['the array type by name', "SELECT '{16400}'::_regclass", TYPE],
    ['qualified with pg_catalog', 'SELECT 16400::pg_catalog.regnamespace', TYPE],
    ['quoted', 'SELECT x::"regnamespace" FROM t', TYPE],
    ['a column definition list', "SELECT * FROM json_to_record('{\"a\":16400}') AS r(a regnamespace)", TYPE],
    [
      'an XMLTABLE column',
      "SELECT * FROM XMLTABLE('/r' PASSING xmlparse(document '<r><a>16400</a></r>') COLUMNS a regclass PATH 'a')",
      TYPE,
    ],
    ['a pg_ type', 'SELECT x::pg_lsn FROM t', TYPE],
    ['a catalog\'s row type', 'SELECT NULL::pg_proc', TYPE],
    ['aclitem', "SELECT 'x=r/y'::aclitem", TYPE],
    ['a type in this project\'s schema', `SELECT x::"${OWN}".mood FROM t`, TYPE],
    ['a type in public', 'SELECT x::public.citext FROM t', 'OUTSIDE_PROJECT_SCHEMA'],
  ])('refuses %s', async (_label, sql, code) => {
    await refusedBoth(sql, code)
  })

  it('names the refused type', async () => {
    expect((await admit('SELECT 16400::regnamespace'))?.message).toMatch(/regnamespace/)
  })
})

describe('functions: only the listed ones', () => {
  it.each([
    // OID alias casts written as calls, and their I/O functions.
    ['a function-style cast', 'SELECT regnamespace(16400::int)'],
    ['an output function', 'SELECT regnamespaceout(16400)'],
    // SQL given as text.
    ['query_to_xml', "SELECT query_to_xml('select nspname from pg_namespace', true, false, '')"],
    ['query_to_xmlschema', "SELECT query_to_xmlschema('select 1', true, false, '')"],
    ['query_to_xml_and_xmlschema', "SELECT query_to_xml_and_xmlschema('select 1', true, false, '')"],
    ['cursor_to_xml', "SELECT cursor_to_xml(c, 10, true, false, '') FROM t"],
    ['table_to_xml', "SELECT table_to_xml('x', true, false, '')"],
    ['schema_to_xml', "SELECT schema_to_xml('x', true, false, '')"],
    ['database_to_xml', "SELECT database_to_xml(true, false, '')"],
    ['in FROM', "SELECT * FROM query_to_xml('select 1', true, false, '') AS x"],
    ['ts_stat', "SELECT * FROM ts_stat('select to_tsvector(prosrc) from pg_proc')"],
    ['ts_rewrite', "SELECT ts_rewrite('a'::tsquery, 'select 1')"],
    ['dblink', "SELECT * FROM dblink('dbname=x', 'select 1') AS t(n text)"],
    ['crosstab', "SELECT * FROM crosstab('select 1') AS t(a int)"],
    // Comments, probes by name or id, and object ids made names.
    ['obj_description', "SELECT obj_description(16400, 'pg_namespace')"],
    ['col_description', 'SELECT col_description(16400, 1)'],
    ['shobj_description', "SELECT shobj_description(1, 'pg_database')"],
    ['to_regclass', "SELECT to_regclass('x')"],
    ['to_regnamespace', "SELECT to_regnamespace('x')"],
    ['has_table_privilege', "SELECT has_table_privilege('x', 'select')"],
    ['has_schema_privilege', "SELECT has_schema_privilege('x', 'usage')"],
    ['pg_has_role', "SELECT pg_has_role('x', 'member')"],
    ['row_security_active', 'SELECT row_security_active(16400)'],
    ['format_type', 'SELECT format_type(16400, NULL)'],
    ['oidvectortypes, which names any type by id', "SELECT oidvectortypes('28030')"],
    ['currval, whose error names any relation', 'SELECT currval(16400)'],
    ['nextval', "SELECT nextval('orders_id_seq')"],
    ['setval', "SELECT setval('orders_id_seq', 1)"],
    ['satisfies_hash_partition', 'SELECT satisfies_hash_partition(16400, 2, 0, 1)'],
    ['makeaclitem', "SELECT makeaclitem(10, 10, 'SELECT', false)"],
    ['acldefault', "SELECT acldefault('r', 10)"],
    ['enum_in', "SELECT enum_in('x', 16400)"],
    ['record_in', "SELECT record_in('()', 16400, -1)"],
    ['ts_debug', "SELECT * FROM ts_debug('english', 'x')"],
    ['brin_summarize_new_values', 'SELECT brin_summarize_new_values(16400)'],
    ['gin_clean_pending_list', 'SELECT gin_clean_pending_list(16400)'],
    ['fmgr_sql_validator', 'SELECT fmgr_sql_validator(16400)'],
    ['plpgsql_validator', 'SELECT plpgsql_validator(16400)'],
    [
      'get_current_ts_config, whose type a coalesce spreads to an id',
      'SELECT COALESCE(get_current_ts_config(), g) FROM generate_series(3748, 3752) g',
    ],
    // Settings and the server.
    ['set_config', "SELECT set_config('search_path', 'information_schema', true)"],
    ['current_setting', "SELECT current_setting('backenly.app_role')"],
    ['inet_server_addr', 'SELECT inet_server_addr()'],
    ['version', 'SELECT version()'],
    // Large objects and system functions.
    ['lo_get', 'SELECT lo_get(16400)'],
    ['lo_import', "SELECT lo_import('/etc/passwd')"],
    ['loread', 'SELECT loread(0, 100)'],
    ['pg_get_functiondef', 'SELECT pg_get_functiondef(16400)'],
    ['pg_read_file', "SELECT pg_read_file('postgresql.conf')"],
    ['pg_sleep', 'SELECT pg_sleep(10)'],
    // Allocators sized by their argument.
    ['repeat', "SELECT repeat('x', 1000000000)"],
    ['lpad', "SELECT lpad('x', 1000000000)"],
    ['rpad', "SELECT rpad('x', 1000000000)"],
    ['array_fill', 'SELECT array_fill(1, ARRAY[100000000])'],
    // A function in this project's schema, and TABLESAMPLE methods.
    ['a function in this project\'s schema', `SELECT "${OWN}".leak()`],
    ['a TABLESAMPLE method outside the two built in', 'SELECT * FROM t TABLESAMPLE system_rows(10)'],
  ])('refuses %s', async (_label, sql) => {
    await refusedBoth(sql, FUNCTION)
  })

  it('names the refused function', async () => {
    const err = await admit("SELECT oidvectortypes('28030')")
    expect(err).toMatchObject({ code: FUNCTION })
    expect(err?.message).toMatch(/oidvectortypes\(\)/)
  })
})

/**
 * Found by review after the first version, which refused dangerous functions
 * only when they were called with parentheses. PostgreSQL reads `q.b` as b(q)
 * when the FROM item q has no column b, and a function in FROM hands that call
 * its scalar value: these listed every project's schema and read other
 * projects' function source through ts_stat.
 */
describe('column notation: a call when the FROM item has no such column', () => {
  it.each([
    ['g.regnamespace over a series of ids', 'SELECT g.regnamespace AS n FROM generate_series(16384, 20000) g'],
    ['g.regclass', 'SELECT g.regclass FROM generate_series(16384, 16390) g'],
    ['g.regprocedure', 'SELECT g.regprocedure FROM generate_series(16384, 16390) g'],
    ['g.regrole', 'SELECT g.regrole FROM generate_series(10, 20000) g'],
    [
      't.ts_stat, which ran SQL given as text',
      "SELECT t.ts_stat FROM unnest(ARRAY['SELECT array_to_tsvector(ARRAY[prosrc]) FROM pg_proc']) t",
    ],
    [
      't.ts_stat over a listed scalar function',
      "SELECT t.ts_stat FROM concat('select array_to_tsvector(array[nspname::text]) from pg_namespace') t",
    ],
    ['g.obj_description', 'SELECT g.obj_description AS c FROM generate_series(16384, 16390) g'],
    ['g.currval', 'SELECT g.currval FROM generate_series(16384, 16384) g'],
    ['t.to_regclass', "SELECT t.to_regclass FROM unnest(ARRAY['x.y']) t"],
    ['g.regclassout', 'SELECT g.regclassout FROM generate_series(16384, 16384) g'],
    ['g.brin_summarize_new_values', 'SELECT g.brin_summarize_new_values FROM generate_series(16384, 16384) g'],
    ['g.fmgr_sql_validator', 'SELECT g.fmgr_sql_validator FROM generate_series(16384, 16384) g'],
    ['g.plpgsql_validator', 'SELECT g.plpgsql_validator FROM generate_series(16384, 16384) g'],
    ['g.lo_get', 'SELECT g.lo_get FROM generate_series(16384, 16384) g'],
    ['g.oidvectortypes', "SELECT g.oidvectortypes FROM unnest(ARRAY['28030']) g"],
    ['a ROWS FROM alias', 'SELECT g.regclass FROM ROWS FROM (generate_series(16384, 16390)) AS g(x)'],
    ['a LATERAL function', 'SELECT x.regnamespace FROM notes, LATERAL unnest(ARRAY[16384]) x'],
    ['a function with no alias', 'SELECT generate_series.regclass FROM generate_series(16384, 16390)'],
    ['an inner function shadowing an outer table', 'SELECT (SELECT g.regclass FROM generate_series(16384, 16384) g) FROM orders g'],
    [
      'an inner function shadowing an outer function that declares the column',
      'SELECT (SELECT g.regclass FROM generate_series(16384, 16390) g) FROM generate_series(1, 2) AS g(regclass)',
    ],
    [
      'a function in FROM this check cannot name',
      'SELECT (SELECT int4.regnamespace FROM CAST(16384 AS int4)) FROM orders int4',
    ],
    ['a qualifier that names nothing in FROM', 'SELECT nothing.regclass FROM orders'],
    ['field selection on a value', 'SELECT (16400).regclass'],
    ['field selection calling obj_description', 'SELECT (16400::int).obj_description'],
    ['field selection calling ts_stat', "SELECT ('select 1'::text).ts_stat"],
    ['field selection on a whole row', "SELECT (t).ts_stat FROM unnest(ARRAY['x']) t"],
  ])('refuses %s', async (_label, sql) => {
    await refusedBoth(sql, FUNCTION)
  })

  it('names the function and the column it is not', async () => {
    const err = await admit('SELECT g.regnamespace FROM generate_series(16384, 16390) g')
    expect(err?.message).toMatch(/regnamespace\(\)/)
    expect(err?.message).toMatch(/g\.regnamespace/)
  })
})

describe('schemas other than the project\'s own', () => {
  it.each([
    ['the platform\'s public schema', 'SELECT * FROM public.users'],
    ['another project', `SELECT body FROM "${OTHER}".secrets`],
    ['a database-qualified name', 'SELECT * FROM otherdb.public.users'],
    ['another project beside this one', `SELECT * FROM "${OWN}".orders o JOIN "${OTHER}".orders x ON true`],
    ['a function in public', 'SELECT public.similarity(a, b) FROM t'],
    ['a function in another project', `SELECT "${OTHER}".fn()`],
    ['an operator in public', 'SELECT a OPERATOR(public.<->) b FROM t'],
    ['an ORDER BY operator in public', 'SELECT a FROM t ORDER BY a USING OPERATOR(public.<)'],
    ['a subquery operator in public', 'SELECT a OPERATOR(public.=) ANY (SELECT b FROM u) FROM t'],
    ['a collation in public', 'SELECT a COLLATE public."x" FROM t'],
    ['a TABLESAMPLE method in public', 'SELECT * FROM t TABLESAMPLE public.system_rows(10)'],
  ])('refuses %s', async (_label, sql) => {
    await refusedBoth(sql, 'OUTSIDE_PROJECT_SCHEMA')
  })

  it('refuses a catalog schema as a catalog, whatever it qualifies', async () => {
    await refusedBoth('SELECT information_schema._pg_truetypid(a, t) FROM x', CATALOG)
    await refusedBoth('SELECT * FROM pg_toast.pg_toast_16400', CATALOG)
  })

  it('tells the caller to leave names unqualified', async () => {
    const err = await admit('SELECT * FROM public.users')
    expect(err?.hint).toMatch(/unqualified/)
    expect(err?.message).toMatch(/public/)
  })
})

describe('SHOW: only listed settings', () => {
  it.each([
    ['SHOW ALL', 'SHOW ALL'],
    ['a platform setting', 'SHOW "backenly.app_role"'],
    ['a server setting', 'SHOW work_mem'],
    ['a file location', 'SHOW data_directory'],
  ])('refuses %s', async (_label, sql) => {
    await refusedBoth(sql, 'SETTING_NOT_ALLOWED')
  })

  it.each([['SHOW search_path'], ['SHOW TimeZone'], ['SHOW TIME ZONE'], ['SHOW "DateStyle"'], ['SHOW server_version']])(
    'admits %s',
    async (sql) => {
      expect(await admit(sql)).toBeNull()
    },
  )
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

describe('what the statement is comes from its parse tree', () => {
  it.each([
    [
      'a SELECT behind a nested comment that once read as SHOW',
      '/* /* */ show */ SELECT g FROM generate_series(1, 3000000) g',
      'select',
    ],
    ['VALUES', "VALUES (1, 'a')", 'select'],
    ['TABLE', 'TABLE orders', 'select'],
    ['EXPLAIN', 'EXPLAIN SELECT * FROM orders', 'explain'],
    ['SHOW', 'SHOW search_path', 'show'],
  ])('%s', async (_label, sql, kind) => {
    expect(await checkReadQuery(sql, OWN)).toEqual({ refusal: null, kind })
    expect(await admitReadQuery(sql, PROJECT)).toBe(kind)
  })
})

describe('reads that must keep working', () => {
  it.each([
    ['a plain select', 'SELECT * FROM posts'],
    ['a join', 'SELECT p.title, u.email FROM posts p JOIN users u ON u.id = p.author_id'],
    [
      'columns of a table named like functions that are not listed',
      'SELECT f.path, f.version, f.host, f.width, f.height, f.point, f.name FROM files f',
    ],
    ['schema-qualified columns of the project\'s own table', `SELECT "${OWN}".orders.id FROM "${OWN}".orders`],
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
    [
      'a share of the total, ranked',
      'SELECT status, count(*), round(100.0 * count(*) / sum(count(*)) OVER (), 1) AS pct, ' +
        'rank() OVER (ORDER BY count(*) DESC) FROM orders GROUP BY status',
    ],
    ['an ordered-set aggregate', 'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) FROM orders'],
    [
      'mode and percentile_disc',
      'SELECT mode() WITHIN GROUP (ORDER BY status), percentile_disc(0.9) WITHIN GROUP (ORDER BY amount) FROM orders',
    ],
    [
      'monthly revenue',
      "SELECT date_trunc('month', \"createdAt\") AS month, sum(amount) AS revenue, count(DISTINCT customer_id) " +
        "FROM orders WHERE \"createdAt\" >= now() - interval '1 year' GROUP BY 1 ORDER BY 1",
    ],
    [
      'a calendar of days, joined to the data',
      "SELECT d.day::date, coalesce(count(o.id), 0) FROM generate_series('2026-01-01'::date, '2026-01-31'::date, " +
        "interval '1 day') AS d(day) LEFT JOIN orders o ON o.\"createdAt\"::date = d.day::date GROUP BY 1 ORDER BY 1",
    ],
    ['the series column by the alias alone', 'SELECT g.g FROM generate_series(1, 3) g'],
    ['a column the alias declares, even one named like a function', 'SELECT g.regclass FROM generate_series(1, 3) AS g(regclass)'],
    ['a function with no alias, by its own name', 'SELECT generate_series.generate_series FROM generate_series(1, 3)'],
    [
      'JSON operators',
      "SELECT data->>'name' AS name, data #>> '{address,city}' AS city FROM profiles " +
        "WHERE data @> '{\"active\": true}'::jsonb AND data ? 'email'",
    ],
    ['a LATERAL JSON function', "SELECT e.value->>'sku' AS sku FROM orders o, LATERAL jsonb_array_elements(o.items) AS e(value)"],
    ['jsonb_each, its key and value', 'SELECT p.id, e.key, e.value FROM profiles p, jsonb_each(p.data) e'],
    ['jsonb_array_elements without column names', 'SELECT e.value FROM orders o, jsonb_array_elements(o.items) e'],
    ['WITH ORDINALITY', "SELECT u.ordinality, u.u FROM unnest(ARRAY['a', 'b']) WITH ORDINALITY u"],
    ['unnest with a column name', 'SELECT t.x FROM unnest(ARRAY[1, 2]) AS t(x)'],
    ['a column definition list', "SELECT r.a, r.b FROM jsonb_to_record('{\"a\":1,\"b\":\"x\"}') AS r(a int, b text)"],
    ['a field of a JSON record', 'SELECT (jsonb_each(data)).key FROM profiles'],
    [
      'JSON builders',
      "SELECT jsonb_build_object('id', id, 'tags', to_jsonb(tags)), jsonb_agg(title) FROM posts GROUP BY id, tags",
    ],
    ['json_agg of a row', 'SELECT json_agg(t) FROM (SELECT id, title FROM posts) t'],
    [
      'casts to ordinary types',
      "SELECT id::text, price::numeric(10,2), \"createdAt\"::date, CAST(qty AS bigint), '7 days'::interval, " +
        "'2026-01-01'::timestamptz, ARRAY['a', 'b']::text[], external_id::uuid, payload::jsonb, flag::boolean, " +
        "1.5::double precision, 'x'::varchar(10), 'x'::char(1), 3::smallint, 2.5::real, 'x'::bytea, " +
        "'12:00'::time, '12:00+00'::timetz, '2026-01-01 00:00'::timestamp, '{}'::json FROM items",
    ],
    ['casts written as calls', 'SELECT date("createdAt"), text(id), int4(qty), float8(price) FROM orders'],
    [
      'grammar that names pg_catalog itself',
      "SELECT EXTRACT(year FROM \"createdAt\") AS y, date_trunc('month', \"createdAt\") AS m, " +
        "\"createdAt\" AT TIME ZONE 'UTC' AS utc, (\"createdAt\", \"updatedAt\") OVERLAPS (now(), now()) FROM orders",
    ],
    [
      'string functions and conditionals',
      "SELECT substring(name from 1 for 3), trim(both ' ' from name), position('a' in name), " +
        "overlay(name placing 'x' from 1 for 1), name similar to 'a%', name ILIKE '%x%', name LIKE 'a!%' ESCAPE '!', " +
        "coalesce(nickname, name), nullif(a, b), greatest(a, b), CASE WHEN a > 1 THEN 'big' ELSE 'small' END FROM people",
    ],
    [
      'more string work',
      "SELECT lower(email), upper(name), initcap(name), length(name), replace(phone, '-', ''), " +
        "regexp_replace(name, '\\s+', ' ', 'g'), split_part(email, '@', 2), concat(first, ' ', last), " +
        "concat_ws(', ', city, country), left(name, 1), right(name, 2), md5(email), to_char(\"createdAt\", 'YYYY-MM'), " +
        "string_to_array(tags_csv, ','), array_to_string(tags, ', '), format('%s (%s)', name, id) FROM people",
    ],
    [
      'math',
      'SELECT round(avg(amount), 2), abs(min(amount)), ceil(max(amount)), floor(sum(amount) / 3), ' +
        'stddev(amount), width_bucket(amount, 0, 1000, 10), power(2, 3), sqrt(16), mod(7, 3) FROM orders',
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
    ['TABLESAMPLE BERNOULLI', 'SELECT * FROM orders TABLESAMPLE BERNOULLI (5)'],
    [
      'DISTINCT ON, NULLS LAST, LIMIT and OFFSET',
      'SELECT DISTINCT ON (customer_id) * FROM orders ORDER BY customer_id, "createdAt" DESC NULLS LAST LIMIT 10 OFFSET 5',
    ],
    ['FETCH FIRST', 'SELECT * FROM orders ORDER BY id FETCH FIRST 5 ROWS ONLY'],
    ['VALUES', "VALUES (1, 'a'), (2, 'b')"],
    ['TABLE', 'TABLE orders'],
    ['EXPLAIN', 'EXPLAIN SELECT * FROM posts WHERE id = 1'],
    ['EXPLAIN with options', 'EXPLAIN (FORMAT JSON, VERBOSE) SELECT * FROM posts'],
    ['a parameter', 'SELECT * FROM orders WHERE status = $1'],
    [
      'full-text search with a configuration given by name',
      "SELECT id, ts_rank(to_tsvector('english', body), plainto_tsquery('english', 'hello')) FROM posts " +
        "WHERE to_tsvector('english', body) @@ websearch_to_tsquery('english', 'hello world')",
    ],
    ['full-text search with a tsquery literal', "SELECT id FROM posts WHERE search_vector @@ 'cat & dog'::tsquery"],
    ['ordered aggregates', "SELECT string_agg(name, ', ' ORDER BY name), array_agg(DISTINCT tag) FROM tags"],
    ['arrays', 'SELECT cardinality(tags), array_length(tags, 1), array_position(tags, $1), unnest(tags) FROM posts'],
    ['a uuid', 'SELECT gen_random_uuid()'],
    ['ranges', "SELECT daterange(start_date, end_date) @> '2026-01-15'::date FROM bookings"],
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
