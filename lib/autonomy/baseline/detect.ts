/**
 * BEHAVIOURAL REGRESSION — this backend is behaving unlike itself
 * ===============================================================
 *
 * The invariant probe over the baseline collector's time series. Every other
 * probe in the catalogue asks whether the backend is SHAPED correctly or is
 * ANSWERING; this one asks whether it is behaving the way it usually does.
 *
 * Three subjects, three different questions:
 *
 *   query latency   a statement that used to take 4ms now takes 60ms. Fast by
 *                   any fixed threshold, fifteen times worse than its own
 *                   normal, and the thing the developer actually noticed.
 *   sequential scans  a table being scanned far more than usual — the shape of
 *                   a query that lost its index path or a new code path that
 *                   filters on something unindexed.
 *   table size      unexpected growth. A table that quietly went from 40 MB to
 *                   4 GB is a runaway writer, and nothing else here would say
 *                   a word about it.
 *
 * ── Never auto-fixed, and that is not caution ──────────────────────────────
 *
 * A deviation is a SYMPTOM. The repair depends entirely on the cause, and the
 * cause is not in the data: a query that got slower might need an index, or
 * might be scanning ten times more rows because the product got popular. The
 * platform's own rule is that a finding with no determinable correct action is
 * notify_only, and this is the clearest case of it in the catalogue.
 *
 * What the finding carries instead is the measurement AND what changed on this
 * backend just before it — which is the next thing anyone would go and look up
 * by hand.
 */

import { prisma } from '@/lib/db/prisma'
import type { RawFinding } from '@/lib/core/types'
import { judgeDeviation, describeDeviation, type Sample } from './deviation'
import { changesBefore, summariseCorrelation } from '../change-correlation'
import { hourBucket, RETENTION_DAYS } from './collector'

/**
 * How much worse than normal is worth reporting, per subject.
 *
 * Latency is tightest: a query at three times its own baseline is unambiguous,
 * and latency is the measure with the least natural variance once the baseline
 * stability check has passed. Scans and size are looser because both legitimately
 * grow with usage — a table doubling in a week is a product working.
 */
export const THRESHOLDS = {
  latencyRatio: 3,
  scanRatio: 5,
  sizeRatio: 4,
} as const

/**
 * Floors, below which a ratio is arithmetic rather than a problem.
 *
 * 25ms: a query going from 1ms to 20ms is 20x and nobody will ever act on it.
 * 500 scans/hour: below this the table is barely being read.
 * 256 MB: a table going from 1 MB to 100 MB is 100x and still small.
 */
export const FLOORS = {
  latencyMs: 25,
  scansPerHour: 500,
  sizeBytes: 256 * 1024 * 1024,
} as const

interface SubjectSpec {
  kind: string
  /** Matches the stored `subject`; null means every subject of this kind. */
  suffix: string | null
  threshold: number
  floor: number
  unit: string
  label: (subject: string, metadata: Record<string, unknown>) => string
  /** What this deviation means, in the finding's own words. */
  consequence: string
}

const SPECS: SubjectSpec[] = [
  {
    kind: 'query',
    suffix: null,
    threshold: THRESHOLDS.latencyRatio,
    floor: FLOORS.latencyMs,
    unit: 'ms',
    label: (_s, m) => `The query ${String(m.sql ?? '').slice(0, 80)}…`,
    consequence:
      'Every request that runs it is paying that difference. Nothing in the schema changed shape, ' +
      'so this is a behaviour change rather than a missing index the shape probes would have caught.',
  },
  {
    kind: 'table',
    suffix: ':seq_scan',
    threshold: THRESHOLDS.scanRatio,
    floor: FLOORS.scansPerHour,
    unit: ' scans/hour',
    label: (s) => `Sequential scans on "${s.replace(/:seq_scan$/, '')}"`,
    consequence:
      'A jump in full-table reads usually means a query stopped using an index — a new filter ' +
      'column, a changed predicate, or an index that was dropped.',
  },
  {
    kind: 'table',
    suffix: ':bytes',
    threshold: THRESHOLDS.sizeRatio,
    floor: FLOORS.sizeBytes,
    unit: ' bytes',
    label: (s) => `The size of "${s.replace(/:bytes$/, '')}"`,
    consequence:
      'Growth this far outside the table\'s own pattern is usually a writer that lost its bound — ' +
      'a retry loop, a missing cleanup, or a job that started running more often than intended.',
  },
]

