/**
 * PARTITIONING ADVICE — only for a table larger than PostgreSQL's cache
 * ---------------------------------------------------------------------
 * Production QA (2026-11-09): "Partitioning candidate: events" and
 * "Partitioning candidate: product_views", filed under Reliability with no next
 * step, for tables PostgreSQL served from memory. The scan advised partitioning
 * any table past a million rows, or past 100,000 with a log-like name, as a
 * change waiting for approval that had nothing to approve.
 *
 * The manual's rule of thumb (Table Partitioning, 5.12.1) is a table larger
 * than the server's memory. SQL cannot read physical memory; effective_cache_size
 * is the server's own estimate of the memory that caches its data, and the
 * advice names both numbers.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
import {
  detectPartitioningCandidates,
  planPartitionFindings,
  runAndStoreInfraIntelligence,
  runInfraIntelligence,
  type FiledPartitionFinding,
  type PartitioningFinding,
} from '@/lib/ai/infra-intelligence'
import { closureOf } from '@/lib/autonomy/resolution'
import { classifyFix } from '@/lib/core/fix-classifier'
import { getManualRemediationHint, hasExecutableFix } from '@/lib/core/fix-actions'
import { summariseFinding } from '@/lib/core/finding-summaries'
import { categoryOf } from '@/lib/core/finding-groups'

let userId: string
let projectId: string
let schema: string
let pool: Pool
/** Connections that say the server caches 64 kB, so a small table outgrows it. */
let smallCache: Pool

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { email: `partition-${Date.now()}@example.test`, password: 'x', name: 'partition' } })).id
  projectId = (await prisma.project.create({ data: { name: 'partition-advice', userId } })).id
  schema = `workspace_${projectId}`
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  smallCache = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, options: '-c effective_cache_size=64kB' })

  const q = (sql: string) => pool.query(sql)
  await q(`CREATE SCHEMA "${schema}"`)
  // Past 100,000 rows with a log-like name: the old rule's partitioning
  // candidate. A few megabytes.
  await q(`CREATE TABLE "${schema}".events (id bigserial PRIMARY KEY, kind text)`)
  await q(`INSERT INTO "${schema}".events (kind) SELECT 'view' FROM generate_series(1, 100001)`)
  await q(`CREATE TABLE "${schema}".notes (id bigserial PRIMARY KEY, body text)`)
  await q(`INSERT INTO "${schema}".notes (body) SELECT repeat('x', 200) FROM generate_series(1, 2000)`)
  // Backenly's own table: never the owner's to partition.
  await q(`CREATE TABLE "${schema}"._backenly_jobs (id bigserial PRIMARY KEY, payload text)`)
  await q(`INSERT INTO "${schema}"._backenly_jobs (payload) SELECT repeat('y', 200) FROM generate_series(1, 2000)`)
  // Already partitioned: neither the parent nor its partition is advice.
  await q(`CREATE TABLE "${schema}".visits (id bigint, at date NOT NULL) PARTITION BY RANGE (at)`)
  await q(`CREATE TABLE "${schema}".visits_2026 PARTITION OF "${schema}".visits FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`)
  await q(`INSERT INTO "${schema}".visits SELECT g, date '2026-03-01' FROM generate_series(1, 20000) g`)
  await q(`ANALYZE "${schema}".events, "${schema}".notes, "${schema}"._backenly_jobs, "${schema}".visits`)
}, 120_000)

afterAll(async () => {
  await prisma.healthFinding.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.platformNotification.deleteMany({ where: { projectId } }).catch(() => {})
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await pool.end()
  await smallCache.end()
  await prisma.project.delete({ where: { id: projectId } }).catch(() => {})
  await prisma.user.delete({ where: { id: userId } }).catch(() => {})
})

describe('detectPartitioningCandidates', () => {
  test("advises no partitioning in the report of a project whose tables all fit in the server's cache", async () => {
    const report = await runInfraIntelligence(projectId)
    expect(report.partitioningCandidates).toEqual([])
    expect(report.approvalRequired).toEqual([])
  })

  test('raises nothing for tables the server can cache, whatever their rows or names', async () => {
    expect(await detectPartitioningCandidates(pool, schema)).toEqual([])
  })

  test('names a table larger than the cache with both sizes; never a Backenly table or a partition', async () => {
    const found = await detectPartitioningCandidates(smallCache, schema)
    expect(found.map((f) => f.table).sort()).toEqual(['events', 'notes'])
    const events = found.find((f) => f.table === 'events')!
    expect(events.cacheBytes).toBe(64 * 1024)
    expect(events.bytes).toBeGreaterThan(64 * 1024)
    expect(events.liveRows).toBe(100001)
    expect(events.recommendation).toMatch(
      /^"events" takes [\d.]+ MB, more than the 64 kB PostgreSQL expects to have cached on this server, so reads of it cannot all come from memory\.$/,
    )
  })

  test('a read that fails rejects, rather than reading as "nothing to advise"', async () => {
    const broken = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, options: '-c effective_cache_size=not-a-size' })
    await expect(detectPartitioningCandidates(broken, schema)).rejects.toBeTruthy()
    await broken.end()
  })
})

