/**
 * Restore to a point: the backend as it was right after one change, by undoing
 * everything made after it, newest first.
 *
 * Each step is an ordinary restore (lib/changes/recovery.ts): it is proved
 * before it runs, verified after, recorded as its own entry and reapplied on
 * its own. So this is a sequence, not one transaction, and it holds every step
 * to the restore's own rules. It runs a step only when its restore is lossless,
 * and stops at the first step that needs a person or cannot run, naming it and
 * saying why. What it restored before stopping stays restored; running it again
 * continues from there, once that step is resolved.
 *
 * What "made after the point" means, entry by entry, newest first:
 *
 *   a change in effect                         restored
 *   a change that failed, or that a restore or
 *   a recovery after the point already undid   nothing to undo
 *   a restore after the point, of a change
 *   made before it                             undone: that change is reapplied
 *   a restore of something made after the
 *   point                                      nothing to undo: both are after it
 *   a change only a credential rule keeps
 *   (a revoked key, a removed secret)          left as it is, and named: no
 *                                              restore ever brings it back
 *   a snapshot restore                         stops: History does not undo one
 *   a change still running, or waiting for a
 *   person                                     stops
 *   a step of an architecture change, or its
 *   undo, when the whole change and its undo
 *   are after the point and the undo finished  nothing to undo: nothing of it is
 *                                              left
 *   any other step of an architecture change   stops, before anything runs: one
 *                                              is undone whole, by the engine
 *
 * Who may run it is who may restore: a person, from History or from Deploy
 * (a published version's point is the last change before it was published),
 * or a person approving an agent's request to restore a version
 * (describeVersionRestore, restoreToVersion).
 */

import { prisma } from '@/lib/db/prisma'
import { IN_EFFECT } from './types'
import {
  ARCHITECTURE_CHANGE_GROUP,
  ARCHITECTURE_UNDO_SUFFIX,
  previewRecovery,
  recoverChange,
  type RecoveryOutcome,
  type RecoveryPreview,
} from './recovery'

export interface RangeEntry {
  id: string
  seq: number
  summary: string
}

export interface RangeStep extends RangeEntry {
  /** restore: undo the change. reapply: undo a restore made after the point. */
  action: 'restore' | 'reapply'
  /** The record the step acts on: the change, or the restore being undone. */
  recordId: string
}

export interface RangeStop extends RangeEntry {
  code: 'NEEDS_APPROVAL' | 'BLOCKED' | 'UNAVAILABLE' | 'IN_PROGRESS' | 'NEEDS_PERSON' | 'SNAPSHOT' | 'FAILED'
  reason: string
  /** The step's record, to open its own restore dialog. */
  recordId: string
}

export interface RangePlan {
  afterSeq: number
  /** What it would undo, in the order it would, up to the first stop. */
  steps: RangeStep[]
  /** Changes after the point that stay as they are, and why. */
  kept: Array<RangeEntry & { reason: string }>
  /** Where it would stop before running anything, when that is known now. */
  stop: RangeStop | null
}

export interface RangeOutcome {
  afterSeq: number
  restored: Array<RangeEntry & { action: 'restore' | 'reapply'; recoveryId: string; recoverySeq: number }>
  kept: Array<RangeEntry & { reason: string }>
  stoppedAt: RangeStop | null
}

type Row = { id: string; seq: number; kind: string; status: string; summary: string | null; title: string; recoversId: string | null; groupId: string | null }

const label = (r: Row) => r.summary ?? r.title
const STILL_RUNNING = new Set(['applying', 'verifying', 'recovering', 'restoring'])
const ROW = { id: true, seq: true, kind: true, status: true, summary: true, title: true, recoversId: true, groupId: true } as const

/**
 * The architecture change an entry belongs to, by its plan's group, and
 * whether the entry is that change's undo. An architecture change
 * (lib/structural-evolution) is put back whole, by the engine's own undo, never
 * one step at a time (ARCHITECTURE_CHANGE_GROUP).
 */
function architectureOf(groupId: string | null): { group: string; undo: boolean } | null {
  if (!groupId?.startsWith(ARCHITECTURE_CHANGE_GROUP)) return null
  const undo = groupId.endsWith(ARCHITECTURE_UNDO_SUFFIX)
  return { group: undo ? groupId.slice(0, -ARCHITECTURE_UNDO_SUFFIX.length) : groupId, undo }
}

