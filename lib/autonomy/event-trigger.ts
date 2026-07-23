/**
 * AUTONOMY EVENT TRIGGER — close the perception gap between cron and reality
 * ==========================================================================
 *
 * The reconciler is cron-driven (30 min on Pro/Enterprise, 24 h on Free).
 * That cadence is correct for drift detection but wrong for the "Backenly
 * noticed and acted" moment: a user creates a table, gets nothing for the
 * whole cadence window, and is gone.
 *
 * This module fires the reconciler IMMEDIATELY after Tier-0 mutations that
 * typically open new gaps (missing FK index, missing API, missing RLS). The
 * cron stays as the backstop for drift detection it can't predict from the
 * mutation alone — this is the additive event-driven path, not a replacement.
 *
 * Hard rules:
 *   • Fire-and-forget. Never throws, never blocks the mutation path.
 *   • Per-project debounce — a chain of create_table → add_column → generate_api
 *     in one turn coalesces into ONE reconciler run, not three.
 *   • Respects FLAGS.ENABLE_AUTONOMY_RECONCILER and the per-project dial — uses
 *     the same runReconciler dispatcher the cron uses, no second decision path.
 *   • Process-local debounce only. Across multiple Next.js / runtime workers we
 *     may double-fire, but runReconciler is idempotent (every action funnels
 *     through the deterministic kernel with its own breaker + dedupe), so the
 *     worst case is a wasted probe — never a duplicate mutation.
 */

import { runReconciler } from './reconciler'
import { FLAGS } from '@/lib/config/flags'

/**
 * Mutations that typically open a Tier-0 / Tier-1 invariant gap the reconciler
 * can act on. Anything not in this set still gets caught by the cron tick.
 *
 * Keep this list TIGHT — every entry pays one reconciler probe per mutation
 * (debounced). The criterion is "this mutation is highly likely to leave a
 * detectable gap behind", not "this mutation is interesting".
 */
const KICK_REASONS = new Set<string>([
  // Schema reality changes — open FK-index, FK-constraint, missing-API gaps.
  'create_table',
  'add_column',
  'add_constraint',
  'rename_column',
  'drop_column',
  'generate_api',
  // Security surface changes — RLS / permission gaps the loop reconciles.
  'add_rls',
  'enable_auth',
  'add_oauth_provider',
  // Realtime / triggers — touch the workspace schema in ways that can shift
  // the desired-state diff (e.g. trigger adds a column).
  'create_trigger',
  'enable_realtime',
  'enable_teams',
  'enable_vector_search',
])

/** Reasons the kick layer accepts as a debounce key, lowercased for stability. */
export function shouldKickFor(reason: string): boolean {
  return KICK_REASONS.has(reason.toLowerCase())
}

interface Pending {
  /** setTimeout handle (typed loosely to stay Node/edge compatible). */
  timer: ReturnType<typeof setTimeout>
  /** All reasons coalesced into this pending kick (audit-friendly). */
  reasons: string[]
}

const pending = new Map<string, Pending>()

// 1.5s — long enough to coalesce a typical brain turn's chain of mutations,
// short enough that the user still sees autonomy act within the same session.
const DEBOUNCE_MS = 1500

// Defensive ceiling. If pending ever drifts above this, something is wrong —
// timers should always clear themselves. Cap protects against a runaway leak
// in a long-lived process. 10k projects per worker is generous; we'll hit
// other limits long before this.
const MAX_PENDING = 10_000

/**
 * Schedule an event-driven reconciler run for this project. Coalesces back-to-
 * back calls into one. Returns immediately; never throws.
 *
 * Call AFTER a successful Tier-0 mutation. The cron remains the source of
 * truth for drift the event path can't predict.
 */
export function kickReconciler(projectId: string, reason: string): void {
  if (!FLAGS.ENABLE_AUTONOMY_RECONCILER) return
  if (!projectId) return
  if (!shouldKickFor(reason)) return

  const existing = pending.get(projectId)
  if (existing) {
    existing.reasons.push(reason)
    clearTimeout(existing.timer)
    existing.timer = setTimeout(() => runKick(projectId), DEBOUNCE_MS)
    return
  }

  // Defence in depth: if the map ever drifts above MAX_PENDING something is
  // wrong — refuse to enqueue and log. Better to lose ONE event-driven kick
  // than leak memory in a long-lived PM2 worker.
  if (pending.size >= MAX_PENDING) {
    console.warn(
      `[autonomy:event-trigger] pending map at ceiling (${pending.size}); ` +
      `dropping kick for ${projectId} — cron tick will still pick it up.`,
    )
    return
  }

  const entry: Pending = {
    reasons: [reason],
    timer: setTimeout(() => runKick(projectId), DEBOUNCE_MS),
  }
  pending.set(projectId, entry)
}

async function runKick(projectId: string): Promise<void> {
  const entry = pending.get(projectId)
  pending.delete(projectId)
  if (!entry) return

  try {
    // runReconciler honors the master flag + per-project dial + breaker + the
    // change-freeze during incidents. We add no second decision path here.
    await runReconciler(projectId)
    console.log(
      `[autonomy:event-trigger] kicked project=${projectId} ` +
      `reasons=${entry.reasons.join(',')}`,
    )
  } catch (err: any) {
    // Fire-and-forget. The cron tick will pick this up if the event path lost.
    console.warn(
      `[autonomy:event-trigger] kick failed project=${projectId}:`,
      err?.message ?? err,
    )
  }
}
