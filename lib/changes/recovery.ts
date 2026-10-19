/**
 * RECOVERY
 * ========
 *
 * Restoring the state before a governed change: automatically, when the change
 * failed and the restore is provably lossless; by a person's decision
 * otherwise. docs/CHANGE_RECOVERY.md has the whole picture; the pieces are:
 *
 *   plan      lib/changes/plan.ts      what to run, in what order (pure)
 *   impact    lib/changes/impact.ts    what it would do to data written since
 *   proof     the plan, run in a transaction that is then rolled back
 *   execute   the plan again, for real: tables locked first, impact measured
 *             again under the lock and held to what was approved, values
 *             checked before commit, then the result checked against the
 *             checkpoint, independently of the plan
 *
 * A restore is itself a governed change (kind = 'recovery'), with its own
 * checkpoint and vault, so the state it replaces is protected the same way and
 * a restore can be reapplied. The console never calls that a rollback of a
 * rollback; it says "Reapply this change".
 *
 * ── Only one recovery at a time, and only once ──────────────────────────────
 *
 * The right to recover a change is claimed by compare-and-set on its status
 * (lib/changes/lifecycle.ts), with a lease. A duplicate request, a retried
 * job, a second tab: each loses the claim and reports what the winner did. A
 * process that dies mid-recovery leaves the lease to expire, and
 * `reconcileChanges` then reads the catalog to record what actually happened.
 * It never re-runs a recovery on its own.
 *
 * ── Who may ─────────────────────────────────────────────────────────────────
 *
 *   automatic  Backenly, right after a change failed, only when lossless
 *   manual     a person with admin rights, from the console; a restore that is
 *              not lossless needs them to approve exactly what it would do
 *   approved   a person approving a request (an agent's, or Backenly's own
 *              escalation) in the existing approvals flow
 *
 * The routes and the approval flow decide who the person is. An agent's key can
 * request a restore and never run one.
 */

import type { PoolClient } from 'pg'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { CatalogSnapshot } from './catalog'
import { describeChange } from './describe'
import {
  acknowledgementOf,
  impactCovered,
  measureImpact,
  type AcknowledgedImpact,
  type Impact,
  type ResultData,
} from './impact'
import { checkpointIntact, tableChecksum } from './integrity'
import {
  AbandonChange,
  currentChange,
  withChangeAttribution,
  withGovernedChange,
  type StoredSnapshot,
} from './ledger'
import { claimRecovery, recordEvent, recordTiming, releaseRecovery, RECOVERY_LEASE_MS, transition } from './lifecycle'
import { ChangeInProgressError, readCatalogOn, withChangeLock } from './lock'
import { createVaultStatements, qualified, vaultSchemaName } from './names'
import { planRestore, verifyAgainstCheckpoint, type PlanConflict, type PlannedStep, type RestorePlan } from './plan'
import { rollbackWindowDays, windowEndsAt } from './policy'
import { IN_EFFECT, RECOVERY_OWED, type ChangePreservation, type ChangeStatus, type PreservedEntry, type TableChange } from './types'
import { keptText, quotesKeptHere } from './residency'
import type { ChangeVerification, VerificationCheck } from './verify'

// ── Loading ──────────────────────────────────────────────────────────────────

interface LoadedChange {
  id: string
  projectId: string
  seq: number
  kind: string
  title: string
  summary: string
  status: string
  source: string
  apiKeyId: string | null
  actorUserId: string | null
  createdAt: Date
  recoversId: string | null
  recoveredById: string | null
  recoveryClaim: string | null
  recoveryLeaseUntil: Date | null
  footprint: TableChange[]
  checkpoint: StoredSnapshot
  resultState: CatalogSnapshot & { data?: ResultData }
  preserved: ChangePreservation | null
  intact: boolean
}

async function load(projectId: string, changeId: string): Promise<LoadedChange | null> {
  const row = await prisma.backendChange.findFirst({ where: { id: changeId, projectId } })
  if (!row) return null
  const checkpoint = ((row.checkpoint as any)?.database ?? null) as StoredSnapshot | null
  const footprint = (row.footprint as unknown as TableChange[] | null) ?? []
  return {
    id: row.id,
    projectId: row.projectId,
    seq: row.seq,
    kind: row.kind,
    title: row.title,
    summary: row.summary ?? describeChange(footprint),
    status: row.status,
    source: row.source,
    apiKeyId: row.apiKeyId,
    actorUserId: row.actorUserId,
    createdAt: row.createdAt,
    recoversId: row.recoversId,
    recoveredById: row.recoveredById,
    recoveryClaim: row.recoveryClaim,
    recoveryLeaseUntil: row.recoveryLeaseUntil,
    footprint,
    checkpoint: checkpoint ?? { schema: '', capturedAt: '', tables: {} },
    resultState: (row.resultState as unknown as LoadedChange['resultState'] | null) ?? { schema: '', capturedAt: '', tables: {} },
    preserved: (row.preserved as unknown as ChangePreservation | null) ?? null,
    intact: !!checkpoint && checkpointIntact(row),
  }
}

/**
 * Where the data a restore needs is now. A change's own vault, unless later
 * restores in its chain moved it: restoring #12 brings a table back out of
 * #12's vault, reapplying #12 moves it into that reapply's vault, and the next
 * restore of #12 has to look there. Newest first.
 */
async function candidateEntries(projectId: string, change: LoadedChange): Promise<PreservedEntry[]> {
  const found: Array<{ seq: number; entries: PreservedEntry[] }> = [{ seq: change.seq, entries: change.preserved?.entries ?? [] }]
  let frontier = [change.id]
  for (let depth = 0; depth < 20 && frontier.length > 0; depth++) {
    const next = await prisma.backendChange.findMany({
      where: { projectId, kind: 'recovery', recoversId: { in: frontier } },
      select: { id: true, seq: true, preserved: true },
    })
    for (const r of next) found.push({ seq: r.seq, entries: (r.preserved as unknown as ChangePreservation | null)?.entries ?? [] })
    frontier = next.map((r) => r.id)
  }
  // Most recently moved first, so a name resolves to where its data is now.
  return found.sort((a, b) => b.seq - a.seq).flatMap((f) => f.entries)
}

/** The entries whose vault table is still there and unaltered; and what is not. */
async function intactEntries(client: PoolClient, entries: PreservedEntry[]): Promise<{ intact: PreservedEntry[]; altered: string[] }> {
  if (entries.length === 0) return { intact: [], altered: [] }
  const schemas = [...new Set(entries.map((e) => e.vault))]
  const res = await client.query<{ nspname: string; relname: string }>(
    `SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p')`,
    [schemas],
  )
  const present = new Set(res.rows.map((r) => `${r.nspname}.${r.relname}`))
  const intact: PreservedEntry[] = []
  const altered: string[] = []
  for (const e of entries) {
    if (!e.vaultTable || !present.has(`${e.vault}.${e.vaultTable}`)) continue
    if (e.checksum) {
      const now = await tableChecksum(client, e.vault, e.vaultTable)
      if (now.checksum !== e.checksum || (e.rows !== null && now.rows !== e.rows)) {
        altered.push(e.kind === 'column' ? `${e.table}.${e.column}` : e.table)
        continue
      }
    }
    intact.push(e)
  }
  return { intact, altered }
}

