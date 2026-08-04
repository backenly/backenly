/**
 * BUILD LOCK — Unified Mutation Governance
 * =========================================
 * Single chokepoint for EVERY mutation path in the runtime.
 *
 * Enforces:
 *   1. Project-scoped distributed lock   — PostgreSQL advisory locks (atomic, no TOCTOU)
 *   2. Hourly execution budget           — max 10 build/modify operations per project/hour
 *   3. Cooldown windows                  — 2-min cooldown after any mutation
 *   4. Approval routing                  — destructive actions (DROP_TABLE, etc.) flagged
 *
 * Lock strategy (two-layer):
 *   PRIMARY   — pg_try_advisory_lock(hash(projectId))  — atomic, session-scoped, instant
 *   AUDIT     — BackgroundJob row                       — budget tracking + audit trail
 *
 * The advisory lock is atomic: if two processes race, only one wins.
 * The BackgroundJob provides the audit/budget history.
 *
 * Fallback: if advisory lock fails (DB down), falls back to in-memory map.
 *
 * Rules:
 *   - Every mutation path MUST call withBuildLock() or acquireBuildLock/releaseBuildLock
 *   - Lock is advisory: on DB failure, execution is allowed (fail open — never block user)
 *   - Lock TTL is 10 minutes — a hung build auto-expires via session cleanup
 *   - Budget is per project per hour — not per user (projects are the isolation unit)
 */

import { prisma } from '@/lib/db/prisma'
import { Pool, type PoolClient } from 'pg'

// ── Config ─────────────────────────────────────────────────────────────────────

const LOCK_TTL_MS      = 10 * 60 * 1000  // 10 min stale lock auto-expiry (for mem fallback)
const MAX_OPS_PER_HOUR = 10              // per project
const COOLDOWN_MS      = 2 * 60 * 1000   // 2 min after any mutation
const STALE_JOB_MS     = 2 * 60 * 1000   // BackgroundJob marked 'running' >2 min is stale

/** Categories that require explicit user approval before execution. */
export const APPROVAL_REQUIRED_ACTIONS = new Set([
  'DROP_TABLE',
  'TRUNCATE_TABLE',
  'ROLLBACK_TO_VERSION',
  'REVOKE_KEY',
])

// ── Types ──────────────────────────────────────────────────────────────────────

export type MutationKind = 'build' | 'modify' | 'storage' | 'resume'

export interface BuildLockHandle {
  projectId: string
  lockId: string       // BackgroundJob.id (for budget audit)
  lockKey: number      // pg advisory lock key
  kind: MutationKind
  acquiredAt: number
  usingAdvisory: boolean  // true = pg advisory, false = in-memory fallback
}

export interface LockResult {
  acquired: boolean
  handle?: BuildLockHandle
  blockedReason?: string
}

export interface BudgetResult {
  allowed: boolean
  remaining: number
  blockedReason?: string
}

// ── Advisory lock key derivation ───────────────────────────────────────────────

/**
 * Hash a projectId string to a positive 32-bit integer for use as a
 * PostgreSQL advisory lock key. djb2 variant — deterministic and collision-resistant
 * enough for per-project scoping.
 */
function projectToLockKey(projectId: string): number {
  let hash = 5381
  for (let i = 0; i < projectId.length; i++) {
    hash = ((hash << 5) - hash) + projectId.charCodeAt(i)
    hash = hash | 0  // keep 32-bit int
  }
  return Math.abs(hash)
}

