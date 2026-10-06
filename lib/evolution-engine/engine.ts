/**
 * THE ARCHITECTURE EVOLUTION ENGINE — the loop around every primitive
 * ===================================================================
 *
 * A primitive (./primitive.ts) knows how to make one kind of change. This file
 * is everything around it, identical for every kind:
 *
 *   propose   assess → classify → rehearse on a copy → ask a person, in the
 *             queue they already use (./request.ts)
 *   approve   bind consent to the exact version the person was shown, rebuilt
 *             from the live system; never from what a request body claims
 *   advance   run what was approved under the primitive's governed execution
 *             contract, and turn what happened into lifecycle states
 *   observe   watch a cut-over change under real traffic until it has earned
 *             `stable`, or stop it
 *   judge     say whether it helped, from measurements only, never by assumption
 *   undo      the primitive's rollback, which refuses rather than lose a write
 *   remember  every step, in architecture memory (./memory.ts), which the next
 *             analysis consults
 *
 * ── What may happen without a person ────────────────────────────────────────
 *
 * Proposing (assessment and rehearsal change nothing) and observing (reads
 * only) run on the scheduler when ENABLE_EVOLUTION_SCHEDULER is on. Running
 * rungs needs, every time: a person's consent to the exact plan version, the
 * deployment's ENABLE_EVOLUTION_MUTATIONS, and — for unattended resumption —
 * the scheduler flag and an autonomy level that is not OFF. See ./policy.ts.
 *
 * Agents read all of this over MCP and can approve none of it: every decision
 * here is reached only through routes that require a platform session.
 *
 * ── Lifecycle bookkeeping ────────────────────────────────────────────────────
 *
 * The current state of a decision is the last transition remembered for it.
 * Every transition is checked against ./lifecycle.ts; one the table does not
 * allow is refused and logged, never written. Each re-entry of a state carries
 * an attempt number, so a resumed change records its second `expanding` while a
 * retried scheduler pass cannot record the same entry twice.
 */

import { FLAGS } from '@/lib/config/flags'
import { getProjectAutonomyLevel } from '@/lib/autonomy/autonomy-level'
import { canTransition, canUndoFrom, userFacingStatus, type LifecycleState } from './lifecycle'
import {
  DEFAULT_POLICY,
  approvalRequirement,
  mayResumeUnattended,
  riskOf,
  shouldAutoRollback,
  type EvolutionPolicy,
} from './policy'
import { observationVerdict, CONSISTENCY_SIGNAL } from './observe'
import { assessBenefit, type BenefitReport, type BenefitVerdict } from './benefit'
import {
  decisionTrail,
  evidenceHashOf,
  latestAssessment,
  newDecisionId,
  openDecision,
  passesOf,
  priorsFor,
  readMemory,
  remember,
  snapshotsOf,
  summarizeDecisions,
  type DecisionSummary,
  type EvolutionRecord,
  type MemoryEntry,
} from './memory'
import {
  allPrimitives,
  primitiveById,
  type EnginePlan,
  isConsentRefusal,
  type EvolutionPrimitive,
  type ExecutionOutcome,
  type Opportunity,
  type Rehearsal,
  type RungStage,
  type SnapshotPhase,
  type UserFacingSummary,
} from './primitive'
import {
  claimRequest,
  raiseRequest,
  requestById,
  requestForDecision,
  setRequestStatus,
  type EvolutionRequestDetails,
} from './request'
import type { ArchitectureChangeView, ArchitectureSummary, NoChangeView, RecommendationView } from './views'
import { prisma } from '@/lib/db'
import { EVOLUTION_FINDING_TYPE } from '@/lib/core/types'
import './installed'

// ── Identity ─────────────────────────────────────────────────────────────────

interface DecisionRef {
  decisionId: string
  concernKey: string
  proposalKey: string
  planId: string
  planVersion?: string
  primitive: string
  subject: string
}

const refOf = (d: DecisionSummary): DecisionRef => ({
  decisionId: d.decisionId,
  concernKey: d.concernKey,
  proposalKey: d.proposalKey,
  planId: d.planId,
  planVersion: d.planVersion,
  primitive: d.primitive,
  subject: d.subject,
})

const base = (d: DecisionRef): Omit<EvolutionRecord, 'event'> => ({
  v: 1,
  decisionId: d.decisionId,
  concernKey: d.concernKey,
  proposalKey: d.proposalKey,
  planId: d.planId,
  ...(d.planVersion ? { planVersion: d.planVersion } : {}),
  primitive: d.primitive,
  subject: d.subject,
})

/** Is this deployment allowed to run rungs at all? */
export function executionEnabled(): { enabled: boolean; reason: string | null } {
  return FLAGS.ENABLE_EVOLUTION_MUTATIONS
    ? { enabled: true, reason: null }
    : {
        enabled: false,
        reason:
          'Architecture changes are switched off in this deployment (ENABLE_EVOLUTION_MUTATIONS). ' +
          'Backenly still proposes, rehearses and records them; nothing runs until an operator turns this on.',
      }
}

// ── Memory helpers ───────────────────────────────────────────────────────────

async function decision(projectId: string, decisionId: string): Promise<{ summary: DecisionSummary | null; trail: MemoryEntry[] }> {
  const trail = await decisionTrail(projectId, decisionId)
  return { summary: summarizeDecisions(trail)[0] ?? null, trail }
}

function entriesInto(trail: MemoryEntry[], state: LifecycleState): number {
  return trail.filter(e => e.record.event === 'transition' && e.record.state === state).length
}

/**
 * Enter a lifecycle state, if the table allows it. Returns whether a
 * transition was recorded. Refused transitions are logged and not written:
 * memory must never contain a history the lifecycle could not have produced.
 */
async function enter(
  projectId: string,
  d: DecisionRef,
  to: LifecycleState,
  o: { sentence: string; milestone?: boolean; payload?: Record<string, unknown>; userId?: string | null },
): Promise<boolean> {
  const { summary, trail } = await decision(projectId, d.decisionId)
  const from = summary?.state ?? null
  if (from === to) return false
  if (from === null ? to !== 'proposed' : !canTransition(from, to)) {
    console.warn(`[evolution] refused transition ${from ?? '∅'} → ${to} for decision ${d.decisionId}`)
    return false
  }
  const r = await remember({
    projectId,
    record: { ...base(d), event: 'transition', state: to, from, attempt: entriesInto(trail, to) + 1, payload: o.payload },
    milestone: !!o.milestone,
    sentence: o.sentence,
    userId: o.userId ?? null,
  })
  return r.written
}

/** The path a change walks forward. A resumed change re-enters part of it. */
const FORWARD: LifecycleState[] = ['approved', 'expanding', 'backfilling', 'verifying', 'cutover', 'observing']

