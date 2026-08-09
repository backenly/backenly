/**
 * HOT TABLE — index the column the scans are on, or name no column at all
 * ------------------------------------------------------------------------
 * detectHotTables MEASURES sequential scans from pg_stat_user_tables and then
 * chose which column to index from a hardcoded name list: created_at, user_id,
 * owner_id, updated_at, first one that exists on the table.
 *
 * So on a table whose queries filter `customer_ref`, it counted the scans
 * correctly and proposed an index on `created_at` — a write on every insert and
 * update, forever, buying nothing, with the scans it was meant to absorb still
 * happening. And `infra_hot_table` is classified auto, so at high or critical
 * pressure that index was APPLIED without asking.
 *
 * The column now comes from the same place the scans do. This pins the two
 * outcomes that matter: the measured column wins over a same-table name-list
 * candidate, and with no measurement available the finding names NO column
 * (which classifyFix routes to notify_only) rather than guessing.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { runInfraIntelligence } from '@/lib/ai/infra-intelligence'
import { classifyFix } from '@/lib/core/fix-classifier'

let userId: string
let projectId: string
let schema: string
let pool: Pool
let hasExtension = false

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `hot-measured-${Date.now()}@example.test`, password: 'x', name: 'hot' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'hot-measured-test', userId } })
  projectId = project.id
  schema = `workspace_${projectId}`

  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 })

  // Create it here rather than assuming the test database already has it.
  //
  // Without this the whole measured-column half of this file passed VACUOUSLY:
  // the test database had no pg_stat_statements, every assertion was skipped,
  // and the suite reported green while proving nothing. That is the same shape
  // as the negative probe fixtures that passed against a stub — a test that
  // cannot fail is worse than no test, because the suite spends its credibility
  // vouching for it.
  //
  // CREATE EXTENSION succeeds whenever the library is preloaded, which
  // docker-compose.dev.yml and docker/postgres-init now guarantee.
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`).catch(() => {})
  const ext = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'`)
  hasExtension = ext.rows.length > 0

  await pool.query(`CREATE SCHEMA "${schema}"`)
  // created_at exists — it is exactly what the old name list would have picked —
  // but every read filters customer_ref. That gap is the whole test.
  await pool.query(`CREATE TABLE "${schema}"."orders" (
    id serial primary key,
    customer_ref text,
    status text,
    amount numeric,
    created_at timestamptz default now()
  )`)
  await pool.query(`INSERT INTO "${schema}"."orders"(customer_ref, status, amount)
    SELECT 'c'||(i%9000), 's', i FROM generate_series(1,300000) i`)
  await pool.query(`ANALYZE "${schema}"."orders"`)

  if (hasExtension) {
    await pool.query(`SELECT pg_stat_statements_reset()`)
    // Enough reads to clear the detector's seq_scan floor.
    for (let i = 0; i < 220; i++) {
      await pool.query(`SELECT id, amount FROM "${schema}"."orders" WHERE "customer_ref" = $1`, [`c${i}`])
    }
  }
}, 180_000)

afterAll(async () => {
  await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await pool?.end().catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('the measured column wins over the conventional one', () => {
  test('the fixture is real — the extension this file depends on is present', () => {
    // Asserted rather than skipped. Every measured-column test below is
    // meaningless without it, and a silent skip is how a suite reports green on
    // assertions that never ran. If this fails, the database needs
    // `shared_preload_libraries = 'pg_stat_statements'` and a restart — see
    // docker-compose.dev.yml.
    expect(hasExtension).toBe(true)
  })

  test('picks customer_ref, not created_at', async () => {
    const report = await runInfraIntelligence(projectId)
    const hot = report.hotTables.find(h => h.table === 'orders')
    expect(hot).toBeDefined()
    expect(hot!.kind).toBe('index_pressure')
    expect(hot!.indexColumn).toBe('customer_ref')
    expect(hot!.suggestedIndex).toContain('"customer_ref"')
    expect(hot!.suggestedIndex).not.toContain('created_at')
  }, 120_000)

  test('the suggested index carries no DESC, because equality has no direction', async () => {
    const report = await runInfraIntelligence(projectId)
    const hot = report.hotTables.find(h => h.table === 'orders')
    expect(hot!.suggestedIndex).not.toMatch(/DESC/)
  }, 120_000)

  test('the recommendation says what was measured', async () => {
    const report = await runInfraIntelligence(projectId)
    const hot = report.hotTables.find(h => h.table === 'orders')
    expect(hot!.recommendation).toContain('customer_ref')
    expect(hot!.recommendation).toMatch(/filter on/i)
  }, 120_000)
})

describe('with no measurement available, it names no column', () => {
  test('reports the pressure and refuses to pick a column', async () => {
    await pool.query(`DROP EXTENSION pg_stat_statements`)
    try {
      const report = await runInfraIntelligence(projectId)
      const hot = report.hotTables.find(h => h.table === 'orders')
      expect(hot).toBeDefined()
      // The scan pressure is still real and still reported…
      expect(hot!.seqScans).toBeGreaterThan(100)
      // …but nothing is proposed, because nothing was measured.
      expect(hot!.indexColumn).toBeUndefined()
      expect(hot!.suggestedIndex).toBeUndefined()
      expect(report.autoApplicableFixes).toEqual([])
      expect(hot!.recommendation).toMatch(/will not guess/i)
    } finally {
      await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`)
    }
  }, 120_000)

  test('a column-less hot table is notify_only, so no dead-end button appears', () => {
    // This routing already existed and was correct; it simply never fired,
    // because the name list nearly always found something to name.
    expect(classifyFix('infra_hot_table', { tableName: 'orders' }).decision).toBe('notify_only')
    expect(classifyFix('infra_hot_table', { tableName: 'orders', columnName: 'customer_ref' }).decision)
      .toBe('auto')
  })
})
