/**
 * The inactivity clock: when a project was last really used.
 *
 * `Project.lastActivityAt` is what Backenly Cloud's idle sweep measures, so it
 * must move for real use and ONLY for real use:
 *
 *   counts    authenticated runtime traffic (data, auth, realtime), an MCP call
 *             from the owner's agent, a dashboard write, and the owner opening
 *             the project console
 *   does not  dashboard polling, autonomy, cron-triggered functions, backups,
 *             the observer, or any request that was refused
 *
 * Callers stamp only AFTER the serving gate has let the request through, so a
 * paused or locked project's clock cannot be moved by the traffic it refuses.
 * The write itself also refuses a paused project, because resuming is what
 * restarts the clock (lib/projects/pause-lifecycle.ts) and nothing else may.
 *
 * ── Cheap by construction ───────────────────────────────────────────────────
 *
 * This sits on the hot path of every runtime request, so it is fire-and-forget
 * and throttled twice: in memory (one attempt per project per hour per process)
 * and in the database (the UPDATE matches nothing if the clock moved within the
 * hour). A busy project costs one conditional UPDATE an hour, not one a request.
 *
 * The hour is also what the pause relies on: a project idle for days has an old
 * clock, so the first real request after that always writes, and that write is
 * what makes a pause decided against the old value lose (see the conditional
 * write in lib/projects/pause-lifecycle.ts).
 *
 * It is edition-neutral. A self-hosted project gets a truthful "last used" time
 * and nothing reads it to pause anything.
 */
import { prisma } from '@/lib/db/prisma'

export const ACTIVITY_TOUCH_INTERVAL_MS = 60 * 60 * 1000
const MAX_TRACKED = 10_000

/** projectId -> when this process last attempted a stamp. Bounded, LRU order. */
const lastAttempt = new Map<string, number>()

function remember(projectId: string, at: number): void {
  lastAttempt.delete(projectId)
  lastAttempt.set(projectId, at)
  while (lastAttempt.size > MAX_TRACKED) {
    const oldest = lastAttempt.keys().next().value
    if (oldest === undefined) break
    lastAttempt.delete(oldest)
  }
}

/**
 * Record that a project was really used, at most once an hour.
 *
 * Never throws and never blocks the caller: returns the pending write so tests
 * can await it, and product code ignores it.
 */
export function touchProjectActivity(projectId: string, now: number = Date.now()): Promise<void> {
  const previous = lastAttempt.get(projectId)
  if (previous !== undefined && now - previous < ACTIVITY_TOUCH_INTERVAL_MS) return Promise.resolve()
  remember(projectId, now)

  return prisma.project
    .updateMany({
      where: {
        id: projectId,
        pausedAt: null,
        OR: [
          { lastActivityAt: null },
          { lastActivityAt: { lt: new Date(now - ACTIVITY_TOUCH_INTERVAL_MS) } },
        ],
      },
      // Real use also withdraws a pending pause warning: the project is no
      // longer idle, so the warning no longer describes it.
      data: { lastActivityAt: new Date(now), pauseWarnedAt: null },
    })
    .then(() => undefined)
    .catch((err: any) => {
      // Forget the attempt so the next request retries instead of waiting out
      // the hour on a write that never landed.
      lastAttempt.delete(projectId)
      console.warn(`[activity] could not stamp ${projectId}:`, err?.message ?? err)
    })
}

/** Test seam: forget every in-memory throttle. */
export function resetActivityThrottle(): void {
  lastAttempt.clear()
}
