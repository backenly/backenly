/**
 * THE CATALOGS ARE THE ONE THING THE STATEMENT ITSELF MUST REFUSE
 * ================================================================
 * For table data, run_query's boundary is PostgreSQL's: the project's bkn_ro_
 * role has no grant on another project's schema (sql-workspace-isolation.test.ts
 * proves that). The system catalogs are different. They are readable by PUBLIC
 * and describe every project in the database, so the role itself can read
 * another project's function source, schema name and table names, and the only
 * thing between run_query and that read is the check on the statement
 * (lib/mcp/read-query-ast.ts).
 *
 * So each route here is run twice: directly as the project's bkn_ro_ role, with
 * nothing in front, to prove it really reaches the other project, and then
 * through runReadQuery, which must refuse it before PostgreSQL sees it. A
 * refusal of something the role could not read anyway would prove nothing.
 *
 * Analytics reads of the project's own tables are here too, so the refusals
 * cannot pass because nothing works.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { execFileSync } from 'child_process'
import { Client } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { capped, readOnlyConnection, runReadQuery } from '@/lib/mcp/read-query'
import { readOnlyLogin } from '@/lib/services/direct-access'
import { projectDatabaseUrl } from '@/lib/data-plane/regional'

/** In the other project's function source, so a leak of it is unmistakable. */
const MARKER = 'other-project-function-source-2j8x'
/** The other project's table comment. */
const COMMENT = 'other-project-table-comment-2j8x'

let userId: string
let projectId: string
let otherProjectId: string
let schema: string
let otherSchema: string
/** The other project's schema, its table, the table's row type, its function and its read-only role, by object id. */
let otherSchemaOid: number
let otherTableOid: number
let otherRowTypeOid: number
let otherFunctionOid: number
let otherRole: string
let otherRoleOid: number

const raw = (sql: string) => prisma.$executeRawUnsafe(sql)
const oidOf = async (sql: string, ...args: unknown[]) =>
  (await prisma.$queryRawUnsafe<Array<{ oid: number }>>(sql, ...args))[0].oid

beforeAll(async () => {
  // The SECURITY DEFINER helpers that provision the per-project bkn_ro_ role
  // (see sql-workspace-isolation.test.ts for why options come first).
  execFileSync(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-q', '-f', 'scripts/setup-direct-access.sql', '-d', process.env.TEST_DATABASE_URL!],
    { stdio: 'pipe' },
  )

  const user = await prisma.user.create({
    data: { email: `rq-catalog-${Date.now()}@example.test`, password: 'x', name: 'run_query catalog guard' },
  })
  userId = user.id
  projectId = (await prisma.project.create({ data: { name: 'run-query-catalog-guard', userId } })).id
  otherProjectId = (await prisma.project.create({ data: { name: 'run-query-catalog-victim', userId } })).id
  schema = `workspace_${projectId}`
  otherSchema = `workspace_${otherProjectId}`

  await raw(`CREATE SCHEMA "${schema}"`)
  await raw(`CREATE TABLE "${schema}"."notes" (id serial primary key, body text, amount numeric, "createdAt" timestamptz)`)
  await raw(
    `INSERT INTO "${schema}"."notes"(body, amount, "createdAt") VALUES ` +
      `('mine one', 10, '2026-01-05'), ('mine two', 30, '2026-02-07')`,
  )
  await raw(`CREATE TABLE "${schema}"."Mixed Case Notes" ("Body" text)`)
  await raw(`INSERT INTO "${schema}"."Mixed Case Notes"("Body") VALUES ('beta'), ('alpha')`)

  // Another project with a table and a function worth stealing.
  await raw(`CREATE SCHEMA "${otherSchema}"`)
  await raw(`CREATE TABLE "${otherSchema}".customer_ledger (id serial primary key, note text)`)
  await raw(
    `CREATE FUNCTION "${otherSchema}".pricing_rule() RETURNS text LANGUAGE sql AS $fn$ SELECT '${MARKER}'::text $fn$`,
  )
  otherSchemaOid = await oidOf('SELECT oid::int AS oid FROM pg_namespace WHERE nspname = $1', otherSchema)
  otherTableOid = await oidOf(
    `SELECT oid::int AS oid FROM pg_class WHERE relname = 'customer_ledger' AND relnamespace = $1::int::oid`,
    otherSchemaOid,
  )
  otherRowTypeOid = await oidOf('SELECT reltype::int AS oid FROM pg_class WHERE oid = $1::int::oid', otherTableOid)
  await raw(`COMMENT ON TABLE "${otherSchema}".customer_ledger IS '${COMMENT}'`)
  otherFunctionOid = await oidOf(
    `SELECT oid::int AS oid FROM pg_proc WHERE proname = 'pricing_rule' AND pronamespace = $1::int::oid`,
    otherSchemaOid,
  )
  otherRole = (await readOnlyLogin(otherProjectId)).roleName
  otherRoleOid = await oidOf('SELECT oid::int AS oid FROM pg_roles WHERE rolname = $1', otherRole)
}, 180_000)

