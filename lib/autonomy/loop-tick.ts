/**
 * When did the self-healing loop last evaluate this project?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The dashboard's "Self-healing loop — checked N ago" used to read
 * `Project.lastObservedAt`. That column is stamped in exactly one place: the
 * end of `runObserverForProject` (lib/services/workspace-observer.ts), which is
 * driven by the DAILY cron `10 0 * * *`. The reconciler runs every minute and
 * stamps nothing on the project.
 *
 * So the one surface whose job is to prove the every-minute promise was quoting
 * a once-a-day clock. A project reconciled sixty seconds ago rendered "checked
 * 11h ago" — directly contradicting the cadence the pricing page sells on every
 * plan, including Free.
 *
 * The fix is not a new column. `runReconciler` already writes an AUTONOMY_TICK
 * audit row unconditionally on every pass, BEFORE any per-mode work, precisely
 * so that silent runs still register against the cadence gate. That row is
 * already the loop's clock; it simply had no reader.
 *
 * The two timestamps stay separate on purpose. "The deep observer last swept
 * this backend" and "the loop last evaluated this backend" are different facts
 * on different cadences (daily vs per-minute). Collapsing them into one field
 * is what produced the bug, so the health route now returns both and each
 * caller names the one it means.
 */

import { prisma } from '@/lib/db/prisma'

/**
 * Audit actions that mean "the loop completed a pass over this project".
 *
 * AUTONOMY_TICK is the unconditional marker written at the top of every pass.
 * The other three are outcomes a pass can additionally record; they stay in the
 * set so a project whose rows predate the marker, or whose pass ended in a
 * change-freeze, still reads as having been checked.
 *
 * Shared with the reconciler's own cadence gate (`isWithinCadenceCooldown`) so
 * the window that decides whether to run and the timestamp shown to the user
 * can never disagree about what a tick is.
 */
export const LOOP_TICK_ACTIONS = [
  'AUTONOMY_TICK',
  'AUTONOMY_LIVE_RUN',
  'AUTONOMY_SHADOW_DECISION',
  'AUTONOMY_CHANGE_FREEZE',
] as const

/**
 * How far back to look for a tick.
 *
 * Bounded because `audit_logs` has no composite `[projectId, action, timestamp]`
 * index — only `[projectId]` and `[timestamp]` separately (prisma/schema.prisma).
 * An unbounded `ORDER BY timestamp DESC LIMIT 1` would make Postgres sort every
 * audit row this project has ever written, and at one tick per minute that set
 * grows by ~43k rows a month. The bound keeps the scan to a day's worth on a
 * request that runs on every dashboard load.
 *
 * A day is also the right ANSWER boundary, not just the right query boundary: a
 * loop that has not ticked in 24 hours is not "recently checked" by any reading,
 * and the caller should say so rather than print a stale relative time.
 */
const LOOKBACK_HOURS = 24

/**
 * Latest loop pass for a project, or null if it has not run within the lookback.
 *
 * Null is a real answer — "this project is not being reconciled" — and callers
 * must not paper over it with the observer's timestamp. That substitution is
 * the original bug.
 */
export async function getLastLoopTickAt(projectId: string): Promise<Date | null> {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000)

  const row = await prisma.auditLog
    .findFirst({
      where: {
        projectId,
        action: { in: [...LOOP_TICK_ACTIONS] },
        timestamp: { gte: since },
      },
      orderBy: { timestamp: 'desc' },
      select: { timestamp: true },
    })
    .catch(() => null)

  return row?.timestamp ?? null
}