// ── Eligibility ──────────────────────────────────────────────────────────────

export type RecoveryMode = 'automatic' | 'manual' | 'approved'

export interface Availability {
  available: boolean
  /** Plain sentence, when it is not. */
  reason?: string
  code?: 'NOT_RESTORABLE' | 'IN_PROGRESS' | 'EXPIRED' | 'CHECKPOINT_INVALID' | 'NOTHING_TO_RESTORE' | 'FAILED_CHANGE_REAPPLY'
  expiresAt?: string
}

/** The statuses a restore may start from, by mode. */
function restorableFrom(mode: RecoveryMode): ChangeStatus[] {
  if (mode === 'automatic') return ['verification_failed', 'partially_applied']
  return [...IN_EFFECT, ...RECOVERY_OWED] as ChangeStatus[]
}

/**
 * Can a restore be offered at all? Cheap: no catalog read. The preview proves
 * the rest. `targetStatus` is, for a recovery record, the status of the change
 * it restored.
 */
export function availabilityOf(
  change: { kind: string; status: string; footprint: TableChange[]; createdAt: Date; intact: boolean },
  windowDays: number,
  opts: { now?: Date; mode?: RecoveryMode; targetStatus?: string | null } = {},
): Availability {
  const mode = opts.mode ?? 'manual'
  const ends = windowEndsAt(change.createdAt, windowDays)
  if (change.status === 'recovering' || change.status === 'applying' || change.status === 'verifying') {
    return { available: false, code: 'IN_PROGRESS', reason: 'Backenly is still working on this change.' }
  }
  if (!restorableFrom(mode).includes(change.status as ChangeStatus)) {
    return { available: false, code: 'NOT_RESTORABLE', reason: change.status === 'failed' ? 'This change did not alter anything.' : 'This change is no longer in effect.' }
  }
  if (change.kind === 'recovery' && opts.targetStatus !== 'restored') {
    return { available: false, code: 'FAILED_CHANGE_REAPPLY', reason: 'That change failed verification. Ask for it again instead of reapplying it.' }
  }
  if (change.footprint.length === 0) return { available: false, code: 'NOTHING_TO_RESTORE', reason: 'This change did not alter anything.' }
  if (!change.intact) return { available: false, code: 'CHECKPOINT_INVALID', reason: 'Its restore point did not pass its integrity check.' }
  if (mode !== 'automatic' && ends.getTime() < (opts.now ?? new Date()).getTime()) {
    return { available: false, code: 'EXPIRED', reason: `Restore points are kept for ${windowDays} days on this plan, and this one has expired.`, expiresAt: ends.toISOString() }
  }
  return { available: true, expiresAt: ends.toISOString() }
}

// ── Running a plan ───────────────────────────────────────────────────────────

class RecoveryStepError extends Error {
  constructor(readonly index: number, readonly step: PlannedStep | null, readonly cause: string) {
    super(step ? `Recovery stopped at step ${index + 1} (${step.describe}): ${cause}` : `Recovery check failed: ${cause}`)
    this.name = 'RecoveryStepError'
  }
}

class ImpactRefusal extends Error {
  constructor(readonly code: 'NEEDS_APPROVAL' | 'IMPACT_CHANGED' | 'BLOCKED', readonly impact: Impact) {
    super(code)
    this.name = 'ImpactRefusal'
  }
}

const runner = (client: PoolClient) => ({ query: (sql: string, params?: unknown[]) => client.query(sql, params as unknown[]) })

/**
 * Run the plan in one transaction. Tables are locked before anything is
 * measured, so no write can land between the measurement and the statements;
 * `gate` sees the impact under that lock and may refuse. The in-transaction
 * checks run last and must all find nothing wrong, or nothing commits.
 * `commit: false` is the proof: the same everything, then ROLLBACK.
 */
async function runPlan(
  client: PoolClient,
  plan: RestorePlan & { schema: string },
  opts: { commit: boolean; vault: string | null; measure: () => Promise<Impact>; gate: (impact: Impact) => void },
): Promise<Impact> {
  await client.query('BEGIN')
  let index = -1
  try {
    // Bounded waits: a restore that queues behind a long transaction holds
    // every request behind it, so it gives up instead and says why.
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    await client.query(`SET LOCAL statement_timeout = '${opts.commit ? '10min' : '2min'}'`)
    for (const t of plan.lockTables) {
      await client.query(`LOCK TABLE ${qualified(plan.schema, t)} IN ACCESS EXCLUSIVE MODE`)
    }
    const impact = await opts.measure()
    opts.gate(impact)
    if (opts.vault) for (const sql of createVaultStatements(opts.vault)) await client.query(sql)
    for (index = 0; index < plan.steps.length; index++) {
      await client.query(plan.steps[index].sql)
    }
    index = plan.steps.length
    for (const check of plan.checks) {
      const r = await client.query<{ n: string }>(check.sql)
      if (Number(r.rows[0]?.n ?? 0) !== 0) throw new RecoveryStepError(-1, null, `${check.describe} — ${r.rows[0]?.n} did not.`)
    }
    await client.query(opts.commit ? 'COMMIT' : 'ROLLBACK')
    return impact
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {})
    if (err instanceof ImpactRefusal || err instanceof RecoveryStepError) throw err
    if (index >= 0 && index < plan.steps.length) throw new RecoveryStepError(index, plan.steps[index], err?.message ?? String(err))
    throw err
  }
}

// ── Preview ──────────────────────────────────────────────────────────────────

export type RecoverySafety = 'lossless' | 'needs_approval' | 'blocked' | 'unavailable'
export type RecoveryStrategy = 'reverse_migration' | 'manual'

export interface RecoveryCheckRow {
  id: 'restore_point' | 'current_state' | 'plan' | 'data'
  ok: boolean
  label: string
  detail: string
}

export interface RecoveryPreview {
  changeId: string
  seq: number
  summary: string
  /** restore: the state before this change. reapply: undo a restore, bringing the change back. */
  action: 'restore' | 'reapply'
  safety: RecoverySafety
  strategy: RecoveryStrategy
  /** Why it is not lossless, in one plain sentence. */
  reason: string | null
  checks: RecoveryCheckRow[]
  impact: Impact | null
  /** What approving would cover, when it needs approval. */
  acknowledgement: AcknowledgedImpact | null
  conflicts: PlanConflict[]
  /** Later changes to the same tables: restoring those first clears a conflict. */
  blockedBy: Array<{ id: string; seq: number; summary: string }>
  unrecoverable: string[]
  expiresAt: string | null
  /** For View details only. */
  details: {
    steps: Array<{ sql: string; describe: string }>
    proof: { ok: boolean; ms: number; failedStep?: number; error?: string } | null
  }
}