/**
 * The architecture changes with an entry after the point, and whether each is
 * gone: every entry of it after the point, and the newest one that did
 * anything a finished undo. Such a change leaves nothing to undo. One that
 * started at or before the point cannot be passed over, since the point holds
 * part of it, and History cannot put back part of one.
 */
async function architectureAfter(projectId: string, afterSeq: number, rows: Row[]) {
  const changes = new Map<string, { gone: boolean; startedBefore: boolean }>()
  for (const r of rows) {
    const a = architectureOf(r.groupId)
    // Newest first, so the first entry that did anything decides; a failed one altered nothing.
    if (!a || changes.has(a.group) || r.status === 'failed') continue
    changes.set(a.group, { gone: a.undo && IN_EFFECT.has(r.status), startedBefore: false })
  }
  if (changes.size === 0) return changes
  const earlier = await prisma.backendChange.findMany({
    where: { projectId, seq: { lte: afterSeq }, groupId: { in: [...changes.keys()].flatMap((g) => [g, g + ARCHITECTURE_UNDO_SUFFIX]) } },
    select: { groupId: true },
  })
  for (const e of earlier) changes.get(architectureOf(e.groupId)!.group)!.startedBefore = true
  return changes
}

/**
 * The entries after the point, read as steps, without proving any of them: a
 * step's proof depends on the state the steps before it leave.
 */
export async function planRestoreTo(projectId: string, afterSeq: number): Promise<RangePlan> {
  const rows: Row[] = await prisma.backendChange.findMany({
    where: { projectId, seq: { gt: afterSeq } },
    orderBy: { seq: 'desc' },
    select: ROW,
  })
  const targets = new Map<string, Row>()
  const missing = rows.filter((r) => r.recoversId && !rows.some((x) => x.id === r.recoversId)).map((r) => r.recoversId!)
  if (missing.length > 0) {
    for (const t of await prisma.backendChange.findMany({
      where: { id: { in: missing } },
      select: ROW,
    })) targets.set(t.id, t)
  }
  for (const r of rows) targets.set(r.id, r)
  const architecture = await architectureAfter(projectId, afterSeq, rows)

  const plan: RangePlan = { afterSeq, steps: [], kept: [], stop: null }
  for (const r of rows) {
    const entry = { id: r.id, seq: r.seq, summary: label(r) }
    if (r.kind === 'snapshot_restore') {
      plan.stop = { ...entry, recordId: r.id, code: 'SNAPSHOT', reason: `#${r.seq} restored a snapshot, which History cannot undo. Restore an earlier snapshot from Database → Snapshots instead.` }
      break
    }
    const a = architectureOf(r.groupId)
    if (a) {
      const change = architecture.get(a.group)
      if (r.status === 'failed' || (change?.gone && !change.startedBefore)) continue
      plan.stop = {
        ...entry,
        recordId: r.id,
        code: 'UNAVAILABLE',
        reason: change?.startedBefore
          ? `#${r.seq} is one step of an architecture change that started before this point, and an architecture change is only undone whole. Pick a point before it started or after its last step.`
          : `#${r.seq} is one step of an architecture change. Undo the whole change from the Autonomy page first, then restore again.`,
      }
      break
    }
    if (r.kind === 'recovery') {
      const target = r.recoversId ? targets.get(r.recoversId) : undefined
      // Undone already, or what it restored was made after the point too.
      if (!target || target.seq > afterSeq || !IN_EFFECT.has(r.status)) continue
      // Never one step of an architecture change put back on its own (none is
      // restored on its own to begin with, ARCHITECTURE_CHANGE_GROUP).
      if (architectureOf(target.groupId)) {
        plan.stop = { ...entry, recordId: r.id, code: 'UNAVAILABLE', reason: `#${r.seq} restored one step of an architecture change, which is only undone whole. Pick a point after #${r.seq}.` }
        break
      }
      plan.steps.push({ ...entry, summary: label(target), id: target.id, seq: target.seq, action: 'reapply', recordId: r.id })
      continue
    }
    // An ordinary change.
    if (r.status === 'failed' || r.status === 'restored' || r.status === 'recovered') continue
    if (IN_EFFECT.has(r.status)) {
      plan.steps.push({ ...entry, action: 'restore', recordId: r.id })
      continue
    }
    plan.stop = {
      ...entry,
      recordId: r.id,
      code: STILL_RUNNING.has(r.status) ? 'IN_PROGRESS' : 'NEEDS_PERSON',
      reason: STILL_RUNNING.has(r.status)
        ? `#${r.seq} is still being applied or restored. Try again when it has finished.`
        : `#${r.seq} is waiting for a person to decide what happens to it. Decide that first.`,
    }
    break
  }
  return plan
}

