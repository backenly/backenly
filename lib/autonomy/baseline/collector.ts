/**
 * BASELINE COLLECTOR — build the history a deviation can be measured against
 * ==========================================================================
 *
 * Samples three things per project, once an hour:
 *
 *   query       mean milliseconds per call, per query fingerprint
 *   table       sequential scans per hour, and bytes, per table
 *   connections concurrent sessions on this project's own direct-access roles
 *
 * ── Why these three ────────────────────────────────────────────────────────
 *
 * They are the three questions a developer asks about a backend that "feels
 * slow", and none of them was answerable before this. The platform could say a
 * query was over 100ms; it could not say the query used to take 4ms. It could
 * say a table was taking sequential scans; it could not say the scan rate had
 * tripled since Tuesday. It could count connections; it had no idea what this
 * project's normal was.
 *
 * ── Counters, not gauges ───────────────────────────────────────────────────
 *
 * pg_stat_statements and pg_stat_user_tables are CUMULATIVE since the last
 * statistics reset. Storing them raw would make every sample larger than the
 * last and every baseline meaningless. So the collector keeps the previous raw
 * reading per subject and stores the DELTA over the interval — and when a
 * counter goes backwards (someone ran pg_stat_reset, or the server restarted)
 * it re-baselines and stores nothing for that interval rather than recording a
 * negative or absurd value.
 *
 * ── Bounded on purpose ─────────────────────────────────────────────────────
 *
 * A project with ten thousand distinct query shapes must not write ten thousand
 * rows an hour. Only the heaviest MAX_QUERY_SUBJECTS by total time are tracked,
 * which is also the set anyone would look at. Same for tables.
 *
 * Never throws: one project's collection failing must not stop the sweep.
 */

import { Pool } from 'pg'
import { createHash } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { directAccessRoleNames } from '@/lib/services/direct-access'
import { hasCapability } from '../platform-capabilities'

/** Raw cumulative readings, kept between runs so deltas can be computed. */
const RAW_LEDGER_TYPE = 'baseline_raw'

export const MAX_QUERY_SUBJECTS = 20
export const MAX_TABLE_SUBJECTS = 30

/** How long samples are kept. Two weeks is plenty of baseline and a bounded table. */
export const RETENTION_DAYS = 14

let pool: Pool | null = null
function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  return pool
}

/** The hour a timestamp belongs to, in UTC. */
export function hourBucket(at: Date = new Date()): Date {
  const d = new Date(at)
  d.setUTCMinutes(0, 0, 0)
  return d
}

/**
 * A stable, readable identity for a query shape.
 *
 * pg_stat_statements has already replaced literals with $1, so the normalised
 * text IS the shape. It is hashed rather than stored as the subject because a
 * 400-character query does not belong in a unique index, and the text itself
 * travels in `metadata` where it can be read.
 */
export function queryFingerprint(normalisedSql: string): string {
  return createHash('sha1').update(normalisedSql.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16)
}

interface RawReading { [subject: string]: number }