/** Later changes still in effect that touched one of the same tables. */
async function laterOverlapping(projectId: string, change: LoadedChange) {
  const names = new Set(change.footprint.flatMap((c) => [c.before, c.after]).filter((n): n is string => !!n))
  const later = await prisma.backendChange.findMany({
    where: { projectId, seq: { gt: change.seq }, status: { in: [...IN_EFFECT, ...RECOVERY_OWED] } },
    orderBy: { seq: 'desc' },
    select: { id: true, seq: true, summary: true, title: true, footprint: true },
    take: 50,
  })
  return later
    .filter((l) => ((l.footprint as unknown as TableChange[] | null) ?? []).some((c) => names.has(c.before ?? '') || names.has(c.after ?? '')))
    .map((l) => ({ id: l.id, seq: l.seq, summary: l.summary ?? l.title }))
}

async function targetStatusOf(change: LoadedChange): Promise<string | null> {
  if (change.kind !== 'recovery' || !change.recoversId) return null
  const t = await prisma.backendChange.findUnique({ where: { id: change.recoversId }, select: { status: true } })
  return t?.status ?? null
}

export async function previewRecovery(projectId: string, changeId: string): Promise<RecoveryPreview | null> {
  await reconcileChange(projectId, changeId).catch(() => {})
  const change = await load(projectId, changeId)
  if (!change) return null
  const windowDays = await rollbackWindowDays(projectId)
  const availability = availabilityOf(change, windowDays, { targetStatus: await targetStatusOf(change) })
  const base: RecoveryPreview = {
    changeId: change.id,
    seq: change.seq,
    summary: change.summary,
    action: change.kind === 'recovery' ? 'reapply' : 'restore',
    safety: 'unavailable',
    strategy: 'manual',
    reason: availability.reason ?? null,
    checks: [],
    impact: null,
    acknowledgement: null,
    conflicts: [],
    blockedBy: [],
    unrecoverable: [],
    expiresAt: availability.expiresAt ?? null,
    details: { steps: [], proof: null },
  }
  if (!availability.available) {
    base.checks = [{ id: 'restore_point', ok: false, label: 'Restore point available', detail: availability.reason ?? 'Not available.' }]
    return base
  }

  return withChangeLock(projectId, async (client) => {
    const { resolveWorkspaceSchema } = await import('@/lib/services/workspace-pool')
    const schema = await resolveWorkspaceSchema(projectId)
    const live = await readCatalogOn(client, schema)
    const { intact, altered } = await intactEntries(client, await candidateEntries(projectId, change))
    if (altered.length > 0) {
      return {
        ...base,
        reason: `The data kept for ${altered.join(', ')} has been altered since it was kept, so it cannot be trusted.`,
        checks: [{ id: 'restore_point', ok: false, label: 'Restore point available', detail: `Kept data failed its integrity check: ${altered.join(', ')}.` }],
      }
    }
    // The restore's vault will be its own change's: the next number.
    const last = await prisma.backendChange.findFirst({ where: { projectId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    const vault = vaultSchemaName(projectId, (last?.seq ?? 0) + 1)
    const plan = { ...planRestore({ schema, footprint: change.footprint, checkpoint: change.checkpoint, resultState: change.resultState, preserved: intact, live, vault }), schema }
    const out: RecoveryPreview = {
      ...base,
      strategy: 'reverse_migration',
      conflicts: plan.conflicts,
      unrecoverable: plan.unrecoverable,
      details: { steps: plan.steps.map((s) => ({ sql: s.sql, describe: s.describe })), proof: null },
    }
    const restorePoint: RecoveryCheckRow = { id: 'restore_point', ok: true, label: 'Restore point available', detail: 'Its checkpoint and kept data passed their integrity checks.' }
    const protectedNow: RecoveryCheckRow = { id: 'current_state', ok: true, label: 'Current state protected', detail: 'The current state is saved first, and anything this removes is kept, so it can be brought back.' }

    if (plan.conflicts.length > 0) {
      out.blockedBy = await laterOverlapping(projectId, change)
      out.safety = 'blocked'
      out.reason = plan.conflicts.map((c) => c.reason).join('; ')
      out.checks = [restorePoint, protectedNow, { id: 'plan', ok: false, label: 'Recovery plan verified', detail: out.reason }]
      return out
    }

    // The proof: everything the real restore does, rolled back.
    const started = Date.now()
    let impact: Impact | null = null
    try {
      impact = await runPlan(client, plan, {
        commit: false,
        vault: plan.archives.length > 0 ? vault : null,
        measure: () => measureImpact(runner(client), { schema, footprint: change.footprint, checkpoint: change.checkpoint, resultState: change.resultState, preserved: intact }),
        gate: (i) => { if (i.blockers.length > 0) throw new ImpactRefusal('BLOCKED', i) },
      })
      out.details.proof = { ok: true, ms: Date.now() - started }
    } catch (err: any) {
      if (err instanceof ImpactRefusal) {
        impact = err.impact
        out.details.proof = { ok: false, ms: Date.now() - started, error: impact.blockers.join(' ') }
      } else if (err instanceof RecoveryStepError) {
        out.details.proof = { ok: false, ms: Date.now() - started, ...(err.step ? { failedStep: err.index } : {}), error: err.cause }
      } else {
        out.details.proof = { ok: false, ms: Date.now() - started, error: err?.message ?? String(err) }
      }
    }
    out.impact = impact
    const proofOk = out.details.proof?.ok === true
    const blocked = !proofOk || (impact?.blockers.length ?? 0) > 0
    const needsApproval = !!impact?.needsApproval || plan.unrecoverable.length > 0
    out.safety = blocked ? 'blocked' : needsApproval ? 'needs_approval' : 'lossless'
    out.acknowledgement = impact && out.safety === 'needs_approval' ? acknowledgementOf(impact) : null
    out.reason = blocked
      ? (impact?.blockers[0] ?? `The restore would fail against today's data: ${out.details.proof?.error ?? 'unknown error'}`)
      : needsApproval
        ? (impact?.items.find((i) => i.needsApproval)?.detail ?? plan.unrecoverable[0] ?? null)
        : null
    out.checks = [
      restorePoint,
      protectedNow,
      { id: 'plan', ok: proofOk && !blocked, label: 'Recovery plan verified', detail: proofOk ? `Checked end to end without changing anything (${out.details.proof!.ms} ms).` : (out.reason ?? 'The plan could not be verified.') },
      {
        id: 'data',
        ok: !blocked && !needsApproval,
        label: 'No expected data loss',
        detail: !needsApproval ? 'No data written since this change would be removed or overwritten.' : (out.reason ?? ''),
      },
    ]
    return out
  }, { waitMs: 10_000 })
}

// ── Executing ────────────────────────────────────────────────────────────────

export type RecoveryOutcome =
  | {
      ok: true
      changeId: string
      status: 'recovered' | 'restored'
      recoveryId: string
      recoverySeq: number
      verification: ChangeVerification
      impact: Impact
    }
  | {
      ok: false
      code:
        | 'NOT_FOUND' | 'NOT_AVAILABLE' | 'IN_PROGRESS' | 'CONFLICT' | 'NEEDS_APPROVAL'
        | 'IMPACT_CHANGED' | 'BLOCKED' | 'INTEGRITY' | 'RECOVERY_FAILED' | 'CHANGE_IN_PROGRESS'
      error: string
      changeId: string
      status: string
      impact?: Impact
      acknowledgement?: AcknowledgedImpact
      conflicts?: PlanConflict[]
      blockedBy?: Array<{ id: string; seq: number; summary: string }>
      failedStep?: { index: number; sql: string; describe: string }
      recoveryId?: string | null
    }

export interface RecoveryOptions {
  mode: RecoveryMode
  /** The person who decided it. Null for an automatic recovery. */
  actorUserId?: string | null
  /** For a restore that is not lossless: exactly what the person approved. */
  acknowledged?: AcknowledgedImpact | null
  /** The approval request it executes, for the record. */
  approvalId?: string | null
}

export async function recoverChange(projectId: string, changeId: string, opts: RecoveryOptions): Promise<RecoveryOutcome> {
  const started = Date.now()
  if (opts.mode !== 'automatic') await reconcileChange(projectId, changeId).catch(() => {})
  const change = await load(projectId, changeId)
  if (!change) return { ok: false, code: 'NOT_FOUND', error: 'Change not found.', changeId, status: 'missing' }
  const fail = (code: Extract<RecoveryOutcome, { ok: false }>['code'], error: string, extra: Partial<Extract<RecoveryOutcome, { ok: false }>> = {}): RecoveryOutcome =>
    ({ ok: false, code, error, changeId, status: change.status, ...extra })

  const windowDays = await rollbackWindowDays(projectId)
  const targetStatus = await targetStatusOf(change)
  const availability = availabilityOf(change, windowDays, { mode: opts.mode, targetStatus })
  if (!availability.available) {
    return fail(availability.code === 'IN_PROGRESS' ? 'IN_PROGRESS' : availability.code === 'CHECKPOINT_INVALID' ? 'INTEGRITY' : 'NOT_AVAILABLE', availability.reason ?? 'Not available.')
  }

  const claim = await claimRecovery(change.id, restorableFrom(opts.mode))
  if (!claim) {
    const now = await prisma.backendChange.findUnique({ where: { id: change.id }, select: { status: true } })
    return { ok: false, code: 'IN_PROGRESS', error: 'This change is already being recovered, or was just recovered.', changeId, status: now?.status ?? change.status }
  }
  const principals = {
    requestedBy: opts.mode === 'automatic' ? { kind: 'backenly', reason: 'verification' } : opts.actorUserId ? { kind: 'user', userId: opts.actorUserId } : { kind: 'unknown' },
    authorizedBy: opts.mode === 'automatic' ? { kind: 'backenly', policy: 'lossless_only' } : opts.actorUserId ? { kind: 'user', userId: opts.actorUserId, source: opts.mode === 'approved' ? 'explicit_approval' : 'dashboard' } : null,
    executedBy: { kind: 'backenly' },
  }
  await recordEvent(change.id, projectId, 'recovery_started', { mode: opts.mode, from: claim.from, claim: claim.claim, ...(opts.approvalId ? { approvalId: opts.approvalId } : {}), ...principals })

  const reapply = change.kind === 'recovery'
  const title = reapply
    ? `Reapply #${targetSeqOf(change)}`
    : opts.mode === 'automatic'
      ? `Automatic recovery of #${change.seq}`
      : `Restore the state before #${change.seq}`
  const summary = reapply ? `Reapplied the change restored by #${change.seq}` : `Restored the state before #${change.seq}`
  const attr = opts.mode === 'automatic'
    ? { source: 'system' as const, actorUserId: null, apiKeyId: null }
    : { source: opts.mode === 'approved' ? ('approval' as const) : ('dashboard' as const), actorUserId: opts.actorUserId ?? null }

  let committed = false
  let measured: Impact | null = null
  let restoreRecord: { id: string; seq: number } | null = null
  try {
    const { change: closed } = await withChangeAttribution(attr, () =>
      withGovernedChange({ projectId, kind: 'recovery', recoversId: change.id, title, summary, autoRecover: false }, async () => {
        const open = currentChange(projectId)!
        restoreRecord = { id: open.id, seq: open.seq }
        const { intact, altered } = await intactEntries(open.client, await candidateEntries(projectId, change))
        if (altered.length > 0) throw new AbandonChange({ code: 'INTEGRITY', reason: `The data kept for ${altered.join(', ')} was altered after it was kept.` })
        const plan = { ...planRestore({ schema: open.schema, footprint: change.footprint, checkpoint: change.checkpoint, resultState: change.resultState, preserved: intact, live: open.before, vault: open.vault }), schema: open.schema }
        if (plan.conflicts.length > 0) throw new AbandonChange({ code: 'CONFLICT', conflicts: plan.conflicts })

        const acknowledged = opts.acknowledged && Object.keys(opts.acknowledged).length > 0 ? opts.acknowledged : null
        try {
          measured = await runPlan(open.client, plan, {
            commit: true,
            vault: plan.archives.length > 0 ? open.vault : null,
            measure: () => measureImpact(runner(open.client), { schema: open.schema, footprint: change.footprint, checkpoint: change.checkpoint, resultState: change.resultState, preserved: intact }),
            gate: (impact) => {
              if (impact.blockers.length > 0) throw new ImpactRefusal('BLOCKED', impact)
              const needsApproval = impact.needsApproval || plan.unrecoverable.length > 0
              if (!needsApproval) return
              if (opts.mode === 'automatic' || !acknowledged) throw new ImpactRefusal('NEEDS_APPROVAL', impact)
              if (!impactCovered(impact, acknowledged)) throw new ImpactRefusal('IMPACT_CHANGED', impact)
            },
          })
        } catch (e) {
          // Refused before anything ran: withdrawn, not a failed recovery.
          if (e instanceof ImpactRefusal) throw new AbandonChange({ code: 'IMPACT', refusal: e })
          throw e
        }
        committed = true
        if (plan.archives.length > 0) open.vaultCreated = true

        // What the restore kept, with real counts and checksums, so reapplying
        // brings it back and can trust it.
        for (const a of plan.archives) {
          const sum = await tableChecksum(open.client, a.vault, a.vaultTable).catch(() => null)
          a.rows = sum?.rows ?? null
          a.checksum = sum?.checksum ?? null
        }
        open.preserved.push(...plan.archives)

        // The independent check: read back from the catalog, compare to the checkpoint.
        const after = await readCatalogOn(open.client, open.schema)
        const against = verifyAgainstCheckpoint(change.footprint, change.checkpoint, after, plan.keptObjects)
        const checks: VerificationCheck[] = against.checks.map((c, i) => ({
          id: `checkpoint_${i}`,
          label: c.table,
          outcome: c.ok ? 'confirmed' : 'contradicted',
          detail: c.detail,
        }))
        checks.push({ id: 'values', label: 'Kept values back on their rows', outcome: 'confirmed', detail: `${plan.checks.length} value check${plan.checks.length === 1 ? '' : 's'} passed before commit` })
        open.verification = {
          outcome: against.ok ? 'confirmed' : 'contradicted',
          checkedAt: new Date().toISOString(),
          checks,
        }
        await restorePlatformRecords(projectId, open.schema, change.footprint, change.checkpoint, after)
      }),
    )
    if (!closed || !restoreRecord) throw new Error('The recovery was not recorded.')
    const record = restoreRecord as { id: string; seq: number }

    if (closed.status !== 'healthy') {
      // It ran, and the result does not match the checkpoint. Not recovered.
      await releaseRecovery(change.id, claim.claim, 'recovery_failed')
      await recordEvent(change.id, projectId, 'recovery_failed', { recoveryId: record.id, phase: 'verification', checks: closed.verification?.checks.filter((c) => c.outcome !== 'confirmed') ?? [] })
      await stopAndEscalate(projectId, change, 'The restore ran, but the result did not match the restore point.')
      return fail('RECOVERY_FAILED', 'The restore ran, but the result did not match the restore point. Automatic recovery has stopped; a person needs to look.', { recoveryId: record.id })
    }

    const finalStatus: 'recovered' | 'restored' = opts.mode === 'automatic' ? 'recovered' : 'restored'
    await releaseRecovery(change.id, claim.claim, finalStatus, { recoveredById: record.id, recoveredAt: new Date() })
    await recordEvent(change.id, projectId, 'recovery_verified', { recoveryId: record.id, seq: record.seq, checks: closed.verification?.checks.length ?? 0 })
    await recordEvent(change.id, projectId, reapply ? 'reapplied' : finalStatus === 'recovered' ? 'recovery_completed' : 'restored', {
      recoveryId: record.id,
      ms: Date.now() - started,
      ...principals,
    })
    recordTiming('recovery', Date.now() - started, { projectId, mode: opts.mode, outcome: 'verified' })
    if (reapply && change.recoversId) {
      // The change this restore had undone is in effect again.
      await transition(change.recoversId, ['restored'], 'healthy')
      await recordEvent(change.recoversId, projectId, 'reapplied', { by: record.id, ...principals })
    }
    await afterRecovery(projectId, change, record.seq, opts, reapply)
    return {
      ok: true,
      changeId: change.id,
      status: finalStatus,
      recoveryId: record.id,
      recoverySeq: record.seq,
      verification: closed.verification!,
      impact: measured ?? { items: [], blockers: [], needsApproval: false, fingerprint: '' },
    }
  } catch (caught: any) {
    const back = claim.from
    let err = caught
    if (err instanceof AbandonChange && (err.payload as { code?: string }).code === 'IMPACT') {
      err = (err.payload as { refusal: ImpactRefusal }).refusal
    }
    if (err instanceof AbandonChange) {
      const payload = err.payload as { code: 'CONFLICT' | 'INTEGRITY'; conflicts?: PlanConflict[]; reason?: string }
      await releaseRecovery(change.id, claim.claim, back)
      await recordEvent(change.id, projectId, 'recovery_failed', { phase: 'plan', code: payload.code, reason: payload.reason ?? payload.conflicts?.map((c) => c.reason).join('; ') })
      if (payload.code === 'CONFLICT') {
        return fail('CONFLICT', `Not restored: ${payload.conflicts!.map((c) => c.reason).join('; ')}. Nothing was changed.`, {
          conflicts: payload.conflicts,
          blockedBy: await laterOverlapping(projectId, change),
          status: back,
        })
      }
      return fail('INTEGRITY', `Not restored: ${payload.reason} Nothing was changed.`, { status: back })
    }
    if (err instanceof ImpactRefusal) {
      await releaseRecovery(change.id, claim.claim, back)
      // A blocker can quote a value PostgreSQL refused to convert.
      const quote = await quotesKeptHere(projectId)
      await recordEvent(change.id, projectId, 'recovery_planned', { safety: err.code === 'BLOCKED' ? 'blocked' : 'needs_approval', impact: err.impact.items, blockers: err.impact.blockers.map((b) => keptText(b, quote)) })
      const first = err.impact.blockers[0] ?? err.impact.items.find((i) => i.needsApproval)?.detail ?? 'It would affect data written since this change.'
      const message =
        err.code === 'BLOCKED' ? `Not restored: ${first} Nothing was changed.`
          : err.code === 'IMPACT_CHANGED' ? `Not restored: the data has changed since this restore was approved. Review it again. Nothing was changed.`
            : `This restore needs approval: ${first}`
      return fail(err.code, message, { impact: err.impact, acknowledgement: acknowledgementOf(err.impact), status: back })
    }
    if (err instanceof ChangeInProgressError) {
      await releaseRecovery(change.id, claim.claim, back)
      return fail('CHANGE_IN_PROGRESS', err.message, { status: back })
    }
    if (!committed) {
      // Nothing took effect: the transaction rolled back (a statement failed,
      // a value check failed, or the connection went away before COMMIT).
      const to: ChangeStatus = opts.mode === 'automatic' ? 'recovery_failed' : back
      await releaseRecovery(change.id, claim.claim, to)
      // A connection lost mid-restore leaves the restore's own record open, the
      // catalog unread. Every statement it ran was in that one transaction, so
      // it is closed as failed here, not left for the reconciler to report as
      // a change that needs a person.
      if (restoreRecord) await closeUncommitted((restoreRecord as { id: string }).id, projectId, err)
      const step = err instanceof RecoveryStepError && err.step ? { index: err.index, sql: err.step.sql, describe: err.step.describe } : undefined
      await recordEvent(change.id, projectId, 'recovery_failed', { phase: 'execute', error: keptText(String(err?.message ?? err), await quotesKeptHere(projectId)).slice(0, 500), ...(step ? { step: step.describe } : {}) })
      recordTiming('recovery', Date.now() - started, { projectId, mode: opts.mode, outcome: 'failed' })
      if (opts.mode === 'automatic') await stopAndEscalate(projectId, change, `The automatic recovery failed and was rolled back: ${err?.message ?? err}`)
      return fail('RECOVERY_FAILED', `${err?.message ?? err}. The restore was rolled back, so nothing was changed.`, {
        status: to,
        ...(step ? { failedStep: step } : {}),
        recoveryId: (restoreRecord as { id: string } | null)?.id ?? null,
      })
    }
    // After COMMIT: the restore took effect and could not be confirmed. The
    // claim stays, with its lease, for the reconciler to settle from the catalog.
    await recordEvent(change.id, projectId, 'recovery_failed', { phase: 'after_commit', error: keptText(String(err?.message ?? err), await quotesKeptHere(projectId)).slice(0, 500) })
    return fail('RECOVERY_FAILED', `The restore was applied but could not be confirmed (${err?.message ?? err}). Backenly will check it again.`, { status: 'recovering' })
  }
}

async function closeUncommitted(recordId: string, projectId: string, err: unknown): Promise<void> {
  const error = keptText(String((err as { message?: string })?.message ?? err), await quotesKeptHere(projectId))
  const closed = await transition(recordId, ['applying'], 'failed', { error: error.slice(0, 2000), completedAt: new Date() }).catch(() => false)
  if (closed) await recordEvent(recordId, projectId, 'apply_failed', { error: error.slice(0, 500), committed: false })
}

function targetSeqOf(change: LoadedChange): string {
  const m = /#(\d+)/.exec(change.title)
  return m ? m[1] : '?'
}

// ── Automatic recovery and escalation ────────────────────────────────────────

export interface AutoRecoveryOutcome {
  status: ChangeStatus
  /** One plain sentence: what happened. */
  explanation: string
  recoveryId?: string | null
  recoverySeq?: number | null
  approvalId?: string | null
  verified: boolean
}

/**
 * A change just failed (part-way, or protected verification). Recover it if
 * that is provably lossless; otherwise leave it for a person, through the
 * existing approvals, and say why. Called by the ledger inside the change's own
 * lock, so nothing else can land in between.
 */
export async function recoverAutomatically(projectId: string, changeId: string): Promise<AutoRecoveryOutcome> {
  // While a recovery anywhere in this project needs a person, Backenly takes
  // no further automatic recovery action on its own.
  const stuck = await prisma.backendChange.findFirst({
    where: { projectId, id: { not: changeId }, status: { in: ['manual_intervention_required', 'recovery_failed'] } },
    select: { seq: true },
  })
  const change = await load(projectId, changeId)
  if (!change) return { status: 'manual_intervention_required', explanation: 'The change record could not be read.', verified: false }
  if (stuck) {
    const explanation = `Automatic recovery is paused while change #${stuck.seq} needs attention, so this one waits for a person too.`
    const approvalId = await escalate(projectId, change, explanation, null)
    return { status: 'awaiting_approval', explanation, approvalId, verified: false }
  }

  const outcome = await recoverChange(projectId, changeId, { mode: 'automatic' })
  if (outcome.ok) {
    return {
      status: 'recovered',
      explanation: 'Backenly restored the previous state and verified it.',
      recoveryId: outcome.recoveryId,
      recoverySeq: outcome.recoverySeq,
      verified: true,
    }
  }
  const failed = outcome as Extract<RecoveryOutcome, { ok: false }>
  if (failed.code === 'NEEDS_APPROVAL') {
    const explanation = `Recovering it would affect data written since: ${failed.impact?.items.find((i) => i.needsApproval)?.detail ?? 'see the details'}`
    const approvalId = await escalate(projectId, change, explanation, failed.impact ?? null)
    return { status: 'awaiting_approval', explanation, approvalId, verified: false }
  }
  if (failed.code === 'RECOVERY_FAILED' || failed.code === 'CONFLICT' || failed.code === 'BLOCKED' || failed.code === 'INTEGRITY' || failed.code === 'NOT_AVAILABLE') {
    const now = await prisma.backendChange.findUnique({ where: { id: changeId }, select: { status: true } })
    if (now?.status !== 'manual_intervention_required') await stopAndEscalate(projectId, change, failed.error)
    return { status: 'manual_intervention_required', explanation: failed.error, recoveryId: failed.recoveryId ?? null, verified: false }
  }
  return { status: (failed.status as ChangeStatus) ?? 'verification_failed', explanation: failed.error, verified: false }
}

/** Needs a person, who can approve exactly what recovering would do. */
async function escalate(projectId: string, change: LoadedChange, explanation: string, impact: Impact | null): Promise<string | null> {
  const moved = await transition(change.id, ['verification_failed', 'partially_applied', 'recovery_failed'], 'awaiting_approval')
  if (!moved) return null
  // The explanation can carry a database error, which quotes values.
  const quote = await quotesKeptHere(projectId)
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } })
  let approvalId: string | null = null
  if (project?.userId) {
    const { createApprovalRequest } = await import('@/lib/mcp/approvals')
    const rows = impact?.items.filter((i) => i.needsApproval).reduce((n, i) => n + i.count, 0) ?? null
    // The impact this recovery just measured is the request; there is nothing
    // to gain from previewing the same change again inside its own lock.
    const restore: RestoreRequest = {
      target: `Restore the state before change #${change.seq}: ${change.summary}`,
      rowCount: rows,
      toolArgs: { changeId: change.id, acknowledged: impact ? acknowledgementOf(impact) : {}, origin: 'backenly' },
    }
    const row = await createApprovalRequest({
      projectId,
      userId: project.userId,
      message: `Change #${change.seq} (${change.summary}) failed verification. ${keptText(explanation, quote)}`,
      danger: { tool: 'revert_schema_change', target: restore.target, rowCount: rows, reversible: true },
      toolArgs: { ...restore.toolArgs },
      restore,
    })
    approvalId = row.id
  }
  await recordEvent(change.id, projectId, 'recovery_escalated', { approvalId, explanation: keptText(explanation, quote) })
  await audit(projectId, null, 'CHANGE_RECOVERY_AWAITING_APPROVAL', { changeId: change.id, seq: change.seq, summary: `Change #${change.seq} failed verification and needs your approval to recover: ${change.summary}` })
  return approvalId
}