/** Why a step's proof stops the sequence, or null when it may run. */
function stopFor(step: RangeStep, preview: RecoveryPreview | null): RangeStop | null {
  const at = { id: step.id, seq: step.seq, summary: step.summary, recordId: step.recordId }
  if (!preview) return { ...at, code: 'FAILED', reason: `#${step.seq} could not be read.` }
  switch (preview.safety) {
    case 'lossless':
      return null
    case 'needs_approval':
      return { ...at, code: 'NEEDS_APPROVAL', reason: preview.reason ?? `Restoring #${step.seq} needs your approval.` }
    case 'blocked':
      return { ...at, code: 'BLOCKED', reason: preview.reason ?? `Restoring #${step.seq} is blocked.` }
    default:
      return { ...at, code: 'UNAVAILABLE', reason: preview.reason ?? `#${step.seq} cannot be restored.` }
  }
}

/**
 * Undo everything after the point, newest first, step by step, stopping at the
 * first step that is not lossless. A change only a credential rule keeps is
 * left as it is and named, rather than stopping the rest.
 */
export async function restoreTo(
  projectId: string,
  afterSeq: number,
  /** `approved`: run on a person's approval of an agent's request, and recorded so. */
  opts: { actorUserId: string; mode?: 'manual' | 'approved' },
): Promise<RangeOutcome> {
  const plan = await planRestoreTo(projectId, afterSeq)
  const out: RangeOutcome = { afterSeq, restored: [], kept: [...plan.kept], stoppedAt: null }
  for (const step of plan.steps) {
    const preview = await previewRecovery(projectId, step.recordId)
    if (preview?.safety === 'unavailable' && preview.unavailableCode === 'NOT_REVERSIBLE') {
      out.kept.push({ id: step.id, seq: step.seq, summary: step.summary, reason: preview.reason ?? 'It cannot be undone.' })
      continue
    }
    const stop = stopFor(step, preview)
    if (stop) {
      out.stoppedAt = stop
      return out
    }
    const done = await recoverChange(projectId, step.recordId, { mode: opts.mode ?? 'manual', actorUserId: opts.actorUserId })
    if (done.ok !== true) {
      const failed = done as Extract<RecoveryOutcome, { ok: false }>
      const busy = failed.code === 'IN_PROGRESS' || failed.code === 'CHANGE_IN_PROGRESS'
      out.stoppedAt = { id: step.id, seq: step.seq, summary: step.summary, recordId: step.recordId, code: busy ? 'IN_PROGRESS' : 'FAILED', reason: failed.error }
      return out
    }
    out.restored.push({ id: step.id, seq: step.seq, summary: step.summary, action: step.action, recoveryId: done.recoveryId, recoverySeq: done.recoverySeq })
  }
  out.stoppedAt = plan.stop
  return out
}

/** The point a published version stands for: the last change made before it was published. */
export async function pointOfPublish(projectId: string, publishedAt: Date): Promise<number> {
  const last = await prisma.backendChange.findFirst({
    where: { projectId, createdAt: { lte: publishedAt } },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  })
  return last?.seq ?? 0
}

/** A published version, and the point it stands for: the last change made before it was published. */
export interface PublishedPoint {
  version: number
  publishedAt: Date
  after: number
}

