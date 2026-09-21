/**
 * IS THE LOOP ACTUALLY REPAIRING ANYTHING RIGHT NOW?
 * ===================================================
 *
 * `ENABLE_AUTONOMY_LIVE_EXECUTION` defaults to false. With the reconciler on
 * and that flag unset, every project runs in shadow: the loop evaluates every
 * invariant, decides what it would do, writes an `AUTONOMY_SHADOW_DECISION`
 * row that looks like work, and repairs nothing.
 *
 * Nothing said so. The dashboard badge renders `labelFor(project.autonomyLevel)`,
 * which is the stored dial — so a project reads "Autopilot" while the loop is
 * structurally incapable of applying a single fix. The cron logged a warning
 * to the server console, throttled hourly, which is not a place any owner
 * looks. `.env.example` states the problem in its own words: shadow mode "is
 * indistinguishable from working autonomy on every dashboard surface".
 *
 * That is the same failure as every other one this audit turned up. A surface
 * asserting something the runtime does not support, with nothing in between to
 * catch the disagreement.
 *
 * ── Authoritative, not inferred ────────────────────────────────────────────
 *
 * `TrustReport.shadowPreview` already existed and was derived from the last
 * shadow audit row. Two problems with that: it is evidence the loop LEFT
 * rather than a statement of what it IS, so it goes stale and says nothing on
 * a project that has never ticked; and nothing consumed it.
 *
 * This reads the flags and the dial directly. It is a fact about the process
 * and the project, available before the loop has ever run.
 *
 * ── The reasons are not interchangeable ────────────────────────────────────
 *
 * Three different things produce "nothing will be applied", and an owner acts
 * differently on each:
 *
 *   loop_off             the operator disabled autonomy entirely. Their call.
 *   deployment_flag_off  the OPERATOR can fix this, and on a self-hosted
 *                        install the owner and the operator are usually the
 *                        same person reading two different docs.
 *   project_dial_off     the OWNER chose Review-only. Working as intended.
 *
 * Collapsing them into one "off" would tell a self-hoster their dial is wrong
 * when the actual cause is a missing line in `.env`.
 */

import { FLAGS } from '@/lib/config/flags'
import type { AutonomyLevel } from './autonomy-level'

export type ExecutionMode = 'live' | 'shadow'

export type ExecutionModeReason =
  /** Applying fixes, subject to the dial, the breaker and the tier gates. */
  | 'live'
  /** `ENABLE_AUTONOMY_RECONCILER` is off. The loop does not run at all. */
  | 'loop_off'
  /** The loop evaluates and decides, and may not act. Operator-level. */
  | 'deployment_flag_off'
  /** The owner set this project to a level that does not act. */
  | 'project_dial_off'

export interface ExecutionModeState {
  mode: ExecutionMode
  reason: ExecutionModeReason
  /** One sentence, written for the person reading it rather than for a log. */
  explanation: string
  /** True only when the loop can currently apply a fix to this project. */
  repairsAreApplied: boolean
}

/**
 * What the loop will actually do for this project, right now.
 *
 * Mirrors the dispatch in `runReconciler` exactly — flag, then dial — because
 * two answers to "is this live" would eventually disagree, and the one on the
 * dashboard is the one people would believe.
 */
export function resolveExecutionMode(level: AutonomyLevel): ExecutionModeState {
  if (!FLAGS.ENABLE_AUTONOMY_RECONCILER) {
    return {
      mode: 'shadow',
      reason: 'loop_off',
      explanation:
        'Autonomy is switched off for this deployment, so Backenly is not watching this backend. ' +
        'Nothing is detected and nothing is repaired.',
      repairsAreApplied: false,
    }
  }

  if (!FLAGS.ENABLE_AUTONOMY_LIVE_EXECUTION) {
    return {
      mode: 'shadow',
      reason: 'deployment_flag_off',
      explanation:
        'Backenly is watching this backend and recording what it would repair, but this deployment ' +
        'has not enabled live execution, so nothing is being applied. ' +
        'Set ENABLE_AUTONOMY_LIVE_EXECUTION=true to turn repairs on.',
      repairsAreApplied: false,
    }
  }

  if (level === 'OFF') {
    return {
      mode: 'shadow',
      reason: 'project_dial_off',
      explanation:
        'Autonomy is set to Off for this project, so Backenly is watching and recording what it ' +
        'would repair without applying anything. Pick a mode to let it act.',
      repairsAreApplied: false,
    }
  }

  return {
    mode: 'live',
    reason: 'live',
    explanation: 'Backenly is applying the repairs this mode allows, and holding the rest for you.',
    repairsAreApplied: true,
  }
}
