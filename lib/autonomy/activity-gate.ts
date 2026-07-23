/**
 * Which projects the autonomy loop is allowed to spend a cycle on.
 *
 * ── Why this is not just "every project" ────────────────────────────────────
 *
 * The reconciler does real work per project — catalog reads, drift diffing,
 * sometimes model calls. Running it against abandoned free projects burns
 * budget on backends nobody will ever look at again. So there is an activity
 * gate, and the gate is the thing that decides whether self-healing happens.
 *
 * ── Why the gate had to change ──────────────────────────────────────────────
 *
 * It used to be a single condition: a ConversationMessage in the last 30 days.
 * That made sense when the in-app chat was how backends got built — talking to
 * the project WAS using the project. It is now wrong twice over:
 *
 *   1. The chat door is gone. Builds happen over MCP. `backend_chat` still
 *      writes conversation rows (brain saveTurn), but an agent calling the
 *      fine-grained tools directly — create_table, add_column, the documented
 *      and supported path — writes NONE. Such a project would never once enter
 *      the loop. It would report Autopilot as on, and silently never run.
 *
 *   2. It measures the wrong thing even when it fires. It keys on how recently
 *      someone TALKED about the backend, not on whether the backend is alive.
 *      A production backend serving real traffic, that nobody has chatted about
 *      in a month, ages out of self-healing — exactly inverted from the promise
 *      that it keeps working while nobody is watching. This was not
 *      theoretical: project 83821024 had gone 47 days since its last message
 *      and had already stopped being healed, with tables and a live schema.
 *
 * So the gate now asks "is this backend alive?" and accepts any real signal:
 * end-user traffic, a governed mutation, a conversation, or simply being new
 * enough that it has not had time to produce any of those yet. Traffic is
 * listed first because it is the strongest evidence a backend matters and is
 * the one index built for this shape (`[projectId, timestamp]`).
 *
 * Erring toward inclusion is deliberate: a false positive costs one reconciler
 * pass, a false negative costs a customer their self-healing, silently.
 */

export const ACTIVITY_WINDOW_DAYS = 30

/**
 * Prisma `where` selecting projects eligible for a background pass.
 *
 * Shared by every scheduled sweep that needs "is this project worth spending a
 * cycle on": the autonomy reconciler, the background health scan, infra
 * intelligence, architecture evolution, and frontend coevolution — in both the
 * in-process node-cron tick (instrumentation.ts, the scheduler that actually
 * runs on self-hosted/PM2) and the HTTP cron routes. They must not drift: two
 * different answers to "is this project alive" is how a backend gets healed on
 * one deployment topology and not the other, or gets its schema evolved but
 * never its health checked.
 *
 * `windowDays` varies by sweep — the cheap, frequent ones look back further
 * than the expensive daily ones — but the DEFINITION of activity must not.
 */
export function activeProjectsWhere(
  windowDays: number = ACTIVITY_WINDOW_DAYS,
  now: Date = new Date(),
) {
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)

  return {
    // No tables means no backend to reconcile — nothing to be right or wrong about.
    tables: { some: {} },
    deletedAt: null,
    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    AND: [
      {
        OR: [
          // Live end-user traffic: the strongest signal a backend is real.
          { apiRequestLogs: { some: { timestamp: { gte: cutoff } } } },
          // Any governed mutation — this is what catches an agent driving the
          // MCP tools directly, which writes no conversation row.
          { auditLogs: { some: { timestamp: { gte: cutoff } } } },
          // A conversation with the brain (backend_chat over MCP).
          { conversationMessages: { some: { createdAt: { gte: cutoff } } } },
          // Newly created, or changed platform-side, and simply has not had
          // time to emit any of the above yet. Without this a fresh project
          // waits for its first request before it is ever protected.
          { createdAt: { gte: cutoff } },
          { updatedAt: { gte: cutoff } },
        ],
      },
    ],
  }
}
