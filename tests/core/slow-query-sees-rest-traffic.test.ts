/**
 * SLOW QUERIES — the sensor must see the traffic apps actually send
 * -----------------------------------------------------------------
 * Apps read through the REST APIs: /api/v2 is PostgREST, and v1 /db is served
 * through PostgREST too (server/routes/postgrest-handler.ts). PostgREST logs in
 * as its authenticator and runs each request as anon, authenticated or
 * service_role (lib/postgrest/gateway.ts), and pg_stat_statements records the
 * statement under that role.
 *
 * Two things hid those reads from the sensor:
 *   - it dropped any statement containing `pg_catalog`, which every PostgREST
 *     statement selects (production QA, 2026-11-09);
 *   - it reads as the application role, and PostgreSQL shows the text of a
 *     statement another role ran only to a role holding the privileges of
 *     pg_read_all_stats. Until the procedures granted them, every REST read was
 *     `<insufficient privilege>` to it (production QA, 2026-11-16: 30 slow v2 and
 *     30 slow v1 /db reads on 1,000,002 rows raised nothing).
 *
 * So this runs as production does: the statements through an authenticator
 * login that switches to service_role, and the sensor reading as a NOSUPERUSER
 * role with pg_read_all_stats, as the procedures leave the application role.
 * Only the project's statements count: its own roles', and those PostgREST and
 * Backenly ran naming its schema (lib/autonomy/statement-attribution.ts).
 *
 * The statements are PostgREST v14.15's own, assembled the way
 * src/PostgREST/Query/Statements.hs (mainRead) and QueryBuilder.hs
 * (readPlanToQuery, readPlanToCountQuery) assemble them, including the double
 * spaces: v14.15 is the version docker-compose.dev.yml and production run.
 * They are sent with bind parameters, as PostgREST sends them, so
 * pg_stat_statements groups and normalises them exactly as it does in
 * production.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { randomBytes } from 'crypto'
import { Client, Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { detectSlowQueryMissingIndexes } from '@/lib/autonomy/slow-query-index'
import { closeAllWorkspacePools } from '@/lib/services/workspace-pool'

let userId: string
let projectId: string
let schema: string
let branchSchema: string
let pool: Pool
let hasExtension = false

const CALLS = 25
const PASSWORD = `pw_${randomBytes(8).toString('hex')}`
const tag = randomBytes(4).toString('hex')
/** The application role as the procedures leave it: NOSUPERUSER, with pg_read_all_stats. */
const READER = `slowq_app_${tag}`
/** PostgREST's login: NOINHERIT, able only to become the request roles. */
const AUTHENTICATOR = `slowq_authn_${tag}`
/** Someone else's session on the same database: an operator's, say. */
const OPERATOR = `slowq_operator_${tag}`
const SUPER_URL = process.env.DATABASE_URL!

function loginUrl(role: string): string {
  const u = new URL(SUPER_URL)
  u.username = role
  u.password = PASSWORD
  return u.toString()
}

/** mainRead: `WITH pgrst_source AS ( <read> ) <count CTE> SELECT … FROM ( SELECT * FROM pgrst_source ) _postgrest_t` */
function postgrestRead(read: string, countQuery?: string): string {
  const countCte = countQuery ? `, pgrst_source_count AS (${countQuery})` : ''
  const total = countQuery ? '(SELECT pg_catalog.count(*) FROM pgrst_source_count)' : 'null::bigint'
  return (
    `WITH pgrst_source AS ( ${read} ) ${countCte} ` +
    `SELECT ${total} AS total_result_set, pg_catalog.count(_postgrest_t) AS page_total, ` +
    `coalesce(json_agg(_postgrest_t), '[]') AS body, ` +
    `nullif(current_setting('response.headers', true), '') AS response_headers, ` +
    `nullif(current_setting('response.status', true), '') AS response_status, ` +
    `'' AS response_inserted FROM ( SELECT * FROM pgrst_source ) _postgrest_t`
  )
}

/** readPlanToQuery: each filter is `notOp <> " " <> field <> " = " <> value`, joined by " AND ". */
function readQuery(qi: string, selects: string, filters: string[], limitParam: number): string {
  return `SELECT ${selects} FROM ${qi} WHERE ${filters.map((f) => ` ${f}`).join(' AND ')}   LIMIT $${limitParam} OFFSET $${limitParam + 1}`
}