const STAGE_STATE: Partial<Record<RungStage, LifecycleState>> = {
  expand: 'expanding',
  backfill: 'backfilling',
  verify: 'verifying',
  cutover: 'cutover',
}

/** Enter every forward state after the current one, up to `target`, as traces. */
async function walkTo(projectId: string, d: DecisionRef, target: LifecycleState, sentence: (s: LifecycleState) => string): Promise<void> {
  const { summary } = await decision(projectId, d.decisionId)
  const from = summary?.state ?? null
  const start = from && FORWARD.includes(from) ? FORWARD.indexOf(from) + 1 : 0
  const end = FORWARD.indexOf(target)
  for (let i = start; i <= end; i++) {
    if (i === 0) continue // `approved` is entered by approval, never by walking
    await enter(projectId, d, FORWARD[i], { sentence: sentence(FORWARD[i]) })
  }
}

async function snapshot(
  projectId: string,
  d: DecisionRef,
  primitive: EvolutionPrimitive<any, any>,
  plan: EnginePlan,
  phase: SnapshotPhase,
  now: Date,
): Promise<void> {
  const snap = await primitive.snapshot(projectId, plan, phase, now).catch(err => ({
    v: 1 as const,
    phase,
    at: now.toISOString(),
    data: {},
    unavailable: [{ metric: '*', reason: 'not_yet_measurable' as const, detail: err instanceof Error ? err.message : String(err) }],
  }))
  await remember({
    projectId,
    record: { ...base(d), event: 'measured', payload: { snapshot: snap }, attempt: undefined },
    milestone: false,
    sentence: `${phase} snapshot`,
  })
}

function firedByOf(trail: MemoryEntry[]): string[] {
  for (const e of trail) {
    const p = (e.record.payload ?? {}) as { firedBy?: string[] }
    if (e.record.event === 'transition' && e.record.state === 'proposed' && Array.isArray(p.firedBy)) return p.firedBy
  }
  return []
}

function summaryOf(trail: MemoryEntry[]): UserFacingSummary | null {
  for (let i = trail.length - 1; i >= 0; i--) {
    const s = ((trail[i].record.payload ?? {}) as { summary?: UserFacingSummary }).summary
    if (s) return s
  }
  return null
}

// ── Propose ──────────────────────────────────────────────────────────────────

export interface ProposalPassResult {
  assessed: number
  requested: number
  refreshed: number
  rehearsalFailed: number
  skipped: Array<{ concernKey: string; reason: string }>
}

/** A project-level marker: the last time a proposal pass ran, and what it concluded. */
const PASS_MARKER: DecisionRef = {
  decisionId: 'assessment-pass',
  concernKey: '*',
  proposalKey: '*',
  planId: '*',
  primitive: '*',
  subject: '*',
}

/**
 * Assess every primitive, remember what was concluded, and ask a person about
 * every executable proposal that has no open decision yet.
 *
 * Changes nothing in the customer's schema: assessment reads, and rehearsal is
 * a transaction that is always rolled back.
 */
export async function proposeChanges(projectId: string, opts: { now?: Date } = {}): Promise<ProposalPassResult> {
  const now = opts.now ?? new Date()
  const out: ProposalPassResult = { assessed: 0, requested: 0, refreshed: 0, rehearsalFailed: 0, skipped: [] }
  const memory = await readMemory(projectId)
  const decisions = summarizeDecisions(memory)
  const recommendations: RecommendationView[] = []
  const noChange: NoChangeView[] = []
  let watching = 0

  for (const primitive of allPrimitives()) {
    const assessment = await primitive.assess(projectId, { now, priors: priorsFor(decisions) })
    for (const s of assessment.subjects) {
      if (s.noChangeReason) noChange.push({ subject: s.subject, reason: s.noChangeReason })
    }
    const stillProposed = new Set(assessment.opportunities.filter(o => o.level === 'executable_proposal').map(o => o.concernKey))
    const assessedSubjects = new Set(assessment.subjects.map(x => x.subject))
    for (const opp of assessment.opportunities) {
      out.assessed++
      if (opp.level === 'watching') watching++
      const evidenceHash = evidenceHashOf({ level: opp.level, evidence: opp.evidence, pressure: opp.pressure })
      const last = latestAssessment(memory, opp.concernKey)
      if (!last || last.record.evidenceHash !== evidenceHash) {
        const sentence = sentenceForAssessment(opp)
        await remember({
          projectId,
          record: {
            v: 1,
            decisionId: `assessment:${opp.concernKey}`,
            concernKey: opp.concernKey,
            proposalKey: opp.key,
            planId: opp.planId,
            primitive: opp.primitive,
            subject: opp.subject,
            event: 'assessed',
            level: opp.level,
            evidenceHash,
            payload: { levelReason: opp.levelReason, evidence: opp.evidence, pressure: opp.pressure },
          },
          milestone: false,
          sentence,
        })
      }
      if (opp.level === 'recommendation_only') {
        recommendations.push({ subject: opp.subject, concernKey: opp.concernKey, sentence: sentenceForAssessment(opp) })
      }
      if (opp.level !== 'executable_proposal') continue

      const open = openDecision(decisions, opp.concernKey)
      if (open) {
        const refreshed = await refreshIfStale(projectId, primitive, open, opp, now)
        if (refreshed === 'refreshed') out.refreshed++
        else out.skipped.push({ concernKey: opp.concernKey, reason: `a decision is already ${open.state ?? 'open'}` })
        continue
      }
      const r = await requestApproval(projectId, primitive, opp, now)
      if (r === 'requested') out.requested++
      else if (r === 'rehearsal_failed') out.rehearsalFailed++
      else out.skipped.push({ concernKey: opp.concernKey, reason: r })
    }

    // A request still waiting for a concern this pass no longer proposes —
    // because something changed, or memory now holds it back — must not stay
    // in front of the owner as if it were current.
    for (const d of decisions) {
      if (d.primitive !== primitive.id || d.state !== 'awaiting_approval' || d.declined) continue
      if (!assessedSubjects.has(d.subject) || stillProposed.has(d.concernKey)) continue
      await withdrawRequest(projectId, refOf(d), 'it is no longer proposed: the latest analysis of this table no longer supports it')
    }
  }

  await remember({
    projectId,
    record: {
      ...base(PASS_MARKER),
      event: 'assessed',
      payload: {
        recommendations: recommendations.slice(0, 20),
        noChange: noChange.slice(0, 20),
        watching,
      },
    },
    milestone: false,
    sentence: `assessed ${out.assessed} concern(s)`,
  })
  return out
}

function sentenceForAssessment(opp: Opportunity): string {
  const what = `${opp.subject}`
  switch (opp.level) {
    case 'executable_proposal':
      return `A change to ${what} is ready to propose: ${opp.levelReason}.`
    case 'recommendation_only':
      return `Recommended for ${what}, not proposed to run: ${opp.levelReason}.`
    case 'watching':
      return `Watching ${what}: ${opp.levelReason}.`
    default:
      return `No change for ${what}: ${opp.levelReason}.`
  }
}

