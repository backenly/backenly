/**
 * Pausing and resuming a project: the mechanics, and only the mechanics.
 *
 * ── The caller decides, this performs ───────────────────────────────────────
 *
 * Whether a project SHOULD be paused, and whether its owner may resume it for
 * free, are Backenly Cloud's commercial questions. They are answered in the
 * private overlay, which reads the owner's entitlements INSIDE the lock this
 * module provides and only then calls a transition here. Nothing in this file
 * reads a plan, a subscription or an entitlement, and a test pins that.
 *
 * Nothing public calls `applyPauseTransition` either (also pinned), so on a
 * self-hosted deployment `pausedAt` is never set and none of this ever runs.
 * The same shape as lib/projects/sandbox-lifecycle.ts: a transition on
 * project-local columns is product, the decision to make it is not.
 *
 * ── Why a lock, and why it fails CLOSED ─────────────────────────────────────
 *
 * A pause is decided on one read and committed later, after a pg_dump that can
 * take a while. Traffic can arrive in between; so can a second sweep, a resume
 * click, or a plan change. Every lifecycle write therefore runs under a
 * per-project transaction-scoped advisory lock, and the final write is
 * conditional on the state the decision was made against.
 *
 * lib/ai/build-runtime/build-lock.ts is deliberately NOT reused: it falls back
 * to an in-memory lock and lets the work proceed when the database is
 * unreachable, which is right for a user's mutation and wrong here. A lifecycle
 * transition that cannot be serialised does not happen.
 */
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { ensureSchemaRegistered } from '@/lib/postgrest/registration'
import { discardOutbox } from '@/lib/webhooks/capture'
import { DELETED_PAUSE_REASON, MIGRATING_PAUSE_REASON, invalidateProjectServingState } from './serving-state'
import { confirmPropagation, type Propagation } from '@/lib/auth-projection/confirm'

export type LifecycleTx = Prisma.TransactionClient

/**
 * First key of the two-key advisory lock. The build lock uses the single
 * 64-bit form, and PostgreSQL keeps the two forms in separate key spaces, so
 * the two locks can never contend with each other.
 */
const LIFECYCLE_LOCK_SPACE = 0x70617573 // 'paus'

export class LifecycleBusyError extends Error {
  readonly code = 'LIFECYCLE_BUSY'
  constructor(projectId: string) {
    super(`Another pause or resume is in progress for project ${projectId}.`)
    this.name = 'LifecycleBusyError'
  }
}

/** Who caused a transition, for the audit trail. */
export type LifecycleActor =
  | { kind: 'system'; label: string }
  | { kind: 'user'; userId: string; email?: string | null }

/**
 * Run `fn` holding this project's lifecycle lock, in one transaction.
 *
 * Throws LifecycleBusyError when another transition holds the lock, and lets a
 * database error propagate. Neither is swallowed: the caller either skips the
 * project this run (the sweep) or tells the user to try again (resume).
 */