// ── PostgreSQL advisory locks ─────────────────────────────────────────────────
//
// THE POOL BUG THIS EXISTS TO FIX
// -------------------------------
// `pg_advisory_lock` is SESSION-scoped. These two calls used to go through
// `prisma.$queryRaw`, which draws an arbitrary connection from the pool — so the
// lock could be taken on connection A and the unlock issued on connection B.
// `pg_advisory_unlock` on a session that does not hold the lock does not throw:
// it logs a warning and returns FALSE. The return value was discarded, so the
// failure was completely silent and the lock stayed held on connection A until
// that connection happened to be recycled.
//
// The old code knew: "if Prisma happens to reuse the original connection, this
// will succeed." Correctness rested on pool luck.
//
// The consequence was not theoretical. It reproduced on demand under repeated
// repair cycles against a real database:
// after a repair, later repairs for that project fail with "Another auto-fix is
// in progress" while ZERO BackgroundJobs are running — so `reapStaleJobs` finds
// nothing to reap (release had already marked the job `completed`), gives up,
// and the project loses autonomous repair entirely until the connection
// recycles. That is the same silent-stall shape as the thirteen-day
// `attempted=0` outage: every ledger row looks like activity.
//
// So the lock now holds a DEDICATED connection for its whole lifetime. Acquire
// and release are provably the same session, and the unlock result is checked
// rather than assumed. If the process dies the connection dies with it, which
// releases the lock — the correct behaviour for an advisory lock.

/**
 * Connections used solely to hold advisory locks. Separate from Prisma's pool
 * because a connection parked holding a lock must not be handed to unrelated
 * queries, and because Prisma gives no API to pin one.
 */
const lockPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Locks are held briefly and one at a time per project. This ceiling bounds
  // how many projects can mutate concurrently on one instance.
  max: 10,
})

/** lockKey → the connection holding it. The pin that makes unlock correct. */
const _heldLockClients = new Map<number, PoolClient>()

/**
 * Take the advisory lock on a connection we keep checked out.
 * Returns false without leaking the connection when the lock is already held.
 */
async function pgTryAdvisoryLock(key: number): Promise<boolean> {
  // Already held by this process — do not double-acquire. pg advisory locks are
  // re-entrant per session and would then need matching unlocks to release.
  if (_heldLockClients.has(key)) return false

  let client: PoolClient
  try {
    client = await lockPool.connect()
  } catch {
    return false
  }

  try {
    const res = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [key],
    )
    if (res.rows[0]?.acquired === true) {
      _heldLockClients.set(key, client)
      return true
    }
    client.release()
    return false
  } catch {
    client.release()
    return false
  }
}

/**
 * Release the advisory lock on the SAME connection that took it.
 *
 * Loud on failure: a silent false here is precisely the bug above, and a lock
 * that fails to release costs the project its autonomous repairs.
 */
async function pgAdvisoryUnlock(key: number): Promise<void> {
  const client = _heldLockClients.get(key)
  if (!client) {
    // Nothing pinned for this key. Either the lock was never taken by this
    // process, or it was taken by another instance — in which case stealing it
    // would be wrong. Both are no-ops, not errors.
    return
  }

  _heldLockClients.delete(key)
  try {
    const res = await client.query<{ released: boolean }>(
      'SELECT pg_advisory_unlock($1::bigint) AS released',
      [key],
    )
    if (res.rows[0]?.released !== true) {
      console.error(
        `[BuildLock] pg_advisory_unlock(${key}) returned false on the session that ` +
        `holds it. This should be impossible; the connection is being destroyed so ` +
        `the lock cannot leak.`,
      )
      // Destroying the connection guarantees the lock is dropped server-side.
      client.release(new Error('advisory unlock failed'))
      return
    }
    client.release()
  } catch (err: any) {
    console.error(`[BuildLock] advisory unlock error for ${key}: ${err?.message}`)
    // Destroy rather than return a possibly-locked connection to the pool.
    client.release(new Error('advisory unlock threw'))
  }
}

// ── In-memory fallback lock ────────────────────────────────────────────────────

const _memLocks = new Map<string, { acquiredAt: number; kind: MutationKind }>()

function memAcquire(projectId: string, kind: MutationKind): boolean {
  const existing = _memLocks.get(projectId)
  if (existing && Date.now() - existing.acquiredAt < LOCK_TTL_MS) return false
  _memLocks.set(projectId, { acquiredAt: Date.now(), kind })
  return true
}

function memRelease(projectId: string): void {
  _memLocks.delete(projectId)
}

// ── Stale-job cleanup ─────────────────────────────────────────────────────────