type RequestOutcome = 'requested' | 'rehearsal_failed' | string

/** Plan, rehearse, and — only if the rehearsal passed — ask a person. */
async function requestApproval(
  projectId: string,
  primitive: EvolutionPrimitive<any, any>,
  opp: Opportunity,
  now: Date,
  existing?: DecisionRef,
): Promise<RequestOutcome> {
  const resolved = await primitive.resolvePlan(projectId, opp.spec)
  if ('refusal' in resolved) {
    if (existing) await withdrawRequest(projectId, existing, `no plan can be built any more: ${resolved.refusal}`)
    return `no plan: ${resolved.refusal}`
  }
  const plan = resolved.plan as EnginePlan
  if (plan.validity !== 'executable') {
    if (existing) await withdrawRequest(projectId, existing, `the plan is no longer executable: ${plan.blockedReasons.join('; ')}`)
    return `not executable: ${plan.blockedReasons.join('; ')}`
  }

  const d: DecisionRef = existing
    ? { ...existing, planVersion: plan.planVersion, planId: plan.planId, proposalKey: plan.proposalKey }
    : {
        decisionId: newDecisionId(),
        concernKey: opp.concernKey,
        proposalKey: plan.proposalKey,
        planId: plan.planId,
        planVersion: plan.planVersion,
        primitive: primitive.id,
        subject: opp.subject,
      }
  const firedBy = opp.pressure.filter(p => p.class === 'measured_cost').map(p => p.kind)
  if (!existing) {
    await enter(projectId, d, 'proposed', {
      sentence: `Backenly found a change worth making to ${opp.subject}.`,
      payload: { spec: opp.spec, level: opp.level, firedBy, levelReason: opp.levelReason },
    })
    await snapshot(projectId, d, primitive, plan, 'R', now)
  }
  await enter(projectId, d, 'rehearsing', { sentence: `Rehearsing the change to ${opp.subject} on a copy of its data.` })
  const rehearsal = await primitive.rehearse(projectId, plan).catch(
    (err): Rehearsal => ({
      passed: false,
      authorization: 'unavailable',
      authorizationDetail: '',
      detail: `the rehearsal could not run: ${err instanceof Error ? err.message : String(err)}`,
      report: null,
    }),
  )
  if (!rehearsal.passed) {
    // Not shown to the owner: there is nothing for them to decide. Remembered,
    // and retried by a later pass once a day has passed. A request already
    // waiting for an earlier version is withdrawn: it was rehearsed, this
    // version was not.
    await enter(projectId, d, 'blocked', {
      sentence: `The rehearsal of the change to ${opp.subject} did not pass, so it was not proposed.`,
      payload: { reason: rehearsal.detail, rehearsal: { passed: false, detail: rehearsal.detail } },
    })
    if (existing) await resolveRequest(projectId, d.decisionId)
    return 'rehearsal_failed'
  }
  await enter(projectId, d, 'rehearsed', {
    sentence: `The change to ${opp.subject} rehearsed cleanly on a copy of its data.`,
    payload: { rehearsal: { passed: true, authorization: rehearsal.authorization, detail: rehearsal.detail } },
  })

  const traits = primitive.traits(plan, rehearsal)
  const requirement = approvalRequirement(traits)
  if (requirement.humanOnly) {
    if (existing) await withdrawRequest(projectId, d, `software may not run it: ${requirement.reason}`)
    return `not runnable by software: ${requirement.reason}`
  }
  const summary = primitive.describe(plan, opp)
  const technical = technicalFor(plan, opp)
  const details: EvolutionRequestDetails = {
    v: 1,
    primitive: primitive.id,
    decisionId: d.decisionId,
    concernKey: d.concernKey,
    proposalKey: d.proposalKey,
    planId: d.planId,
    planVersion: plan.planVersion,
    subject: d.subject,
    spec: opp.spec,
    level: opp.level,
    ask: 'approve',
    summary,
    risk: riskOf(traits),
    rehearsal: {
      planVersion: plan.planVersion,
      passed: true,
      authorization: rehearsal.authorization,
      detail: rehearsal.detail,
      at: now.toISOString(),
    },
    technical,
  }
  const findingId = await raiseRequest(projectId, details)
  await enter(projectId, d, 'awaiting_approval', {
    sentence: `Backenly prepared a change to ${d.subject} and is waiting for your approval: ${summary.headline}.`,
    milestone: true,
    payload: { findingId, spec: opp.spec, summary },
  })
  return 'requested'
}

function technicalFor(plan: EnginePlan, opp: Opportunity): EvolutionRequestDetails['technical'] {
  const d = (opp.diagnostics ?? {}) as { clientMigration?: EvolutionRequestDetails['technical']['clientMigration'] }
  return {
    steps: plan.steps.map(s => ({ title: s.title, why: s.why, tier: s.tier, humanOnly: s.capability === 'human_only', sql: s.sql })),
    evidence: opp.evidence.map(e => ({ family: e.family, verdict: e.verdict, detail: e.detail })),
    pressure: opp.pressure.map(p => ({ kind: p.kind, class: p.class, detail: p.detail })),
    semanticBoundary: opp.semanticBoundary,
    contractBlockers: plan.contractBlockers,
    caveats: plan.caveats,
    clientMigration: d.clientMigration ?? [],
  }
}

/** A waiting request whose plan moved, or a rehearsal that failed a day ago: try again. */
async function refreshIfStale(
  projectId: string,
  primitive: EvolutionPrimitive<any, any>,
  open: DecisionSummary,
  opp: Opportunity,
  now: Date,
): Promise<'refreshed' | 'current'> {
  if (open.primitive !== primitive.id) return 'current'
  const { trail } = await decision(projectId, open.decisionId)
  const everApproved = trail.some(e => e.record.event === 'transition' && e.record.state === 'approved')
  if (everApproved) return 'current'
  const retryRehearsal = open.state === 'blocked' && now.getTime() - open.updatedAt.getTime() > 86_400_000
  let drifted = false
  if (open.state === 'awaiting_approval') {
    const resolved = await primitive.resolvePlan(projectId, opp.spec)
    // A plan that can no longer be built, or whose version moved, is
    // re-proposed — or withdrawn — by requestApproval.
    drifted = 'refusal' in resolved || resolved.plan.planVersion !== open.planVersion
  }
  if (!retryRehearsal && !drifted) return 'current'
  const r = await requestApproval(projectId, primitive, opp, now, refOf(open))
  return r === 'requested' ? 'refreshed' : 'current'
}