export async function withProjectLifecycleLock<T>(
  projectId: string,
  fn: (tx: LifecycleTx) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async tx => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${LIFECYCLE_LOCK_SPACE}::int, hashtext(${projectId})) AS acquired`
      if (!rows[0]?.acquired) throw new LifecycleBusyError(projectId)
      return fn(tx)
    },
    // Short on purpose: the slow part of a pause (the snapshot) happens before
    // the lock is taken, never inside it.
    { maxWait: 5_000, timeout: 15_000 },
  )
}

export interface PauseTransitionInput {
  /**
   * `lastActivityAt` as it was when the decision to pause was made. The write
   * only lands if it is still exactly that, so real use that arrived while the
   * snapshot ran cancels the pause instead of being overruled by it.
   */
  observedLastActivityAt: Date | null
  reason: string
}

export interface PauseTransitionResult {
  paused: boolean
  cancelledDeliveries: number
}

/**
 * Mark a project paused, if and only if nothing changed since the decision.
 *
 * Must be called inside withProjectLifecycleLock. Returns `{ paused: false }`
 * when the project was used, deleted, locked or already paused in the meantime;
 * that is an ordinary outcome, not an error.
 */
export async function applyPauseTransition(
  tx: LifecycleTx,
  projectId: string,
  input: PauseTransitionInput,
): Promise<PauseTransitionResult> {
  // Prisma drops an `undefined` filter entirely, which would silently remove
  // the one guard that stops a stale decision pausing a project in use.
  if (input.observedLastActivityAt === undefined) {
    throw new Error('applyPauseTransition: observedLastActivityAt is required (null when never used)')
  }

  const { count } = await tx.project.updateMany({
    where: {
      id: projectId,
      pausedAt: null,
      deletedAt: null,
      lockedDownAt: null,
      // Prisma renders both a Date and null here as an exact match, which is
      // IS NOT DISTINCT FROM: a project first used mid-snapshot no longer
      // matches a decision taken while it had never been used.
      lastActivityAt: input.observedLastActivityAt,
    },
    data: { pausedAt: new Date(), pauseReason: input.reason },
  })

  if (count === 0) return { paused: false, cancelledDeliveries: 0 }

  const cancelledDeliveries = await cancelPendingDeliveries(tx, projectId)
  return { paused: true, cancelledDeliveries }
}

/**
 * The half of a pause that cannot run inside the lifecycle transaction.
 *
 * The webhook outbox lives in the project's own schema and is reached through
 * the workspace pool, a different connection. Pending deliveries are cancelled
 * a second time here, idempotently, to catch one that a drain already in flight
 * created after the transaction's own pass.
 */
export async function afterPauseCommitted(
  projectId: string,
  input: {
    reason: string
    actor: LifecycleActor
    cancelledDeliveries: number
    snapshotId?: string | null
  },
): Promise<{ discardedOutboxEvents: number; cancelledDeliveries: number; propagation: Propagation }> {
  // This process's own gates (MCP, the mutation kernel) see the pause now. The
  // runtime is another process and catches up within FRESH_MS. A project kept
  // in another region is paused there once its region has the change
  // (lib/auth-projection/confirm.ts).
  invalidateProjectServingState(projectId)
  // Its direct Postgres logins connect past every door, so they stop too;
  // resuming brings them back with the same passwords. Never throws.
  await (await import('./paused-logins')).stopDirectLogins(projectId, 'paused')
  const propagation = await confirmPropagation({ entity: 'project', entityId: projectId })

  const discardedOutboxEvents = await discardOutbox(projectId)
  const lateCancellations = await cancelPendingDeliveries(prisma, projectId)
  const cancelledDeliveries = input.cancelledDeliveries + lateCancellations

  await writeAudit(projectId, 'PROJECT_PAUSED', input.actor, `Project paused (${input.reason})`, {
    reason: input.reason,
    cancelledDeliveries,
    discardedOutboxEvents,
    snapshotId: input.snapshotId ?? null,
    propagation,
  })

  return { discardedOutboxEvents, cancelledDeliveries, propagation }
}

/**
 * Clear a pause. Must be called inside withProjectLifecycleLock.
 *
 * Idempotent: a project that is not paused (a second click, a concurrent
 * resume) matches nothing and returns `{ resumed: false }`.
 *
 * Resuming counts as use, so the inactivity clock restarts from now.
 */
export async function applyResumeTransition(
  tx: LifecycleTx,
  projectId: string,
): Promise<{ resumed: boolean }> {
  const { count } = await tx.project.updateMany({
    // Never the pause of a move to a database of its own: that move ends it
    // (applyMigrationThaw), and lifting it early would let the project serve
    // from a database mid-copy.
    where: {
      id: projectId,
      pausedAt: { not: null },
      OR: [{ pauseReason: null }, { pauseReason: { not: MIGRATING_PAUSE_REASON } }],
    },
    data: {
      pausedAt: null,
      pauseReason: null,
      pauseWarnedAt: null,
      lastActivityAt: new Date(),
    },
  })
  return { resumed: count > 0 }
}

/**
 * The half of a resume that must not run inside the lifecycle transaction.
 *
 * Registration is idempotent and was never removed by the pause, so this is a
 * repair for anything that drifted while the project sat paused rather than a
 * step the resume depends on.
 */
export async function afterResumeCommitted(projectId: string, actor: LifecycleActor): Promise<void> {
  // Without this the owner who just clicked Resume would be refused by this
  // process's MCP and mutation gates for up to FRESH_MS.
  invalidateProjectServingState(projectId)
  // The direct Postgres logins the pause stopped, back with their passwords. Never throws.
  await (await import('./paused-logins')).restoreDirectLogins(projectId, 'resumed')
  await ensureSchemaRegistered(projectId)
  await writeAudit(projectId, 'PROJECT_RESUMED', actor, 'Project resumed', {})
}

// ── The pause of a move to a database of its own ─────────────────────────────
//
// A move (lib/data-plane/tenancy-migration.ts) stops every door for a few
// minutes while the project's data is copied, as any pause does, and then
// lets it serve again. Unlike an inactivity pause it is not a decision about
// the project: nothing is thrown away. The webhook outbox and the deliveries
// waiting to go out are kept, so the events a project captured before the move
// are delivered after it, from its new database. And it changes nothing else
// on the row: ending it leaves the project exactly as it was before.

/**
 * Pause a project for a move to a database of its own, if it is serving: not
 * paused for any reason, not deleted, not locked. Must be called inside
 * withProjectLifecycleLock. `{ frozen: false }` is an ordinary answer: the
 * move does not go ahead.
 */
export async function applyMigrationFreeze(tx: LifecycleTx, projectId: string): Promise<{ frozen: boolean }> {
  const { count } = await tx.project.updateMany({
    where: { id: projectId, pausedAt: null, deletedAt: null, lockedDownAt: null },
    data: { pausedAt: new Date(), pauseReason: MIGRATING_PAUSE_REASON },
  })
  return { frozen: count > 0 }
}

/**
 * End a move's pause. Must be called inside withProjectLifecycleLock. Only
 * that pause: one with another reason is left alone. A project whose deletion
 * was asked for during the move stays paused, as a deleted project
 * (lib/projects/deletion.ts), rather than serving. Nothing else on the row is
 * touched, so the inactivity clock is where it was.
 */
export async function applyMigrationThaw(tx: LifecycleTx, projectId: string): Promise<{ thawed: boolean; deleted: boolean }> {
  const row = await tx.project.findUnique({ where: { id: projectId }, select: { pauseReason: true, pausedAt: true, deletedAt: true } })
  if (!row || !row.pausedAt || row.pauseReason !== MIGRATING_PAUSE_REASON) return { thawed: false, deleted: false }
  if (row.deletedAt) {
    await tx.project.update({ where: { id: projectId }, data: { pauseReason: DELETED_PAUSE_REASON } })
    return { thawed: false, deleted: true }
  }
  await tx.project.update({ where: { id: projectId }, data: { pausedAt: null, pauseReason: null } })
  return { thawed: true, deleted: false }
}

/**
 * The half of a move's pause outside the lifecycle transaction: this process's
 * gates see it at once, the project's direct logins stop (their sessions end),
 * and its region is told. The outbox and the deliveries are kept. Never throws
 * once the pause has committed; what could not be done is in the answer.
 */
export async function afterMigrationFreezeCommitted(
  projectId: string,
  actor: LifecycleActor,
): Promise<{ stoppedLogins: string[]; propagation: Propagation | null }> {
  invalidateProjectServingState(projectId)
  const stoppedLogins = await (await import('./paused-logins')).stopDirectLogins(projectId, MIGRATING_PAUSE_REASON)
  const propagation = await confirmPropagation({ entity: 'project', entityId: projectId }).catch(() => null)
  await writeAudit(projectId, 'PROJECT_PAUSED', actor, 'Project paused while it moves to a database of its own', {
    reason: MIGRATING_PAUSE_REASON,
    outboxKept: true,
    stoppedLogins: stoppedLogins.length,
    propagation,
  }).catch(() => {})
  return { stoppedLogins, propagation }
}

/**
 * The half of ending a move's pause outside the lifecycle transaction, wherever
 * the project's data now is: this process's gates, the direct logins back with
 * their passwords in that database (lib/projects/paused-logins.ts), and its
 * canonical schema served there. Never throws.
 */
export async function afterMigrationThawCommitted(
  projectId: string,
  actor: LifecycleActor,
): Promise<{ restoredLogins: string[]; propagation: Propagation | null }> {
  invalidateProjectServingState(projectId)
  const restoredLogins = await (await import('./paused-logins')).restoreDirectLogins(projectId, 'move ended')
  await ensureSchemaRegistered(projectId).catch(() => null)
  const propagation = await confirmPropagation({ entity: 'project', entityId: projectId }).catch(() => null)
  await writeAudit(projectId, 'PROJECT_RESUMED', actor, 'Project serving again after its move', {
    reason: MIGRATING_PAUSE_REASON,
    restoredLogins: restoredLogins.length,
    propagation,
  }).catch(() => {})
  return { restoredLogins, propagation }
}

// ── Internals ────────────────────────────────────────────────────────────────

/** Cancel a project's webhook deliveries still waiting to go out; a deletion stops them too. */
export async function cancelPendingDeliveries(
  client: Pick<LifecycleTx, 'webhookLog'>,
  projectId: string,
): Promise<number> {
  const { count } = await client.webhookLog.updateMany({
    where: { status: { in: ['PENDING', 'RETRYING'] }, webhook: { projectId } },
    data: { status: 'CANCELLED', error: 'project_paused', nextRetryAt: null },
  })
  return count
}

async function writeAudit(
  projectId: string,
  action: 'PROJECT_PAUSED' | 'PROJECT_RESUMED',
  actor: LifecycleActor,
  details: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action,
      type: 'project',
      projectId,
      userId: actor.kind === 'user' ? actor.userId : null,
      userEmail: actor.kind === 'user' ? actor.email ?? null : null,
      details,
      metadata: { ...metadata, actor: actor.kind === 'system' ? `system:${actor.label}` : 'user' } as object,
    },
  })
}
