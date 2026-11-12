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
 *   - The lock lasts exactly as long as its holder: the holder releases it, or
 *     the holder's process stops and its session ends with it. Nothing else
 *     releases it, not another acquirer and not a timer: a slow holder cannot be
 *     told from a hung one, and taking the lock from one still working runs two
 *     changes on one project at once. A holder past LOCK_TTL_MS is logged.
 *   - A release releases only its own acquisition (a token), so a release that
 *     comes late never frees the next holder.
 *   - Budget is per project per hour — not per user (projects are the isolation unit)
 */

import { prisma } from '@/lib/db/prisma'
import { Pool, type PoolClient } from 'pg'

// ── Config ─────────────────────────────────────────────────────────────────────

// The job record's deadline (timeoutAt): past it the queue's stuck-job sweep
// closes a record whose holder stopped without releasing (lib/queue,
// detectAndTimeoutStuckJobs). Also the age past which a holder in this process
// is logged. Never a reason to take the lock from its holder.
const LOCK_TTL_MS      = 10 * 60 * 1000
const MAX_OPS_PER_HOUR = 10              // per project
const COOLDOWN_MS      = 2 * 60 * 1000   // 2 min after any mutation

/** What a caller is told while another holder has the project's lock. */
const BLOCKED_REASON = 'Another change to this project is still in progress. Try again when it finishes.'

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
  /** This acquisition of the advisory lock: only it releases the lock. */
  token?: symbol
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
// in progress" while ZERO BackgroundJobs are running — so the stale-job reaper
// found nothing to reap (release had already marked the job `completed`), gave up,
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

/** A lock this process holds: the connection it was taken on, and which acquisition took it. */
interface HeldLock {
  client: PoolClient
  token: symbol
  since: number
  kind?: MutationKind
  /** Whether a holder this long has been logged (once per holder). */
  said?: boolean
}

/** lockKey → the lock this process holds. The pin that makes unlock correct. */
const _heldLocks = new Map<number, HeldLock>()

/**
 * Take the advisory lock on a connection we keep checked out. Returns this
 * acquisition's token, or null without leaking the connection when the lock is
 * already held.
 */
async function pgTryAdvisoryLock(key: number): Promise<symbol | null> {
  // Already held by this process — do not double-acquire. pg advisory locks are
  // re-entrant per session and would then need matching unlocks to release.
  if (_heldLocks.has(key)) return null

  let client: PoolClient
  try {
    client = await lockPool.connect()
  } catch {
    return null
  }

  try {
    const res = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [key],
    )
    if (res.rows[0]?.acquired === true) {
      const token = Symbol(`build-lock:${key}`)
      _heldLocks.set(key, { client, token, since: Date.now() })
      return token
    }
    client.release()
    return null
  } catch {
    client.release()
    return null
  }
}

/**
 * Release the advisory lock on the SAME connection that took it, and only for
 * the acquisition that took it.
 *
 * Loud on failure: a silent false here is precisely the bug above, and a lock
 * that fails to release costs the project its autonomous repairs.
 */
