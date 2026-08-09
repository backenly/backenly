/**
 * INDEX BLOAT — measured, repaired, and verifiably closed
 * --------------------------------------------------------
 * `IndexFinding.kind` declared a `'fragmented'` variant and nothing ever emitted
 * it. Table bloat had a detector and a repair; index bloat had a string in a
 * union type.
 *
 * The fixture below is the real thing rather than a mock: 600k rows, an index,
 * delete 90% of the rows, VACUUM. That leaves the heap reusable and the index
 * holding every page it ever allocated — measured at 9.27% leaf density on the
 * same 13 MB of disk. A btree does not shrink on its own.
 *
 * Two invalidation rules are pinned here, and they are different signals doing
 * different jobs:
 *
 *   - WRITE VOLUME on the table makes DETECTION work. Bloat accumulates with the
 *     size unchanged, which is the entire phenomenon, so an earlier version that
 *     re-measured only on a size change kept its healthy reading through exactly
 *     the churn that invalidated it and reported nothing.
 *   - INDEX SIZE makes the REPAIR verifiable. A REINDEX shrinks the index, the
 *     next tick notices, and the gap closes. Without it a cached bloated reading
 *     would outlive its own repair and evaluateFixOutcome would escalate a fix
 *     that worked.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import {
  detectIndexBloat,
  BLOAT_DENSITY_PCT,
  BLOAT_MIN_INDEX_BYTES,
  MIN_REMEASURE_MINUTES,
} from '@/lib/autonomy/index-bloat'
import { executeAction } from '@/lib/ai/minimal-executor'
import { classifyFix } from '@/lib/core/fix-classifier'
import { buildFixAction } from '@/lib/core/fix-actions'
import { hasCapability, resetCapabilityCache } from '@/lib/autonomy/platform-capabilities'

let userId: string
let projectId: string
let schema: string
let pool: Pool

const density = async (indexName: string): Promise<number> => {
  const r = await pool.query(
    `SELECT avg_leaf_density FROM pgstatindex(format('%I.%I', $1::text, $2::text)::regclass)`,
    [schema, indexName],
  )
  return Number(r.rows[0].avg_leaf_density)
}

/**
 * Move the ledger entry past the re-measure cooldown.
 *
 * The cooldown is a production bound — a very write-heavy table must not
 * schedule a full index scan every minute — and bloat develops over days, so
 * half an hour of detection latency costs nothing real. Backdating is how the
 * test exercises the WRITE-DELTA trigger without waiting for wall-clock time,
 * the same approach the unused-index suite takes with its fourteen-day window.
 */
const agePastCooldown = async () => {
  const older = new Date(Date.now() - (MIN_REMEASURE_MINUTES + 5) * 60_000).toISOString()
  const rows = await prisma.projectPreference.findMany({
    where: { projectId, type: 'index_bloat_scan' },
    select: { key: true, value: true },
  })
  for (const r of rows) {
    await prisma.projectPreference.update({
      where: { projectId_type_key: { projectId, type: 'index_bloat_scan', key: r.key } },
      data: { value: JSON.stringify({ ...JSON.parse(r.value), measuredAt: older }) },
    })
  }
}

/**
 * Wait until pg_stat_user_tables reflects the writes we just made.
 *
 * The detection trigger is n_tup_upd + n_tup_del, and PostgreSQL reports those
 * to the statistics collector asynchronously after the transaction ends. In
 * production that lag is irrelevant — the probe runs once a minute and bloat
 * develops over days — but a test that deletes and probes in the same
 * millisecond races it, which is exactly how this suite went intermittently red.
 *
 * Polling here tests the detector rather than Postgres's stats latency. It never
 * masks a real failure: if the counter never arrives the wait times out and the
 * assertion that follows still fails.
 */
const waitForWriteStats = async (minWrites: number, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = await pool.query(
      `SELECT COALESCE(s.n_tup_upd, 0) + COALESCE(s.n_tup_del, 0) AS w
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
         LEFT JOIN pg_stat_user_tables s ON s.relid = t.oid
        WHERE n.nspname = $1 AND t.relname = 'events'`,
      [schema],
    )
    if (Number(r.rows[0]?.w ?? 0) >= minWrites) return
    if (Date.now() > deadline) return
    await new Promise(res => setTimeout(res, 200))
  }
}

