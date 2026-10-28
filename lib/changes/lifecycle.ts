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
import { projectRegion } from '@/lib/data-plane/regional'
import type { ChangeStatus } from './types'

/**
 * What every change metric names: the project, the region holding its data,
 * the change, and how a recovery ran. Ids and kinds only, never row data.
 */
export async function changeLabels(
  projectId: string,
  changeId: string,
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const region = await projectRegion(projectId).catch(() => 'unknown')
  return { projectId, region, changeId, ...extra }
}

/**
 * A change that needs a person is said once, in a fixed form an operator's log
 * alarm can match: BACKENLY_CHANGE_NEEDS_PERSON, with ids only. The reason
 * stays on the change's own record, where residency rules decide what it keeps.
 */
async function announce(changeId: string, to: ChangeStatus): Promise<void> {
  if (to !== 'manual_intervention_required') return
  try {
    const row = await prisma.backendChange.findUnique({ where: { id: changeId }, select: { projectId: true, seq: true } })
    if (!row) return
    const labels = await changeLabels(row.projectId, changeId)
    console.error(`BACKENLY_CHANGE_NEEDS_PERSON project=${row.projectId} region=${labels.region} change=${changeId} seq=${row.seq}`)
    metrics.record('change.needs_person', 1, labels)
  } catch (err) {
    console.error(`[ChangeLifecycle] could not announce that change ${changeId} needs a person:`, err)
  }
}

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
  // A restore removed the functions Backenly generated for a table it removed;
  // `data.functions` keeps each row, for undoing the restore (lib/services/domain-endpoints.ts).
  | 'generated_endpoints_removed'

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
  const mode = typeof data?.mode === 'string' ? { mode: data.mode } : {}
  metrics.record(`change.${type}`, 1, await changeLabels(projectId, changeId, mode))
}

/** A duration, for the recovery timings the reliability work reads. */
export async function recordTiming(
  name: string,
  ms: number,
  projectId: string,
  changeId: string,
  labels: Record<string, string>,
): Promise<void> {
  metrics.record(`change.${name}_ms`, ms, await changeLabels(projectId, changeId, labels))
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
  if (res.count === 1) await announce(changeId, to)
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
  if (res.count === 1) await announce(changeId, to)
  return res.count === 1
}
