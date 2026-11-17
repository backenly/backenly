/**
 * SLOW QUERIES — a check that cannot read the statements says so
 * --------------------------------------------------------------
 * PostgREST runs every REST request as anon, authenticated or service_role,
 * and PostgreSQL shows the text of a statement another role ran only to a role
 * holding the privileges of pg_read_all_stats. Read by a role without them,
 * pg_stat_statements answers, and every REST read, function statement and
 * direct-connection statement in it is `<insufficient privilege>`.
 *
 * The measured slow-query invariant then read as satisfied: production QA
 * (2026-11-16) sent 60 slow REST reads and the backend was "healthy". The
 * invariant now requires the text to be readable, and says what to grant when
 * it is not, the way it already says what to install when the extension is
 * missing (lib/autonomy/platform-capabilities.ts).
 *
 * Read as a NOSUPERUSER role, as production reads.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { randomBytes } from 'crypto'
import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { computeDesiredStateDiff } from '@/lib/autonomy/desired-state'
import { hasCapability, resetCapabilityCache } from '@/lib/autonomy/platform-capabilities'
import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { closeAllWorkspacePools } from '@/lib/services/workspace-pool'
import { HOME_REGION } from '@/lib/regions'

const SUPER_URL = process.env.DATABASE_URL!
const PASSWORD = `pw_${randomBytes(8).toString('hex')}`
const READER = `slowq_app_${randomBytes(4).toString('hex')}`

let pool: Pool
let userId: string
let projectId: string

function readerUrl(): string {
  const u = new URL(SUPER_URL)
  u.username = READER
  u.password = PASSWORD
  return u.toString()
}

/** Every pooled connection and cached answer dropped, so the next read is as `url`. */
async function readAs(url: string): Promise<void> {
  await closeAllWorkspacePools()
  await disconnectRegionalClients()
  resetCapabilityCache()
  process.env.DATABASE_URL = url
}

const SLOW_QUERIES = 'measured_slow_queries_are_indexed'

beforeAll(async () => {
  pool = new Pool({ connectionString: SUPER_URL, max: 2 })
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`).catch(() => {})
  await pool.query(`CREATE ROLE ${READER} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PASSWORD}'`)
  userId = (await prisma.user.create({ data: { email: `slowq-hidden-${Date.now()}@example.test`, password: 'x', name: 'slowq' } })).id
  projectId = (await prisma.project.create({ data: { name: 'slowq-hidden', userId } })).id
  await pool.query(`CREATE SCHEMA "workspace_${projectId}"`)
}, 60_000)

afterAll(async () => {
  await readAs(SUPER_URL)
  await pool?.query(`DROP SCHEMA IF EXISTS "workspace_${projectId}" CASCADE`).catch(() => {})
  await pool?.query(`DROP OWNED BY ${READER}`).catch(() => {})
  await pool?.query(`DROP ROLE IF EXISTS ${READER}`).catch(() => {})
  await pool?.end().catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('the measured slow-query check, read as a role that cannot see other roles\' statements', () => {
  test('the fixture is real: pg_stat_statements is installed', async () => {
    const r = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`)
    expect(r.rows).toHaveLength(1)
  })

  test('reports that the statement text cannot be read, and what to grant', async () => {
    await readAs(readerUrl())
    const state = await hasCapability('statement_text', HOME_REGION)
    expect(state).toMatchObject({ available: false, indeterminate: false })
    expect(state.remediation).toMatch(/GRANT pg_read_all_stats TO/)
  })

  test('is reported as not checked, never as holding', async () => {
    await readAs(readerUrl())
    const report = await computeDesiredStateDiff(projectId)
    expect(report.disabled.find((d) => d.id === SLOW_QUERIES)).toMatchObject({
      capability: 'statement_text',
      remediation: expect.stringMatching(/pg_read_all_stats/),
    })
    expect(report.invariants.find((i) => i.id === SLOW_QUERIES)).toMatchObject({ satisfied: false, gaps: [] })
  }, 120_000)

  test('runs once the role holds the privileges of pg_read_all_stats', async () => {
    await pool.query(`GRANT pg_read_all_stats TO ${READER}`)
    await readAs(readerUrl())
    expect(await hasCapability('statement_text', HOME_REGION)).toMatchObject({ available: true })
    const report = await computeDesiredStateDiff(projectId)
    expect(report.disabled.map((d) => d.id)).not.toContain(SLOW_QUERIES)
  }, 120_000)
})
