/**
 * The build lock must actually release. Against a real Postgres.
 *
 * ── The bug ─────────────────────────────────────────────────────────────────
 * `pg_advisory_lock` is SESSION-scoped, and both the lock and the unlock used to
 * be issued through Prisma's connection POOL. The unlock could therefore land on
 * a different connection than the lock. `pg_advisory_unlock` on a session that
 * does not hold the lock does not throw — it returns FALSE — and the return
 * value was discarded. So the lock silently stayed held until that pooled
 * connection was recycled, and every subsequent mutation for that project failed
 * with "Another auto-fix is in progress" while zero jobs were running.
 *
 * `reapStaleJobs` could not rescue it: release had already marked the
 * BackgroundJob `completed`, so there was nothing stale to reap.
 *
 * selfops-bench reproduced it on demand (fk-column-unindexed never repaired in
 * 12 cycles). This pins it shut at the primitive.
 *
 * Mocking is pointless here — what is being tested IS the interaction between
 * pg session semantics and a connection pool, so it needs a real database.
 */

import { Pool } from 'pg'
import { acquireBuildLock, releaseBuildLock } from '@/lib/ai/build-runtime/build-lock'

const CONN = process.env.BENCH_DATABASE_URL || process.env.DATABASE_URL || ''
const projectId = `lock-test-${Date.now()}`

/** Ask Postgres directly whether ANY session holds our advisory lock. */
async function advisoryLocksHeld(): Promise<number> {
  const pool = new Pool({ connectionString: CONN, max: 1 })
  try {
    const res = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_locks WHERE locktype = 'advisory'`,
    )
    return Number(res.rows[0]?.n ?? 0)
  } finally {
    await pool.end().catch(() => {})
  }
}

describe('build lock advisory release', () => {
  it('releases the advisory lock so the same project can lock again', async () => {
    const first = await acquireBuildLock(projectId, 'modify')
    expect(first.acquired).toBe(true)
    expect(first.handle).toBeDefined()

    // While held, a second acquisition for the SAME project must fail — that is
    // the mutual exclusion the lock exists to provide.
    const contended = await acquireBuildLock(projectId, 'modify')
    expect(contended.acquired).toBe(false)

    await releaseBuildLock(first.handle)

    // The whole point: after release, the project is lockable again. Before the
    // fix this returned false forever whenever the unlock had been routed to a
    // different pooled connection.
    const second = await acquireBuildLock(projectId, 'modify')
    expect(second.acquired).toBe(true)
    await releaseBuildLock(second.handle)
  }, 30_000)

  it('leaves no advisory lock held in the database after release', async () => {
    const before = await advisoryLocksHeld()

    const lock = await acquireBuildLock(`${projectId}-leak`, 'modify')
    expect(lock.acquired).toBe(true)
    await releaseBuildLock(lock.handle)

    // Not "fewer than before" — exactly back to baseline. A leaked advisory lock
    // is invisible to every application-level check; only pg_locks can see it.
    const after = await advisoryLocksHeld()
    expect(after).toBe(before)
  }, 30_000)

  it('survives repeated acquire/release cycles without leaking', async () => {
    const before = await advisoryLocksHeld()

    // Ten cycles is enough to exhaust a small pool and force the unlock onto a
    // connection other than the one that locked — the exact condition that made
    // the original bug intermittent rather than obvious.
    for (let i = 0; i < 10; i++) {
      const lock = await acquireBuildLock(`${projectId}-cycle-${i}`, 'modify')
      expect(lock.acquired).toBe(true)
      await releaseBuildLock(lock.handle)
    }

    expect(await advisoryLocksHeld()).toBe(before)
  }, 60_000)
})