/**
 * Deviations from this project's own measured normal.
 *
 * Returns [] when there is no baseline yet, and that is correct rather than
 * evasive: the collector needs twelve hours before it can say anything, and
 * claiming a regression from three data points would be the noise that teaches
 * an owner to ignore the queue.
 */
export async function detectBehaviouralRegression(projectId: string): Promise<RawFinding[]> {
  const now = new Date()
  const currentBucket = hourBucket(now)
  // The current hour is still filling, so it is not comparable to complete
  // hours. The most recent COMPLETE bucket is the one under judgement.
  const judgedBucket = new Date(currentBucket.getTime() - 60 * 60 * 1000)
  const windowStart = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const rows = await prisma.dbBaselineSample.findMany({
    where: { projectId, bucket: { gte: windowStart, lte: judgedBucket } },
    orderBy: { bucket: 'asc' },
    select: { kind: true, subject: true, bucket: true, value: true, samples: true, metadata: true },
  }).catch(() => [] as Array<{
    kind: string; subject: string; bucket: Date; value: number
    samples: number; metadata: unknown
  }>)
  if (rows.length === 0) return []

  const bySubject = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = `${r.kind}|${r.subject}`
    const list = bySubject.get(key) ?? []
    list.push(r)
    bySubject.set(key, list)
  }

  const findings: RawFinding[] = []
  // Correlation is one set of queries for the whole report, not one per
  // deviation: a regression that shows up across four subjects at once has ONE
  // set of preceding changes, and asking four times would be four identical
  // round trips producing four identical lists.
  let correlation: Awaited<ReturnType<typeof changesBefore>> | null = null

  for (const [key, series] of bySubject) {
    const [kind, subject] = key.split('|')
    const spec = SPECS.find(s =>
      s.kind === kind && (s.suffix === null || subject.endsWith(s.suffix)),
    )
    if (!spec) continue

    const latest = series[series.length - 1]
    // Only judge the bucket we actually intended to judge. A subject whose last
    // sample is from yesterday is not regressing, it stopped being observed.
    if (latest.bucket.getTime() !== judgedBucket.getTime()) continue

    const baseline: Sample[] = series
      .slice(0, -1)
      .map(s => ({ value: s.value, samples: s.samples }))

    const verdict = judgeDeviation({
      baseline,
      current: latest.value,
      threshold: spec.threshold,
      floor: spec.floor,
    })
    if (verdict.kind !== 'regressed') continue

    if (correlation === null) correlation = await changesBefore(projectId, judgedBucket)
    const correlationLine = summariseCorrelation(correlation)
    const metadata = (latest.metadata ?? {}) as Record<string, unknown>

    findings.push({
      type: 'behavioural_regression',
      severity: verdict.ratio >= spec.threshold * 3 ? 'critical' : 'warning',
      autoFixable: false,
      details: {
        tableName: (metadata.table as string | undefined) ?? undefined,
        location: `${kind}:${subject}`,
        measure: kind === 'query' ? 'query_latency' : subject.endsWith(':bytes') ? 'table_size' : 'sequential_scans',
        baselineValue: verdict.baseline,
        currentValue: verdict.current,
        ratio: Math.round(verdict.ratio * 10) / 10,
        observedHours: verdict.observations,
        sql: metadata.sql,
        // The correlation travels WITH the finding rather than being computed at
        // render time: the changes that matter are the ones near the deviation,
        // and by the time anyone reads this the window has moved on.
        changesBefore: correlation,
        reason:
          `${describeDeviation(spec.label(subject, metadata), spec.unit, verdict)} ` +
          `${spec.consequence}` +
          (correlationLine ? ` ${correlationLine}` : ' Nothing changed on this backend beforehand that Backenly recorded.'),
      },
    })
  }

  return findings
}
