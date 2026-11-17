/**
 * THE SIZE OF AN INDEX, ESTIMATED AS THE APPLICATION ROLE
 * -------------------------------------------------------
 * The authority decision bounds what Backenly builds on its own by the share
 * of the plan's database storage it would take (lib/authority/decision.ts).
 * The estimate read the column's width from pg_stats, which PostgreSQL leaves
 * out for a table where row-level security is active for the reader. Every
 * workspace table is FORCE ROW LEVEL SECURITY and the application role is
 * NOBYPASSRLS, so in production the width was always missing and the estimate
 * was the whole heap: about twice the real index on the QA store's
 * product_views, enough to take its 512 MB plan past 90% (production QA,
 * 2026-11-16: a slow-query index Backenly should have built waited for a
 * person).
 *
 * Read as production reads: a NOSUPERUSER role that owns the table through
 * membership, under FORCE ROW LEVEL SECURITY, with the service-role escape
 * Backenly's policies carry.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { randomBytes, randomUUID } from 'crypto'
import { Pool } from 'pg'
import { heapBoundBytes, readIndexBuildFacts } from '@/lib/authority/build-facts'
import { jwtClaimFunctionSql, serviceRoleClause } from '@/lib/postgrest/rls-translation'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { closeAllWorkspacePools } from '@/lib/services/workspace-pool'

const SUPER_URL = process.env.DATABASE_URL!
const tag = randomBytes(4).toString('hex')
const OWNER = `estimate_owner_${tag}`
const APP = `estimate_app_${tag}`
const PASSWORD = `pw_${randomBytes(8).toString('hex')}`
const projectId = randomUUID()
const schema = `workspace_${projectId}`
const qi = `"${schema}"."product_views"`
const ROWS = 300_000

let pool: Pool

async function readAs(url: string): Promise<void> {
  await closeAllWorkspacePools()
  await disconnectRegionalClients()
  process.env.DATABASE_URL = url
}

function appUrl(): string {
  const u = new URL(SUPER_URL)
  u.username = APP
  u.password = PASSWORD
  return u.toString()
}

beforeAll(async () => {
  pool = new Pool({ connectionString: SUPER_URL, max: 2 })
  await pool.query(`CREATE ROLE ${OWNER} NOLOGIN`)
  await pool.query(`CREATE ROLE ${APP} LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD '${PASSWORD}'`)
  await pool.query(`GRANT ${OWNER} TO ${APP}`)
  await pool.query(`CREATE SCHEMA "${schema}" AUTHORIZATION ${OWNER}`)
  await pool.query(jwtClaimFunctionSql(schema))
  await pool.query(`CREATE TABLE ${qi} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id text NOT NULL, referrer text)`)
  // Referrers as the QA store wrote them: 78 characters, 60 distinct.
  await pool.query(`INSERT INTO ${qi} (session_id, referrer)
    SELECT 'sess-' || lpad(i::text, 10, '0'),
           'https://ref' || (i % 60) || '.example.com/campaign/' || repeat('x', 40) || '/' || (i % 60)
      FROM generate_series(1, ${ROWS}) i`)
  await pool.query(`ALTER TABLE ${qi} OWNER TO ${OWNER}`)
  await pool.query(`ALTER FUNCTION "${schema}"."backenly_jwt_claim"(text) OWNER TO ${OWNER}`)
  await pool.query(`ALTER TABLE ${qi} ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE ${qi} FORCE ROW LEVEL SECURITY`)
  await pool.query(`CREATE POLICY backenly_service ON ${qi} FOR SELECT USING (${serviceRoleClause(schema)})`)
  await pool.query(`ANALYZE ${qi}`)
}, 120_000)

afterAll(async () => {
  await readAs(SUPER_URL)
  await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  for (const role of [APP, OWNER]) await pool?.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
  await pool?.end().catch(() => {})
})

describe('the index estimate the storage bound reads', () => {
  test('pg_stats hides the table from the application role, as it does in production', async () => {
    const asApp = new Pool({ connectionString: appUrl(), max: 1 })
    try {
      const seen = await asApp.query(`SELECT count(*)::int AS n FROM pg_stats WHERE schemaname = $1 AND tablename = 'product_views'`, [schema])
      expect(seen.rows[0].n).toBe(0)
    } finally {
      await asApp.end()
    }
  })

  test('is the same, within the sample\'s noise, read as the application role as read with the statistics', async () => {
    await readAs(SUPER_URL)
    const withStats = await readIndexBuildFacts(projectId, 'product_views', 'referrer')
    await readAs(appUrl())
    const asApp = await readIndexBuildFacts(projectId, 'product_views', 'referrer')

    expect(withStats.estimatedBytes).not.toBeNull()
    expect(asApp.tableBytes).toBe(withStats.tableBytes)
    expect(asApp.estimatedBytes).not.toBeNull()
    expect(Math.abs(asApp.estimatedBytes! - withStats.estimatedBytes!) / withStats.estimatedBytes!).toBeLessThan(0.15)
    // And nowhere near the whole heap, which is what it used to be.
    expect(asApp.estimatedBytes!).toBeLessThan(heapBoundBytes(asApp.tableBytes!) * 0.75)
  }, 120_000)

  test('falls back to the heap bound when the policies admit no service role', async () => {
    await pool.query(`DROP POLICY backenly_service ON ${qi}`)
    await pool.query(`CREATE POLICY nobody ON ${qi} FOR SELECT USING (false)`)
    await readAs(appUrl())
    const facts = await readIndexBuildFacts(projectId, 'product_views', 'referrer')
    expect(facts.estimatedBytes).toBe(heapBoundBytes(facts.tableBytes!))
  }, 120_000)
})