/** Each statement in its own transaction, as PostgREST runs a request: role first, then the read. */
async function asPostgrest(statements: Array<{ sql: string; params: (i: number) => unknown[] }>): Promise<void> {
  const c = new Client({ connectionString: loginUrl(AUTHENTICATOR) })
  await c.connect()
  try {
    for (let i = 0; i < CALLS; i++) {
      for (const st of statements) {
        await c.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY')
        await c.query(`select set_config('role', $1, true), set_config('request.method', 'GET', true)`, ['service_role'])
        await c.query(st.sql, st.params(i))
        await c.query('COMMIT')
      }
    }
  } finally {
    await c.end()
  }
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `slowq-rest-${Date.now()}@example.test`, password: 'x', name: 'slowq' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'slowq-rest-test', userId } })
  projectId = project.id
  schema = `workspace_${projectId}`
  // A preview branch's schema starts with the project's own name. Its
  // statements contain the project's schema name as a substring, so they pass
  // the position() filter and must still be told apart.
  branchSchema = `${schema}_br_scratch`

  pool = new Pool({ connectionString: SUPER_URL, max: 3 })
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`).catch(() => {})
  hasExtension = (await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`)).rows.length > 0

  // PostgREST's request roles are cluster-wide and other suites leave them in
  // place; made here when this server has none yet, and never dropped.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`)
  }
  await pool.query(`CREATE ROLE ${READER} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PASSWORD}'`)
  await pool.query(`GRANT pg_read_all_stats TO ${READER}`)
  await pool.query(`CREATE ROLE ${AUTHENTICATOR} LOGIN NOINHERIT PASSWORD '${PASSWORD}'`)
  await pool.query(`GRANT service_role TO ${AUTHENTICATOR}`)
  await pool.query(`CREATE ROLE ${OPERATOR} LOGIN PASSWORD '${PASSWORD}'`)

  for (const s of [schema, branchSchema]) {
    await pool.query(`CREATE SCHEMA "${s}"`)
    await pool.query(`CREATE TABLE "${s}"."product_views" (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      referrer text,
      session_key text,
      campaign text,
      landing_page text,
      user_agent text,
      country text,
      ${s === branchSchema ? 'only_on_branch text,' : ''}
      created_at timestamptz DEFAULT now(),
      deleted_at timestamptz
    )`)
    await pool.query(`INSERT INTO "${s}"."product_views"(referrer, session_key, campaign, landing_page, user_agent, country)
      SELECT 'r' || (i % 300), 's' || i, 'c' || (i % 40), '/p/' || i, 'ua', 'IN' FROM generate_series(1, 2000) i`)
    await pool.query(`ANALYZE "${s}"."product_views"`)
    await pool.query(`GRANT USAGE ON SCHEMA "${s}" TO service_role, ${OPERATOR}`)
    await pool.query(`GRANT SELECT ON "${s}"."product_views" TO service_role, ${OPERATOR}`)
  }

  if (!hasExtension) return
  await pool.query(`SELECT pg_stat_statements_reset()`)

  const qi = `"${schema}"."product_views"`
  const col = (c: string) => `${qi}."${c}"`

  // GET /api/v2/:id/product_views?referrer=eq.X&limit=20 — no count requested.
  const v2 = postgrestRead(readQuery(qi, `${qi}.*`, [`${col('referrer')} = $1`], 2))
  // GET /api/v1/:id/db/product_views?session_key=X&limit=20 — translateReadQuery
  // adds the soft-delete predicate, and the handler asks for count=exact.
  const v1 = postgrestRead(
    readQuery(qi, `${qi}.*`, [`${col('session_key')} = $1`, `${col('deleted_at')} IS NULL`], 2),
    `SELECT 1  FROM ${qi} WHERE  ${col('session_key')} = $4 AND  ${col('deleted_at')} IS NULL`,
  )
  // A v2 read that selects six columns: its WHERE starts past character 400.
  const wide = postgrestRead(
    readQuery(qi, ['id', 'referrer', 'session_key', 'landing_page', 'user_agent', 'country'].map(col).join(', '), [`${col('campaign')} = $1`], 2),
  )
  // The same table in the branch schema, filtering a column only it has.
  const bqi = `"${branchSchema}"."product_views"`
  const onBranch = postgrestRead(readQuery(bqi, `${bqi}.*`, [`${bqi}."only_on_branch" = $1`], 2))

  await asPostgrest([
    { sql: v2, params: (i) => [`none-${i}`, 20, 0] },
    { sql: v1, params: (i) => [`none-${i}`, 20, 0, `none-${i}`] },
    { sql: wide, params: (i) => [`none-${i}`, 20, 0] },
    { sql: onBranch, params: (i) => [`none-${i}`, 20, 0] },
  ])

  // The same shape of read on the project's table, from a session that is
  // neither the project's nor PostgREST's nor Backenly's.
  const operator = new Client({ connectionString: loginUrl(OPERATOR) })
  await operator.connect()
  try {
    const byHand = postgrestRead(readQuery(qi, `${qi}.*`, [`${col('landing_page')} = $1`], 2))
    for (let i = 0; i < CALLS; i++) await operator.query(byHand, [`none-${i}`, 20, 0])
  } finally {
    await operator.end()
  }

  // From here the sensor reads as the application role does in production.
  await closeAllWorkspacePools()
  process.env.DATABASE_URL = loginUrl(READER)
}, 180_000)

