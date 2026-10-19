/**
 * THE LIFECYCLE OF A GOVERNED CHANGE
 * ==================================
 *
 * The only code that moves `BackendChange.status`. Everything else asks it to.
 *
 *   applying → verifying → healthy | unverified | verification_failed
 *   applying → failed | partially_applied
 *   verification_failed | partially_applied → recovering | awaiting_approval
 *   recovering → recovered | restored | recovery_failed (or back, if released)
 *   recovery_failed → manual_intervention_required
 *   awaiting_approval | manual_intervention_required → kept (a person's call)
 *
 * docs/CHANGE_RECOVERY.md draws the whole graph. The migration that created
 * the table installs a trigger enforcing exactly these edges, so a bug here, a
 * script, or anyone at psql gets the same answer this module would give.
 *
 * ── Compare-and-set, never read-then-write ──────────────────────────────────
 *
 * A transition names the states it may come from and is one conditional UPDATE.
 * Two workers racing for the same move cannot both win: one gets the row, the
 * other gets `false` and the current state. That is what makes a duplicated
 * recovery request, a retried job or a redelivered event harmless: they lose
 * the race and report what the winner did.
 *
 * ── Every transition is an event ────────────────────────────────────────────
 *
 * `backend_change_events` is append-only (the same trigger refuses UPDATE and
 * DELETE). Each event carries the principals involved (lib/principal): who
 * requested the change, who authorised what happened, who executed it.
 */

import { randomUUID } from 'crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { metrics } from '@/lib/observability/metrics'
import type { ChangeStatus } from './types'

/** The edges the trigger allows, from → to. Kept identical to the migration. */
export const TRANSITIONS: Readonly<Record<ChangeStatus, readonly ChangeStatus[]>> = {
  applying: ['verifying', 'failed', 'partially_applied', 'manual_intervention_required'],
  verifying: ['healthy', 'unverified', 'verification_failed', 'manual_intervention_required'],
  healthy: ['recovering'],
  unverified: ['recovering'],
  failed: [],
  partially_applied: ['recovering', 'awaiting_approval', 'manual_intervention_required'],
  verification_failed: ['recovering', 'awaiting_approval', 'manual_intervention_required'],
  awaiting_approval: ['recovering', 'manual_intervention_required', 'kept'],
  recovering: [
    'recovered', 'restored', 'recovery_failed',
    // a claim released without completing goes back to where it came from
    'healthy', 'unverified', 'partially_applied', 'verification_failed', 'awaiting_approval',
    'manual_intervention_required', 'kept',
  ],
  recovered: [],
  restored: ['healthy'],
  recovery_failed: ['recovering', 'manual_intervention_required'],
  manual_intervention_required: ['recovering', 'kept'],
  kept: ['recovering'],
}

export function canTransition(from: string, to: ChangeStatus): boolean {
  return (TRANSITIONS[from as ChangeStatus] ?? []).includes(to)
}

export type ChangeEventType =
  | 'checkpointed'
  | 'applied'
  | 'apply_failed'
  | 'partially_applied'
  | 'verified'
  | 'verification_inconclusive'
  | 'verification_failed'
  | 'recovery_planned'
  | 'recovery_escalated'
  | 'recovery_started'
  | 'recovery_completed'
  | 'recovery_verified'
  | 'recovery_failed'
  | 'restored'
  | 'reapplied'
  | 'manual_intervention_required'
  | 'kept'
  | 'reconciled'

/** Record one lifecycle event. Never throws: the evidence must not fail the change. */
export async function recordEvent(
  changeId: string,
  projectId: string,
  type: ChangeEventType,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.backendChangeEvent.create({
      data: { changeId, projectId, type, data: (data ?? undefined) as Prisma.InputJsonValue | undefined },
    })
  } catch (err) {
    console.error(`[ChangeLifecycle] could not record ${type} for change ${changeId}:`, err)
  }
  metrics.record(`change.${type}`, 1, { projectId })
}

/** A duration, for the recovery timings the reliability work reads. */
export function recordTiming(name: string, ms: number, labels: Record<string, string>): void {
  metrics.record(`change.${name}_ms`, ms, labels)
}

/**
 * Move a change from one of `from` to `to`. Returns false, changing nothing,
 * when the change is in none of them: someone else moved it first.
 */
export async function transition(
  changeId: string,
  from: readonly ChangeStatus[],
  to: ChangeStatus,
  data: Omit<Prisma.BackendChangeUpdateManyMutationInput, 'status'> = {},
): Promise<boolean> {
  const allowed = from.filter((f) => canTransition(f, to))
  if (allowed.length === 0) throw new Error(`No lifecycle edge from ${from.join('|')} to ${to}`)
  const res = await prisma.backendChange.updateMany({
    where: { id: changeId, status: { in: [...allowed] } },
    data: { ...data, status: to },
  })
  return res.count === 1
}

/** How long a recovery may hold its claim before the reconciler may look at it. */
export const RECOVERY_LEASE_MS = 15 * 60 * 1000

/**
 * Take the right to recover a change. Exactly one caller gets it; everyone
 * else gets null and should report the change's current state instead.
 */
export async function claimRecovery(
  changeId: string,
  from: readonly ChangeStatus[],
): Promise<{ claim: string; from: ChangeStatus } | null> {
  const row = await prisma.backendChange.findUnique({ where: { id: changeId }, select: { status: true } })
  if (!row || !from.includes(row.status as ChangeStatus)) return null
  const claim = randomUUID()
  const won = await prisma.backendChange.updateMany({
    where: { id: changeId, status: row.status },
    data: { status: 'recovering', recoveryClaim: claim, recoveryLeaseUntil: new Date(Date.now() + RECOVERY_LEASE_MS) },
  })
  return won.count === 1 ? { claim, from: row.status as ChangeStatus } : null
}

/** End a claim: to a final state, or back where it came from. Only the claim's owner can. */
export async function releaseRecovery(
  changeId: string,
  claim: string,
  to: ChangeStatus,
  data: Omit<Prisma.BackendChangeUpdateManyMutationInput, 'status' | 'recoveryClaim' | 'recoveryLeaseUntil'> = {},
): Promise<boolean> {
  if (!canTransition('recovering', to)) throw new Error(`No lifecycle edge from recovering to ${to}`)
  const res = await prisma.backendChange.updateMany({
    where: { id: changeId, status: 'recovering', recoveryClaim: claim },
    data: { ...data, status: to, recoveryClaim: null, recoveryLeaseUntil: null },
  })
  return res.count === 1
}