/**
 * Reap BackgroundJob rows stuck in 'running' status for longer than STALE_JOB_MS.
 *
 * Why: pg_advisory_lock is session-scoped. With Prisma's pooled connections,
 * a release call can land on a different pooled connection than the acquire,
 * leaving the original lock held until the source connection is cycled out.
 * This function detects orphaned BackgroundJob rows and marks them as failed
 * so budget checks recover, and attempts a best-effort advisory_unlock on the
 * stuck key.
 *
 * Returns true if any stale job was cleaned up (caller may retry the lock).
 */
async function reapStaleJobs(projectId: string, lockKey: number): Promise<boolean> {
  try {
    const staleCutoff = new Date(Date.now() - STALE_JOB_MS)
    const reaped = await prisma.backgroundJob.updateMany({
      where: {
        projectId,
        type: 'build_lock',
        status: 'running',
        OR: [
          { startedAt: { lt: staleCutoff } },
          { startedAt: null, createdAt: { lt: staleCutoff } },
          { timeoutAt: { lt: new Date() } },
        ],
      },
      data: { status: 'failed', completedAt: new Date(), error: 'Stale lock reaped (job exceeded TTL)' },
    })

    if (reaped.count === 0) return false

    // Release the advisory lock if THIS process is the one pinning it. When the
    // holder is another instance, `pgAdvisoryUnlock` is a no-op by design —
    // forcibly stealing a lock held elsewhere is how two workers end up mutating
    // one project at once, which is the exact race the lock exists to prevent.
    await pgAdvisoryUnlock(lockKey)

    return true
  } catch {
    return false
  }
}

// ── Lock acquisition ───────────────────────────────────────────────────────────

/**
 * Acquire a project-scoped mutation lock.
 *
 * Uses PostgreSQL advisory locks as the primary mechanism (atomic, no TOCTOU race).
 * Creates a BackgroundJob record for budget tracking.
 * Falls back to in-memory lock if the DB is unreachable.
 *
 * If the advisory lock is held, attempts a stale-lock reap before giving up —
 * orphaned locks from Prisma pool churn are auto-cleared.
 */
export async function acquireBuildLock(
  projectId: string,
  kind: MutationKind = 'build',
): Promise<LockResult> {
  const lockKey = projectToLockKey(projectId)

  // ── Primary: PostgreSQL advisory lock ─────────────────────────────────────
  try {
    let acquired = await pgTryAdvisoryLock(lockKey)

    // If the lock is held, check whether it's stale and retry once after reaping.
    if (!acquired) {
      const reaped = await reapStaleJobs(projectId, lockKey)
      if (reaped) {
        acquired = await pgTryAdvisoryLock(lockKey)
      }
    }

    if (!acquired) {
      return {
        acquired: false,
        blockedReason: `Another auto-fix is in progress for this project. Try again in a few seconds.`,
      }
    }

    // Create BackgroundJob for audit trail + budget tracking
    let jobId = `advisory:${projectId}:${Date.now()}`
    try {
      const record = await prisma.backgroundJob.create({
        data: {
          projectId,
          type: 'build_lock',
          status: 'running',
          payload: { kind, lockKey, lockedAt: new Date().toISOString() },
          maxAttempts: 1,
          startedAt: new Date(),
          timeoutAt: new Date(Date.now() + LOCK_TTL_MS),
        },
      })
      jobId = record.id
    } catch { /* non-fatal — advisory lock already acquired */ }

    return {
      acquired: true,
      handle: { projectId, lockId: jobId, lockKey, kind, acquiredAt: Date.now(), usingAdvisory: true },
    }
  } catch {
    // DB completely unreachable — fall back to in-memory
  }

  // ── Fallback: in-memory lock ───────────────────────────────────────────────
  const acquired = memAcquire(projectId, kind)
  if (!acquired) {
    return { acquired: false, blockedReason: 'Another operation is in progress.' }
  }
  return {
    acquired: true,
    handle: {
      projectId,
      lockId: `mem:${projectId}:${Date.now()}`,
      lockKey,
      kind,
      acquiredAt: Date.now(),
      usingAdvisory: false,
    },
  }
}

