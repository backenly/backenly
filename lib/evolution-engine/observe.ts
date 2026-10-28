/**
 * OBSERVATION — a change is not done when the last rung finishes
 * ===============================================================
 *
 * Cutover proves the migration ran. Real traffic proves the new shape behaves,
 * and only real traffic can: authorization against the actual mix of users,
 * latency under the actual load, consistency under the actual write pattern.
 * So a cut-over change is watched, in passes, for a window, and earns `stable`
 * only when:
 *
 *   - the window (policy.observationHours) has elapsed since cutover
 *   - at least policy.minObservationPasses passes were taken inside it
 *   - the latest pass MEASURED consistency and found it holding — a pass that
 *     could not check consistency cannot be the one that declares stability
 *   - no pass saw a regression
 *
 * A regression at any point ends observation with `regressed`: the engine
 * stops the change (lifecycle `blocked`) and reports it. Whether it is also
 * undone is policy (see ./policy.ts), and undoing is always the rollback that
 * refuses to lose a write.
 *
 * Pure.
 */

import type { EvolutionPolicy } from './policy'
import type { ObservationSignal } from './primitive'

/** The signal every primitive must report, by this name, for stability to be declared. */
export const CONSISTENCY_SIGNAL = 'consistency'

export interface ObservationPass {
  at: string
  signals: ObservationSignal[]
}

export type ObservationVerdict =
  | { status: 'continue'; reason: string }
  | { status: 'stable'; reason: string }
  | { status: 'regressed'; reason: string; signals: ObservationSignal[] }

export function observationVerdict(input: {
  passes: ObservationPass[]
  cutoverAt: Date
  now: Date
  policy: EvolutionPolicy
}): ObservationVerdict {
  const { passes, cutoverAt, now, policy } = input
  const inWindow = passes.filter(p => new Date(p.at).getTime() >= cutoverAt.getTime())

  const regressions = inWindow.flatMap(p => p.signals.filter(s => s.status === 'regressed'))
  if (regressions.length > 0) {
    return {
      status: 'regressed',
      reason: regressions.map(s => `${s.name}: ${s.detail}`).join('; '),
      signals: regressions,
    }
  }

  const elapsedHours = (now.getTime() - cutoverAt.getTime()) / 3_600_000
  if (elapsedHours < policy.observationHours) {
    return {
      status: 'continue',
      reason: `watching for ${policy.observationHours}h after cutover; ${Math.max(0, Math.floor(elapsedHours))}h so far`,
    }
  }
  if (inWindow.length < policy.minObservationPasses) {
    return {
      status: 'continue',
      reason: `${inWindow.length} of ${policy.minObservationPasses} observation passes taken`,
    }
  }
  const latest = inWindow[inWindow.length - 1]
  const consistency = latest.signals.find(s => s.name === CONSISTENCY_SIGNAL)
  if (!consistency || consistency.status !== 'ok') {
    return {
      status: 'continue',
      reason: 'the latest pass could not confirm the two shapes agree, so it cannot be the one that declares the change stable',
    }
  }
  return {
    status: 'stable',
    reason: `no regression across ${inWindow.length} passes over ${Math.floor(elapsedHours)}h, and the data still agrees`,
  }
}