/** Automation stops here; the evidence stays; a person decides. */
async function stopAndEscalate(projectId: string, change: LoadedChange, reason: string): Promise<void> {
  await transition(change.id, ['recovery_failed', 'verification_failed', 'partially_applied', 'awaiting_approval'], 'manual_intervention_required').catch(() => false)
  // The reason can be a database error, which quotes values.
  const kept = keptText(reason, await quotesKeptHere(projectId))
  await recordEvent(change.id, projectId, 'manual_intervention_required', { reason: kept.slice(0, 500) })
  await audit(projectId, null, 'CHANGE_RECOVERY_NEEDS_ATTENTION', { changeId: change.id, seq: change.seq, summary: `Change #${change.seq} needs attention: ${kept}` })
}

// ── Reconciling interrupted work ─────────────────────────────────────────────

/**
 * Settle a change a process stopped working on: a recovery whose lease ran out,
 * or a change still `applying` long after it began. Reads the catalog and
 * records what actually happened. Never re-runs anything.
 */
export async function reconcileChange(projectId: string, changeId: string, now = new Date()): Promise<string | null> {
  const row = await prisma.backendChange.findFirst({
    where: { id: changeId, projectId },
    select: { status: true, recoveryLeaseUntil: true, recoveryClaim: true, createdAt: true },
  })
  if (!row) return null
  const staleRecovery = row.status === 'recovering' && row.recoveryLeaseUntil !== null && row.recoveryLeaseUntil < now
  const staleApply = (row.status === 'applying' || row.status === 'verifying') && row.createdAt.getTime() < now.getTime() - RECOVERY_LEASE_MS
  if (!staleRecovery && !staleApply) return null

  try {
    return await withChangeLock(projectId, async (client) => {
      const change = await load(projectId, changeId)
      if (!change) return null
      const { resolveWorkspaceSchema } = await import('@/lib/services/workspace-pool')
      const schema = await resolveWorkspaceSchema(projectId)
      const live = await readCatalogOn(client, schema)

      if (staleRecovery && change.recoveryClaim) {
        const started = await prisma.backendChangeEvent.findFirst({
          where: { changeId, type: 'recovery_started' },
          orderBy: { at: 'desc' },
          select: { data: true },
        })
        const info = (started?.data ?? {}) as { mode?: RecoveryMode; from?: ChangeStatus }
        const restored = verifyAgainstCheckpoint(change.footprint, change.checkpoint, live).ok
        const untouched = change.footprint.every((c) => {
          if (c.object || !c.after) return true
          const A = change.resultState.tables[c.after]
          const L = live.tables[c.after]
          return !!A && !!L && JSON.stringify(A.columns.map((x) => x.name)) === JSON.stringify(L.columns.map((x) => x.name))
        })
        const record = await prisma.backendChange.findFirst({ where: { projectId, kind: 'recovery', recoversId: changeId }, orderBy: { seq: 'desc' }, select: { id: true } })
        let to: ChangeStatus
        if (restored) to = info.mode === 'automatic' ? 'recovered' : 'restored'
        else if (untouched && info.mode !== 'automatic' && info.from) to = info.from
        else to = 'manual_intervention_required'
        await releaseRecovery(changeId, change.recoveryClaim, to, restored && record ? { recoveredById: record.id, recoveredAt: now } : {})
        await recordEvent(changeId, projectId, 'reconciled', { found: restored ? 'restored' : untouched ? 'not_restored' : 'neither', to })
        return to
      }

      // A change that never closed. Whatever it did is in the catalog now,
      // unless later changes landed after the lock was released, in which case
      // its effects can no longer be told apart from theirs.
      const later = await prisma.backendChange.count({ where: { projectId, seq: { gt: change.seq } } })
      const { diffCatalogs } = await import('./diff')
      const footprint = later === 0 ? diffCatalogs(change.checkpoint, live) : null
      const moved = await transition(changeId, [row.status as ChangeStatus], 'manual_intervention_required', {
        ...(footprint ? { footprint: footprint as unknown as Prisma.InputJsonValue } : {}),
        error: later === 0
          ? 'The process applying this change stopped before it finished.'
          : 'The process applying this change stopped before it finished, and later changes have landed since.',
        completedAt: now,
      })
      if (moved) await recordEvent(changeId, projectId, 'reconciled', { found: 'interrupted', objects: footprint?.length ?? null })
      return moved ? 'manual_intervention_required' : null
    }, { waitMs: 2_000 })
  } catch (err) {
    if (err instanceof ChangeInProgressError) return null // someone is still working on it
    throw err
  }
}