async function pgAdvisoryUnlock(key: number, token: symbol): Promise<void> {
  const held = _heldLocks.get(key)
  if (!held || held.token !== token) {
    // Not this acquisition's lock: released already, never taken by this
    // process, or taken since by the next holder, whose lock this must not
    // free. A no-op, not an error.
    return
  }
  const client = held.client

  _heldLocks.delete(key)
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

// The same rule as the advisory lock: held until its holder releases it (the
// process is alive while it holds it), and released only by that acquisition.
const _memLocks = new Map<string, { acquiredAt: number; kind: MutationKind; token: symbol }>()

function memAcquire(projectId: string, kind: MutationKind): symbol | null {
  if (_memLocks.has(projectId)) return null
  const token = Symbol(`build-lock:mem:${projectId}`)
  _memLocks.set(projectId, { acquiredAt: Date.now(), kind, token })
  return token
}

function memRelease(projectId: string, token: symbol | undefined): void {
  if (token && _memLocks.get(projectId)?.token === token) _memLocks.delete(projectId)
}

// ── A holder that has kept the lock a long time ───────────────────────────────
//
// There is no stale-lock reaping. It used to run whenever an acquirer found
// the lock held: any holder whose record was more than two minutes old was
// marked failed and its lock released on its own connection, so the caller
// could take it. The lock is pinned to its holder's connection and ends with
// its session, so the only holder that reaping could release was one still
// running in this process — a build of several tables, an index built online
// on a large table — and the reconciler, which tries a repair every minute,
// then changed the project alongside it. A record left 'running' by a process
// that stopped is closed by the queue's stuck-job sweep (timeoutAt).

const HOLDER_WORDS: Record<MutationKind, string> = {
  build: 'build',
  modify: 'change',
  storage: 'storage change',
  resume: 'resumed build',
}

/** Log, once per holder, a holder in this process that has kept the lock past LOCK_TTL_MS. */
function sayLongHolder(projectId: string, key: number): void {
  const held = _heldLocks.get(key)
  if (!held || held.said) return
  const age = Date.now() - held.since
  if (age < LOCK_TTL_MS) return
  held.said = true
  const holder = held.kind ? `A ${HOLDER_WORDS[held.kind]}` : 'A holder'
  console.error(
    `[BuildLock] ${holder} has held the build lock of project ${projectId} for ${Math.floor(age / 60_000)} minutes. ` +
      'Nothing takes the lock from a live holder: changes to this project wait until it finishes or this process stops.',
  )
}

// ── Lock acquisition ───────────────────────────────────────────────────────────

/**
 * Acquire a project-scoped mutation lock.
 *
 * Uses PostgreSQL advisory locks as the primary mechanism (atomic, no TOCTOU race).
 * Creates a BackgroundJob record for budget tracking.
 * Falls back to in-memory lock if the DB is unreachable.
 *
 * If the lock is held, the caller is told so and waits: it never takes the
 * lock from its holder, however long that holder has had it.
 */
export async function acquireBuildLock(
  projectId: string,
  kind: MutationKind = 'build',
): Promise<LockResult> {
  const lockKey = projectToLockKey(projectId)

  // ── Primary: PostgreSQL advisory lock ─────────────────────────────────────
  try {
    const token = await pgTryAdvisoryLock(lockKey)
    if (!token) {
      sayLongHolder(projectId, lockKey)
      return { acquired: false, blockedReason: BLOCKED_REASON }
    }
    const held = _heldLocks.get(lockKey)
    if (held) held.kind = kind

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
      handle: { projectId, lockId: jobId, lockKey, kind, acquiredAt: Date.now(), usingAdvisory: true, token },
    }
  } catch {
    // DB completely unreachable — fall back to in-memory
  }

  // ── Fallback: in-memory lock ───────────────────────────────────────────────
  const token = memAcquire(projectId, kind)
  if (!token) {
    return { acquired: false, blockedReason: BLOCKED_REASON }
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
      token,
    },
  }
}

/**
 * Release a previously acquired lock. Safe to call more than once: only the
 * acquisition that holds the lock releases it, so a release that comes late
 * never frees the next holder, and never closes the next holder's record.
 */
export async function releaseBuildLock(handle: BuildLockHandle | undefined): Promise<void> {
  if (!handle) return

  if (!handle.usingAdvisory) {
    memRelease(handle.projectId, handle.token)
    return
  }

  if (!handle.token || _heldLocks.get(handle.lockKey)?.token !== handle.token) return

  // The record first, while this acquisition still holds the lock: a record
  // reads 'running' only while its holder has the lock. A lock taken without a
  // record (the create failed) has none to close; the other 'running' records
  // are not this holder's.
  if (!handle.lockId.startsWith('advisory:')) {
    await prisma.backgroundJob.update({
      where: { id: handle.lockId },
      data: { status: 'completed', completedAt: new Date() },
    }).catch(() => {})
  }
  await pgAdvisoryUnlock(handle.lockKey, handle.token)
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

/**
 * Run `fn` holding the project's build lock if it is free, and record nothing:
 * no job row, so no budget or cooldown is spent. For a short section that must
 * not land in the middle of a mutation (consent to an architecture change,
 * lib/evolution-engine/engine.ts approveRequest), never for a mutation itself.
 */
export async function whileBuildLockFree<T>(projectId: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const key = projectToLockKey(projectId)
  const token = await pgTryAdvisoryLock(key)
  if (!token) return { ran: false }
  try {
    return { ran: true, value: await fn() }
  } finally {
    await pgAdvisoryUnlock(key, token)
  }
}