/** Take a waiting request out of the queue: the engine withdrew it; the owner did not decline it. */
async function resolveRequest(projectId: string, decisionId: string): Promise<void> {
  const req = await requestForDecision(projectId, decisionId)
  if (req && (req.status === 'pending_approval' || req.status === 'approving')) {
    await setRequestStatus(projectId, req.findingId, 'resolved')
  }
}

async function withdrawRequest(projectId: string, d: DecisionRef, reason: string): Promise<void> {
  const entered = await enter(projectId, d, 'blocked', {
    sentence: `Backenly withdrew its request to change ${d.subject}: ${reason}.`,
    milestone: true,
    payload: { reason },
  })
  if (entered) await resolveRequest(projectId, d.decisionId)
}

// ── Approve ──────────────────────────────────────────────────────────────────

export type ApprovalResult =
  | { ok: true; message: string; state: LifecycleState | null }
  | { ok: false; status: 404 | 409 | 422; error: string; currentPlanVersion?: string }

export const isApprovalRefusal = (r: ApprovalResult): r is Extract<ApprovalResult, { ok: false }> => !r.ok

/**
 * A person approved a request. Consent binds to `planVersion` — the version
 * they were shown — and only if the plan rebuilt from the live system right now
 * still has that version, and a rehearsal of exactly that version passed.
 * The spec comes from the request row, never from the caller.
 */
export async function approveRequest(input: {
  projectId: string
  findingId: string
  planVersion: string
  userId: string
}): Promise<ApprovalResult> {
  const { projectId, findingId, planVersion, userId } = input
  const req = await requestById(projectId, findingId)
  if (!req) return { ok: false, status: 404, error: 'No such approval request in this project.' }
  const ev = req.evolution
  if (ev.ask !== 'approve') return { ok: false, status: 409, error: 'This change is waiting for a resume or undo decision, not an approval.' }
  if (req.status !== 'pending_approval') return { ok: false, status: 409, error: 'This request was already decided.' }
  if (ev.planVersion !== planVersion) {
    return {
      ok: false,
      status: 409,
      error: 'This change was updated after you opened it. Review the current version before approving.',
      currentPlanVersion: ev.planVersion,
    }
  }
  if (!ev.rehearsal.passed || ev.rehearsal.planVersion !== planVersion) {
    return { ok: false, status: 409, error: 'This exact version has not passed a rehearsal, so it cannot be approved yet.' }
  }
  const primitive = primitiveById(ev.primitive)
  const spec = primitive?.normaliseSpec(ev.spec) ?? null
  if (!primitive || !spec) return { ok: false, status: 422, error: 'This request cannot be read by this version of Backenly.' }
  // The queue row and the remembered lifecycle must agree that this is waiting
  // on a person; a row that outlived its decision is not consent to anything.
  const remembered = (await decision(projectId, ev.decisionId)).summary
  if (remembered?.state !== 'awaiting_approval' || remembered.declined) {
    return { ok: false, status: 409, error: 'This request is out of date. Refresh to see the current state of this change.' }
  }

  if (!(await claimRequest(projectId, findingId))) {
    return { ok: false, status: 409, error: 'This request is already being approved.' }
  }
  const d: DecisionRef = {
    decisionId: ev.decisionId,
    concernKey: ev.concernKey,
    proposalKey: ev.proposalKey,
    planId: ev.planId,
    planVersion: ev.planVersion,
    primitive: ev.primitive,
    subject: ev.subject,
  }
  let granted
  try {
    granted = await primitive.grant({ projectId, spec, planVersion, approvedBy: userId, decisionId: ev.decisionId })
  } catch (err) {
    await setRequestStatus(projectId, findingId, 'pending_approval')
    throw err
  }
  if (isConsentRefusal(granted)) {
    await setRequestStatus(projectId, findingId, 'pending_approval')
    if (granted.currentPlanVersion && granted.currentPlanVersion !== planVersion) {
      // The table moved since this was rehearsed: rehearse the current version
      // and put that in front of the person instead.
      await reRequest(projectId, primitive, d, ev, new Date()).catch(() => {})
      const fresh = await requestById(projectId, findingId)
      return {
        ok: false,
        status: 409,
        error: 'The table changed since this was prepared. Backenly re-checked it; review the updated change.',
        currentPlanVersion: fresh?.evolution.planVersion ?? granted.currentPlanVersion,
      }
    }
    return { ok: false, status: 409, error: `Not approved: ${granted.refusal}` }
  }

  await setRequestStatus(projectId, findingId, 'approved')
  await enter(projectId, d, 'approved', {
    sentence: `You approved: ${ev.summary.headline}.`,
    milestone: true,
    userId,
    payload: { findingId, spec: ev.spec, summary: ev.summary, approvalId: granted.approvalId },
  })

  const exec = executionEnabled()
  if (!exec.enabled) return { ok: true, message: `Approved. ${exec.reason}`, state: 'approved' }
  // Consent is recorded whatever happens next; a failure to start is the
  // change's state to report, not the approval's.
  try {
    const advanced = await advance({ projectId, decisionId: ev.decisionId, actor: userId })
    return { ok: true, message: `Approved. ${advanced.message}`, state: advanced.state }
  } catch (err) {
    console.error('[evolution] advance after approval failed:', err)
    return { ok: true, message: 'Approved. It could not start just now; it will be retried, or you can resume it.', state: 'approved' }
  }
}

async function reRequest(
  projectId: string,
  primitive: EvolutionPrimitive<any, any>,
  d: DecisionRef,
  ev: EvolutionRequestDetails,
  now: Date,
): Promise<void> {
  const assessment = await primitive.assess(projectId, { subjects: [ev.subject], now })
  const opp = assessment.opportunities.find(o => o.concernKey === ev.concernKey)
  if (!opp || opp.level !== 'executable_proposal') return
  await requestApproval(projectId, primitive, opp, now, d)
}

/** The person said "not now" to an approval request. Remembered, and respected until something new is measured. */
export async function recordDecline(projectId: string, findingId: string, userId: string | null): Promise<void> {
  const req = await requestById(projectId, findingId)
  if (!req) return
  const ev = req.evolution
  if (ev.ask !== 'approve') return
  await remember({
    projectId,
    record: {
      v: 1,
      decisionId: ev.decisionId,
      concernKey: ev.concernKey,
      proposalKey: ev.proposalKey,
      planId: ev.planId,
      planVersion: ev.planVersion,
      primitive: ev.primitive,
      subject: ev.subject,
      event: 'declined',
    },
    milestone: false,
    sentence: `You declined: ${ev.summary.headline}. Backenly will not raise it again unless something new is measured.`,
    userId,
  })
}

// ── Advance ──────────────────────────────────────────────────────────────────

export interface AdvanceResult {
  state: LifecycleState | null
  message: string
  outcome?: ExecutionOutcome
}

const ADVANCEABLE: LifecycleState[] = ['approved', 'expanding', 'backfilling', 'verifying', 'cutover']

