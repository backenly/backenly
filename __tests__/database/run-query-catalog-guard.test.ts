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

let userId: string
let projectId: string
let otherProjectId: string
let schema: string
let otherSchema: string
/** The other project's schema, its table, the table's row type and its sequence, by object id. */
let otherSchemaOid: number
let otherTableOid: number
let otherRowTypeOid: number

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
