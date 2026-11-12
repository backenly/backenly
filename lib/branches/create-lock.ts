/**
 * ONE BRANCH IS CUT AT A TIME, PER PROJECT
 * ========================================
 *
 * The active-branch limit was a read-then-write with the whole clone in
 * between: createBranch counted the project's active branches, spent seconds
 * cloning the schema, and only then wrote the branch's row. Two creates that
 * arrived together both counted four, both cloned, and both wrote, so a
 * project held six branches under a limit of five. Production QA (2026-11-09)
 * saw exactly that from an agent that called create_branch in parallel.
 *
 * A PostgreSQL advisory lock decides it, as lib/changes/lock.ts and
 * lib/autonomy/maintenance/single-flight.ts do, for the same reasons: the
 * database decides atomically across every instance; session-scoped, on a
 * connection kept checked out until release, because an unlock on another
 * pooled connection silently does nothing; the two-integer keyspace with a
 * namespace of its own. It is taken on the platform database, where the
 * branch rows are counted and written.
 *
 * It WAITS, up to a bound: the second create runs once the first has finished,
 * and then meets the limit or a free slot like any other. Past the bound it is
 * refused, rather than queued for as long as a large clone takes.
 */
import { Pool } from 'pg'
import { projectToLockKey } from '@/lib/autonomy/maintenance/single-flight'

/** 'brch'. Fixed: changing it would let an old and a new instance both cut a branch. */
const BRANCH_CREATE_LOCK_NAMESPACE = 0x62726368
const DEFAULT_WAIT_MS = 120_000

export class BranchCreateBusyError extends Error {
  readonly code = 'BRANCH_CREATE_IN_PROGRESS'
  constructor() {
    super('Another branch is being created for this project right now. Try again in a moment.')
    this.name = 'BranchCreateBusyError'
  }
}

let pool: Pool | null = null

function lockPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    // An idle client's error is emitted on the pool; unhandled, it ends the process.
    pool.on('error', (err) => console.error('[BranchCreateLock] pool:', err.message))
  }
  return pool
}

/** Run `fn` holding the project's branch-creation lock. */
export async function withBranchCreateLock<T>(
  projectId: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<T> {
  const client = await lockPool().connect()
  const key = projectToLockKey(projectId)
  let locked = false
  let broken = false
  const lost = (err: Error) => {
    broken = true
    console.error(`[BranchCreateLock] connection for ${projectId} lost:`, err.message)
  }
  client.on('error', lost)
  try {
    const waitMs = Math.max(1, Math.floor(opts.waitMs ?? DEFAULT_WAIT_MS))
    await client.query(`SET lock_timeout = ${waitMs}`)
    try {
      await client.query('SELECT pg_advisory_lock($1::int4, $2::int4)', [BRANCH_CREATE_LOCK_NAMESPACE, key])
      locked = true
    } catch (err: any) {
      // 55P03 lock_not_available: lock_timeout expired while waiting.
      if (err?.code === '55P03') throw new BranchCreateBusyError()
      throw err
    } finally {
      await client.query('RESET lock_timeout').catch(() => { broken = true })
    }
    return await fn()
  } finally {
    if (locked && !broken) {
      await client
        .query('SELECT pg_advisory_unlock($1::int4, $2::int4)', [BRANCH_CREATE_LOCK_NAMESPACE, key])
        .catch(() => { broken = true })
    }
    client.off('error', lost)
    // A connection whose unlock did not run is discarded, which ends its
    // session and so the lock with it.
    client.release(broken)
  }
}

/** For tests and shutdown. */
export async function closeBranchCreateLockPool(): Promise<void> {
  const p = pool
  pool = null
  if (p) await p.end()
}