/** Every stale change in a project. Run by the maintenance cron. */
export async function reconcileChanges(projectId: string, now = new Date()): Promise<number> {
  const stale = await prisma.backendChange.findMany({
    where: {
      projectId,
      OR: [
        { status: 'recovering', recoveryLeaseUntil: { lt: now } },
        { status: { in: ['applying', 'verifying'] }, createdAt: { lt: new Date(now.getTime() - RECOVERY_LEASE_MS) } },
      ],
    },
    select: { id: true },
    take: 50,
  })
  let settled = 0
  for (const s of stale) if (await reconcileChange(projectId, s.id, now).catch(() => null)) settled++
  return settled
}

// ── After a verified recovery ────────────────────────────────────────────────

/**
 * The platform rows that describe tables follow the schema: a table the
 * restore brought back is registered again, one it moved aside is not, and
 * row-level-security metadata for every touched table is put back as it was.
 * Left alone they would disagree with the database, and the autonomy loop
 * treats disagreement as something to repair.
 */
async function restorePlatformRecords(
  projectId: string,
  schema: string,
  footprint: TableChange[],
  checkpoint: StoredSnapshot,
  live: CatalogSnapshot,
): Promise<void> {
  const platform = checkpoint.platform
  if (!platform) return
  const touched = new Set(footprint.filter((c) => !c.object).flatMap((c) => [c.before, c.after]).filter((n): n is string => !!n))
  const registeredBefore = new Set(platform.registered)

  for (const name of touched) {
    const exists = !!live.tables[name]
    const row = await prisma.table.findFirst({ where: { projectId, name }, select: { id: true } })
    if (exists && registeredBefore.has(name) && !row) {
      await prisma.table.create({ data: { projectId, name, schema, description: 'Restored' } }).catch(() => {})
    } else if (!exists && row) {
      await prisma.table.delete({ where: { id: row.id } }).catch(() => {})
    }
  }

  await prisma.permissionPolicy.deleteMany({ where: { projectId, tableName: { in: [...touched] } } })
  const keep = platform.policies.filter((p) => live.tables[String(p.tableName)])
  if (keep.length > 0) {
    await prisma.permissionPolicy.createMany({
      data: keep.map((p) => ({
        ...(p as any),
        createdAt: new Date(String(p.createdAt)),
        updatedAt: new Date(String(p.updatedAt)),
      })),
      skipDuplicates: true,
    })
  }
}