async function loadRaw(projectId: string, kind: string): Promise<RawReading> {
  const row = await prisma.projectPreference.findFirst({
    where: { projectId, type: RAW_LEDGER_TYPE, key: kind },
    select: { value: true },
  }).catch(() => null)
  if (!row?.value) return {}
  try {
    const parsed = JSON.parse(row.value)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch { return {} }
}

async function saveRaw(projectId: string, kind: string, reading: RawReading): Promise<void> {
  await prisma.projectPreference.upsert({
    where: { projectId_type_key: { projectId, type: RAW_LEDGER_TYPE, key: kind } },
    create: {
      projectId, type: RAW_LEDGER_TYPE, key: kind,
      value: JSON.stringify(reading), confidence: 1,
    },
    update: { value: JSON.stringify(reading), lastSeen: new Date() },
  }).catch(() => { /* observability — never a blocker */ })
}

async function writeSample(
  projectId: string,
  kind: string,
  subject: string,
  bucket: Date,
  value: number,
  samples: number,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await prisma.dbBaselineSample.upsert({
    where: { projectId_kind_subject_bucket: { projectId, kind, subject, bucket } },
    create: { projectId, kind, subject, bucket, value, samples, metadata: metadata as any },
    // Re-running inside the same hour refines the sample. The collector is
    // scheduled hourly, so this is the retry path rather than the normal one.
    update: { value, samples, metadata: metadata as any },
  }).catch(() => { /* one sample lost is not worth failing a sweep */ })
}

// ── Query latency ────────────────────────────────────────────────────────────

/**
 * Mean milliseconds per call, over THIS interval, per query shape.
 *
 * The delta matters more than it looks: `mean_exec_time` in pg_stat_statements
 * is the mean since the statistics were reset, so a query that has run a million
 * times at 4ms and just started taking 400ms barely moves it. Dividing the delta
 * in total time by the delta in calls gives the mean for the last hour, which is
 * the number that actually changes when something breaks.
 */
async function collectQueryLatency(
  projectId: string,
  schema: string,
  bucket: Date,
): Promise<void> {
  const cap = await hasCapability('pg_stat_statements')
  if (!cap.available) return

  const res = await getPool().query<{
    query: string
    calls: string
    total_ms: string
  }>(
    `SELECT LEFT(query, 400) AS query, calls, total_exec_time AS total_ms
       FROM pg_stat_statements
      WHERE position($1 in query) > 0
        AND query NOT LIKE '%pg_catalog%'
        AND query NOT LIKE '%information_schema%'
      ORDER BY total_exec_time DESC
      LIMIT ${MAX_QUERY_SUBJECTS}`,
    [schema],
  )
  if (res.rows.length === 0) return

  const prevCalls = await loadRaw(projectId, 'query_calls')
  const prevTotal = await loadRaw(projectId, 'query_total_ms')
  const nextCalls: RawReading = {}
  const nextTotal: RawReading = {}

  for (const r of res.rows) {
    const fp = queryFingerprint(r.query)
    const calls = Number(r.calls) || 0
    const totalMs = Number(r.total_ms) || 0
    nextCalls[fp] = calls
    nextTotal[fp] = totalMs

    const pc = prevCalls[fp]
    const pt = prevTotal[fp]
    // No prior reading, or the counters went backwards (stats reset / restart).
    // Re-baseline and record nothing: a delta across a reset is fiction.
    if (pc === undefined || pt === undefined || calls < pc || totalMs < pt) continue

    const dCalls = calls - pc
    const dTotal = totalMs - pt
    if (dCalls <= 0) continue // ran zero times this hour — no latency to report

    await writeSample(
      projectId, 'query', fp, bucket,
      dTotal / dCalls, dCalls,
      { sql: r.query.replace(/\s+/g, ' ').trim().slice(0, 300) },
    )
  }

  await saveRaw(projectId, 'query_calls', nextCalls)
  await saveRaw(projectId, 'query_total_ms', nextTotal)
}

// ── Table scans and size ─────────────────────────────────────────────────────

async function collectTableActivity(
  projectId: string,
  schema: string,
  bucket: Date,
): Promise<void> {
  const res = await getPool().query<{
    relname: string
    seq_scan: string
    live_rows: string
    total_bytes: string
  }>(
    `SELECT s.relname,
            s.seq_scan,
            s.n_live_tup                         AS live_rows,
            pg_total_relation_size(c.oid)::text  AS total_bytes
       FROM pg_stat_user_tables s
       JOIN pg_class c     ON c.relname = s.relname
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = s.schemaname
      WHERE s.schemaname = $1
        AND left(s.relname, 1) <> '_'
      ORDER BY s.seq_scan DESC
      LIMIT ${MAX_TABLE_SUBJECTS}`,
    [schema],
  )
  if (res.rows.length === 0) return

  const prevScans = await loadRaw(projectId, 'table_seq_scan')
  const nextScans: RawReading = {}

  for (const r of res.rows) {
    const table = r.relname
    const scans = Number(r.seq_scan) || 0
    nextScans[table] = scans

    const bytes = Number(r.total_bytes) || 0
    const liveRows = Number(r.live_rows) || 0

    // SIZE is a gauge, not a counter — it is recorded every hour regardless of
    // history, which is what makes "this table grew 40x this week" answerable.
    await writeSample(
      projectId, 'table', `${table}:bytes`, bucket,
      bytes, 1, { table, liveRows },
    )

    // SCANS is a counter, so only the delta is meaningful.
    const ps = prevScans[table]
    if (ps === undefined || scans < ps) continue
    await writeSample(
      projectId, 'table', `${table}:seq_scan`, bucket,
      scans - ps, 1, { table, liveRows },
    )
  }

  await saveRaw(projectId, 'table_seq_scan', nextScans)
}

// ── Connections ──────────────────────────────────────────────────────────────

/**
 * Sessions held by this project's own direct-access roles.
 *
 * A gauge sampled once an hour, so it is a coarse picture rather than a peak
 * detector — deliberately. The question this answers is "does this project
 * normally hold three connections or thirty", which is exactly the thing an
 * absolute threshold on a shared cluster could never tell anyone.
 */
async function collectConnections(projectId: string, bucket: Date): Promise<void> {
  const roles = directAccessRoleNames(projectId)
  const res = await getPool().query<{ total: string; idle_in_tx: string }>(
    `SELECT COUNT(*)::text                                                  AS total,
            COUNT(*) FILTER (WHERE state = 'idle in transaction')::text     AS idle_in_tx
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = ANY($1::text[])`,
    [[roles.ro, roles.rw, roles.owner]],
  )
  const total = Number(res.rows[0]?.total ?? 0)
  await writeSample(
    projectId, 'connections', 'project', bucket,
    total, 1, { idleInTransaction: Number(res.rows[0]?.idle_in_tx ?? 0) },
  )
}

// ── Entry points ─────────────────────────────────────────────────────────────

/** Collect one project's hourly sample. Never throws. */
export async function collectBaseline(projectId: string, at: Date = new Date()): Promise<void> {
  const schema = `workspace_${projectId}`
  const bucket = hourBucket(at)
  // allSettled, not sequential awaits: one collector failing (a missing
  // extension, a dropped schema mid-sweep) must not cost the other two.
  await Promise.allSettled([
    collectQueryLatency(projectId, schema, bucket),
    collectTableActivity(projectId, schema, bucket),
    collectConnections(projectId, bucket),
  ])
}

/**
 * Drop samples past the retention window.
 *
 * Deliberately global rather than per project: it is one indexed delete on
 * `bucket`, and running it per project would do the same work N times.
 */
export async function pruneBaseline(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const res = await prisma.dbBaselineSample
    .deleteMany({ where: { bucket: { lt: cutoff } } })
    .catch(() => ({ count: 0 }))
  return res.count
}