describe('the stored scan', () => {
  test('withdraws what no longer holds, and never as a repair', async () => {
    // Raised under the old rule: no sizes. Its table fits in the cache.
    const legacy = await prisma.healthFinding.create({
      data: {
        projectId, type: 'infra_partition_events', severity: 'critical', status: 'open', autoFixed: false,
        details: { title: 'Partitioning candidate: events', table: 'events', requiresApproval: true },
      },
    })
    // Raised under this rule when the cache was smaller; it fits now.
    const fits = await prisma.healthFinding.create({
      data: {
        projectId, type: 'infra_partition_notes', severity: 'info', status: 'open', autoFixed: false,
        details: { title: 'Larger than the cache: notes', table: 'notes', tableName: 'notes', bytes: 700_000, cacheBytes: 65_536 },
      },
    })

    await runAndStoreInfraIntelligence(projectId, userId)

    const after = await prisma.healthFinding.findMany({ where: { projectId, type: { startsWith: 'infra_partition_' } } })
    const byId = new Map(after.map((f) => [f.id, f]))
    expect(closureOf(byId.get(legacy.id)!)).toBe('detector_retired')
    expect(closureOf(byId.get(fits.id)!)).toBe('condition_cleared')
    expect(after.filter((f) => f.status === 'open')).toEqual([])
  }, 60_000)
})

describe('planPartitionFindings', () => {
  const candidate = (table: string, bytes = 3 * 1024 ** 3): PartitioningFinding => ({
    table, liveRows: 1, bytes, cacheBytes: 1024 ** 3, recommendation: `"${table}" takes ${bytes}`,
  })
  const row = (type: string, status: string, details: Record<string, unknown>): FiledPartitionFinding => ({
    id: `${type}:${status}:${JSON.stringify(details)}`, type, status, details,
  })
  const sized = { cacheBytes: 1024 ** 3, bytes: 3 * 1024 ** 3 }

  test('changes nothing after a read that failed', () => {
    const plan = planPartitionFindings([row('infra_partition_events', 'open', {})], { scanned: false, candidates: [] })
    expect(plan).toEqual({ retire: [], cleared: [], refresh: [], raise: [] })
  })

  test('replaces a finding raised under the old rule when its table is still too big, and only withdraws it otherwise', () => {
    const old = row('infra_partition_events', 'open', { table: 'events' })
    const stale = row('infra_partition_logs', 'open', { table: 'logs' })
    const plan = planPartitionFindings([old, stale], { scanned: true, candidates: [candidate('events')] })
    expect(plan.retire).toEqual([old, stale])
    expect(plan.raise.map((f) => f.table)).toEqual(['events'])
    expect(plan.cleared).toEqual([])
  })

  test("never raises again what a person dismissed; raises again what Backenly withdrew", () => {
    const plan = planPartitionFindings(
      [
        row('infra_partition_events', 'dismissed', { ...sized, dismissedAt: '2026-11-01T00:00:00Z' }),
        row('infra_partition_logs', 'dismissed', { ...sized, withdrawnBy: 'infra_reaper' }),
      ],
      { scanned: true, candidates: [candidate('events'), candidate('logs')] },
    )
    expect(plan.raise.map((f) => f.table)).toEqual(['logs'])
  })

  test('keeps a finding that still holds, bringing its numbers up to date only when they moved', () => {
    const same = row('infra_partition_events', 'open', { ...sized, description: '"events" takes 3221225472', detectedAt: 'then' })
    const grown = row('infra_partition_logs', 'open', { ...sized, description: '"logs" takes 2', detectedAt: 'then' })
    const gone = row('infra_partition_notes', 'open', sized)
    const plan = planPartitionFindings([same, grown, gone], {
      scanned: true,
      candidates: [candidate('events'), candidate('logs', 5 * 1024 ** 3)],
    })
    expect(plan.raise).toEqual([])
    expect(plan.retire).toEqual([])
    expect(plan.cleared).toEqual([gone])
    expect(plan.refresh).toEqual([
      { id: grown.id, details: { ...sized, bytes: 5 * 1024 ** 3, liveRows: 1, description: `"logs" takes ${5 * 1024 ** 3}`, detectedAt: 'then' } },
    ])
  })
})

describe('the finding', () => {
  const details = { tableName: 'events', table: 'events', bytes: 3 * 1024 ** 3, cacheBytes: 1024 ** 3 }
  const legacy = { table: 'events', requiresApproval: true }

  test('is advice under Performance, whatever the table is called, with nothing to run', () => {
    expect(classifyFix('infra_partition_events', details).decision).toBe('notify_only')
    expect(hasExecutableFix('infra_partition_events', details)).toBe(false)
    expect(categoryOf({ type: 'infra_partition_auth_logs', details: { table: 'auth_logs' } } as any)).toBe('performance')
    expect(categoryOf({ type: 'infra_hot_table_users', details: { tableName: 'users' } } as any)).toBe('performance')
  })

  test('says why, and gives both ways forward', () => {
    expect(summariseFinding('infra_partition_events', details)).toBe("`events` is larger than PostgreSQL's cache: keep it smaller, or partition it")
    expect(getManualRemediationHint('infra_partition_events', details)).toBe(
      'events takes 3 GB, more than the 1 GB PostgreSQL expects to have cached on this server, so reads of it ' +
        'cannot all come from memory. Nothing is broken.\n\n' +
        'If old rows in events can go after a while, keep the table smaller: ask your coding agent to deploy a ' +
        'scheduled function that deletes rows older than the retention you choose. If every row must stay, ask ' +
        'your coding agent to plan partitioning events by the column your queries filter on, usually a date. ' +
        'That means creating a partitioned table and moving the rows across, which Backenly does not do on its own.',
    )
  })

  test('raised under the old rule, is not said to be larger than anything', () => {
    expect(summariseFinding('infra_partition_events', legacy)).toBe('`events` was flagged by a retired check that counted rows, not size')
    expect(getManualRemediationHint('infra_partition_events', legacy)).toBe(
      'Raised by a check Backenly has retired, which counted rows rather than size. The next scan withdraws it ' +
        "unless events is larger than PostgreSQL's cache. Nothing is broken.",
    )
  })
})