async function audit(projectId: string, userId: string | null, action: string, details: Record<string, unknown>) {
  await prisma.auditLog.create({
    data: { projectId, userId, action, type: 'schema', details: JSON.stringify({ ...details, at: new Date().toISOString() }), timestamp: new Date() },
  }).catch(() => {})
}

async function afterRecovery(projectId: string, change: LoadedChange, recoverySeq: number, opts: RecoveryOptions, reapply: boolean): Promise<void> {
  const tables = new Set(change.footprint.filter((c) => !c.object).flatMap((c) => [c.before, c.after]).filter((n): n is string => !!n))

  // Caches that describe tables.
  await import('@/lib/ai/execution-cache').then(({ invalidateSchemaCache }) => invalidateSchemaCache(projectId)).catch(() => {})
  await import('@/lib/services/workspace-validator')
    .then(({ invalidateSchemaCache }) => { for (const t of tables) invalidateSchemaCache(projectId, t) })
    .catch(() => {})
  await import('@/lib/services/workspace-table-stats')
    .then(({ invalidateTableStats }) => { for (const t of tables) invalidateTableStats(projectId, t) })
    .catch(() => {})

  // A new baseline. The schema reconciler compares the live schema with the
  // latest snapshot and repairs what it reads as drift; measured against the
  // pre-recovery snapshot, it would re-create what was just restored.
  await import('@/lib/services/workspace-schema-snapshot')
    .then(({ captureSchemaSnapshot }) => captureSchemaSnapshot(projectId, 'post_migration'))
    .catch(() => {})

  // The Autonomy page's activity feed and its "Rolled back" count read these.
  // A reapply undoes a restore: it is not counted as a rollback.
  const what = reapply ? 'CHANGE_REAPPLIED' : opts.mode === 'automatic' ? 'ROLLBACK_CHANGE_RECOVERED' : 'ROLLBACK_CHANGE_RESTORED'
  const sentence = reapply
    ? `Reapplied a change that had been restored (#${recoverySeq})`
    : opts.mode === 'automatic'
      ? `Recovered automatically: change #${change.seq} (${change.summary}) failed verification; the previous state is back and verified`
      : `Restored the state before change #${change.seq} (${change.summary}), verified`
  await audit(projectId, opts.actorUserId ?? null, what, { changeId: change.id, seq: change.seq, recoverySeq, tables: [...tables], summary: sentence })

  // Any other request to restore this change is answered now. Left pending, it
  // would sit in the approvals inbox asking for something already done, and
  // approving it later would find nothing to restore.
  if (!reapply) {
    const pending = await prisma.agentApprovalRequest
      .findMany({ where: { projectId, status: 'pending', tool: 'revert_schema_change' }, select: { id: true, toolArgs: true } })
      .catch(() => [] as Array<{ id: string; toolArgs: unknown }>)
    const ids = pending.filter((p) => (p.toolArgs as { changeId?: string } | null)?.changeId === change.id).map((p) => p.id)
    if (ids.length > 0) {
      const now = new Date()
      await prisma.agentApprovalRequest
        .updateMany({
          where: { id: { in: ids }, status: 'pending' },
          data: {
            status: 'executed',
            decidedBy: opts.actorUserId ?? null,
            decidedAt: now,
            executedAt: now,
            resultSummary: opts.mode === 'automatic' ? `Already done: ${sentence}.` : `Already done from Database → Changes: ${sentence}.`,
          },
        })
        .catch(() => {})
    }
  }

  await import('@/lib/operational-memory/ledger')
    .then(({ recordRollbackMemory }) =>
      recordRollbackMemory({
        projectId,
        actorId: opts.actorUserId ?? null,
        actorType: opts.mode === 'automatic' ? 'system' : 'user',
        summary: sentence,
        reason: opts.mode === 'automatic' ? 'Protected verification failed after the change.' : 'A person restored the previous state.',
        rollbackId: change.id,
      }),
    )
    .catch(() => {})
}