/** Run what was approved, and turn what happened into lifecycle states. */
export async function advance(input: {
  projectId: string
  decisionId: string
  actor?: string | null
  now?: Date
  policy?: EvolutionPolicy
}): Promise<AdvanceResult> {
  const { projectId, decisionId } = input
  const now = input.now ?? new Date()
  const policy = input.policy ?? DEFAULT_POLICY
  const { summary, trail } = await decision(projectId, decisionId)
  if (!summary || !summary.state) return { state: null, message: 'No such change.' }
  if (!ADVANCEABLE.includes(summary.state)) {
    return { state: summary.state, message: `Nothing to run: the change is ${userFacingStatus(summary.state).label.toLowerCase()}.` }
  }
  const primitive = primitiveById(summary.primitive)
  if (!primitive) return { state: summary.state, message: 'This change was made by a primitive this deployment does not have.' }
  const d = refOf(summary)
  const exec = executionEnabled()

  // The end of "before": captured once, immediately before the first rung
  // that could change anything.
  if (summary.state === 'approved' && !snapshotsOf(trail).some(s => s.phase === 'S0') && exec.enabled) {
    const spec = primitive.normaliseSpec(summary.spec)
    const resolved = spec ? await primitive.resolvePlan(projectId, spec) : null
    if (resolved && !('refusal' in resolved)) await snapshot(projectId, d, primitive, resolved.plan, 'S0', now)
  }

  const outcome = await primitive.execute(projectId, summary.planId, { mutationsEnabled: exec.enabled })
  const subject = summary.subject
  const traceFor = (s: LifecycleState) => `${userFacingStatus(s).label}: ${subject}.`

  if (outcome.status === 'in_flight_elsewhere') {
    return { state: summary.state, message: 'Another change is running on this project; this one continues after it.', outcome }
  }

  // The furthest stage a rung of this attempt actually reached.
  const reached = outcome.steps
    .filter(s => s.status !== 'awaiting_human')
    .map(s => STAGE_STATE[s.stage])
    .filter((s): s is LifecycleState => !!s)
  const furthest = reached.sort((a, b) => FORWARD.indexOf(b) - FORWARD.indexOf(a))[0] ?? null

  if (outcome.status === 'completed') {
    await walkTo(projectId, d, 'cutover', traceFor)
    const s = summaryOf(trail)
    const hours = policy.observationHours
    await enter(projectId, d, 'observing', {
      sentence: `Backenly ${s?.did ?? `changed ${subject}`}. Existing apps keep working; it is being watched for ${hours} hours before it counts as done.`,
      milestone: true,
      payload: { cutoverAt: now.toISOString() },
    })
    const spec = primitive.normaliseSpec(summary.spec)
    const resolved = spec ? await primitive.resolvePlan(projectId, spec) : null
    if (resolved && !('refusal' in resolved)) await snapshot(projectId, d, primitive, resolved.plan, 'S1', now)
    return { state: 'observing', message: `The change is in place and being watched for ${hours} hours.`, outcome }
  }

  if (outcome.status === 'awaiting_background_work') {
    if (furthest) await walkTo(projectId, d, furthest, traceFor)
    return { state: furthest ?? summary.state, message: 'The change is in progress; existing data is being copied in the background.', outcome }
  }

  // halted or refused
  if (outcome.stoppedBecause === 'mutations_disabled') {
    if (furthest) await walkTo(projectId, d, furthest, traceFor)
    return { state: furthest ?? summary.state, message: exec.reason ?? 'Changes are switched off here.', outcome }
  }
  const failedStep = outcome.steps.find(s => s.status === 'failed')
  if (furthest) await walkTo(projectId, d, furthest, traceFor)
  const reason = plainReason(outcome)
  const failed = outcome.stoppedBecause === 'rung_failed' && failedStep?.stage !== 'rehearsal'
  const target: LifecycleState = failed ? 'failed' : 'blocked'
  await enter(projectId, d, target, {
    sentence: failed
      ? `A step of the change to ${subject} did not complete: ${reason}. Your app works as before; you can resume or undo it.`
      : `Backenly paused the change to ${subject}: ${reason}. Your app works as before.`,
    milestone: true,
    payload: { reason, stoppedBecause: outcome.stoppedBecause, haltReason: outcome.haltReason },
  })
  // A pause the person asked for is theirs to lift from the changes list; any
  // other stop is put back in front of them.
  if (outcome.stoppedBecause !== 'consent' || !summary.withdrawn) {
    await askToResumeOrUndo(projectId, d, reason)
  }
  return { state: target, message: `The change stopped: ${reason}.`, outcome }
}

function plainReason(outcome: ExecutionOutcome): string {
  switch (outcome.stoppedBecause) {
    case 'consent':
      return 'its approval is no longer in place'
    case 'drift':
      return 'the table changed after the change was approved, so the approved version no longer matches'
    case 'capability':
      return 'part of it cannot run in this deployment'
    case 'verification':
      return 'the old and new shapes did not match when checked, so nothing more was opened'
    case 'rung_failed':
      return outcome.haltReason ?? 'a step failed'
    default:
      return outcome.haltReason ?? 'it stopped'
  }
}

async function askToResumeOrUndo(projectId: string, d: DecisionRef, reason: string): Promise<void> {
  const req = await requestForDecision(projectId, d.decisionId)
  if (!req) return
  await raiseRequest(projectId, { ...req.evolution, ask: 'resume_or_undo', stoppedBecause: reason })
}

// ── Pause, resume, undo ──────────────────────────────────────────────────────

export type ActionResult = { ok: true; message: string; state: LifecycleState | null } | { ok: false; status: 404 | 409; error: string }

export const isActionRefusal = (r: ActionResult): r is Extract<ActionResult, { ok: false }> => !r.ok

export async function pause(input: { projectId: string; decisionId: string; userId: string }): Promise<ActionResult> {
  const { projectId, decisionId, userId } = input
  const { summary } = await decision(projectId, decisionId)
  if (!summary?.state) return { ok: false, status: 404, error: 'No such change.' }
  if (!ADVANCEABLE.includes(summary.state)) return { ok: false, status: 409, error: 'Only a change that is still being applied can be paused.' }
  const primitive = primitiveById(summary.primitive)
  if (!primitive) return { ok: false, status: 409, error: 'Unknown change type.' }
  const w = await primitive.withdraw({ projectId, planId: summary.planId, by: userId })
  if (!w.ok) return { ok: false, status: 409, error: w.detail }
  const d = refOf(summary)
  await remember({
    projectId,
    record: { ...base(d), event: 'withdrawn' },
    milestone: true,
    sentence: `You paused the change to ${summary.subject}. Nothing further runs until you resume it; your app works as before.`,
    userId,
  })
  await enter(projectId, d, 'blocked', { sentence: `Paused by you: ${summary.subject}.`, payload: { reason: 'you paused it' } })
  return { ok: true, message: 'Paused. Nothing further runs until you resume it.', state: 'blocked' }
}

