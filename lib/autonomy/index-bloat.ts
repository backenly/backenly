/**
 * INDEX BLOAT — the kind the infra report declared and never once emitted
 * =======================================================================
 *
 * `IndexFinding.kind` in lib/ai/infra-intelligence.ts listed `'fragmented'`
 * alongside `'unused'` and `'missing'`. Nothing ever produced it. Table bloat
 * had a real detector and a real repair; index bloat had a string in a union.
 *
 * It is worth having because a btree does not shrink on its own. Delete or
 * update most of a table's rows and `VACUUM` marks the heap reusable, but the
 * index keeps every page it ever allocated — now mostly empty. Measured on a
 * real 200k-row table: deleting 90% of the rows and vacuuming left the index at
 * 9.26% leaf density and exactly the same 4.5 MB on disk. Every scan of it then
 * walks ten times more pages than it needs to, and the space is never returned.
 * `REINDEX` restored it to 89.5% density and 467 KB.
 *
 * ── Why this needs pgstattuple, and what happens without it ─────────────────
 *
 * Leaf density is not in any statistics view. The well-known "index bloat
 * estimate" queries derive it from column widths and row counts, and they are
 * approximations that go wrong on exactly the schemas people ask about (wide
 * text keys, partial indexes, non-default fillfactor). `pgstatindex()` reads the
 * index and reports the real number.
 *
 * That makes it a declared platform capability (see platform-capabilities.ts).
 * When `pgstattuple` is absent this invariant reports UNCHECKED rather than
 * satisfied — the alternative is a probe that returns nothing and is
 * indistinguishable from a healthy backend. Unlike pg_stat_statements it is a
 * plain extension: `CREATE EXTENSION pgstattuple` needs no preload and no
 * restart.
 *
 * ── Why the measurement is rate-limited, and what re-triggers it ────────────
 *
 * `pgstatindex()` walks the whole index. This catalogue runs every minute, so
 * measuring every large index on every tick would spend real I/O forever to
 * re-learn a number that moves over days. Each index therefore carries a ledger
 * entry and is re-measured only on a signal.
 *
 * Getting those signals right took two attempts, and the first one was wrong in
 * an instructive way. It re-measured when the index SIZE changed — which is
 * exactly the signal for verifying the REPAIR (a REINDEX shrinks the index, the
 * next tick notices, the gap closes, and evaluateFixOutcome can certify a fix
 * that worked) and exactly the wrong signal for DETECTING the problem. Bloat
 * accumulates with the size unchanged: that is the entire phenomenon. Deleting
 * 90% of a table and vacuuming leaves the index byte-for-byte the same size and
 * mostly empty, so a healthy reading taken beforehand stayed cached and the
 * detector reported nothing.
 *
 * The detection signal is WRITE VOLUME on the table. Leaf density can only fall
 * through dead index entries, and those come from updates and deletes, which
 * `pg_stat_user_tables` already counts. So the triggers are:
 *
 *   • no entry yet
 *   • the index size changed        → the repair landed (or a rebuild happened)
 *   • updates + deletes advanced by REMEASURE_AFTER_WRITES → bloat may have grown
 *   • those counters went BACKWARDS → statistics were reset, the delta is void
 *   • the entry is older than MEASUREMENT_TTL_HOURS → catch-all
 *
 * bounded underneath by MIN_REMEASURE_MINUTES so a write-heavy table cannot
 * trigger a full index scan every minute.
 *
 * Read-only. The repair (REINDEX_INDEX) lives in the executor.
 */

