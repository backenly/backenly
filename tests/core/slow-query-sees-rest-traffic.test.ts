/**
 * SLOW QUERIES — the sensor must see the traffic apps actually send
 * -----------------------------------------------------------------
 * Apps read through the REST APIs: /api/v2 is PostgREST, and v1 /db is served
 * through PostgREST too (server/routes/postgrest-handler.ts). Every statement
 * PostgREST runs selects `pg_catalog.count(_postgrest_t)`, and the sensor
 * dropped any statement containing `pg_catalog`. So on production (2026-11-09),
 * 120 slow v2 reads and 80 slow v1 /db reads on a 1.14M-row table produced no
 * finding in 20 minutes, while 40 reads through /database/query produced one
 * within a minute.
 *
 * The statements below are PostgREST v14.15's own, assembled the way
 * src/PostgREST/Query/Statements.hs (mainRead) and QueryBuilder.hs
 * (readPlanToQuery, readPlanToCountQuery) assemble them, including the double
 * spaces: v14.15 is the version docker-compose.dev.yml and production run.
 * They are sent with bind parameters, as PostgREST sends them, so
 * pg_stat_statements groups and normalises them exactly as it does in
 * production.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { detectSlowQueryMissingIndexes } from '@/lib/autonomy/slow-query-index'

let userId: string
let projectId: string
let schema: string
let branchSchema: string
let pool: Pool
let hasExtension = false

const CALLS = 25

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

  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`).catch(() => {})
  hasExtension = (await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`)).rows.length > 0

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

  for (let i = 0; i < CALLS; i++) {
    await pool.query(v2, [`none-${i}`, 20, 0])
    await pool.query(v1, [`none-${i}`, 20, 0, `none-${i}`])
    await pool.query(wide, [`none-${i}`, 20, 0])
    await pool.query(onBranch, [`none-${i}`, 20, 0])
  }
}, 180_000)

afterAll(async () => {
  for (const s of [schema, branchSchema]) {
    if (s) await pool?.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
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

  test('the replayed statements carry pg_catalog, as PostgREST statements do', async () => {
    const r = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_statements WHERE position($1 in query) > 0 AND query LIKE '%pg_catalog.count%'`,
      [`"${schema}"`],
    )
    expect(r.rows[0].n).toBeGreaterThanOrEqual(3)
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