export async function resume(input: { projectId: string; decisionId: string; userId: string }): Promise<ActionResult> {
  const { projectId, decisionId, userId } = input
  const { summary, trail } = await decision(projectId, decisionId)
  if (!summary?.state) return { ok: false, status: 404, error: 'No such change.' }
  const primitive = primitiveById(summary.primitive)
  if (!primitive) return { ok: false, status: 409, error: 'Unknown change type.' }
  const d = refOf(summary)

  // A change regressed in observation, kept on purpose: watching resumes.
  const stoppedIn = lastActiveState(trail)
  if (summary.state === 'blocked' && stoppedIn === 'observing') {
    await enter(projectId, d, 'observing', { sentence: `You kept the change to ${summary.subject}; Backenly is watching it again.`, milestone: true, userId })
    await clearQueue(projectId, decisionId)
    return { ok: true, message: 'Kept. Backenly continues to watch it.', state: 'observing' }
  }
  if (!['blocked', 'failed', ...ADVANCEABLE].includes(summary.state)) {
    return { ok: false, status: 409, error: 'This change is not stopped.' }
  }

  // Consent must be live for the exact version, rebuilt from the live system.
  if (summary.state === 'blocked' || summary.state === 'failed') {
    const spec = primitive.normaliseSpec(summary.spec)
    if (!spec || !summary.planVersion) return { ok: false, status: 409, error: 'This change cannot be resumed; undo it instead.' }
    const granted = await primitive.grant({ projectId, spec, planVersion: summary.planVersion, approvedBy: userId, decisionId })
    if (isConsentRefusal(granted)) {
      return {
        ok: false,
        status: 409,
        error: granted.currentPlanVersion
          ? 'The table changed since this was approved, so it cannot simply resume. Undo it, and Backenly will propose the change again for the table as it is now.'
          : `It cannot resume: ${granted.refusal}`,
      }
    }
    const back = stoppedIn && ADVANCEABLE.includes(stoppedIn) ? stoppedIn : 'approved'
    await enter(projectId, d, back, { sentence: `You resumed the change to ${summary.subject}.`, milestone: true, userId })
  }
  await clearQueue(projectId, decisionId)
  const exec = executionEnabled()
  if (!exec.enabled) return { ok: true, message: `Resumed. ${exec.reason}`, state: (await decision(projectId, decisionId)).summary?.state ?? null }
  const r = await advance({ projectId, decisionId, actor: userId })
  return { ok: true, message: r.message, state: r.state }
}

/** The last forward state before the decision stopped. */
function lastActiveState(trail: MemoryEntry[]): LifecycleState | null {
  for (let i = trail.length - 1; i >= 0; i--) {
    const r = trail[i].record
    if (r.event === 'transition' && r.state && FORWARD.includes(r.state)) return r.state
  }
  return null
}

async function clearQueue(projectId: string, decisionId: string): Promise<void> {
  const req = await requestForDecision(projectId, decisionId)
  if (req && req.status === 'pending_approval' && req.evolution.ask === 'resume_or_undo') {
    await setRequestStatus(projectId, req.findingId, 'approved', { ask: 'approve', stoppedBecause: undefined })
  }
}

export async function undo(input: { projectId: string; decisionId: string; userId: string; automatic?: boolean }): Promise<ActionResult> {
  const { projectId, decisionId, userId } = input
  const { summary } = await decision(projectId, decisionId)
  if (!summary?.state) return { ok: false, status: 404, error: 'No such change.' }
  if (!canUndoFrom(summary.state)) return { ok: false, status: 409, error: 'There is nothing to undo for this change.' }
  const primitive = primitiveById(summary.primitive)
  if (!primitive) return { ok: false, status: 409, error: 'Unknown change type.' }
  const d = refOf(summary)

  const result = await primitive.rollback(projectId, summary.planId, userId)
  if (result.status === 'in_flight_elsewhere') {
    return { ok: false, status: 409, error: 'Another change is running on this project. Try again in a minute.' }
  }
  await enter(projectId, d, 'rolling_back', { sentence: `Undoing the change to ${summary.subject}.`, userId })
  if (result.status === 'rolled_back' || result.status === 'nothing_to_undo') {
    await enter(projectId, d, 'rolled_back', {
      sentence: `${input.automatic ? 'Backenly' : 'You'} undid the change to ${summary.subject}. It is exactly as it was before, and no data was lost.`,
      milestone: true,
      userId,
      payload: { actions: result.actions, automatic: !!input.automatic },
    })
    const req = await requestForDecision(projectId, decisionId)
    if (req) await setRequestStatus(projectId, req.findingId, 'resolved')
    return { ok: true, message: 'Undone. Everything is exactly as it was, and no data was lost.', state: 'rolled_back' }
  }
  const reason = result.reason ?? 'the undo could not complete'
  await enter(projectId, d, 'blocked', {
    sentence: `Backenly did not undo the change to ${summary.subject}: ${reason}. Nothing was removed.`,
    milestone: true,
    userId,
    payload: { reason, rollback: result },
  })
  await askToResumeOrUndo(projectId, d, reason)
  return { ok: false, status: 409, error: `Not undone: ${reason}` }
}

// ── Observe and judge ────────────────────────────────────────────────────────

export interface ObservePassResult {
  state: LifecycleState | null
  verdict: 'continue' | 'stable' | 'regressed'
  reason: string
  benefit?: BenefitReport
}

/**
 * One observation pass over a cut-over change. Reads only. Decides `stable`
 * after the window with enough passes and measured agreement, or stops the
 * change on the first regression.
 */