import { prisma } from '@/lib/db/prisma'
import { queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { probeQueryFailed } from '@/lib/core/drift-detector'
import type { RawFinding } from '@/lib/core/types'

const LEDGER_TYPE = 'index_bloat_scan'

/**
 * Leaf density below which a rebuild is worth its I/O.
 *
 * A freshly built btree sits near 90%. Postgres itself leaves headroom for
 * inserts, so a healthy, actively-written index lives comfortably in the 60-80%
 * range and rebuilding one there reclaims almost nothing while costing a full
 * index scan and a temporary double of its size on disk.
 *
 * Fifty percent means the index is carrying at least as much empty space as
 * data. That is the point where the rebuild pays for itself in pages read on
 * every subsequent scan, and it is comfortably clear of normal operation, so a
 * write-heavy index does not flap in and out of the queue.
 */
export const BLOAT_DENSITY_PCT = 50

/**
 * Size floor. Below this the reclaim is not worth a line in anyone's queue —
 * and `pgstatindex` on a small index is cheap but so is the saving.
 */
export const BLOAT_MIN_INDEX_BYTES = 10 * 1024 * 1024 // 10 MB

/** Catch-all staleness bound on a density measurement. */
export const MEASUREMENT_TTL_HOURS = 6

/**
 * Updates + deletes on the table since the last measurement before the density
 * reading is considered out of date.
 *
 * This is the DETECTION trigger. Ten thousand is low enough that real churn is
 * noticed within a working day on any table busy enough for bloat to matter, and
 * high enough that a trickle of edits does not schedule an index scan.
 */
export const REMEASURE_AFTER_WRITES = 10_000

/**
 * Floor on how often one index may be re-measured, whatever the triggers say.
 * A very write-heavy table would otherwise schedule a full index scan every
 * minute, which is the cost this whole ledger exists to avoid.
 */
export const MIN_REMEASURE_MINUTES = 30

/**
 * Most indexes measured per pass. A project with many large indexes spreads its
 * measurements across ticks instead of stalling one.
 */
const MAX_MEASUREMENTS_PER_PASS = 5

interface LedgerEntry {
  measuredAt: string
  /** avg_leaf_density as reported by pgstatindex, 0-100. */
  density: number
  /** Size at measurement time — a change means the index was rebuilt. */
  sizeBytes: number
  /**
   * n_tup_upd + n_tup_del on the owning table at measurement time. Bloat can
   * only accumulate through those, so their advance is what makes a cached
   * reading stale. Optional so entries written before this field existed simply
   * re-measure once rather than being discarded.
   */
  tableWrites?: number
}

function parseEntry(raw: string | null | undefined): LedgerEntry | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (
      typeof v?.measuredAt === 'string' &&
      typeof v?.density === 'number' &&
      typeof v?.sizeBytes === 'number'
    ) return v
  } catch { /* a malformed row re-measures below */ }
  return null
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(0)} MB`
  return `${(b / 1024).toFixed(0)} KB`
}

export async function detectIndexBloat(projectId: string): Promise<RawFinding[]> {
  const schema = `workspace_${projectId}`

  // Cheap catalog pass: names and sizes only, no index scans.
  const res = await queryWorkspaceSchema(
    projectId,
    // pg_relation_size is a filesystem stat per relation, so it is computed ONCE
    // in a subquery rather than in both the projection and the predicate. With
    // it in both places the catalog pass timed out under load, and because every
    // probe here throws rather than swallowing, that took the whole invariant
    // down instead of quietly returning nothing — which is the right failure
    // mode, and also the one that made the cost visible.
    `SELECT index_name, table_name, size_bytes, table_writes
       FROM (
         SELECT i.relname               AS index_name,
                t.relname               AS table_name,
                pg_relation_size(i.oid) AS size_bytes,
                -- The detection signal: dead index entries can only come from
                -- updates and deletes, which pg_stat_user_tables already counts.
                COALESCE(s.n_tup_upd, 0) + COALESCE(s.n_tup_del, 0) AS table_writes
           FROM pg_index ix
           JOIN pg_class t     ON t.oid = ix.indrelid
           JOIN pg_class i     ON i.oid = ix.indexrelid
           JOIN pg_namespace n ON n.oid = i.relnamespace
           JOIN pg_am am       ON am.oid = i.relam
           LEFT JOIN pg_stat_user_tables s ON s.relid = t.oid
          WHERE n.nspname = $1
            AND t.relkind = 'r'
            -- pgstatindex only understands btree. Calling it on gin/gist raises
            -- rather than returning nothing, so this is a correctness filter.
            AND am.amname = 'btree'
            AND left(t.relname, 1) <> '_'
       ) sized
      WHERE size_bytes >= ${BLOAT_MIN_INDEX_BYTES}`,
    schema,
  ).catch(probeQueryFailed('detectIndexBloat/catalog'))

  const live: Array<{
    index_name: string
    table_name: string
    size_bytes: string | number
    table_writes: string | number
  }> = res?.rows ?? res ?? []

  const seen = new Set(live.map(r => `${r.table_name}.${r.index_name}`))
  if (live.length === 0) {
    await pruneLedger(projectId, seen)
    return []
  }

  const ledgerRows = await prisma.projectPreference.findMany({
    where: { projectId, type: LEDGER_TYPE },
    select: { key: true, value: true },
  }).catch(() => [] as Array<{ key: string; value: string }>)
  const ledger = new Map(ledgerRows.map(r => [r.key, parseEntry(r.value)]))

  const ttlMs = MEASUREMENT_TTL_HOURS * 60 * 60 * 1000
  const now = Date.now()
  let measured = 0
  const findings: RawFinding[] = []

  for (const row of live) {
    const key = `${row.table_name}.${row.index_name}`
    const sizeBytes = Number(row.size_bytes) || 0
    const tableWrites = Number(row.table_writes) || 0
    const prior = ledger.get(key) ?? null

    const ageMs = prior === null ? Infinity : now - new Date(prior.measuredAt).getTime()

    // The size change is what makes the REPAIR verifiable: a REINDEX shrinks the
    // index, so a stale "bloated" reading cannot outlive the fix that worked.
    const sizeChanged = prior !== null && prior.sizeBytes !== sizeBytes

    // Write volume is what makes DETECTION possible. Bloat accumulates with the
    // size unchanged — that is the whole phenomenon — so size alone would keep a
    // healthy reading cached through exactly the churn that invalidates it.
    // A counter that went backwards means the statistics were reset, which makes
    // the delta meaningless rather than small.
    const priorWrites = prior?.tableWrites
    const writesAdvanced =
      prior !== null && (
        priorWrites === undefined ||
        tableWrites < priorWrites ||
        tableWrites - priorWrites >= REMEASURE_AFTER_WRITES
      )

    const expired = ageMs > ttlMs
    const cooldownPassed = ageMs >= MIN_REMEASURE_MINUTES * 60 * 1000

    const needsMeasurement =
      prior === null ||
      // Size change bypasses the cooldown: it means the index was just rebuilt,
      // and making the owner wait half an hour to see their repair confirmed
      // would escalate a successful fix in the meantime.
      sizeChanged ||
      (cooldownPassed && (writesAdvanced || expired))

    let density = prior?.density ?? null
    if (needsMeasurement) {
      if (measured >= MAX_MEASUREMENTS_PER_PASS) {
        // Deferred to a later tick. Report nothing for this index rather than
        // reporting a reading we just decided not to trust.
        continue
      }
      measured++
      density = await measureDensity(projectId, schema, row.index_name)
      if (density === null) continue
      await recordMeasurement(projectId, key, density, sizeBytes, tableWrites)
    }

    if (density === null || density >= BLOAT_DENSITY_PCT) continue

    findings.push({
      type: 'index_bloat',
      severity: 'warning',
      autoFixable: true,
      details: {
        tableName: row.table_name,
        indexName: row.index_name,
        location: key,
        leafDensityPct: Math.round(density * 10) / 10,
        sizeBytes,
        reason:
          `Index "${row.index_name}" on "${row.table_name}" is only ${density.toFixed(1)}% full — ` +
          `it is holding ${fmtBytes(sizeBytes)} of pages that are mostly empty, so every scan of it ` +
          `reads far more of the disk than it needs to. A btree never shrinks on its own after rows ` +
          `are deleted or updated; rebuilding it reclaims the space and changes no data.`,
      },
    })
  }

  await pruneLedger(projectId, seen)
  return findings
}

/**
 * Real leaf density from pgstatindex. Null when it cannot be measured.
 *
 * Never throws: an index can be dropped between the catalog pass and this call,
 * and a missing index is not a probe failure. The capability gate in
 * desired-state.ts is what reports the extension being absent.
 */
async function measureDensity(
  projectId: string,
  schema: string,
  indexName: string,
): Promise<number | null> {
  try {
    // Passed as a VALUE, not interpolated: pgstatindex takes a regclass, and
    // building that string by concatenation is how an identifier with a quote in
    // it would reach the parser.
    const res = await queryWorkspaceSchema(
      projectId,
      `SELECT avg_leaf_density FROM pgstatindex(format('%I.%I', $1::text, $2::text)::regclass)`,
      schema,
      indexName,
    )
    const rows = (res?.rows ?? res ?? []) as Array<{ avg_leaf_density: number | string }>
    const d = Number(rows[0]?.avg_leaf_density)
    return Number.isFinite(d) ? d : null
  } catch {
    return null
  }
}

async function recordMeasurement(
  projectId: string,
  key: string,
  density: number,
  sizeBytes: number,
  tableWrites: number,
): Promise<void> {
  const entry: LedgerEntry = {
    measuredAt: new Date().toISOString(),
    density,
    sizeBytes,
    tableWrites,
  }
  await prisma.projectPreference.upsert({
    where: { projectId_type_key: { projectId, type: LEDGER_TYPE, key } },
    create: {
      projectId, type: LEDGER_TYPE, key,
      value: JSON.stringify(entry), confidence: 1,
    },
    update: { value: JSON.stringify(entry), lastSeen: new Date() },
  }).catch(() => { /* the ledger is observability, never a probe blocker */ })
}

/** Forget measurements for indexes that no longer exist. */
async function pruneLedger(projectId: string, seen: Set<string>): Promise<void> {
  const rows = await prisma.projectPreference.findMany({
    where: { projectId, type: LEDGER_TYPE },
    select: { key: true },
  }).catch(() => [] as Array<{ key: string }>)
  const gone = rows.map(r => r.key).filter(k => !seen.has(k))
  if (gone.length === 0) return
  await prisma.projectPreference.deleteMany({
    where: { projectId, type: LEDGER_TYPE, key: { in: gone } },
  }).catch(() => { /* non-fatal */ })
}