// ── Keeping a change ─────────────────────────────────────────────────────────

/**
 * A person decides to keep a change as it is after it failed its checks.
 *
 * The other half of "a person decides": without it a declined recovery would
 * read as waiting forever, and a change needing attention would keep automatic
 * recovery paused for the whole project. The change stays in effect, its failed
 * checks stay on record, and it can still be restored later.
 *
 * Only from awaiting_approval or manual_intervention_required, and only by a
 * person: an automatic path never keeps a failed change. Compare-and-set, so a
 * keep racing a restore leaves exactly one of them done.
 */
export async function keepChange(
  projectId: string,
  changeId: string,
  actorUserId: string,
  opts: { via?: 'console' | 'approval' } = {},
): Promise<{ ok: true; changeId: string; status: 'kept' } | { ok: false; code: 'NOT_FOUND' | 'NOT_PENDING'; error: string; status?: string }> {
  const change = await prisma.backendChange.findFirst({
    where: { id: changeId, projectId, kind: 'change' },
    select: { id: true, seq: true, status: true, summary: true, title: true },
  })
  if (!change) return { ok: false, code: 'NOT_FOUND', error: 'Change not found.' }
  const moved = await transition(change.id, ['awaiting_approval', 'manual_intervention_required'], 'kept')
  if (!moved) {
    const now = await prisma.backendChange.findUnique({ where: { id: change.id }, select: { status: true } })
    return { ok: false, code: 'NOT_PENDING', error: 'This change is not waiting for a decision.', status: now?.status ?? change.status }
  }
  await recordEvent(change.id, projectId, 'kept', {
    from: change.status,
    authorizedBy: { kind: 'user', userId: actorUserId, source: opts.via === 'approval' ? 'explicit_approval' : 'dashboard' },
  })
  const summary = change.summary ?? change.title
  await audit(projectId, actorUserId, 'CHANGE_KEPT', { changeId: change.id, seq: change.seq, summary: `Kept change #${change.seq} as it is after it failed its checks: ${summary}` })

  // Its pending restore requests are answered: the person decided.
  if (opts.via !== 'approval') {
    const pending = await prisma.agentApprovalRequest
      .findMany({ where: { projectId, status: 'pending', tool: 'revert_schema_change' }, select: { id: true, toolArgs: true } })
      .catch(() => [] as Array<{ id: string; toolArgs: unknown }>)
    const ids = pending.filter((p) => (p.toolArgs as { changeId?: string } | null)?.changeId === change.id).map((p) => p.id)
    if (ids.length > 0) {
      await prisma.agentApprovalRequest
        .updateMany({
          where: { id: { in: ids }, status: 'pending' },
          data: { status: 'rejected', decidedBy: actorUserId, decidedAt: new Date(), resultSummary: 'Declined: the change was kept as it is.' },
        })
        .catch(() => {})
    }
  }
  return { ok: true, changeId: change.id, status: 'kept' }
}