export async function observe(input: { projectId: string; decisionId: string; now?: Date; policy?: EvolutionPolicy }): Promise<ObservePassResult> {
  const { projectId, decisionId } = input
  const now = input.now ?? new Date()
  const policy = input.policy ?? DEFAULT_POLICY
  const { summary, trail } = await decision(projectId, decisionId)
  if (!summary || summary.state !== 'observing' || !summary.cutoverAt) {
    return { state: summary?.state ?? null, verdict: 'continue', reason: 'not being observed' }
  }
  const primitive = primitiveById(summary.primitive)
  const spec = primitive?.normaliseSpec(summary.spec)
  if (!primitive || !spec) return { state: summary.state, verdict: 'continue', reason: 'unknown change type' }
  const resolved = await primitive.resolvePlan(projectId, spec)
  const d = refOf(summary)
  const signals =
    'refusal' in resolved
      ? [{ name: CONSISTENCY_SIGNAL, status: 'regressed' as const, detail: resolved.refusal }]
      : await primitive.observe(projectId, resolved.plan, { since: summary.cutoverAt, now })
  await remember({
    projectId,
    record: { ...base(d), event: 'observed', payload: { signals } },
    milestone: false,
    sentence: signals.map(s => `${s.name}: ${s.status}`).join(', '),
  })
  const passes = [...passesOf(trail), { at: now.toISOString(), signals }]
  const verdict = observationVerdict({ passes, cutoverAt: summary.cutoverAt, now, policy })
  if (verdict.status === 'continue') return { state: 'observing', verdict: 'continue', reason: verdict.reason }

  if (verdict.status === 'regressed') {
    // The signals' own details, not their internal names, are what a person reads.
    const problem = verdict.signals.map(sg => sg.detail).join('; ')
    await stopForRegression(projectId, d, summary.subject, problem, policy, input)
    return { state: 'blocked', verdict: 'regressed', reason: verdict.reason }
  }

  // Stable by observation. Whether it also HELPED is a separate question,
  // answered from measurements only.
  if ('refusal' in resolved) return { state: 'observing', verdict: 'continue', reason: resolved.refusal }
  await snapshot(projectId, d, primitive, resolved.plan, 'S2', now)
  const benefit = await judge(projectId, primitive, resolved.plan, decisionId, now)
  if (benefit.verdict === 'regressed') {
    await stopForRegression(projectId, d, summary.subject, asClause(benefit.summary), policy, input)
    return { state: 'blocked', verdict: 'regressed', reason: benefit.summary, benefit }
  }
  const s = summaryOf(trail)
  const lead =
    benefit.verdict === 'beneficial'
      ? `Backenly improved your ${s?.subjectTitle ?? summary.subject} architecture: it ${s?.did ?? 'restructured it'}.`
      : `Backenly ${s?.did ?? `restructured ${summary.subject}`}.`
  // The milestone already says it works; the benefit summary's own lead would repeat it.
  const outcome = benefit.summary.replace(/^It works correctly\.\s*/, '')
  const later = benefit.verdict === 'beneficial' ? '' : ' Backenly will look again a month after the change.'
  await enter(projectId, d, 'stable', {
    sentence: `${lead} Existing apps kept working, the data matches, and it can be undone.${outcome ? ` ${outcome}` : ''}${later}`,
    milestone: true,
  })
  await remember({ projectId, record: { ...base(d), event: 'outcome', payload: { benefit, phase: 'S2' } }, milestone: false, sentence: benefit.summary })
  const req = await requestForDecision(projectId, decisionId)
  if (req) await setRequestStatus(projectId, req.findingId, 'resolved')
  return { state: 'stable', verdict: 'stable', reason: verdict.reason, benefit }
}

/** "It made things worse: x rose from a to b." → "x rose from a to b", to sit inside a sentence. */
const asClause = (summary: string) => summary.replace(/^It made things worse:\s*/, '').replace(/[.\s]+$/, '')

/** `reason` is a clause: no lead-in, no closing stop. */
async function stopForRegression(
  projectId: string,
  d: DecisionRef,
  subject: string,
  reason: string,
  policy: EvolutionPolicy,
  input: { projectId: string; decisionId: string },
): Promise<void> {
  await enter(projectId, d, 'blocked', {
    sentence: `Backenly stopped the change to ${subject} because it saw a problem: ${reason}.`,
    milestone: true,
    payload: { reason, verdict: 'regressed' },
  })
  if (shouldAutoRollback(policy, true)) {
    const r = await undo({ projectId, decisionId: input.decisionId, userId: 'evolution-engine', automatic: true })
    if (r.ok) return
  }
  await askToResumeOrUndo(projectId, d, reason)
}

async function judge(
  projectId: string,
  primitive: EvolutionPrimitive<any, any>,
  plan: EnginePlan,
  decisionId: string,
  now: Date,
): Promise<BenefitReport> {
  const { trail } = await decision(projectId, decisionId)
  const snapshots = snapshotsOf(trail)
  const measurements = await primitive.measure(projectId, plan, snapshots, { firedBy: firedByOf(trail), now }).catch(() => [])
  const passes = passesOf(trail)
  const lastConsistency = [...passes].reverse().flatMap(p => p.signals).find(s => s.name === CONSISTENCY_SIGNAL)
  const rehearsed = trail
    .map(e => ((e.record.payload ?? {}) as { rehearsal?: { authorization?: string } }).rehearsal)
    .filter(Boolean)
    .pop()
  return assessBenefit(
    {
      correctness: lastConsistency?.status === 'ok' ? 'pass' : lastConsistency?.status === 'regressed' ? 'fail' : 'not_run',
      compatibility: passes.some(p => p.signals.some(s => s.status === 'regressed')) ? 'fail' : 'pass',
      authorization: rehearsed?.authorization === 'passed' ? 'pass' : rehearsed?.authorization === 'failed' ? 'fail' : 'not_run',
    },
    measurements,
  )
}

/** Benefits that take weeks to show are re-judged 30 and 90 days after cutover. */
async function longHorizon(projectId: string, d: DecisionSummary, now: Date): Promise<void> {
  if (d.state !== 'stable' || !d.cutoverAt) return
  const primitive = primitiveById(d.primitive)
  const spec = primitive?.normaliseSpec(d.spec)
  if (!primitive || !spec) return
  const { trail } = await decision(projectId, d.decisionId)
  const taken = new Set(snapshotsOf(trail).map(s => s.phase))
  const age = (now.getTime() - d.cutoverAt.getTime()) / 86_400_000
  const due: SnapshotPhase | null = age >= 90 && !taken.has('L90') ? 'L90' : age >= 30 && !taken.has('L30') ? 'L30' : null
  if (!due) return
  const resolved = await primitive.resolvePlan(projectId, spec)
  if ('refusal' in resolved) return
  const ref = refOf(d)
  await snapshot(projectId, ref, primitive, resolved.plan, due, now)
  const benefit = await judge(projectId, primitive, resolved.plan, d.decisionId, now)
  const changed = benefit.verdict !== d.outcome?.verdict
  await remember({
    projectId,
    record: { ...base(ref), event: 'outcome', payload: { benefit, phase: due } },
    milestone: changed && benefit.verdict === 'beneficial',
    sentence:
      changed && benefit.verdict === 'beneficial'
        ? `${due === 'L30' ? 'A month' : 'Three months'} on, the change to ${d.subject} has paid off: ${benefit.summary}`
        : benefit.summary,
  })
}

// ── The sweep ────────────────────────────────────────────────────────────────

/** How often the (expensive) proposal pass runs per project. */
export const PROPOSAL_INTERVAL_MS = 24 * 3_600_000

export interface SweepResult {
  projectId: string
  disposition: 'disabled' | 'swept'
  reason?: string
  observed: number
  advanced: number
  proposals?: ProposalPassResult
}

