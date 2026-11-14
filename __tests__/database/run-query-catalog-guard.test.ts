/**
 * THE CATALOGS ARE THE ONE THING THE STATEMENT ITSELF MUST REFUSE
 * ================================================================
 * For table data, run_query's boundary is PostgreSQL's: the project's bkn_ro_
 * role has no grant on another project's schema (sql-workspace-isolation.test.ts
 * proves that). The system catalogs are different. They are readable by PUBLIC
 * and describe every project in the database, so the role itself can read
 * another project's function source and schema name, and the only thing between
 * run_query and that read is the check on the statement (lib/mcp/read-query-ast.ts).
 *
 * So each route here is run twice: directly as the project's bkn_ro_ role, with
 * nothing in front, to prove it really reaches the other project, and then
 * through runReadQuery, which must refuse it before PostgreSQL sees it. A
 * refusal of something the role could not read anyway would prove nothing.
 *
 * Positive reads of the project's own tables are here too, so the refusals
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
let otherSchemaOid: number

const raw = (sql: string) => prisma.$executeRawUnsafe(sql)

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
  await raw(`CREATE TABLE "${schema}"."notes" (id serial primary key, body text)`)
  await raw(`INSERT INTO "${schema}"."notes"(body) VALUES ('mine one'), ('mine two')`)
  await raw(`CREATE TABLE "${schema}"."Mixed Case Notes" ("Body" text)`)
  await raw(`INSERT INTO "${schema}"."Mixed Case Notes"("Body") VALUES ('beta'), ('alpha')`)

  // Another project with a function worth stealing.
  await raw(`CREATE SCHEMA "${otherSchema}"`)
  await raw(
    `CREATE FUNCTION "${otherSchema}".pricing_rule() RETURNS text LANGUAGE sql AS $fn$ SELECT '${MARKER}'::text $fn$`,
  )
  const rows = await prisma.$queryRawUnsafe<Array<{ oid: number }>>(
    'SELECT oid::int AS oid FROM pg_namespace WHERE nspname = $1',
    otherSchema,
  )
  otherSchemaOid = rows[0].oid
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

type Rows = Array<Record<string, unknown>>

/** [what, the statement, how its rows show the other project when run directly] */
const ROUTES: Array<[string, () => string, (rows: Rows) => boolean]> = [
  [
    'the reported query: a double-quoted pg_proc',
    () => 'SELECT proname, prosrc FROM "pg_proc"',
    (rows) => rows.some((r) => String(r.prosrc).includes(MARKER)),
  ],
  [
    'schema enumeration through a double-quoted pg_namespace',
    () => 'SELECT nspname FROM "pg_namespace"',
    (rows) => rows.some((r) => r.nspname === otherSchema),
  ],
  [
    'both names quoted',
    () => 'SELECT prosrc FROM "pg_catalog"."pg_proc"',
    (rows) => rows.some((r) => String(r.prosrc).includes(MARKER)),
  ],
  [
    'a unicode-escaped name',
    () => 'SELECT prosrc FROM U&"\\0070g_proc"',
    (rows) => rows.some((r) => String(r.prosrc).includes(MARKER)),
  ],
  [
    'an object id cast to its name',
    // Output is quoted where the name needs it, as a workspace schema's hyphens do.
    () => `SELECT ${otherSchemaOid}::regnamespace::text AS name`,
    (rows) => rows.some((r) => String(r.name).includes(otherSchema)),
  ],
  [
    'a query passed as text',
    () => "SELECT query_to_xml('select nspname from pg_namespace', true, false, '') AS x",
    (rows) => rows.some((r) => String(r.x).includes(otherSchema)),
  ],
  [
    'a probe by name',
    () => `SELECT to_regnamespace('"${otherSchema}"')::text AS found`,
    (rows) => rows.some((r) => String(r.found).includes(otherSchema)),
  ],
]

describe('every route to another project\'s catalog entries', () => {
  test.each(ROUTES)('%s: the role reads it, and run_query refuses it', async (_label, sql, leaks) => {
    const direct = await asReadOnlyRole((c) => c.query(sql()))
    expect(leaks(direct.rows as Rows)).toBe(true)

    await expect(runReadQuery(projectId, sql(), 10)).rejects.toMatchObject({ code: 'CATALOG_NOT_READABLE' })
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
      const direct = await asReadOnlyRole((c) => c.query(capped(PAYLOAD, 10)))
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
