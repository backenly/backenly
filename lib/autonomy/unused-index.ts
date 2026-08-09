/**
 * UNUSED INDEXES — the one performance repair that costs something to be wrong
 * ============================================================================
 *
 * Every index is paid for on every INSERT and UPDATE of its table, forever. An
 * index nothing reads is pure cost, and finding them is a standard part of
 * running Postgres well.
 *
 * ── Why this took its own module rather than joining the infra scan ──────────
 *
 * `detectIndexIssues` in lib/ai/infra-intelligence.ts already computed this. Its
 * results went into `InfraReport.approvalRequired`, which nothing persisted,
 * nothing rendered, and no route returned. It was a correct query whose answer
 * was thrown away on every run — the platform knew about the wasted write
 * throughput and never said so.
 *
 * It could not simply be wired up as it stood, because its evidence was
 * `idx_scan < 10`, and `idx_scan` is a COUNTER SINCE THE STATISTICS WERE LAST
 * RESET. It says nothing about elapsed time. An index created ten minutes ago
 * has zero scans. An index on a table nobody has touched since the last
 * `pg_stat_reset()` has zero scans. A perfectly load-bearing index on a
 * quarter-end report has zero scans in April. Filing any of those as "unused,
 * safe to drop" is the finding-evidence policy's exact prohibition: a claim
 * about runtime behaviour with no runtime observation behind it.
 *
 * ── The evidence this module requires instead ────────────────────────────────
 *
 * A per-index observation ledger. On first sight of an index we record the
 * timestamp and its current scan count and raise NOTHING. On later passes the
 * evidence is the DELTA over the observed window:
 *
 *     scansNow - scansAtFirstSight, over (now - firstSeenAt)
 *
 * Only once that window is at least UNUSED_INDEX_MIN_OBSERVATION_DAYS and the
 * delta is zero does the index become a finding. That is an actual measurement:
 * "Backenly watched this index for fourteen days and Postgres never once used
 * it." It is also reset-proof — if `scansNow < scansAtFirstSight` the statistics
 * were reset underneath us, so the baseline is re-established and the clock
 * starts again rather than reporting a negative delta as zero usage.
 *
 * ── Why this is never automatic ─────────────────────────────────────────────
 *
 * Dropping an index is reversible in principle (the pre-fix snapshot carries its
 * full definition and the rollback engine recreates it) but expensive in
 * practice: rebuilding one on a large table takes minutes and, unless the drop
 * was CONCURRENTLY-safe, the queries that needed it are slow the entire time.
 * More importantly, "no reads in fourteen days" is evidence, not proof — only
 * the person who wrote the application knows about the quarterly job. So this is
 * classified `approval`: Backenly states what it measured and the owner decides.
 *
 * Read-only. Never drops anything itself.
 */

import { prisma } from '@/lib/db/prisma'
import { queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { probeQueryFailed } from '@/lib/core/drift-detector'
import type { RawFinding } from '@/lib/core/types'

/** ProjectPreference bucket holding the per-index observation ledger. */
const LEDGER_TYPE = 'index_usage'

/**
 * How long an index must be watched before its silence means anything.
 *
 * Fourteen days rather than seven so a weekly job — the most common thing a
 * short window mistakes for an unused index — has had two chances to run.
 */
export const UNUSED_INDEX_MIN_OBSERVATION_DAYS = 14

/**
 * Minimum size before a never-read index is worth a human's attention.
 *
 * An 8KB index costs almost nothing to keep. Reporting it spends the queue's
 * credibility on a recommendation whose upside is unmeasurable, which is how a
 * review queue trains its reader to skim.
 */
export const UNUSED_INDEX_MIN_BYTES = 1024 * 1024 // 1 MB

interface LiveIndex {
  index_name: string
  table_name: string
  idx_scan: string | number
  size_bytes: string | number
  definition: string
}

interface LedgerEntry {
  firstSeenAt: string
  scansAtFirstSeen: number
}

function parseEntry(raw: string | null | undefined): LedgerEntry | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (typeof v?.firstSeenAt === 'string' && typeof v?.scansAtFirstSeen === 'number') return v
  } catch { /* a malformed row re-baselines below */ }
  return null
}

/**
 * Indexes this project has never used, measured over a real window.
 *
 * Constraint-backed indexes (PRIMARY KEY / UNIQUE) are excluded at the SQL
 * level and not merely filtered afterwards: they cannot be dropped with DROP
 * INDEX at all, so reporting one produces a finding whose only possible repair
 * fails. Their scan counts are also meaningless as usage — the index exists to
 * enforce the constraint on every write, not to serve reads.
 */
