/**
 * TELEMETRY — what an extraction is observed and measured by
 * ===========================================================
 *
 * Observation, for now, is reconciliation: the one witness that can say the
 * two representations agree, and the signal the engine requires before it
 * calls a change stable. No before/after numbers are captured yet, so every
 * outcome is reported as `insufficient_evidence` — said plainly, never
 * rounded up to an improvement.
 */

import type { ExtractionPlan } from './plan'
import type { Measurement, ObservationSignal, SnapshotPhase, TelemetrySnapshot } from '@/lib/evolution-engine/primitive'
import { CONSISTENCY_SIGNAL } from '@/lib/evolution-engine/observe'
import { readTableFacts } from './facts'
import { reconcileExtraction } from './reconcile'

export async function observeExtraction(
  projectId: string,
  plan: ExtractionPlan,
  _window: { since: Date; now: Date },
): Promise<ObservationSignal[]> {
  const host = await readTableFacts(plan.schema, plan.spec.host)
  if (!host) return [{ name: CONSISTENCY_SIGNAL, status: 'regressed', detail: `${plan.spec.host} no longer exists` }]
  const r = await reconcileExtraction(projectId, host, plan.spec).catch(() => null)
  return [
    r
      ? { name: CONSISTENCY_SIGNAL, status: r.consistent ? 'ok' : 'regressed', detail: r.summary }
      : { name: CONSISTENCY_SIGNAL, status: 'unavailable', detail: 'reconciliation could not run' },
  ]
}

export async function snapshotExtraction(
  _projectId: string,
  _plan: ExtractionPlan,
  phase: SnapshotPhase,
  now: Date,
): Promise<TelemetrySnapshot> {
  return {
    v: 1,
    phase,
    at: now.toISOString(),
    data: {},
    unavailable: [{ metric: '*', reason: 'not_yet_measurable', detail: 'before/after metrics are not captured yet' }],
  }
}

export async function measureExtraction(
  _projectId: string,
  _plan: ExtractionPlan,
  _snapshots: TelemetrySnapshot[],
  _context: { firedBy: string[]; now: Date },
): Promise<Measurement[]> {
  return []
}