afterAll(async () => {
  await closeAllWorkspacePools()
  process.env.DATABASE_URL = SUPER_URL
  for (const s of [schema, branchSchema]) {
    if (s) await pool?.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
  }
  for (const role of [READER, AUTHENTICATOR, OPERATOR]) {
    await pool?.query(`DROP OWNED BY ${role}`).catch(() => {})
    await pool?.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
  }
  await pool?.end().catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('slow-query sensor — REST traffic', () => {
  test('the fixture is real: pg_stat_statements is installed', () => {
    // Asserted, not skipped: every test below proves nothing without it.
    expect(hasExtension).toBe(true)
  })

  test('the replayed statements carry pg_catalog and were run as service_role, as PostgREST statements are', async () => {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid
        WHERE r.rolname = 'service_role' AND position($1 in s.query) > 0 AND s.query LIKE '%pg_catalog.count%'`,
      [`"${schema}"`],
    )
    expect(r.rows[0].n).toBeGreaterThanOrEqual(3)
  })

  test('the sensor reads as a role that is not a superuser', async () => {
    const reader = new Client({ connectionString: process.env.DATABASE_URL })
    await reader.connect()
    try {
      const r = await reader.query(`SELECT current_user AS who, rolsuper FROM pg_roles WHERE rolname = current_user`)
      expect(r.rows[0]).toEqual({ who: READER, rolsuper: false })
    } finally {
      await reader.end()
    }
  })

  // The thresholds are lowered so the fixture does not need a million rows to
  // be slow; which statements the sensor reads is what is under test.
  const detect = () => detectSlowQueryMissingIndexes(projectId, { minAvgMs: 0, minCalls: CALLS })

  test('a v2 (PostgREST) read is counted', async () => {
    const findings = await detect()
    expect(findings.map((f) => f.details.location)).toContain('product_views.referrer')
  })

  test('a v1 /db read, served through PostgREST with count=exact, is counted', async () => {
    const findings = await detect()
    expect(findings.map((f) => f.details.location)).toContain('product_views.session_key')
  })

  test('a read whose WHERE starts past the first 400 characters is counted', async () => {
    const findings = await detect()
    expect(findings.map((f) => f.details.location)).toContain('product_views.campaign')
  })

  test("a preview branch's statements are never attributed to production", async () => {
    const findings = await detect()
    expect(findings.map((f) => f.details.location)).not.toContain('product_views.only_on_branch')
  })

  test("a statement another role ran is not the project's traffic, whatever it reads", async () => {
    const findings = await detect()
    expect(findings.map((f) => f.details.location)).not.toContain('product_views.landing_page')
  })

  test('each finding names a column that exists and carries the fix inputs', async () => {
    const findings = await detect()
    const referrer = findings.find((f) => f.details.location === 'product_views.referrer')!
    expect(referrer.type).toBe('slow_query_missing_index')
    expect(referrer.details.tableName).toBe('product_views')
    expect(referrer.details.columnName).toBe('referrer')
    expect(referrer.details.calls).toBeGreaterThanOrEqual(CALLS)
  })

  test('the production thresholds still apply by default', async () => {
    // Microsecond reads on 2,000 rows are not slow, so the defaults find nothing.
    expect(await detectSlowQueryMissingIndexes(projectId)).toEqual([])
  })

  test('an index on the column ends the finding', async () => {
    await pool.query(`CREATE INDEX ON "${schema}"."product_views" (referrer)`)
    const findings = await detect()
    expect(findings.map((f) => f.details.location)).not.toContain('product_views.referrer')
  })
})
