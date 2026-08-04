/**
 * Table-bloat probe + its repair, proven end to end against a real table.
 *
 * ── What this pins down ─────────────────────────────────────────────────────
 *
 * Dead-tuple bloat used to be reported as `infra_hot_table_<table>`, whose only
 * repair is CREATE INDEX on a column the detector names. Bloat has no such
 * column — the whole table is the target — so those findings arrived with
 * `columnName: null`, were correctly classified notify-only, and sat open
 * forever underneath a recommendation telling the owner to run VACUUM. Four of
 * them were in the production queue, against tables at 91% and 96% index
 * coverage that had nothing wrong with their indexes at all.
 *
 * Two things had to be true to close that, and both are asserted here:
 *
 *   1. The probe fires only on real bloat. The old threshold was 20% dead
 *      tuples, which is exactly PostgreSQL's own `autovacuum_vacuum_scale_factor`
 *      — the point at which the database STARTS cleaning up, i.e. the normal
 *      operating state of any healthy write-heavy table. Flagging there means
 *      flagging correct behaviour.
 *   2. The repair actually reclaims. VACUUM is auto-applied, and an auto-applied
 *      fix whose probe cannot re-run afterwards is recorded as a success on the
 *      executor's word alone.
 *
 * Autovacuum is disabled on the fixture table on purpose: with it on, the
 * database would clean up mid-test and the probe would go quiet for a reason
 * that has nothing to do with the code under test.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { detectTableBloat } from '@/lib/autonomy/invariant-probes'
import { buildFixAction, hasExecutableFix } from '@/lib/core/fix-actions'
import { classifyFix } from '@/lib/core/fix-classifier'
import { executeAction } from '@/lib/ai/minimal-executor'

const prisma = new PrismaClient()
const q = (sql: string) => prisma.$executeRawUnsafe(sql)

let userId: string
let projectId: string
let schema: string

const TABLE = 'bloaty'

/**
 * pg_stat_user_tables is refreshed by the stats collector, not synchronously.
 *
 * Polls until the count reaches `atLeast` rather than merely becoming non-zero:
 * after a second DELETE the previous delete's total is already visible, so a
 * "wait for > 0" loop returns the stale figure immediately and the test asserts
 * against the wrong state.
 */
async function deadTuples(atLeast = 0): Promise<number> {
  let last = 0
  for (let i = 0; i < 40; i++) {
    const r = await prisma.$queryRawUnsafe<Array<{ dead: string }>>(
      `SELECT n_dead_tup::text AS dead FROM pg_stat_user_tables
        WHERE schemaname = $1 AND relname = $2`,
      schema, TABLE,
    )
    last = Number(r[0]?.dead ?? 0)
    if (last >= atLeast) return last
    await new Promise(res => setTimeout(res, 250))
  }
  return last
}

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `bloat+${userId.slice(0, 8)}@backenly.test`,
      name: 'bloat probe fixture',
      password: 'not-a-real-hash',
    },
  })
  await prisma.project.create({ data: { id: projectId, name: 'bloat-fixture', userId } as any })
  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
}, 180_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 180_000)

describe('detectTableBloat', () => {
  it('stays QUIET for a healthy table', async () => {
    await q(`CREATE TABLE "${schema}"."${TABLE}" (id serial PRIMARY KEY, payload text)`)
    await q(`ALTER TABLE "${schema}"."${TABLE}" SET (autovacuum_enabled = false)`)
    await q(`INSERT INTO "${schema}"."${TABLE}" (payload)
             SELECT repeat('x', 40) FROM generate_series(1, 3000)`)
    await q(`ANALYZE "${schema}"."${TABLE}"`)

    const hit = (await detectTableBloat(projectId)).find(
      f => (f.details as any)?.tableName === TABLE,
    )
    expect(hit).toBeUndefined()
  }, 180_000)

  it('stays QUIET at the ratio Postgres autovacuum treats as normal', async () => {
    // ~20% dead. This is where autovacuum triggers, and where the old detector
    // fired — the reason four healthy production tables were flagged.
    await q(`DELETE FROM "${schema}"."${TABLE}" WHERE id % 5 = 0`)
    await deadTuples(600)

    const hit = (await detectTableBloat(projectId)).find(
      f => (f.details as any)?.tableName === TABLE,
    )
    expect(hit).toBeUndefined()
  }, 180_000)

  it('FIRES once dead rows genuinely outweigh what autovacuum should leave', async () => {
    // Push well past 40% dead with more than the 1,000-tuple floor.
    await q(`DELETE FROM "${schema}"."${TABLE}" WHERE id % 5 <> 0`)
    const dead = await deadTuples(3000)
    expect(dead).toBeGreaterThan(1_000)

    const hit = (await detectTableBloat(projectId)).find(
      f => (f.details as any)?.tableName === TABLE,
    )
    expect(hit).toBeDefined()
    expect(hit!.type).toBe('infra_table_bloat')
    expect((hit!.details as any).deadTupRatio).toBeGreaterThanOrEqual(40)
  }, 180_000)

  it('is auto-classified and has a real executable repair — never a dead end', () => {
    const details = { tableName: TABLE, deadTupRatio: 66 }
    expect(classifyFix('infra_table_bloat', details).decision).toBe('auto')
    expect(hasExecutableFix('infra_table_bloat', details)).toBe(true)
    expect(buildFixAction('infra_table_bloat', details)).toEqual({
      action: 'VACUUM_TABLE',
      params: { tableName: TABLE },
    })
  })

  it('the repair actually reclaims, and the probe then goes QUIET', async () => {
    const before = await deadTuples(3000)
    expect(before).toBeGreaterThan(1_000)

    const res = await executeAction(
      { action: 'VACUUM_TABLE', params: { tableName: TABLE } } as any,
      projectId,
      undefined,
      0,
      undefined,
      false,
    )
    expect(res.success).toBe(true)

    // Ground truth from pg_stat_user_tables, not from the executor's message.
    const after = await prisma.$queryRawUnsafe<Array<{ dead: string }>>(
      `SELECT n_dead_tup::text AS dead FROM pg_stat_user_tables
        WHERE schemaname = $1 AND relname = $2`,
      schema, TABLE,
    )
    expect(Number(after[0]?.dead ?? -1)).toBeLessThan(before)

    const hit = (await detectTableBloat(projectId)).find(
      f => (f.details as any)?.tableName === TABLE,
    )
    expect(hit).toBeUndefined()
  }, 180_000)

  it('refuses a table that no longer exists rather than reporting a repair', async () => {
    const res = await executeAction(
      { action: 'VACUUM_TABLE', params: { tableName: 'never_existed' } } as any,
      projectId,
      undefined,
      0,
      undefined,
      false,
    )
    expect(res.success).toBe(false)
  }, 120_000)

  it('rejects an unsafe identifier instead of interpolating it into DDL', async () => {
    const res = await executeAction(
      { action: 'VACUUM_TABLE', params: { tableName: 'x"; DROP SCHEMA public CASCADE; --' } } as any,
      projectId,
      undefined,
      0,
      undefined,
      false,
    )
    expect(res.success).toBe(false)
    // The schema it tried to drop must still be there.
    const still = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
      `SELECT 1 AS one FROM information_schema.schemata WHERE schema_name = 'public'`,
    )
    expect(still.length).toBe(1)
  }, 120_000)
})