// ── An agent's request ───────────────────────────────────────────────────────

/** The exact call a restore approval runs: the change, and what Backenly measured. */
export interface RestoreRequestArgs {
  changeId: string
  acknowledged: AcknowledgedImpact
  /** Set when Backenly itself asked, recovering a change that failed verification. */
  origin?: 'backenly'
}

/**
 * A restore request as a person is asked to approve it. Only Backenly's own
 * code builds one, from its own measurement: describeRestoreRequest below, or
 * a recovery escalating what it measured. Never from an agent's arguments.
 */
export interface RestoreRequest {
  target: string
  rowCount: number | null
  toolArgs: RestoreRequestArgs
}

/**
 * What an agent's request to restore a change will ask a person to approve,
 * proven now: an impossible request is answered at once instead of parked for
 * a person to approve into a failure, and the approval carries the impact
 * Backenly measured, never anything the agent sent.
 */
export async function describeRestoreRequest(
  projectId: string,
  changeId: string,
): Promise<({ ok: true } & RestoreRequest) | { ok: false; status: number; code: string; error: string }> {
  if (!changeId) return { ok: false, status: 400, code: 'CHANGE_ID_REQUIRED', error: 'revert_change needs { changeId }.' }
  let preview: RecoveryPreview | null
  try {
    preview = await previewRecovery(projectId, changeId)
  } catch (err) {
    if (err instanceof ChangeInProgressError) return { ok: false, status: 409, code: 'CHANGE_IN_PROGRESS', error: err.message }
    throw err
  }
  if (!preview) return { ok: false, status: 404, code: 'CHANGE_NOT_FOUND', error: `No change ${changeId} on this project.` }
  if (preview.safety === 'unavailable' || preview.safety === 'blocked') {
    return {
      ok: false,
      status: 409,
      code: preview.safety === 'unavailable' ? 'RESTORE_NOT_AVAILABLE' : 'RESTORE_BLOCKED',
      error: `The state before change #${preview.seq} cannot be restored: ${preview.reason ?? 'it is not available'}`,
    }
  }
  const affected = preview.impact?.items.filter((i) => i.needsApproval) ?? []
  const rows = affected.reduce((n, i) => n + i.count, 0)
  return {
    ok: true,
    target:
      `Restore the state before change #${preview.seq}: ${preview.summary}` +
      (affected.length > 0 ? `. ${affected.map((i) => i.detail).join(' ')}` : '. No data written since would be affected.'),
    rowCount: affected.length > 0 ? rows : null,
    toolArgs: { changeId: preview.changeId, acknowledged: preview.acknowledgement ?? {} },
  }
}