/** Release a previously acquired lock. Safe to call multiple times. */
export async function releaseBuildLock(handle: BuildLockHandle | undefined): Promise<void> {
  if (!handle) return

  if (handle.usingAdvisory) {
    await pgAdvisoryUnlock(handle.lockKey)
  } else if (handle.lockId.startsWith('mem:')) {
    memRelease(handle.projectId)
    return
  }

  // Update BackgroundJob audit record
  if (!handle.lockId.startsWith('mem:') && !handle.lockId.startsWith('advisory:')) {
    await prisma.backgroundJob.update({
      where: { id: handle.lockId },
      data: { status: 'completed', completedAt: new Date() },
    }).catch(() => {})
  } else {
    // Best-effort update for jobs with generated IDs
    await prisma.backgroundJob.updateMany({
      where: {
        projectId: handle.projectId,
        type: 'build_lock',
        status: 'running',
      },
      data: { status: 'completed', completedAt: new Date() },
    }).catch(() => {})
  }
}

// ── Budget enforcement ─────────────────────────────────────────────────────────

/**
 * Check whether the project is within its hourly mutation budget.
 * Also enforces the post-mutation cooldown window.
 */
export async function checkBuildBudget(projectId: string): Promise<BudgetResult> {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)

    const recentCount = await prisma.backgroundJob.count({
      where: {
        projectId,
        type: 'build_lock',
        status: { in: ['completed', 'failed'] },
        startedAt: { gte: oneHourAgo },
      },
    })

    if (recentCount >= MAX_OPS_PER_HOUR) {
      return {
        allowed: false,
        remaining: 0,
        blockedReason: `Hourly mutation budget reached (${MAX_OPS_PER_HOUR} operations/hour). Try again in a few minutes.`,
      }
    }

    // Cooldown: block if a mutation completed very recently
    const cooldownCutoff = new Date(Date.now() - COOLDOWN_MS)
    const recent = await prisma.backgroundJob.findFirst({
      where: {
        projectId,
        type: 'build_lock',
        status: 'completed',
        completedAt: { gte: cooldownCutoff },
      },
      orderBy: { completedAt: 'desc' },
    })

    if (recent?.completedAt) {
      const waitMs = COOLDOWN_MS - (Date.now() - recent.completedAt.getTime())
      if (waitMs > 0) {
        const waitSec = Math.ceil(waitMs / 1000)
        return {
          allowed: false,
          remaining: MAX_OPS_PER_HOUR - recentCount,
          blockedReason: `Cooldown active — wait ${waitSec}s before the next mutation.`,
        }
      }
    }

    return { allowed: true, remaining: MAX_OPS_PER_HOUR - recentCount }
  } catch {
    // DB unavailable — allow (fail open)
    return { allowed: true, remaining: MAX_OPS_PER_HOUR }
  }
}

// ── Approval routing ───────────────────────────────────────────────────────────

/** Returns true if this action requires explicit user approval before execution. */
export function requiresApproval(action: string): boolean {
  return APPROVAL_REQUIRED_ACTIONS.has(action)
}

// ── High-level wrapper ────────────────────────────────────────────────────────

/**
 * Execute a mutation function under full governance: budget → lock → execute → release.
 *
 * On budget or lock failure, returns { error } instead of executing fn.
 * The lock is always released (advisory + job) even if fn throws.
 */
export async function withBuildLock<T>(
  projectId: string,
  kind: MutationKind,
  fn: (handle: BuildLockHandle) => Promise<T>,
  opts: { skipCooldown?: boolean } = {},
): Promise<{ result?: T; error?: string }> {
  // 1. Budget check (skip cooldown for resumes — they continue an existing build)
  if (!opts.skipCooldown) {
    const budget = await checkBuildBudget(projectId)
    if (!budget.allowed) {
      return { error: budget.blockedReason }
    }
  }

  // 2. Advisory lock acquisition
  const lockResult = await acquireBuildLock(projectId, kind)
  if (!lockResult.acquired || !lockResult.handle) {
    return { error: lockResult.blockedReason }
  }

  const handle = lockResult.handle

  // 3. Execute under lock — always release in finally
  try {
    const result = await fn(handle)
    return { result }
  } finally {
    await releaseBuildLock(handle)
  }
}