/**
 * One scheduler pass for a project: observe what is cut over, re-judge old
 * outcomes, resume what a person approved (only if unattended resumption is
 * allowed), and — at most daily — look for new changes worth proposing.
 *
 * Never approves anything and never starts anything a person did not approve.
 */
export async function sweepArchitecture(input: { projectId: string; now?: Date; policy?: EvolutionPolicy }): Promise<SweepResult> {
  const { projectId } = input
  const now = input.now ?? new Date()
  if (!FLAGS.ENABLE_EVOLUTION_SCHEDULER) {
    return { projectId, disposition: 'disabled', reason: 'the evolution scheduler is off in this deployment', observed: 0, advanced: 0 }
  }
  const autonomyOff = (await getProjectAutonomyLevel(projectId)) === 'OFF'
  if (autonomyOff) return { projectId, disposition: 'disabled', reason: 'autonomy is OFF for this project', observed: 0, advanced: 0 }

  const memory = await readMemory(projectId)
  const decisions = summarizeDecisions(memory).filter(d => d.primitive !== '*')
  let observed = 0
  let advanced = 0

  // Observation reads only: it is not gated on the mutation flag.
  for (const d of decisions.filter(x => x.state === 'observing')) {
    await observe({ projectId, decisionId: d.decisionId, now, policy: input.policy })
    observed++
  }
  for (const d of decisions.filter(x => x.state === 'stable')) await longHorizon(projectId, d, now)

  const exec = executionEnabled()
  const resumable = decisions.filter(x => x.state && ADVANCEABLE.includes(x.state))
  if (
    resumable.length > 0 &&
    mayResumeUnattended({ consented: true, mutationsEnabled: exec.enabled, schedulerEnabled: true, autonomyOff })
  ) {
    // One change per pass: a change rewrites the catalog the next one reads.
    await advance({ projectId, decisionId: resumable[0].decisionId, now, policy: input.policy })
    advanced++
  }

  let proposals: ProposalPassResult | undefined
  const lastPass = [...memory].reverse().find(e => e.record.decisionId === PASS_MARKER.decisionId)
  if (!lastPass || now.getTime() - lastPass.at.getTime() >= PROPOSAL_INTERVAL_MS) {
    proposals = await proposeChanges(projectId, { now })
  }
  return { projectId, disposition: 'swept', observed, advanced, proposals }
}

// ── Views ────────────────────────────────────────────────────────────────────

const LISTED: LifecycleState[] = [
  'approved',
  'expanding',
  'backfilling',
  'verifying',
  'cutover',
  'observing',
  'stable',
  'blocked',
  'failed',
  'rolling_back',
  'rolled_back',
]

/** Recent architecture changes for the Autonomy page, newest first. */
export async function listChanges(projectId: string, opts: { limit?: number; now?: Date } = {}): Promise<ArchitectureChangeView[]> {
  const now = opts.now ?? new Date()
  const memory = await readMemory(projectId)
  const decisions = summarizeDecisions(memory).filter(d => d.primitive !== '*')
  const pending = await prisma.healthFinding.findMany({
    where: { projectId, type: EVOLUTION_FINDING_TYPE, status: 'pending_approval' },
    select: { id: true, details: true },
  })
  const pendingBy = new Map(
    pending.map(p => [((p.details ?? {}) as { evolution?: { decisionId?: string } }).evolution?.decisionId, p.id] as const),
  )
  const schedulerOn = FLAGS.ENABLE_EVOLUTION_SCHEDULER
  return decisions
    // Only what a person approved: a proposal whose rehearsal failed was never
    // shown to anyone and is the engine's business, not news.
    .filter(d => d.state && LISTED.includes(d.state) && d.everApproved)
    // A change that was approved and blocked before it touched anything, and
    // settled changes older than a month, are history, not news.
    .filter(d => !(d.state === 'stable' || d.state === 'rolled_back') || now.getTime() - d.updatedAt.getTime() < 30 * 86_400_000)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, opts.limit ?? 10)
    .map(d => {
      const state = d.state!
      const s = summaryOfDecision(memory, d.decisionId)
      return {
        decisionId: d.decisionId,
        primitive: d.primitive,
        subject: d.subject,
        headline: d.headline ?? s?.headline ?? `A change to ${d.subject}`,
        change: s?.change ?? '',
        status: userFacingStatus(state),
        state,
        ...(d.stoppedBecause ? { stoppedBecause: d.stoppedBecause } : {}),
        ...(d.outcome ? { outcome: { verdict: d.outcome.verdict as BenefitVerdict, summary: d.outcome.summary } } : {}),
        at: d.updatedAt.toISOString(),
        actions: {
          undo: canUndoFrom(state),
          pause: ADVANCEABLE.includes(state),
          // Without the scheduler, a person pushes an in-progress change on.
          resume: state === 'blocked' || state === 'failed' || (!schedulerOn && ADVANCEABLE.includes(state)),
        },
        ...(pendingBy.get(d.decisionId) ? { findingId: pendingBy.get(d.decisionId)! } : {}),
      }
    })
}

function summaryOfDecision(memory: MemoryEntry[], decisionId: string): UserFacingSummary | null {
  return summaryOf(memory.filter(e => e.record.decisionId === decisionId))
}

/** GET /api/projects/[id]/architecture — the concise default. Reads memory only; never re-analyses. */
export async function architectureSummary(projectId: string): Promise<ArchitectureSummary> {
  const memory = await readMemory(projectId)
  const changes = await listChanges(projectId)
  const waitingOnYou = await prisma.healthFinding.count({
    where: { projectId, type: EVOLUTION_FINDING_TYPE, status: 'pending_approval' },
  })
  const lastPass = [...memory].reverse().find(e => e.record.decisionId === PASS_MARKER.decisionId)
  const p = (lastPass?.record.payload ?? {}) as { recommendations?: RecommendationView[]; noChange?: NoChangeView[]; watching?: number }
  return {
    changes,
    waitingOnYou,
    recommendations: p.recommendations ?? [],
    noChange: p.noChange ?? [],
    watching: p.watching ?? 0,
    execution: executionEnabled(),
    analyzedAt: lastPass ? lastPass.at.toISOString() : null,
  }
}

/** Everything remembered about one decision, oldest first. For `?decision=`. */
export async function decisionDetail(projectId: string, decisionId: string) {
  const { summary, trail } = await decision(projectId, decisionId)
  if (!summary) return null
  const req = await requestForDecision(projectId, decisionId)
  return {
    decision: summary,
    status: summary.state ? userFacingStatus(summary.state) : null,
    request: req ? { findingId: req.findingId, status: req.status, evolution: req.evolution } : null,
    trail: trail.map(e => ({
      at: e.at.toISOString(),
      event: e.record.event,
      state: e.record.state ?? null,
      sentence: e.sentence,
      milestone: e.milestone,
      payload: e.record.payload ?? null,
    })),
  }
}
