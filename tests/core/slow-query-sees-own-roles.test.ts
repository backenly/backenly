/**
 * SLOW QUERIES — statements this project's own roles ran, naming no schema
 * ------------------------------------------------------------------------
 * A function's code runs as the project's function role and a direct
 * connection as its access roles, both with a search path set to the project's
 * schema, so their statements say `FROM product_views WHERE country = $1`. The
 * sensor counted only statements naming `"workspace_<id>"."<table>"`, and never
 * saw them (production QA, 2026-11-09: slow function and app SQL raised
 * nothing). The roles are the project's alone, so another project's statements
 * are never attributed to this one.
 *
 * Real roles, real connections, real pg_stat_statements rows.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { Client, Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { detectSlowQueryMissingIndexes } from '@/lib/autonomy/slow-query-index'
import { functionRoleName } from '@/lib/services/ai-functions/function-db-role'
import { directAccessRoleNames } from '@/lib/services/direct-access'

const CALLS = 25
const PASSWORD = 'slow_query_roles_pw'

let userId: string
let projectId: string
let otherProjectId: string
let schema: string
let otherSchema: string
let pool: Pool
let hasExtension = false
const roles: string[] = []

function as(role: string): Client {
  const url = new URL(process.env.DATABASE_URL!)
  return new Client({ host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1), user: role, password: PASSWORD })
}

async function runAs(role: string, searchPath: string, sql: string) {
  const c = as(role)
  await c.connect()
  try {
    await c.query(`SET search_path TO "${searchPath}"`)
    for (let i = 0; i < CALLS; i++) await c.query(sql, [`none-${i}`])
  } finally {
    await c.end()
  }
}

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `slowq-roles-${Date.now()}@example.test`, password: 'x', name: 'slowq' } })).id
  projectId = (await prisma.project.create({ data: { name: 'slowq-roles', userId } })).id
  otherProjectId = (await prisma.project.create({ data: { name: 'slowq-roles-other', userId } })).id
  schema = `workspace_${projectId}`
  otherSchema = `workspace_${otherProjectId}`

  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`).catch(() => {})
  hasExtension = (await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`)).rows.length > 0

  for (const s of [schema, otherSchema]) {
    await pool.query(`CREATE SCHEMA "${s}"`)
    await pool.query(`CREATE TABLE "${s}".product_views (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), referrer text, campaign text, country text)`)
    await pool.query(`INSERT INTO "${s}".product_views (referrer, campaign, country)
      SELECT 'r' || (i % 300), 'c' || (i % 40), 'IN' FROM generate_series(1, 2000) i`)
    await pool.query(`ANALYZE "${s}".product_views`)
  }

  const fn = functionRoleName(schema)
  const rw = directAccessRoleNames(projectId).rw
  const otherFn = functionRoleName(otherSchema)
  for (const [role, s] of [[fn, schema], [rw, schema], [otherFn, otherSchema]] as const) {
    await pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${PASSWORD}'`)
    roles.push(role)
    await pool.query(`GRANT USAGE ON SCHEMA "${s}" TO "${role}"`)
    await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${s}" TO "${role}"`)
  }

  if (!hasExtension) return
  await pool.query(`SELECT pg_stat_statements_reset()`)
  // A function of this project, and a direct connection to it, each naming no schema.
  await runAs(fn, schema, `SELECT * FROM product_views WHERE country = $1`)
  await runAs(rw, schema, `SELECT * FROM product_views WHERE campaign = $1`)
  // Another project's function, against its own schema's table of the same name.
  await runAs(otherFn, otherSchema, `SELECT * FROM product_views WHERE referrer = $1`)
}, 180_000)

afterAll(async () => {
  for (const s of [schema, otherSchema]) if (s) await pool?.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
  for (const r of roles) {
    await pool?.query(`DROP OWNED BY "${r}"`).catch(() => {})
    await pool?.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => {})
  }
  await pool?.end().catch(() => {})
  await prisma.project.deleteMany({ where: { id: { in: [projectId, otherProjectId] } } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('slow-query sensor — statements the project\'s own roles ran', () => {
  test('the fixture is real: pg_stat_statements is installed', () => {
    expect(hasExtension).toBe(true)
  })

  // Lowered thresholds: which statements are read is what is under test.
  const detect = (id: string) => detectSlowQueryMissingIndexes(id, { minAvgMs: 0, minCalls: CALLS })

  test("a function's statement, naming no schema, is counted", async () => {
    expect((await detect(projectId)).map((f) => f.details.location)).toContain('product_views.country')
  })

  test("a direct connection's statement, naming no schema, is counted", async () => {
    expect((await detect(projectId)).map((f) => f.details.location)).toContain('product_views.campaign')
  })

  test("another project's statement is never counted here, and is counted there", async () => {
    expect((await detect(projectId)).map((f) => f.details.location)).not.toContain('product_views.referrer')
    expect((await detect(otherProjectId)).map((f) => f.details.location)).toEqual(['product_views.referrer'])
  })

  test('each finding carries the fix inputs for a column that exists', async () => {
    const country = (await detect(projectId)).find((f) => f.details.location === 'product_views.country')!
    expect(country).toMatchObject({ type: 'slow_query_missing_index', details: { tableName: 'product_views', columnName: 'country' } })
    expect(country.details.calls).toBeGreaterThanOrEqual(CALLS)
  })
})