/** The published version a call names, by `version` or by its deployment's id; null when none matches. */
export async function publishedPoint(projectId: string, ref: { version?: unknown; deploymentId?: unknown }): Promise<PublishedPoint | null> {
  const asked = ref.version === undefined || ref.version === null || ref.version === '' ? null : Number(ref.version)
  const deploymentId = typeof ref.deploymentId === 'string' && ref.deploymentId ? ref.deploymentId : null
  if (asked === null && !deploymentId) return null
  if (asked !== null && (!Number.isInteger(asked) || asked < 1)) return null
  const d = await prisma.deployment.findFirst({
    where: {
      projectId,
      environment: 'live',
      status: 'live',
      version: asked ?? { not: null },
      ...(deploymentId ? { id: deploymentId } : {}),
    },
    select: { version: true, completedAt: true, createdAt: true },
  })
  if (!d || d.version === null) return null
  const publishedAt = d.completedAt ?? d.createdAt
  return { version: d.version, publishedAt, after: await pointOfPublish(projectId, publishedAt) }
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`

/**
 * An agent's request to restore the backend to a published version, as a
 * person is asked to approve it: Backenly's own list of what it would undo,
 * measured now. `steps` is that list by record, so approving runs exactly it.
 */
export interface VersionRestoreRequest {
  /** One line: an approval card's title. */
  target: string
  /** The steps, newest first, and how it runs: the request's full text. */
  detail: string
  toolArgs: { version: number; steps: string[] }
}

export async function describeVersionRestore(
  projectId: string,
  ref: { version?: unknown; deploymentId?: unknown },
): Promise<({ ok: true } & VersionRestoreRequest) | { ok: false; status: number; code: string; error: string }> {
  const point = await publishedPoint(projectId, ref)
  if (!point) {
    return { ok: false, status: 404, code: 'VERSION_NOT_FOUND', error: 'No published version matches. deploy { action: "history" } lists them.' }
  }
  const v = point.version
  const plan = await planRestoreTo(projectId, point.after)
  if (plan.steps.length === 0) {
    return plan.stop
      ? { ok: false, status: 409, code: 'RESTORE_BLOCKED', error: `Restoring to v${v} would stop before undoing anything. ${plan.stop.reason}` }
      : { ok: false, status: 409, code: 'NOTHING_TO_RESTORE', error: `Nothing has changed since v${v} was published: the backend is already as it was then.` }
  }
  const published = point.publishedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
  const detail = [
    `Undoes, newest first:`,
    ...plan.steps.map((s) => `#${s.seq} ${s.summary}${s.action === 'reapply' ? ` (reapplied: it was in effect at v${v})` : ''}`),
    ...(plan.stop ? [`Stops at #${plan.stop.seq}. ${plan.stop.reason}`] : []),
    'Each one is checked before it runs. One that would set aside data written since, or that cannot run, stops it there, for you to review in History.',
  ].join('\n')
  return {
    ok: true,
    target: `Restore the backend to v${v}, published ${published}: undo the ${plural(plan.steps.length, 'change')} made since`,
    detail,
    toolArgs: { version: v, steps: plan.steps.map((s) => s.recordId) },
  }
}

export type VersionRestoreOutcome =
  | { ok: true; version: number; outcome: RangeOutcome; versionCurrent: boolean }
  | { ok: false; code: 'VERSION_NOT_FOUND' | 'STALE'; error: string }

/**
 * Restore the backend to a published version: everything made since it was
 * published undone, then the version recorded as current when the restore
 * reached it in full. `approvedSteps`, from an approval, must still be what
 * restoring would undo, or nothing runs: what runs is what the person read.
 */
export async function restoreToVersion(
  projectId: string,
  ref: { version?: unknown; deploymentId?: unknown },
  opts: { actorUserId: string; approvedSteps?: unknown; via: 'UI' | 'APPROVAL' },
): Promise<VersionRestoreOutcome> {
  const point = await publishedPoint(projectId, ref)
  if (!point) return { ok: false, code: 'VERSION_NOT_FOUND', error: 'No published version matches. deploy { action: "history" } lists them.' }
  if (opts.approvedSteps !== undefined) {
    const plan = await planRestoreTo(projectId, point.after)
    const seen = Array.isArray(opts.approvedSteps) ? opts.approvedSteps.map(String) : null
    if (!seen || seen.length !== plan.steps.length || plan.steps.some((s, i) => s.recordId !== seen[i])) {
      return {
        ok: false,
        code: 'STALE',
        error: `The history changed since this was approved, so nothing was restored. Ask again to see what restoring to v${point.version} would undo now.`,
      }
    }
  }
  const outcome = await restoreTo(projectId, point.after, { actorUserId: opts.actorUserId, mode: opts.via === 'APPROVAL' ? 'approved' : 'manual' })
  let versionCurrent = false
  if (!outcome.stoppedAt) {
    const { markVersionCurrent } = await import('@/lib/deployment/rollback')
    versionCurrent = await markVersionCurrent(projectId, point.version, opts.actorUserId, opts.via).catch(() => false)
  }
  return { ok: true, version: point.version, outcome, versionCurrent }
}
