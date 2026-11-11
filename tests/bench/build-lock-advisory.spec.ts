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
 * The stale-job reaper could not rescue it: release had already marked the
 * BackgroundJob `completed`, so there was nothing stale to reap.
 *
 * It reproduced on demand under repeated repair cycles: an unindexed-foreign-key
 * repair never landed across 12 of them. This pins it shut at the primitive.
 *
 * Mocking is pointless here — what is being tested IS the interaction between
 * pg session semantics and a connection pool, so it needs a real database.
 */

import { Pool } from 'pg'
import { prisma } from '@/lib/db/prisma'
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

/**
 * ── Nothing takes the lock from a live holder ───────────────────────────────
 * A second acquirer used to "reap" any holder whose record was more than two
 * minutes old: it marked the record failed and released the advisory lock on
 * the holder's own connection, then took the lock itself. A build of several
 * tables, or an index built online on a large table, runs longer than that,
 * and the reconciler tries a repair every minute: the two then changed one
 * project at once. When the build finished, its release unlocked by key and
 * freed the repair's lock in turn.
 *
 * The lock belongs to the session that took it: only its holder releases it,
 * or the holder's process stopping, which ends the session.
 */
describe('a live holder keeps the lock', () => {
  const live = `${projectId}-live`
  const status = async (id: string) => (await prisma.backgroundJob.findUnique({ where: { id } }))?.status

  afterAll(async () => {
    await prisma.backgroundJob.deleteMany({ where: { projectId: { startsWith: live } } }).catch(() => {})
  })

  it('keeps it past two minutes: another acquirer waits, and the holder is still recorded as running', async () => {
    const build = await acquireBuildLock(live, 'build')
    expect(build.acquired).toBe(true)
    // Three minutes into a long build: the age the old reaper read as abandoned.
    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000)
    await prisma.backgroundJob.update({
      where: { id: build.handle!.lockId },
      data: { startedAt: threeMinutesAgo, createdAt: threeMinutesAgo },
    })

    const repair = await acquireBuildLock(live, 'modify')
    expect(repair.acquired).toBe(false)
    expect(repair.blockedReason).toBe('Another change to this project is still in progress. Try again when it finishes.')
    expect(await status(build.handle!.lockId)).toBe('running')

    await releaseBuildLock(build.handle)
    expect(await status(build.handle!.lockId)).toBe('completed')
    const next = await acquireBuildLock(live, 'modify')
    expect(next.acquired).toBe(true)
    await releaseBuildLock(next.handle)
  }, 30_000)

  it('never frees the next holder on a release that comes late', async () => {
    const key = `${live}-late`
    const first = await acquireBuildLock(key, 'modify')
    await releaseBuildLock(first.handle)
    const second = await acquireBuildLock(key, 'modify')
    expect(second.acquired).toBe(true)

    // The first holder releases again: the lock is the second holder's now.
    await releaseBuildLock(first.handle)
    const third = await acquireBuildLock(key, 'modify')
    expect(third.acquired).toBe(false)
    expect(await status(second.handle!.lockId)).toBe('running')

    await releaseBuildLock(second.handle)
    expect(await status(second.handle!.lockId)).toBe('completed')
  }, 30_000)

  it('says so when a holder has kept it past ten minutes, and still does not take it', async () => {
    const key = `${live}-long`
    const build = await acquireBuildLock(key, 'build')
    expect(build.acquired).toBe(true)

    const errors = jest.spyOn(console, 'error').mockImplementation(() => {})
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000)
    try {
      const repair = await acquireBuildLock(key, 'modify')
      expect(repair.acquired).toBe(false)
      const said = errors.mock.calls.map((c) => c.join(' '))
      expect(said.filter((s) => /\[BuildLock\]/.test(s))).toEqual([
        `[BuildLock] A build has held the build lock of project ${key} for 11 minutes. Nothing takes the lock ` +
          'from a live holder: changes to this project wait until it finishes or this process stops.',
      ])
      // Said once per holder, not on every attempt.
      await acquireBuildLock(key, 'modify')
      expect(errors.mock.calls.filter((c) => /\[BuildLock\]/.test(c.join(' ')))).toHaveLength(1)
    } finally {
      clock.mockRestore()
      errors.mockRestore()
    }
    await releaseBuildLock(build.handle)
  }, 30_000)
})
