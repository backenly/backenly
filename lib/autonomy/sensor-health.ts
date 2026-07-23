/**
 * Sensor health — can the instruments still detect anything?
 *
 * WHY THIS EXISTS
 * ---------------
 * `computeDesiredStateDiff` already handles a probe that THROWS: `allSettled`
 * catches it, the error is isolated, and the invariant is reported unsatisfied
 * because unknown state is not the same as healthy. That part is sound.
 *
 * The failure it cannot see is a probe that returns `[]` for the wrong reason.
 * `detectMissingRls` — the flagship security probe — carried a duplicate bind
 * parameter and swallowed the resulting error inside its own try/catch, so it
 * returned an empty finding list in every environment. Nothing rejected.
 * Nothing errored. The dashboard rendered green for months while the check was
 * dead, because "no findings" and "cannot detect findings" are the same value.
 *
 * A monitor that cannot fail is worse than no monitor: it manufactures
 * confidence. So a probe is not trusted merely because it ran quietly — it is
 * trusted once it has been OBSERVED producing a finding. Until then its silence
 * is `unverified`, not `clean`.
 *
 * This is the same rule the MCP harness applies to its own guards: a guard that
 * has never been seen red is not evidence of anything.
 */

import { prisma } from '@/lib/db/prisma'

const PREF_TYPE = 'probe_liveness'

export type ProbeStatus =
  /** Ran and produced findings — the probe is demonstrably working. */
  | 'fired'
  /** Ran quietly AND has fired before, so silence is meaningful. */
  | 'clean'
  /** Ran quietly but has NEVER been observed firing — silence proves nothing. */
  | 'unverified'
  /** Threw. Unknown state, never treated as healthy. */
  | 'errored'

export interface ProbeOutcome {
  id: string
  title: string
  status: ProbeStatus
  findingCount: number
  error?: string
  /** ISO timestamp of the last time this probe produced a finding, if ever. */
  lastFiredAt?: string
}

export interface SensorHealthReport {
  evaluatedAt: string
  probes: ProbeOutcome[]
  /** Probes that threw — the loop is partially blind. */
  errored: number
  /** Probes whose silence carries no evidence yet. */
  unverified: number
  /**
   * True only when every probe either fired or is verifiably clean. A report
   * with unverified or errored probes is NOT a clean bill of health, and the
   * field is named so it cannot be misread as one.
   */
  fullyInstrumented: boolean
}

/** Raw per-probe result, as produced by a desired-state evaluation. */
export interface ProbeRun {
  id: string
  title: string
  findingCount: number
  error?: string
}

/**
 * Classify probe runs against their firing history.
 *
 * Pure, so the rule can be proven in a unit test — the same discipline the
 * probes themselves failed to meet.
 */
export function classifyProbeOutcomes(
  runs: ProbeRun[],
  lastFired: Map<string, string>,
): SensorHealthReport {
  const probes: ProbeOutcome[] = runs.map((run) => {
    const lastFiredAt = lastFired.get(run.id)

    let status: ProbeStatus
    if (run.error) {
      status = 'errored'
    } else if (run.findingCount > 0) {
      status = 'fired'
    } else if (lastFiredAt) {
      status = 'clean'
    } else {
      // Ran, said nothing, and has never said anything. Indistinguishable from
      // a probe whose query is broken and silently returns no rows.
      status = 'unverified'
    }

    return {
      id: run.id,
      title: run.title,
      status,
      findingCount: run.findingCount,
      ...(run.error ? { error: run.error } : {}),
      ...(lastFiredAt ? { lastFiredAt } : {}),
    }
  })

  const errored = probes.filter((p) => p.status === 'errored').length
  const unverified = probes.filter((p) => p.status === 'unverified').length

  return {
    evaluatedAt: new Date().toISOString(),
    probes,
    errored,
    unverified,
    fullyInstrumented: errored === 0 && unverified === 0,
  }
}

/** One-line summary that never lets "no findings" masquerade as "healthy". */
export function summariseSensorHealth(report: SensorHealthReport): string {
  const fired = report.probes.filter((p) => p.status === 'fired').length
  const clean = report.probes.filter((p) => p.status === 'clean').length

  const parts = [
    `${report.probes.length} probe(s): ${fired} firing, ${clean} verified clean`,
  ]
  if (report.unverified > 0) {
    parts.push(
      `${report.unverified} UNVERIFIED — these have never produced a finding, so their ` +
      `silence is not evidence the backend is healthy; they may be broken`,
    )
  }
  if (report.errored > 0) {
    parts.push(`${report.errored} ERRORED — the loop is blind to those invariants`)
  }
  return parts.join('. ') + '.'
}

// ── liveness persistence ─────────────────────────────────────────────────────

/**
 * Record that a probe fired. Stored per project on ProjectPreference so no
 * migration is needed; `key` is the invariant id.
 */
export async function recordProbeFired(projectId: string, probeId: string): Promise<void> {
  const now = new Date()
  await prisma.projectPreference.upsert({
    where: { projectId_type_key: { projectId, type: PREF_TYPE, key: probeId } },
    create: {
      projectId, type: PREF_TYPE, key: probeId,
      value: now.toISOString(), confidence: 1,
    },
    update: { value: now.toISOString(), lastSeen: now },
  }).catch(() => { /* liveness is observability, never a build blocker */ })
}

export async function loadProbeLiveness(projectId: string): Promise<Map<string, string>> {
  const rows = await prisma.projectPreference.findMany({
    where: { projectId, type: PREF_TYPE },
    select: { key: true, value: true },
  }).catch(() => [] as Array<{ key: string; value: string }>)
  return new Map(rows.map((r) => [r.key, r.value]))
}

/**
 * Evaluate sensor health for a project by running the real desired-state diff.
 * Probes that fired have their liveness recorded, so the first genuine firing
 * promotes a probe from `unverified` to `clean` permanently.
 */
export async function checkSensorHealth(projectId: string): Promise<SensorHealthReport> {
  const { computeDesiredStateDiff } = await import('./desired-state')
  const report = await computeDesiredStateDiff(projectId)

  // `errors` entries are formatted "[invariantId] message".
  const errorById = new Map<string, string>()
  for (const line of report.errors ?? []) {
    const m = /^\[([^\]]+)\]\s*(.*)$/.exec(line)
    if (m) errorById.set(m[1], m[2])
  }

  const runs: ProbeRun[] = report.invariants.map((inv) => ({
    id: inv.id,
    title: inv.title,
    findingCount: inv.gaps.length,
    ...(errorById.has(inv.id) ? { error: errorById.get(inv.id) } : {}),
  }))

  const lastFired = await loadProbeLiveness(projectId)
  for (const run of runs) {
    if (!run.error && run.findingCount > 0 && !lastFired.has(run.id)) {
      await recordProbeFired(projectId, run.id)
      lastFired.set(run.id, new Date().toISOString())
    }
  }

  return classifyProbeOutcomes(runs, lastFired)
}