export async function detectUnusedIndexes(projectId: string): Promise<RawFinding[]> {
  const schema = `workspace_${projectId}`

  const res = await queryWorkspaceSchema(
    projectId,
    `SELECT i.relname                    AS index_name,
            t.relname                    AS table_name,
            COALESCE(s.idx_scan, 0)      AS idx_scan,
            pg_relation_size(i.oid)      AS size_bytes,
            pg_get_indexdef(i.oid)       AS definition
       FROM pg_index ix
       JOIN pg_class t     ON t.oid = ix.indrelid
       JOIN pg_class i     ON i.oid = ix.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = ix.indexrelid
      WHERE n.nspname = $1
        AND t.relkind = 'r'
        AND ix.indisprimary = false
        AND ix.indisunique  = false
        -- Backing an explicit constraint (EXCLUDE, deferred UNIQUE). DROP INDEX
        -- refuses these outright; only ALTER TABLE ... DROP CONSTRAINT works.
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint c WHERE c.conindid = i.oid
        )
        -- Platform-internal tables are not the owner's to tune.
        AND left(t.relname, 1) <> '_'`,
    schema,
  ).catch(probeQueryFailed('detectUnusedIndexes/catalog'))

  const live: LiveIndex[] = res?.rows ?? res ?? []
  if (live.length === 0) {
    await pruneLedger(projectId, new Set())
    return []
  }

  const ledgerRows = await prisma.projectPreference.findMany({
    where: { projectId, type: LEDGER_TYPE },
    select: { key: true, value: true },
  }).catch(() => [] as Array<{ key: string; value: string }>)
  const ledger = new Map(ledgerRows.map(r => [r.key, parseEntry(r.value)]))

  const now = Date.now()
  const windowMs = UNUSED_INDEX_MIN_OBSERVATION_DAYS * 24 * 60 * 60 * 1000
  const findings: RawFinding[] = []
  const seen = new Set<string>()

  for (const idx of live) {
    const key = `${idx.table_name}.${idx.index_name}`
    seen.add(key)
    const scans = Number(idx.idx_scan) || 0
    const sizeBytes = Number(idx.size_bytes) || 0
    const prior = ledger.get(key) ?? null

    // First sight, or statistics were reset underneath us (a counter can only
    // go down that way). Either way there is no window yet — record and stay
    // silent. Reporting here would be a claim about a period we did not watch.
    if (!prior || scans < prior.scansAtFirstSeen) {
      await recordBaseline(projectId, key, scans)
      continue
    }

    const observedMs = now - new Date(prior.firstSeenAt).getTime()
    if (!Number.isFinite(observedMs) || observedMs < windowMs) continue
    if (scans > prior.scansAtFirstSeen) continue // used at least once — nothing to say
    if (sizeBytes < UNUSED_INDEX_MIN_BYTES) continue

    const days = Math.floor(observedMs / (24 * 60 * 60 * 1000))
    findings.push({
      type: 'unused_index',
      severity: 'info',
      autoFixable: false, // approval-gated: see the module header
      details: {
        tableName: idx.table_name,
        indexName: idx.index_name,
        location: key,
        sizeBytes,
        observedDays: days,
        scansInWindow: 0,
        definition: idx.definition,
        // Carried so the approval modal and the audit row can show exactly what
        // will run, and so a human can paste it if they would rather not
        // delegate the drop.
        sql: `DROP INDEX CONCURRENTLY IF EXISTS "${schema}"."${idx.index_name}";`,
        reason:
          `Backenly watched "${idx.index_name}" on "${idx.table_name}" for ${days} days and ` +
          `PostgreSQL never used it once, while it costs ${fmtBytes(sizeBytes)} of storage and ` +
          `a write on every insert and update to the table. Dropping it is reversible — the ` +
          `pre-fix snapshot keeps its full definition — but only you know whether something ` +
          `that runs less often than ${days} days needs it.`,
      },
    })
  }

  await pruneLedger(projectId, seen)
  return findings
}

async function recordBaseline(projectId: string, key: string, scans: number): Promise<void> {
  const entry: LedgerEntry = {
    firstSeenAt: new Date().toISOString(),
    scansAtFirstSeen: scans,
  }
  await prisma.projectPreference.upsert({
    where: { projectId_type_key: { projectId, type: LEDGER_TYPE, key } },
    create: {
      projectId, type: LEDGER_TYPE, key,
      value: JSON.stringify(entry), confidence: 1,
    },
    update: { value: JSON.stringify(entry), lastSeen: new Date() },
  }).catch(() => { /* the ledger is observability — never a probe blocker */ })
}

/**
 * Forget indexes that no longer exist.
 *
 * Without this, dropping and later recreating an index under the same name
 * would inherit the OLD baseline — so a brand-new index could be reported as
 * "never used in 40 days" on the day it was created.
 */
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

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${b} B`
}
