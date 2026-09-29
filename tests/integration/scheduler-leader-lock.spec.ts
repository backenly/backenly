/**
 * One scheduler per database, against a real Postgres.
 *
 * Every web process runs the scheduler, and a job runs only where the scheduler
 * lock is held (lib/scheduler/leader.ts). That is what lets two instances, or a
 * deploy that briefly overlaps the old task with the new one, share a database
 * without running users' cron functions, backups or the usage close twice.
 *
 * What is being tested is PostgreSQL session semantics (a session lock follows
 * its connection, and dies with it), so mocking would prove nothing.
 */
import { Client } from 'pg'
import { SchedulerLeadership, SCHEDULER_LOCK_KEY, leaderOnly } from '@/lib/scheduler/leader'

const CONN = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || ''
const FAST = { connectionString: CONN, retryMs: 50, heartbeatMs: 50, queryTimeoutMs: 5_000, log: () => {} }

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Sessions that hold the scheduler lock right now, as the database sees it. */
async function holders(): Promise<number> {
  const c = new Client({ connectionString: CONN })
  await c.connect()
  try {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND classid = $1::int::oid AND objid = $2::int::oid AND objsubid = 2`,
      [SCHEDULER_LOCK_KEY[0], SCHEDULER_LOCK_KEY[1]],
    )
    return r.rows[0].n
  } finally {
    await c.end()
  }
}

describe('scheduler leader lock', () => {
  const started: SchedulerLeadership[] = []
  const make = () => {
    const l = new SchedulerLeadership(FAST)
    started.push(l)
    return l
  }
  afterEach(async () => {
    await Promise.all(started.splice(0).map((l) => l.stop()))
  })

  it('makes exactly one of two instances the leader', async () => {
    const a = make()
    const b = make()
    a.start()
    b.start()
    await until(() => a.isLeader() || b.isLeader())
    // Give the follower several retries in which it could wrongly win.
    await new Promise((r) => setTimeout(r, 300))
    expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1)
    expect(await holders()).toBe(1)
  })

  it('hands the lock to the waiting instance when the leader stops (a deploy)', async () => {
    const old = make()
    old.start()
    await until(() => old.isLeader())
    const next = make()
    next.start()
    await new Promise((r) => setTimeout(r, 200))
    expect(next.isLeader()).toBe(false)

    await old.stop()
    expect(old.isLeader()).toBe(false)
    await until(() => next.isLeader())
    expect(await holders()).toBe(1)
  })

  it('stops leading, and lets another instance lead, when its session dies', async () => {
    const a = make()
    a.start()
    await until(() => a.isLeader())

    // Kill the leader's session from outside, as a failover or a network cut would.
    const admin = new Client({ connectionString: CONN })
    await admin.connect()
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE application_name = 'backenly-scheduler-lock' AND pid <> pg_backend_pid()`,
      )
    } finally {
      await admin.end()
    }

    await until(() => !a.isLeader())
    const b = make()
    b.start()
    // Either may win the lock back, but never both.
    await until(() => a.isLeader() || b.isLeader())
    await new Promise((r) => setTimeout(r, 300))
    expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1)
    expect(await holders()).toBe(1)
  })

  it('never leads without a database, and a stopped instance never leads again', async () => {
    const lost = new SchedulerLeadership({ ...FAST, connectionString: 'postgresql://x:y@127.0.0.1:1/none' })
    started.push(lost)
    lost.start()
    await new Promise((r) => setTimeout(r, 300))
    expect(lost.isLeader()).toBe(false)

    const a = make()
    a.start()
    await until(() => a.isLeader())
    await a.stop()
    await new Promise((r) => setTimeout(r, 200))
    expect(a.isLeader()).toBe(false)
    expect(await holders()).toBe(0)
  })
})

describe('leaderOnly', () => {
  it('runs the job only while the instance leads, checked at each tick', async () => {
    let leading = false
    let runs = 0
    const tick = leaderOnly(() => { runs++ }, () => leading)
    await tick()
    expect(runs).toBe(0)
    leading = true
    await tick()
    await tick()
    expect(runs).toBe(2)
    leading = false
    await tick()
    expect(runs).toBe(2)
  })
})
