/**
 * ONE INSTANCE RUNS A LADDER AT A TIME
 * ====================================
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────
 *
 *   At most one maintenance executor may mutate a project's schema at a time,
 *   whether execution originated from the scheduler, the Fargate runner, or an
 *   operator's CLI. If exclusivity cannot be established, no maintenance
 *   mutation occurs.
 *
 * Both halves are load-bearing. The first is why the guard sits on
 * `executeMaintenancePlan` rather than on the sweep: the sweep is not the only
 * caller. The second is why it fails closed, which is the opposite of what
 * `lib/ai/build-runtime/build-lock.ts` does, and deliberately so.
 *
 * ── Two things still to harden ────────────────────────────────────────────
 *
 *   1. Every deployment path must point this pool at the authoritative primary,
 *      NOT at a transaction-pooling endpoint. Session-level advisory locks have
 *      no meaning through a transaction pooler: the backend session a lock is
 *      taken on is not the one a later statement lands on, so two holders can
 *      both believe they own the project. `DATABASE_URL` is read directly here
 *      for that reason, and a pgbouncer-style URL would quietly break the
 *      invariant above while every test still passed.
 *   2. Contention should become evidence. Right now a declined sweep is a
 *      return value; repeated contention on one project is indistinguishable
 *      from a healthy loop with nothing to do, which is exactly the class of
 *      silence this subsystem keeps being bitten by.
 *
 * The sweep became unattended and then became scheduled, and both of those
 * happened without anything stopping two application instances from sweeping
 * the same project in the same minute. That is worse than the problem the
 * scheduler solves. A ladder is a sequence of schema mutations, and two of them
 * interleaved on one table is not a slow migration, it is a corrupted one:
 * `add_structure` refuses when the column exists, so the loser of the race
 * halts a ladder the winner is halfway through and the project is left
 * half-expanded with nobody watching.
 *
 * This deployment can run several instances. `instrumentation.ts` already
 * refuses to boot when a multi-instance topology would weaken the auth limiter,
 * for exactly the reason that nothing about raising a replica count prompts
 * anybody to re-check the per-process assumptions. The maintenance sweep had
 * the same assumption and no such check.
 *
 * ── Why an advisory lock and not a `status = 'running'` row ────────────────
 *
 * Because a row is read-then-write and this has to be atomic. The ledger's
 * `maintenance_executions` row is written AFTER the gates pass, so two
 * instances both reach the write, and `nextAttempt` is itself a read-then-write
 * that races. A Postgres advisory lock is decided by the database in one
 * statement, which is the only place the decision can be correct.
 *
 * ── Why a dedicated pool ───────────────────────────────────────────────────
 *
 * `pg_try_advisory_lock` is SESSION-scoped, and `prisma.$queryRaw` draws an
 * arbitrary connection from its pool. Taking the lock on connection A and
 * releasing it on connection B does not throw: the unlock returns false and the
 * lock stays held until the connection cycles, which strands the project's
 * maintenance for as long as that takes. `lib/ai/build-runtime/build-lock.ts`
 * documents this as a bug it was written to fix, so this follows the same
 * pattern: keep the connection checked out for the duration and release on the
 * same one.
 *
 * ── Why a separate keyspace ────────────────────────────────────────────────
 *
 * The two-argument overload, with a fixed namespace. The build lock hashes a
 * projectId into the single-bigint keyspace, and colliding with it would make a
 * maintenance sweep and a user's build silently block each other with no way to
 * tell which lock was which from `pg_locks`.
 */

import { Pool, type PoolClient } from 'pg'

/**
 * Arbitrary but fixed, and distinct from every other advisory-lock namespace in
 * this repository. Changing it would let an old instance and a new one both
 * believe they hold the sweep.
 */
const MAINTENANCE_LOCK_NAMESPACE = 0x6d61696e // 'main'

/**
 * Same hash as the build lock, deliberately. Two subsystems that disagree about
 * which integer a project is would be a bug nobody could read out of `pg_locks`.
 */
export function projectToLockKey(projectId: string): number {
  let hash = 5381
  for (let i = 0; i < projectId.length; i++) {
    hash = ((hash << 5) - hash) + projectId.charCodeAt(i)
    hash = hash | 0 // keep 32-bit int
  }
  return Math.abs(hash)
}

const lockPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // One checked-out connection per project being swept on this instance. The
  // scheduler fans out at CONCURRENCY 5, so this is the ceiling plus headroom.
  max: 8,
})

/** lockKey → the connection holding it. The pin that makes unlock correct. */
const held = new Map<number, PoolClient>()

async function tryLock(key: number): Promise<boolean> {
  // Advisory locks are re-entrant per session, so a second acquire on a key
  // this process already holds would need a matching second unlock. Treat it
  // as contention instead: something on this instance is already sweeping.
  if (held.has(key)) return false

  let client: PoolClient
  try {
    client = await lockPool.connect()
  } catch {
    // The control-plane database is unreachable. Refusing the sweep is right:
    // without the lock this could fan out into one ladder per instance, and a
    // project whose own database is down is not going to be repaired by DDL.
    return false
  }

  try {
    const res = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::int4, $2::int4) AS acquired',
      [MAINTENANCE_LOCK_NAMESPACE, key],
    )
    if (res.rows[0]?.acquired === true) {
      held.set(key, client)
      return true
    }
    client.release()
    return false
  } catch {
    client.release()
    return false
  }
}

async function unlock(key: number): Promise<void> {
  const client = held.get(key)
  // Nothing pinned for this key: either this process never took it, or another
  // instance holds it. Stealing a lock held elsewhere is how two workers end up
  // mutating one project at once, which is the race this exists to prevent.
  if (!client) return

  held.delete(key)
  try {
    const res = await client.query<{ released: boolean }>(
      'SELECT pg_advisory_unlock($1::int4, $2::int4) AS released',
      [MAINTENANCE_LOCK_NAMESPACE, key],
    )
    if (res.rows[0]?.released !== true) {
      // Loud. A lock that fails to release costs this project every future
      // sweep until the connection cycles, and silence is what made the
      // original pooling bug so hard to find.
      console.error(
        `[MaintenanceSingleFlight] pg_advisory_unlock returned false for key ${key} ` +
        'on the connection that took it. The project will not sweep again until this clears.',
      )
    }
  } catch {
    // Session-scoped: released when the connection is destroyed.
  } finally {
    client.release()
  }
}

/**
 * Close the pool. Tests only.
 *
 * The pool is deliberately long-lived in a server process. A test run that
 * leaves it open holds the worker alive after the last assertion, which reads
 * as a hang rather than as a leaked handle.
 */
export async function closeMaintenanceLockPool(): Promise<void> {
  await lockPool.end().catch(() => {})
}

export type SingleFlight<T> = { ran: true; value: T } | { ran: false }

/**
 * Run `work` for this project, or report that somebody else already is.
 *
 * Never throws for contention. A sweep that does not get the lock has not
 * failed, it has correctly declined, and the caller reports that as its own
 * disposition rather than as an error.
 */
export async function withMaintenanceSingleFlight<T>(
  projectId: string,
  work: () => Promise<T>,
): Promise<SingleFlight<T>> {
  const key = projectToLockKey(projectId)
  if (!(await tryLock(key))) return { ran: false }
  try {
    return { ran: true, value: await work() }
  } finally {
    // In `finally`, so a ladder that throws mid-rung still frees the project
    // for the next tick instead of wedging it until the process restarts.
    await unlock(key)
  }
}