/**
 * VACUUM until the deleted rows are actually reclaimable.
 *
 * VACUUM can only remove tuples older than the oldest snapshot open anywhere in
 * the database. Jest runs suites in parallel against one test database, so a
 * neighbouring suite's bulk insert holds a snapshot for its duration and this
 * one's VACUUM legitimately reclaims nothing — leaving the index dense and the
 * assertion below failing for a reason that has nothing to do with the detector.
 *
 * Retrying is the faithful fix rather than a workaround: the deletes are real,
 * the VACUUM is real, and the only thing being waited on is the neighbour's
 * transaction ending. It cannot mask a defect — if the index never goes sparse
 * the loop times out and the assertion still fails.
 *
 * (This is the same phenomenon `idle_in_transaction` exists to report, observed
 * from the other side.)
 */
const vacuumUntilSparse = async (indexName: string, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await pool.query(`VACUUM "${schema}"."events"`)
    if (await density(indexName) < BLOAT_DENSITY_PCT) return
    if (Date.now() > deadline) return
    await new Promise(res => setTimeout(res, 1000))
  }
}

const sizeOf = async (indexName: string): Promise<number> => {
  const r = await pool.query(
    `SELECT pg_relation_size(i.oid)::bigint AS s
       FROM pg_class i JOIN pg_namespace n ON n.oid = i.relnamespace
      WHERE n.nspname = $1 AND i.relname = $2`,
    [schema, indexName],
  )
  return Number(r.rows[0]?.s ?? 0)
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `index-bloat-${Date.now()}@example.test`, password: 'x', name: 'bloat' },
  })
  userId = user.id
  const project = await prisma.project.create({ data: { name: 'index-bloat-test', userId } })
  projectId = project.id
  schema = `workspace_${projectId}`

  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgstattuple`).catch(() => {})
  resetCapabilityCache()

  await pool.query(`CREATE SCHEMA "${schema}"`)
  await pool.query(`CREATE TABLE "${schema}"."events" (id serial primary key, k int)`)
  // Six hundred thousand rows, not two hundred thousand. The smaller fixture
  // produced a 4.5 MB index — below BLOAT_MIN_INDEX_BYTES — so the probe
  // correctly ignored it and the "healthy index is not reported" assertion
  // passed for the wrong reason. A fixture that cannot trip the threshold cannot
  // test the threshold.
  //
  // No padding column: index size depends on the number of keys, not on the row
  // width, so the pad added tens of megabytes of heap that this suite never
  // reads and made it slow enough to hit the statement timeout when the rest of
  // the suite ran alongside it.
  await pool.query(`INSERT INTO "${schema}"."events"(k)
    SELECT i FROM generate_series(1, 600000) i`)
  await pool.query(`CREATE INDEX idx_events_k ON "${schema}"."events"(k)`)
}, 240_000)

afterAll(async () => {
  await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await pool?.end().catch(() => {})
  await prisma.projectPreference.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('the fixture is real', () => {
  test('pgstattuple is installed, so these assertions can fail', async () => {
    const cap = await hasCapability('pgstattuple')
    expect(cap.available).toBe(true)
  })

  test('a freshly built index is dense, and is not reported', async () => {
    expect(await density('idx_events_k')).toBeGreaterThan(BLOAT_DENSITY_PCT)
    expect(await detectIndexBloat(projectId)).toEqual([])
  }, 60_000)
})

describe('bloat after churn', () => {
  test('deleting most rows leaves the index the same size and mostly empty', async () => {
    const sizeBefore = await sizeOf('idx_events_k')
    expect(sizeBefore).toBeGreaterThanOrEqual(BLOAT_MIN_INDEX_BYTES)

    await pool.query(`DELETE FROM "${schema}"."events" WHERE k % 10 <> 0`)
    await vacuumUntilSparse('idx_events_k')
    await waitForWriteStats(540_000)

    // The point of the whole detector: VACUUM freed the heap and the index kept
    // every page.
    expect(await sizeOf('idx_events_k')).toBe(sizeBefore)
    expect(await density('idx_events_k')).toBeLessThan(BLOAT_DENSITY_PCT)
  }, 120_000)

  test('a cached healthy reading does not survive the churn that invalidated it', async () => {
    // The first version of this detector re-measured only on a SIZE change, and
    // the size is precisely what does not move when an index bloats. The healthy
    // reading taken in the previous describe block stayed cached and the probe
    // reported nothing. The 540k deletes above are what must invalidate it.
    //
    // Before the backdate the cooldown holds it, which is the other half of the
    // contract: a write-heavy table must not schedule an index scan every tick.
    expect(await detectIndexBloat(projectId)).toEqual([])

    await agePastCooldown()
    expect((await detectIndexBloat(projectId)).length).toBeGreaterThan(0)
  }, 60_000)

  test('the probe reports it with the measured density, not an estimate', async () => {
    const findings = await detectIndexBloat(projectId)
    const found = findings.find(f => (f.details as any).indexName === 'idx_events_k')
    expect(found).toBeDefined()
    const d = found!.details as any
    expect(d.tableName).toBe('events')
    expect(found!.autoFixable).toBe(true)
    expect(d.leafDensityPct).toBeLessThan(BLOAT_DENSITY_PCT)
    // Within rounding of the number pgstatindex actually returns.
    expect(Math.abs(d.leafDensityPct - (await density('idx_events_k')))).toBeLessThan(1)
    expect(d.reason).toMatch(/never shrinks on its own/i)
  }, 60_000)

  test('the primary key index is reported too, because REINDEX can rebuild it', async () => {
    // The deliberate difference from unused_index, whose probe excludes
    // constraint-backed indexes because DROP INDEX cannot touch them. REINDEX
    // can, and a bloated primary key is just as expensive to scan — so
    // excluding it here would have been copying a rule from the wrong repair.
    const findings = await detectIndexBloat(projectId)
    expect(findings.map(f => (f.details as any).indexName)).toContain('events_pkey')
  }, 60_000)

  test('it is auto-fixable, because a rebuild changes no data', () => {
    const details = { tableName: 'events', indexName: 'idx_events_k' }
    expect(classifyFix('index_bloat', details).decision).toBe('auto')
    expect(buildFixAction('index_bloat', details)).toEqual({
      action: 'REINDEX_INDEX',
      params: { tableName: 'events', indexName: 'idx_events_k' },
    })
  })
})

describe('the repair, and whether the loop can tell it worked', () => {
  test('REINDEX reclaims the space and reports how much', async () => {
    const sizeBefore = await sizeOf('idx_events_k')
    const res = await executeAction(
      { action: 'REINDEX_INDEX', params: { indexName: 'idx_events_k' } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(res.success).toBe(true)
    const sizeAfter = await sizeOf('idx_events_k')
    expect(sizeAfter).toBeLessThan(sizeBefore)
    // The message has to carry the evidence — "reindexed successfully" is not
    // proof that anything was reclaimed.
    expect(res.message).toMatch(/reclaimed/i)
    expect((res.data as any).reclaimedBytes).toBeGreaterThan(0)
  }, 120_000)

  test('REINDEX also works on the constraint-backed primary key index', async () => {
    const res = await executeAction(
      { action: 'REINDEX_INDEX', params: { indexName: 'events_pkey' } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(res.success).toBe(true)
    expect((res.data as any).reclaimedBytes).toBeGreaterThan(0)
  }, 120_000)

  test('the size change closes the gap immediately, bypassing the cooldown', async () => {
    // Without size-based invalidation the stale "bloated" reading would survive
    // its own repair, and evaluateFixOutcome would escalate a REINDEX that had
    // in fact worked. The cooldown is deliberately bypassed for this signal: a
    // half-hour wait to confirm a successful repair would escalate it first.
    const findings = await detectIndexBloat(projectId)
    expect(findings).toEqual([])
    expect(await density('idx_events_k')).toBeGreaterThan(BLOAT_DENSITY_PCT)
  }, 60_000)

  test('an index that no longer exists is a success, not a failure', async () => {
    const res = await executeAction(
      { action: 'REINDEX_INDEX', params: { indexName: 'idx_gone_entirely' } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(res.success).toBe(true)
    expect(res.message).toMatch(/no longer exists/i)
  }, 30_000)

  test('refuses an identifier that is not one', async () => {
    const res = await executeAction(
      { action: 'REINDEX_INDEX', params: { indexName: 'x"; DROP TABLE events; --' } } as any,
      projectId, undefined, 0, undefined, false,
    )
    expect(res.success).toBe(false)
    expect(res.message).toMatch(/not a valid PostgreSQL identifier/i)
  }, 30_000)

  test('the ledger forgets an index that is dropped', async () => {
    await pool.query(`DROP INDEX "${schema}"."idx_events_k"`)
    await detectIndexBloat(projectId)
    const rows = await prisma.projectPreference.findMany({
      where: { projectId, type: 'index_bloat_scan' },
      select: { key: true },
    })
    // The contract: an index the catalog no longer returns loses its entry.
    // Otherwise an index recreated under the same name would inherit a stale
    // baseline and could be reported bloated on the day it was built.
    expect(rows.map(r => r.key)).not.toContain('events.idx_events_k')

    // events_pkey is gone from the ledger too, and for a second legitimate
    // reason worth stating: both rebuilds took these indexes from 13 MB to
    // roughly a tenth of that, below BLOAT_MIN_INDEX_BYTES, so the catalog pass
    // stops returning them at all. Tracking an index too small to be worth
    // reporting would be pure bookkeeping.
    expect(rows).toEqual([])
    expect(await sizeOf('events_pkey')).toBeLessThan(BLOAT_MIN_INDEX_BYTES)
  }, 60_000)
})