afterAll(async () => {
  await raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await raw(`DROP SCHEMA IF EXISTS "${otherSchema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
}, 60_000)

/** A login as the project's bkn_ro_ role: what run_query runs as, with no check in front. */
async function asReadOnlyRole<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const cred = await readOnlyLogin(projectId)
  const client = new Client(readOnlyConnection(await projectDatabaseUrl(projectId), cred))
  client.on('error', () => {})
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

/** Everything the role gets back for a statement: its rows, or its error's text, which names objects too. */
async function directly(sql: string): Promise<string> {
  return asReadOnlyRole((c) =>
    c.query(sql).then(
      (r) => JSON.stringify(r.rows),
      (e: Error) => `ERROR ${e.message}`,
    ),
  )
}

/** directly, with search_path set to the project's schema, as run_query sets it. */
async function inOwnSchema(sql: string): Promise<string> {
  return asReadOnlyRole(async (c) => {
    await c.query(`SET search_path TO "${schema}"`)
    return c.query(sql).then(
      (r) => JSON.stringify(r.rows),
      (e: Error) => `ERROR ${e.message}`,
    )
  })
}

/** [what, the statement, the code run_query refuses it with, what the role reads that names the other project] */
const ROUTES: Array<[string, () => string, string, () => string]> = [
  ['the reported query: a double-quoted pg_proc', () => 'SELECT proname, prosrc FROM "pg_proc"', 'CATALOG_NOT_READABLE', () => MARKER],
  ['a double-quoted pg_namespace', () => 'SELECT nspname FROM "pg_namespace"', 'CATALOG_NOT_READABLE', () => otherSchema],
  ['both names quoted', () => 'SELECT prosrc FROM "pg_catalog"."pg_proc"', 'CATALOG_NOT_READABLE', () => MARKER],
  ['a unicode-escaped name', () => 'SELECT prosrc FROM U&"\\0070g_proc"', 'CATALOG_NOT_READABLE', () => MARKER],
  ['an object id cast to its name', () => `SELECT ${otherSchemaOid}::regnamespace::text AS name`, 'TYPE_NOT_ALLOWED', () => otherSchema],
  [
    'a query passed as text',
    () => "SELECT query_to_xml('select nspname from pg_namespace', true, false, '') AS x",
    'FUNCTION_NOT_ALLOWED',
    () => otherSchema,
  ],
  ['a probe by name', () => `SELECT to_regnamespace('"${otherSchema}"')::text AS found`, 'FUNCTION_NOT_ALLOWED', () => otherSchema],
  // Found by review: column notation calls a function on a FROM function's scalar.
  [
    'column notation: g.regnamespace over the schema ids',
    () => `SELECT g.regnamespace AS n FROM generate_series(${otherSchemaOid}, ${otherSchemaOid}) g`,
    'FUNCTION_NOT_ALLOWED',
    () => otherSchema,
  ],
  [
    'column notation: g.regclass',
    () => `SELECT g.regclass AS r FROM generate_series(${otherTableOid}, ${otherTableOid}) g`,
    'FUNCTION_NOT_ALLOWED',
    () => 'customer_ledger',
  ],
  [
    'column notation: t.ts_stat, which runs SQL given as text',
    () =>
      "SELECT t.ts_stat FROM unnest(ARRAY['SELECT array_to_tsvector(ARRAY[prosrc]) FROM pg_proc WHERE prosrc LIKE ''%2j8x%''']) t",
    'FUNCTION_NOT_ALLOWED',
    () => MARKER,
  ],
  [
    'column notation: g.currval, whose error names any relation',
    () => `SELECT g.currval FROM generate_series(${otherTableOid}, ${otherTableOid}) g`,
    'FUNCTION_NOT_ALLOWED',
    () => 'customer_ledger',
  ],
  // Found by review: a built-in the deny list did not name.
  ['oidvectortypes, which names any type by id', () => `SELECT oidvectortypes('${otherRowTypeOid}') AS t`, 'FUNCTION_NOT_ALLOWED', () => 'customer_ledger'],
  // Found by the audit: an alias with a column list is not a column, and a
  // function with an OUT parameter names its own column.
  [
    'an alias with a column list: regnamespace.regnamespace',
    () => `SELECT regnamespace.regnamespace::text AS n FROM generate_series(${otherSchemaOid}, ${otherSchemaOid}) AS regnamespace(x)`,
    'FUNCTION_NOT_ALLOWED',
    () => otherSchema,
  ],
  [
    'regclass the same way',
    () => `SELECT regclass.regclass::text AS r FROM generate_series(${otherTableOid}, ${otherTableOid}) AS regclass(x)`,
    'FUNCTION_NOT_ALLOWED',
    () => 'customer_ledger',
  ],
  [
    'regprocedure the same way',
    () => `SELECT regprocedure.regprocedure::text AS p FROM generate_series(${otherFunctionOid}, ${otherFunctionOid}) AS regprocedure(x)`,
    'FUNCTION_NOT_ALLOWED',
    () => 'pricing_rule',
  ],
  [
    'obj_description the same way',
    () => `SELECT obj_description.obj_description AS c FROM generate_series(${otherTableOid}, ${otherTableOid}) AS obj_description(x)`,
    'FUNCTION_NOT_ALLOWED',
    () => COMMENT,
  ],
  [
    'regrole the same way, naming another project\'s role',
    () => `SELECT regrole.regrole::text AS r FROM generate_series(${otherRoleOid}, ${otherRoleOid}) AS regrole(x)`,
    'FUNCTION_NOT_ALLOWED',
    () => otherRole,
  ],
  [
    'ts_stat on json_array_elements_text, whose column is value whatever the alias',
    () =>
      "SELECT ts_stat.ts_stat::text AS w FROM json_array_elements_text('[\"SELECT array_to_tsvector(ARRAY[prosrc]) " +
      "FROM pg_proc WHERE prosrc LIKE ''%source-2j8x%''\"]') AS ts_stat",
    'FUNCTION_NOT_ALLOWED',
    () => MARKER,
  ],
  [
    'current_setting the same way',
    () => "SELECT current_setting.current_setting AS v FROM json_array_elements_text('[\"block_size\"]') AS current_setting",
    'FUNCTION_NOT_ALLOWED',
    () => '8192',
  ],
  [
    'CAST in FROM',
    () => `SELECT regnamespace.regnamespace::text AS n FROM CAST(${otherSchemaOid} AS int4) AS regnamespace(x)`,
    'FUNCTION_NOT_ALLOWED',
    () => otherSchema,
  ],
  [
    'ROWS FROM',
    () => `SELECT regclass.regclass::text AS r FROM ROWS FROM (generate_series(${otherTableOid}, ${otherTableOid})) AS regclass(x)`,
    'FUNCTION_NOT_ALLOWED',
    () => 'customer_ledger',
  ],
]

describe('every route to another project\'s catalog entries', () => {
  test.each(ROUTES)('%s: the role reads it, and run_query refuses it', async (_label, sql, code, leaked) => {
    expect(await directly(sql())).toContain(leaked())
    await expect(runReadQuery(projectId, sql(), 10)).rejects.toMatchObject({ code })
  }, 60_000)

  test('SHOW ALL and current_setting are refused', async () => {
    await expect(runReadQuery(projectId, 'SHOW ALL', 10)).rejects.toMatchObject({ code: 'SETTING_NOT_ALLOWED' })
    await expect(runReadQuery(projectId, "SELECT current_setting('server_version')", 10)).rejects.toMatchObject({
      code: 'FUNCTION_NOT_ALLOWED',
    })
    await expect(runReadQuery(projectId, 'SELECT inet_server_addr()', 10)).rejects.toMatchObject({
      code: 'FUNCTION_NOT_ALLOWED',
    })
  }, 60_000)
})

describe('reading this project still works', () => {
  test('quoted mixed-case identifiers', async () => {
    const r = await runReadQuery(projectId, 'SELECT "Body" FROM "Mixed Case Notes" ORDER BY "Body"', 10)
    expect(r.rows.map((x) => x.Body)).toEqual(['alpha', 'beta'])
  }, 60_000)

  test('the project\'s own schema, qualified', async () => {
    const r = await runReadQuery(projectId, `SELECT n.body FROM "${schema}".notes n ORDER BY n.id`, 10)
    expect(r.rows.map((x) => x.body)).toEqual(['mine one', 'mine two'])
  }, 60_000)

  test('a CTE, a window function and an aggregate', async () => {
    const r = await runReadQuery(
      projectId,
      'WITH x AS (SELECT body, row_number() OVER (ORDER BY id) AS rn FROM notes) SELECT count(*) AS n, max(rn) AS top FROM x',
      10,
    )
    expect(Number(r.rows[0].n)).toBe(2)
    expect(Number(r.rows[0].top)).toBe(2)
  }, 60_000)

  test('JSON operators and casts to ordinary types', async () => {
    const r = await runReadQuery(
      projectId,
      "SELECT jsonb_build_object('b', body)->>'b' AS b, id::text AS t, (id * 1.5)::numeric(10,2) AS x FROM notes ORDER BY id",
      10,
    )
    expect(r.rows.map((x) => x.b)).toEqual(['mine one', 'mine two'])
    expect(r.rows.map((x) => x.t)).toEqual(['1', '2'])
    expect(r.rows.map((x) => x.x)).toEqual(['1.50', '3.00'])
  }, 60_000)

  test('monthly totals over a calendar from generate_series', async () => {
    const r = await runReadQuery(
      projectId,
      "SELECT to_char(m.month, 'YYYY-MM') AS month, coalesce(sum(n.amount), 0) AS total " +
        "FROM generate_series('2026-01-01'::date, '2026-03-01'::date, interval '1 month') AS m(month) " +
        "LEFT JOIN notes n ON date_trunc('month', n.\"createdAt\") = m.month GROUP BY 1 ORDER BY 1",
      10,
    )
    expect(r.rows.map((x) => [x.month, Number(x.total)])).toEqual([
      ['2026-01', 10],
      ['2026-02', 30],
      ['2026-03', 0],
    ])
  }, 60_000)

  test('JSON functions in FROM, read by their columns', async () => {
    const r = await runReadQuery(
      projectId,
      "SELECT e.key, e.value FROM jsonb_each('{\"a\": 1, \"b\": 2}'::jsonb) e ORDER BY e.key",
      10,
    )
    expect(r.rows.map((x) => x.key)).toEqual(['a', 'b'])
  }, 60_000)

  test('a column the alias declares is read as that column, even one named like a function', async () => {
    // The declared column wins over column notation, so this is the integer,
    // never regclass(g): the exception checkColumnRef makes is a real column.
    const r = await runReadQuery(
      projectId,
      `SELECT g.regclass AS v FROM generate_series(${otherTableOid}, ${otherTableOid}) AS g(regclass)`,
      10,
    )
    expect(r.rows.map((x) => Number(x.v))).toEqual([otherTableOid])
  }, 60_000)

  test('SHOW of a listed setting', async () => {
    const r = await runReadQuery(projectId, 'SHOW search_path', 10)
    expect(JSON.stringify(r.rows)).toContain(schema)
  }, 60_000)
})

/**
 * The row cap wraps every SELECT. Whether to wrap was once decided from the
 * statement's text, and `/* /* *\/ show *\/ SELECT ...` (one nested comment, then a
 * SELECT) read as SHOW, so it ran unwrapped and materialised every row.
 */
describe('the row cap holds for every SELECT', () => {
  test('a SELECT behind a nested comment is capped', async () => {
    const r = await runReadQuery(projectId, '/* /* */ show */ SELECT g FROM generate_series(1, 5000) g', 10)
    expect(r.rowCount).toBe(10)
    expect(r.truncated).toBe(true)
  }, 60_000)
})

/**
 * The parser reads a statement with standard_conforming_strings on, where a
 * backslash in '...' is an ordinary character. With it off, the server ends
 * that literal later, so text the check saw inside two string literals becomes
 * SQL. Here the role is given standard_conforming_strings = off, as any role or
 * database could be, and the payload is sent both ways.
 */
describe('the statement runs as it was checked', () => {
  const PAYLOAD = "SELECT 'x\\' || ' AS c, (SELECT count(*) FROM pg_proc) AS leak --'"

  test('a role with standard_conforming_strings off reads the payload as SQL, and run_query does not', async () => {
    const { roleName } = await readOnlyLogin(projectId)
    await raw(`ALTER ROLE "${roleName}" SET standard_conforming_strings = off`)
    try {
      // Directly, exactly as run_query would send it: the subquery on pg_proc runs.
      const direct = await asReadOnlyRole((c) => c.query(capped(PAYLOAD, 10, 'select')))
      expect(direct.fields.map((f) => f.name)).toContain('leak')

      // Through run_query, which pins standard_conforming_strings on: two
      // string literals, concatenated, exactly what the check read.
      const r = await runReadQuery(projectId, PAYLOAD, 10)
      expect(r.fields.map((f) => f.name)).not.toContain('leak')
      expect(r.rows).toHaveLength(1)
      expect(Object.values(r.rows[0])).toEqual(['x\\ AS c, (SELECT count(*) FROM pg_proc) AS leak --'])
    } finally {
      await raw(`ALTER ROLE "${roleName}" RESET standard_conforming_strings`)
    }
  }, 60_000)
})

/** The rest of the audit of the allowlist version, each shown working on the role first. */
describe('what the role reads beyond the catalogs', () => {
  test('a built-in called on a table\'s whole row', async () => {
    const sql = `SELECT "${schema}".notes.hash_record AS h FROM "${schema}".notes`
    expect(await directly(sql)).toMatch(/"h":-?\d+/)
    await expect(runReadQuery(projectId, sql, 10)).rejects.toMatchObject({ code: 'FUNCTION_NOT_ALLOWED' })
  }, 60_000)

  test('system columns: age(xmin) is the cluster\'s transaction counter', async () => {
    const sql = 'SELECT age(xmin) AS a FROM notes'
    expect(await inOwnSchema(sql)).toMatch(/"a":\d+/)
    await expect(runReadQuery(projectId, sql, 10)).rejects.toMatchObject({ code: 'CATALOG_NOT_READABLE' })
  }, 60_000)

  test('a text search configuration named in a schema tells another project\'s schema apart', async () => {
    const other = `SELECT to_tsvector('"${otherSchema}".english', 'a')`
    const missing = `SELECT to_tsvector('"workspace_00000000-0000-0000-0000-000000000000".english', 'a')`
    const byId = `SELECT to_tsvector(${otherTableOid}, 'a')`
    expect(await directly(other)).toMatch(/permission denied for schema/)
    expect(await directly(missing)).toMatch(/does not exist/)
    expect(await directly(byId)).toMatch(/cache lookup failed/)
    for (const sql of [other, missing, byId]) {
      await expect(runReadQuery(projectId, sql, 10)).rejects.toMatchObject({ code: 'TYPE_NOT_ALLOWED' })
    }
  }, 60_000)

  test('EXPLAIN (SETTINGS) and SHOW server_version are refused', async () => {
    await expect(runReadQuery(projectId, 'EXPLAIN (SETTINGS) SELECT 1', 10)).rejects.toMatchObject({
      code: 'EXPLAIN_OPTION_NOT_ALLOWED',
    })
    await expect(runReadQuery(projectId, 'SHOW server_version', 10)).rejects.toMatchObject({ code: 'SETTING_NOT_ALLOWED' })
    const r = await runReadQuery(projectId, 'EXPLAIN (FORMAT JSON) SELECT * FROM notes', 10)
    expect(JSON.stringify(r.rows)).toContain('Seq Scan')
  }, 60_000)
})

describe('what one statement may cost', () => {
  test('XML is refused: libxml2 does not stop for the statement timeout', async () => {
    const sql = "SELECT * FROM XMLTABLE('/r' PASSING XMLPARSE(DOCUMENT '<r><a/></r>') COLUMNS c float8 PATH 'count(//a)')"
    expect(await directly(sql)).toContain('"c":1')
    await expect(runReadQuery(projectId, sql, 10)).rejects.toMatchObject({ code: 'FUNCTION_NOT_ALLOWED' })
  }, 60_000)

  test('a format width and a char(n) are bounded', async () => {
    for (const [sql, length] of [
      ["SELECT length(format('%2000s', '')) AS n", 2000],
      ["SELECT octet_length(''::char(20000)) AS n", 20000],
    ] as Array<[string, number]>) {
      expect(await directly(sql)).toContain(`"n":${length}`)
      await expect(runReadQuery(projectId, sql, 10)).rejects.toMatchObject({ code: 'QUERY_TOO_EXPENSIVE' })
    }
  }, 60_000)

  test('generate_series in FROM is bounded; in the select list the row cap holds', async () => {
    await expect(runReadQuery(projectId, 'SELECT g FROM generate_series(1, 2000000000) g', 10)).rejects.toMatchObject({
      code: 'QUERY_TOO_EXPENSIVE',
    })
    const r = await runReadQuery(projectId, 'SELECT generate_series(1, 2000000000) AS g', 10)
    expect(r.rowCount).toBe(10)
    expect(r.truncated).toBe(true)
  }, 60_000)

  test('running past temp_file_limit is the statement\'s, not a lost connection', async () => {
    const { roleName } = await readOnlyLogin(projectId)
    await raw(`ALTER ROLE "${roleName}" SET temp_file_limit = '1MB'`)
    try {
      // Sorting 300000 values for DISTINCT spills past work_mem to temporary files.
      const sql = 'SELECT count(DISTINCT h) AS n FROM (SELECT md5(generate_series(1, 300000)::text) AS h) s'
      await expect(runReadQuery(projectId, sql, 10)).rejects.toMatchObject({ code: 'QUERY_TOO_EXPENSIVE', status: 400 })
    } finally {
      await raw(`ALTER ROLE "${roleName}" RESET temp_file_limit`)
    }
  }, 60_000)
})

describe('reads agents rely on that stay', () => {
  test('ranges, range_agg, inet, padding and a built-in configuration', async () => {
    const r = await runReadQuery(
      projectId,
      "SELECT '[2026-01-01,2027-01-01)'::tstzrange @> '2026-06-01'::timestamptz AS within, " +
        "'10.0.0.1'::inet << '10.0.0.0/8'::cidr AS inside, lpad('7', 3, '0') AS padded, repeat('ab', 2) AS twice, " +
        "to_tsvector('english'::regconfig, 'running')::text AS ts, " +
        '(SELECT range_agg(r)::text FROM (VALUES (int4range(1, 3)), (int4range(2, 5))) AS v(r)) AS agg',
      10,
    )
    expect(r.rows[0]).toEqual({ within: true, inside: true, padded: '007', twice: 'abab', ts: "'run':1", agg: '{[1,5)}' })
  }, 60_000)
})

/**
 * search_path reaches the project's own schema, so a function or operator
 * defined there is picked over the built-in, and a cast through its own
 * function runs on every conversion. These are made as a read-write login
 * with schema changes allowed could make them, and removed after each test.
 */
describe('the project\'s own code is not run', () => {
  const PEEK = "SELECT string_agg(nspname, ',') FROM pg_catalog.pg_namespace WHERE nspname LIKE 'workspace%'"

  test('an operator or an overload of a listed function in the project\'s schema', async () => {
    await raw(`CREATE FUNCTION "${schema}".peek(int) RETURNS text LANGUAGE sql AS $$ ${PEEK} $$`)
    await raw(`CREATE OPERATOR "${schema}".### (RIGHTARG = int, FUNCTION = "${schema}".peek)`)
    await raw(`CREATE FUNCTION "${schema}".peek2(text, text) RETURNS text LANGUAGE sql AS $$ ${PEEK} $$`)
    await raw(`CREATE OPERATOR "${schema}".+ (LEFTARG = text, RIGHTARG = text, FUNCTION = "${schema}".peek2)`)
    await raw(`CREATE FUNCTION "${schema}".lower(int) RETURNS text LANGUAGE sql AS $$ ${PEEK} $$`)
    try {
      const routes: Array<[string, string]> = [
        ['SELECT ### 1 AS v', 'OPERATOR_NOT_ALLOWED'],
        ["SELECT 'a'::text + 'b'::text AS v", 'OPERATOR_NOT_ALLOWED'],
        ['SELECT lower(1) AS v', 'FUNCTION_NOT_ALLOWED'],
      ]
      for (const [sql, code] of routes) {
        expect(await inOwnSchema(sql)).toContain(otherSchema)
        await expect(runReadQuery(projectId, sql, 10)).rejects.toMatchObject({ code })
      }
      // A statement that names none of them still runs.
      const r = await runReadQuery(projectId, "SELECT upper('abc') AS v, (SELECT count(*) FROM notes) AS n", 10)
      expect(r.rows[0]).toEqual({ v: 'ABC', n: '2' })
    } finally {
      await raw(`DROP OPERATOR IF EXISTS "${schema}".+ (text, text)`)
      await raw(`DROP OPERATOR IF EXISTS "${schema}".### (NONE, int)`)
      await raw(`DROP FUNCTION IF EXISTS "${schema}".peek(int), "${schema}".peek2(text, text), "${schema}".lower(int)`)
    }
  }, 60_000)

  test('a cast through the project\'s own function', async () => {
    const { roleName } = await readOnlyLogin(projectId)
    await raw(`CREATE TYPE "${schema}".mood AS ENUM ('ok')`)
    await raw(`CREATE FUNCTION "${schema}".mood_text("${schema}".mood) RETURNS text LANGUAGE sql AS $$ ${PEEK} $$`)
    await raw(`CREATE CAST ("${schema}".mood AS text) WITH FUNCTION "${schema}".mood_text("${schema}".mood)`)
    await raw(`CREATE TABLE "${schema}".moods (m "${schema}".mood)`)
    await raw(`INSERT INTO "${schema}".moods VALUES ('ok')`)
    await raw(`GRANT SELECT ON "${schema}".moods TO "${roleName}"`)
    try {
      expect(await directly(`SELECT m::text AS v FROM "${schema}".moods`)).toContain(otherSchema)
      await expect(runReadQuery(projectId, 'SELECT m::text AS v FROM moods', 10)).rejects.toMatchObject({
        code: 'FUNCTION_NOT_ALLOWED',
      })
      await expect(runReadQuery(projectId, 'SELECT 1 AS one', 10)).rejects.toMatchObject({ code: 'FUNCTION_NOT_ALLOWED' })
    } finally {
      await raw(`DROP TABLE IF EXISTS "${schema}".moods`)
      await raw(`DROP CAST IF EXISTS ("${schema}".mood AS text)`)
      await raw(`DROP FUNCTION IF EXISTS "${schema}".mood_text("${schema}".mood)`)
      await raw(`DROP TYPE IF EXISTS "${schema}".mood`)
    }
    expect((await runReadQuery(projectId, 'SELECT 1 AS one', 10)).rows).toEqual([{ one: 1 }])
  }, 60_000)
})
