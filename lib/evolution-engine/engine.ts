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
 * Unattended resumption also waits out an incident, as every autonomous change
 * does (lib/autonomy/change-freeze.ts).
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

import { FLAGS, evolutionAllowedFor } from '@/lib/config/flags'
import { getProjectAutonomyLevel } from '@/lib/autonomy/autonomy-level'
import { heldForIncident } from '@/lib/autonomy/change-freeze'
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
import { assessBenefit, type BenefitReport, type BenefitVerdict, type CorrectnessChecks } from './benefit'
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
  AUTOMATIC_REQUESTER,
  primitiveById,
  type EnginePlan,
  isConsentRefusal,
  type EvolutionPrimitive,
  type ExecutionOutcome,
  type Measurement,
  type Opportunity,
  type Rehearsal,
  type RollbackResult,
  type RungStage,
  type SnapshotPhase,
  type UserFacingSummary,
} from './primitive'
import {
  claimRequest,
  isClaimAbandoned,
  raiseRequest,
  releaseAbandonedClaims,
  requestById,
  requestForDecision,
  setRequestStatus,
  type EvolutionRequestDetails,
} from './request'
import type { ArchitectureChangeView, ArchitectureSummary, Continuation, NoChangeView, RecommendationView } from './views'
import { prisma } from '@/lib/db'
import { quotedError, quotesKeptHere } from '@/lib/data-plane/residency'
import { projectRegion } from '@/lib/data-plane/regional'
import { servedHere } from '@/lib/data-plane/serving'
import { enqueueRegionalJob, REGIONAL_STATUS } from '@/lib/queue'
import { regionLabel, type CloudRegionId } from '@/lib/regions'
import { EVOLUTION_FINDING_TYPE } from '@/lib/core/types'
import './installed'

/**
 * A failure in the words a project's records at home may keep. For a project
 * kept in another region they are the platform's, never the database's, which
 * can quote its rows (lib/data-plane/residency.ts).
 */
async function failureWords(projectId: string, err: unknown): Promise<string> {
  return quotedError(err instanceof Error ? err.message : String(err), await quotesKeptHere(projectId))
}

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

/** May rungs run for this project: the deployment's switch, then the rollout's list? */
export function executionEnabled(projectId: string): { enabled: boolean; reason: string | null } {
  if (!FLAGS.ENABLE_EVOLUTION_MUTATIONS) {
    return {
      enabled: false,
      reason:
        'Architecture changes are switched off in this deployment (ENABLE_EVOLUTION_MUTATIONS). ' +
        'Backenly still proposes, rehearses and records them; nothing runs until an operator turns this on.',
    }
  }
  if (!evolutionAllowedFor(projectId)) {
    return {
      enabled: false,
      reason:
        'Architecture changes are rolling out a few projects at a time, and this project is not on the list yet (EVOLUTION_PROJECT_ALLOWLIST). ' +
        'Backenly still proposes, rehearses and records them; nothing runs until it is.',
    }
  }
  return { enabled: true, reason: null }
}

/**
 * Whether approved changes carry on by themselves for this project: the
 * deployment runs them, its scheduler takes them through the backfill,
 * observation and judging, and the project's autonomy is not OFF. A person is
 * asked to approve only a change that then finishes without them: anything
 * else would have them operate the engine by hand, step by step.
 */
export async function continuation(projectId: string): Promise<Continuation> {
  if (!FLAGS.ENABLE_EVOLUTION_MUTATIONS) {
    return { unattended: false, byHand: false, why: "Backenly isn't running architecture changes in this deployment right now." }
  }
  if (!evolutionAllowedFor(projectId)) {
    return { unattended: false, byHand: false, why: "Backenly isn't running architecture changes for this project right now." }
  }
  if (!FLAGS.ENABLE_EVOLUTION_SCHEDULER) {
    return { unattended: false, byHand: true, why: "This deployment doesn't carry architecture changes on by itself." }
  }
  if ((await getProjectAutonomyLevel(projectId)) === 'OFF') {
    return { unattended: false, byHand: true, why: 'Autonomy is off for this project, so Backenly does not carry changes on by itself.' }
  }
  return { unattended: true, byHand: true, why: null }
}

/** A sentence as a clause after a colon: "Autonomy is off…" → "autonomy is off…". Backenly keeps its capital. */
const asAfterColon = (s: string) => s.replace(/^(?!Backenly)[A-Z]/, c => c.toLowerCase())

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
  o: { sentence: string; milestone?: boolean; payload?: Record<string, unknown>; userId?: string | null; problem?: boolean },
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
    problem: o.problem,
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
  const snap = await primitive.snapshot(projectId, plan, phase, now).catch(async err => ({
    v: 1 as const,
    phase,
    at: now.toISOString(),
    data: {},
    unavailable: [{ metric: '*', reason: 'not_yet_measurable' as const, detail: await failureWords(projectId, err) }],
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
  await releaseAbandonedClaims(projectId)
  const runs = await continuation(projectId)
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
      if (!runs.unattended) {
        // Nobody is asked for a change that would then wait on them at every
        // step: until approved changes carry on here by themselves, it is said
        // like a recommendation, and a request already waiting is withdrawn.
        if (open?.state === 'awaiting_approval' && open.primitive === primitive.id) {
          await withdrawRequest(projectId, refOf(open), 'approved changes cannot carry on by themselves here right now')
        }
        recommendations.push({
          subject: opp.subject,
          concernKey: opp.concernKey,
          sentence: `A change to ${opp.subject} is ready, but Backenly is not asking for it: ${asAfterColon(runs.why ?? '')}`,
        })
        out.skipped.push({ concernKey: opp.concernKey, reason: `not asked: ${runs.why}` })
        continue
      }
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
      if (stillProposed.has(d.concernKey)) continue
      if (assessedSubjects.has(d.subject)) {
        await withdrawRequest(projectId, refOf(d), 'it is no longer proposed: the latest analysis of this table no longer supports it')
        continue
      }
      // Not assessed this pass: skipped for size, or gone. A table that was
      // dropped or renamed can never be approved, so its request goes too.
      const spec = primitive.normaliseSpec(d.spec)
      const resolved = spec ? await primitive.resolvePlan(projectId, spec) : { refusal: 'the request can no longer be read' }
      if ('refusal' in resolved) await withdrawRequest(projectId, refOf(d), `no plan can be built any more: ${resolved.refusal}`)
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
  try {
    return await prepareRequest(projectId, primitive, opp, now, plan, d, existing)
  } catch (err) {
    // Whatever stopped it part-way, the decision must not be left between
    // proposing and asking, where nothing would ever pick it up again: it is
    // stopped, and a later pass retries it like a failed rehearsal.
    const reason = `preparing it failed: ${await failureWords(projectId, err)}`
    await enter(projectId, d, 'blocked', {
      sentence: `Backenly could not finish preparing a change to ${opp.subject}, so it was not proposed.`,
      payload: { reason },
    }).catch(() => false)
    await resolveRequest(projectId, d.decisionId).catch(() => {})
    throw err
  }
}

async function prepareRequest(
  projectId: string,
  primitive: EvolutionPrimitive<any, any>,
  opp: Opportunity,
  now: Date,
  plan: EnginePlan,
  d: DecisionRef,
  existing: DecisionRef | undefined,
): Promise<RequestOutcome> {
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
    async (err): Promise<Rehearsal> => ({
      passed: false,
      authorization: 'unavailable',
      authorizationDetail: '',
      detail: `the rehearsal could not run: ${await failureWords(projectId, err)}`,
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
    else {
      await enter(projectId, d, 'blocked', {
        sentence: `The change to ${opp.subject} is not one software may run, so it was not proposed.`,
        payload: { reason: `software may not run it: ${requirement.reason}` },
      })
    }
    return `not runnable by software: ${requirement.reason}`
  }
  const summary = primitive.describe(plan, opp)
  const technical = technicalFor(plan, opp, await quotesKeptHere(projectId))
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

/**
 * The request's opt-in technical section. For a project kept in another region
 * the statements are not stored here: a person who opens them is shown them
 * rendered from the project's own tables (liveStatements), and consent binds to
 * the plan version that hashes them either way.
 */
function technicalFor(plan: EnginePlan, opp: Opportunity, quote: boolean): EvolutionRequestDetails['technical'] {
  const d = (opp.diagnostics ?? {}) as { clientMigration?: EvolutionRequestDetails['technical']['clientMigration'] }
  return {
    ...(quote ? {} : { sqlWithheld: true }),
    steps: plan.steps.map(s => ({ title: s.title, why: s.why, tier: s.tier, humanOnly: s.capability === 'human_only', sql: quote ? s.sql : [] })),
    evidence: opp.evidence.map(e => ({ family: e.family, verdict: e.verdict, detail: e.detail })),
    pressure: opp.pressure.map(p => ({ kind: p.kind, class: p.class, detail: p.detail })),
    semanticBoundary: opp.semanticBoundary,
    contractBlockers: plan.contractBlockers,
    caveats: plan.caveats,
    clientMigration: d.clientMigration ?? [],
  }
}

/** States between proposing a change and asking about it, held only while a pass works on it. */
const PREPARING: LifecycleState[] = ['proposed', 'rehearsing', 'rehearsed']

/** How long a decision may sit in a PREPARING state before it counts as abandoned. */
export const ABANDONED_AFTER_MS = 3_600_000

/** A waiting request whose plan moved, a rehearsal that failed a day ago, or a pass cut off part-way: try again. */
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
  // A pass that stopped between proposing and asking (a deploy, a timeout)
  // left the decision part-way; after an hour nothing is still working on it.
  const abandoned =
    !!open.state && PREPARING.includes(open.state) && now.getTime() - open.updatedAt.getTime() > ABANDONED_AFTER_MS
  let drifted = false
  if (open.state === 'awaiting_approval') {
    const resolved = await primitive.resolvePlan(projectId, opp.spec)
    // A plan that can no longer be built, or whose version moved, is
    // re-proposed — or withdrawn — by requestApproval.
    drifted = 'refusal' in resolved || resolved.plan.planVersion !== open.planVersion
  }
  if (!retryRehearsal && !drifted && !abandoned) return 'current'
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
  // A claim whose attempt died before deciding is taken over, not honoured.
  if (req.status !== 'pending_approval' && !(req.status === 'approving' && isClaimAbandoned(ev))) {
    return { ok: false, status: 409, error: 'This request was already decided.' }
  }
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
  const [busy] = await decisionsInFlight(projectId, ev.decisionId)
  if (busy) return { ok: false, status: 409, error: busy.words }

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
  // Consent and its record, under the build lock Backenly's own repairs take
  // (lib/ai/build-runtime/build-lock.ts): a repair of this table either ended
  // before consent read it, or finds the change approved and waits for it
  // (lib/evolution-engine/holds.ts). The lock is only tried, and taken without
  // a job, so approving spends no build budget and never takes over a long
  // repair; one running now is said, and the person approves again in a moment.
  const { whileBuildLockFree } = await import('@/lib/ai/build-runtime/build-lock')
  const locked = await whileBuildLockFree(projectId, async () => {
    const g = await primitive.grant({ projectId, spec, planVersion, approvedBy: userId, decisionId: ev.decisionId })
    if (!isConsentRefusal(g)) {
      await setRequestStatus(projectId, findingId, 'approved')
      await enter(projectId, d, 'approved', {
        sentence: `You approved: ${ev.summary.headline}.`,
        milestone: true,
        userId,
        payload: { findingId, spec: ev.spec, summary: ev.summary, approvalId: g.approvalId },
      })
    }
    return g
  }).catch(async err => {
    await setRequestStatus(projectId, findingId, 'pending_approval')
    throw err
  })
  if (!locked.ran) {
    await setRequestStatus(projectId, findingId, 'pending_approval')
    return { ok: false, status: 409, error: 'Backenly is changing this project right now (a repair or a build). Approve again in a few seconds.' }
  }
  const granted = locked.value
  if (isConsentRefusal(granted)) {
    await setRequestStatus(projectId, findingId, 'pending_approval')
    if (granted.currentPlanVersion && granted.currentPlanVersion !== planVersion) {
      // The table moved since this was rehearsed: rehearse the current version
      // and put that in front of the person instead, where the tables are.
      if (!(await servedHere(projectId))) {
        if (await pausedNow(projectId)) return { ok: false, status: 409, error: PAUSED }
        const region = await queueInItsRegion('evolution_rerequest', projectId, {
          decisionId: ev.decisionId,
          from: 'awaiting_approval',
          planVersion: ev.planVersion,
        })
        return {
          ok: false,
          status: 409,
          error: `The table changed since this was prepared. Backenly is checking it again in ${regionLabel(region)}, where this project's tables are; the updated change will be in your queue within a minute or two.`,
        }
      }
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

  const exec = executionEnabled(projectId)
  const runs = await continuation(projectId)
  // Requests are raised only where approved changes carry on by themselves;
  // a deployment or a dial that changed since is said, never papered over.
  if (!exec.enabled) return { ok: true, message: `Approved. ${runs.why} It starts when it can; your app works as before.`, state: 'approved' }
  // Consent is recorded whatever happens next; a failure to start is the
  // change's state to report, not the approval's.
  try {
    const advanced = await startWhereTheTablesAre({ projectId, decisionId: ev.decisionId, actor: userId })
    const byHand = runs.unattended ? '' : ` ${runs.why} Resume carries it on.`
    return { ok: true, message: `Approved. ${advanced.message}${byHand}`, state: advanced.state }
  } catch (err) {
    console.error('[evolution] advance after approval failed:', err)
    return { ok: true, message: 'Approved. It could not start just now; it will be retried, or you can resume it.', state: 'approved' }
  }
}

/**
 * Rehearse the change for the table as it is now and put that version in
 * front of the person, on the same decision. 'requested' when it was.
 */
async function reRequest(
  projectId: string,
  primitive: EvolutionPrimitive<any, any>,
  d: DecisionRef,
  about: { subject: string; concernKey: string },
  now: Date,
): Promise<RequestOutcome> {
  const assessment = await primitive.assess(projectId, { subjects: [about.subject], now })
  const opp = assessment.opportunities.find(o => o.concernKey === about.concernKey)
  if (!opp || opp.level !== 'executable_proposal') return 'no longer proposed'
  return requestApproval(projectId, primitive, opp, now, d)
}

/** The person said "not now" to an approval request. Remembered, and respected until something new is measured. */
export async function recordDecline(projectId: string, findingId: string, userId: string | null): Promise<void> {
  const req = await requestById(projectId, findingId)
  if (!req) return
  const ev = req.evolution
  if (ev.ask !== 'approve') return
  // Only a change still waiting for its approval can be declined: a stale tab
  // saying "not now" to one already approved and running declines nothing.
  const { summary, trail } = await decision(projectId, ev.decisionId)
  if (summary?.state !== 'awaiting_approval') return
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
      attempt: trail.filter(e => e.record.event === 'declined').length + 1,
    },
    milestone: true,
    sentence: `You declined: ${ev.summary.headline}. Backenly won't ask again unless something new is measured.`,
    userId,
  })
}

/**
 * A person set a waiting request aside from the queue (POST /architecture
 * { action: 'dismiss' }, the same role floor as approving).
 *
 * For an approval that is a decline, and Backenly remembers it: the change is
 * not asked for again unless something new is measured. For a change that
 * stopped, nothing about the change moves: it stays exactly as it is, and the
 * decision leaves the queue for the Architecture changes card, which still
 * offers what it did.
 */
export async function dismissRequest(input: { projectId: string; findingId: string; userId: string }): Promise<ActionResult> {
  const { projectId, findingId, userId } = input
  const req = await requestById(projectId, findingId)
  if (!req) return { ok: false, status: 404, error: 'No such request in this project.' }
  const moved: ActionResult = { ok: false, status: 409, error: 'This change was already decided. Refresh to see where it is now.' }
  if (req.status !== 'pending_approval') return moved
  const ev = req.evolution
  // A request being checked again is decided on once its updated version is in front of the person.
  const checking = (await decisionsInFlight(projectId, ev.decisionId)).find(j => j.type === 'evolution_rerequest')
  if (checking) return { ok: false, status: 409, error: checking.words }
  const { summary } = await decision(projectId, ev.decisionId)
  if (ev.ask === 'approve') {
    // Only a change still waiting for its approval can be declined: a stale
    // tab must not set aside a change someone already approved, which runs.
    if (summary?.state !== 'awaiting_approval') return moved
    const set = await prisma.healthFinding.updateMany({
      where: { id: findingId, projectId, status: 'pending_approval' },
      data: { status: 'dismissed', details: { evolution: ev, dismissedAt: new Date().toISOString() } as object },
    })
    if (set.count === 0) return moved
    await recordDecline(projectId, findingId, userId)
    return { ok: true, message: "Declined. Backenly won't ask again unless something new is measured.", state: summary.state }
  }
  const set = await prisma.healthFinding.updateMany({
    where: { id: findingId, projectId, status: 'pending_approval' },
    data: { status: 'approved', details: { evolution: { ...ev, ask: 'approve', stoppedBecause: undefined } } as object },
  })
  if (set.count === 0) return moved
  return {
    ok: true,
    message: 'Set aside. The change stays exactly as it is; you can still decide on it under Architecture changes.',
    state: summary?.state ?? null,
  }
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
  const exec = executionEnabled(projectId)

  // The end of "before": captured once, immediately before the first rung
  // that could change anything.
  if (summary.state === 'approved' && !snapshotsOf(trail).some(s => s.phase === 'S0') && exec.enabled) {
    const spec = primitive.normaliseSpec(summary.spec)
    const resolved = spec ? await primitive.resolvePlan(projectId, spec) : null
    if (resolved && !('refusal' in resolved)) await snapshot(projectId, d, primitive, resolved.plan, 'S0', now)
  }

  const outcome = await primitive.execute(projectId, summary.planId, { mutationsEnabled: exec.enabled })
  const subject = summary.subject

  // A person may have paused (or undone) the change while it ran. Their
  // decision stands: what this run reached is not walked over it, and their
  // own pause is not put back in front of them as a stop to decide on.
  const latest = (await decision(projectId, decisionId)).summary
  if (latest?.state && latest.state !== summary.state && !ADVANCEABLE.includes(latest.state)) {
    return { state: latest.state, message: `The change is ${userFacingStatus(latest.state).label.toLowerCase()}.`, outcome }
  }
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
    // "After" starts when the last rung finished, not when this pass began.
    const doneAt = input.now ?? new Date()
    await walkTo(projectId, d, 'cutover', traceFor)
    const s = summaryOf(trail)
    const hours = policy.observationHours
    const watched = (await continuation(projectId)).unattended
    await enter(projectId, d, 'observing', {
      sentence:
        `Backenly ${s?.did ?? `changed ${subject}`}. Existing apps keep working; ` +
        (watched
          ? `it is being watched for ${hours} hours before it counts as done.`
          : 'Backenly is not watching changes in this deployment, so it cannot yet say whether this one helped.'),
      milestone: true,
      payload: { cutoverAt: doneAt.toISOString() },
    })
    const spec = primitive.normaliseSpec(summary.spec)
    const resolved = spec ? await primitive.resolvePlan(projectId, spec) : null
    if (resolved && !('refusal' in resolved)) await snapshot(projectId, d, primitive, resolved.plan, 'S1', doneAt)
    return { state: 'observing', message: `The change is in place${watched ? ` and being watched for ${hours} hours` : ''}.`, outcome }
  }

  if (outcome.status === 'awaiting_background_work') {
    if (furthest) await walkTo(projectId, d, furthest, traceFor)
    return { state: furthest ?? summary.state, message: 'The change is in progress; existing data is being copied in the background.', outcome }
  }

  // halted or refused
  if (outcome.stoppedBecause === 'mutations_disabled') {
    if (furthest) await walkTo(projectId, d, furthest, traceFor)
    return { state: furthest ?? summary.state, message: "Backenly isn't running architecture changes in this deployment right now; nothing ran.", outcome }
  }
  const failedStep = outcome.steps.find(s => s.status === 'failed')
  if (furthest) await walkTo(projectId, d, furthest, traceFor)
  // In the words a person reads; the executor's own account stays in the payload.
  const reason = plainReason(outcome, summaryOf(trail))
  const failed = outcome.stoppedBecause === 'rung_failed' && failedStep?.stage !== 'rehearsal'
  const target: LifecycleState = failed ? 'failed' : 'blocked'
  await enter(projectId, d, target, {
    sentence: failed
      ? `The change to ${subject} stopped: ${reason}. Your app works as before; you can resume or undo it.`
      : `Backenly paused the change to ${subject}: ${reason}. Your app works as before.`,
    milestone: true,
    problem: failed || outcome.stoppedBecause === 'verification',
    payload: { reason, stoppedBecause: outcome.stoppedBecause, haltReason: outcome.haltReason },
  })
  // A pause the person asked for is theirs to lift from the changes list; any
  // other stop is put back in front of them.
  if (outcome.stoppedBecause !== 'consent' || !summary.withdrawn) {
    await askToResumeOrUndo(projectId, d, reason, 'resume_or_undo')
  }
  return { state: target, message: `The change stopped: ${reason}.`, outcome }
}

/**
 * Run what was approved where the project's tables are: what a person's
 * approve, resume or advance calls, rather than `advance` itself.
 *
 * A project of the region this process serves runs now, in this call. One kept
 * in another region is started by that region's own worker, as an
 * `evolution_advance` job it claims within a minute (lib/queue,
 * processRegionalJobs). Its rungs read and write the region's database one
 * statement at a time, and across regions each statement is a round trip: on
 * staging the rehearsal took 1.3 s in its own region and over a minute from the
 * home one, past the load balancer's 60 s, so the person approving saw a
 * timeout and the change stopped at its first step. A start that finds another
 * change running on the project is tried again (lib/queue/worker.ts); should
 * it still not run, the region's scheduler resumes the change on its next pass
 * (sweepArchitecture).
 *
 * What `advance` would answer at once (no such change, nothing to run, nothing
 * runs in this deployment) is answered here, and queues nothing.
 */
export async function startWhereTheTablesAre(input: { projectId: string; decisionId: string; actor?: string | null }): Promise<AdvanceResult> {
  const { projectId, decisionId } = input
  if (await servedHere(projectId)) return advance(input)
  const { summary } = await decision(projectId, decisionId)
  if (!summary?.state) return { state: null, message: 'No such change.' }
  if (!ADVANCEABLE.includes(summary.state)) {
    return { state: summary.state, message: `Nothing to run: the change is ${userFacingStatus(summary.state).label.toLowerCase()}.` }
  }
  if (!executionEnabled(projectId).enabled) {
    return { state: summary.state, message: "Backenly isn't running architecture changes in this deployment right now; nothing ran." }
  }
  if (await pausedNow(projectId)) return { state: summary.state, message: PAUSED }
  // A start still waiting carries whatever the change is when it runs, and is
  // found by the queue below; anything else in flight is finished first.
  const busy = (await decisionsInFlight(projectId, decisionId)).find(j => !(j.type === 'evolution_advance' && j.waiting))
  if (busy) return { state: summary.state, message: busy.words }
  const region = await queueInItsRegion('evolution_advance', projectId, { decisionId, actor: input.actor ?? null }, { maxAttempts: 5 })
  return { state: summary.state, message: `It runs in ${regionLabel(region)}, where this project's tables are, starting within a minute.` }
}

/**
 * The table changed since the person was asked: rehearse the change for the
 * table as it is now and put that version in front of them (`reRequest`), run
 * by the worker of the region a project is kept in, as an
 * `evolution_rerequest` job, for the reason `startWhereTheTablesAre` gives: a
 * rehearsal sends some 700 statements to the region's database. A stopped
 * change that no longer fits its table is said where the person reads it, as
 * `resume` says it when it runs here.
 */
export async function reRequestDecision(
  projectId: string,
  decisionId: string,
  queuedAgainst: { from?: string; planVersion?: string } = {},
): Promise<{ state: LifecycleState | null; outcome: RequestOutcome }> {
  const { summary } = await decision(projectId, decisionId)
  const primitive = summary ? primitiveById(summary.primitive) : null
  if (!summary || !primitive) return { state: summary?.state ?? null, outcome: 'no such change' }
  // Only the change as it was when the person was told it is checked again;
  // one that moved on since (declined, approved, undone) is left as it is.
  const moved =
    summary.declined ||
    (queuedAgainst.from !== undefined && summary.state !== queuedAgainst.from) ||
    (queuedAgainst.planVersion !== undefined && summary.planVersion !== queuedAgainst.planVersion)
  if (moved) return { state: summary.state, outcome: 'moved on' }
  const d = refOf(summary)
  const outcome = await reRequest(projectId, primitive, d, summary, new Date())
  if (outcome === 'no longer proposed' && summary.state === 'awaiting_approval') {
    // Left waiting, its version could never be approved again.
    await withdrawRequest(projectId, d, 'it is no longer proposed: the latest analysis of this table no longer supports it')
  } else if (outcome === 'rehearsal_failed' && summary.state === 'awaiting_approval') {
    // requestApproval set the request aside with a trace; the person was told an updated version was coming.
    const sentence = `Backenly checked the change to ${summary.subject} again for the table as it is now. It did not pass its rehearsal, so Backenly is not asking for it; nothing was changed.`
    await remember({ projectId, record: { ...base(d), event: 'noted', payload: { note: sentence } }, milestone: true, sentence })
  } else if (outcome !== 'requested' && (summary.state === 'blocked' || summary.state === 'failed')) {
    await remember({ projectId, record: { ...base(d), event: 'noted', payload: { note: NO_LONGER_FITS } }, milestone: true, sentence: NO_LONGER_FITS })
  }
  return { state: (await decision(projectId, decisionId)).summary?.state ?? null, outcome }
}

const NO_LONGER_FITS =
  'The table changed since you approved this, and the change no longer fits it as it is now. Undo removes what was done so far; nothing else runs.'

const PART_BUILT =
  'The table changed since you approved this, and part of the change is already in place for the table as it was. Undo removes it; your app works as before.'

/**
 * Whether any run of this change started a step that changes the schema or the
 * data, read from the ladder's own record (maintenance_step_executions, kept
 * at home) for every plan the decision had. Not the lifecycle trail: a run
 * paused or killed mid-rung records the states it reached only after the rung
 * returns. A step that started and failed counts too; undo finds out what is
 * there.
 */
async function builtAnything(projectId: string, trail: MemoryEntry[]): Promise<boolean> {
  const planIds = [...new Set(trail.map(e => e.record.planId).filter((p): p is string => typeof p === 'string' && p.length > 0 && p !== '*'))]
  // Only this decision's own runs: an extraction's plan id is shared by every
  // decision about it, and an earlier one, already undone, left its steps behind.
  const approvedAt = trail.find(e => e.record.event === 'transition' && e.record.state === 'approved')?.at
  if (planIds.length === 0 || !approvedAt) return false
  const step = await prisma.maintenanceStepExecution.findFirst({
    where: {
      execution: { projectId, planId: { in: planIds }, createdAt: { gte: approvedAt } },
      stepKind: { notIn: ['rehearse', 'verify'] },
      // Started, however it went on (running, completed, dispatched, failed).
      status: { notIn: ['pending', 'skipped'] },
    },
    select: { id: true },
  })
  return step !== null
}

/**
 * Look for changes now, where the project's tables are: what the route's
 * `assess` calls. A proposal's rehearsal sends some 700 statements to the
 * region's database; a project kept in another region is assessed by that
 * region's worker, as an `evolution_assess` job (its scheduler also looks
 * every day).
 */
export async function proposeWhereTheTablesAre(projectId: string): Promise<ProposalPassResult & { message?: string }> {
  if (await servedHere(projectId)) return proposeChanges(projectId)
  const none: ProposalPassResult = { assessed: 0, requested: 0, refreshed: 0, rehearsalFailed: 0, skipped: [] }
  if (await pausedNow(projectId)) return { ...none, message: PAUSED }
  const region = await queueInItsRegion('evolution_assess', projectId, {})
  return { ...none, message: `It runs in ${regionLabel(region)}, where this project's tables are, starting within a minute.` }
}

/**
 * Undo where the project's tables are: what a person's undo calls, rather than
 * `undo` itself, for the reason `startWhereTheTablesAre` gives. An undo sends
 * some 160 statements to the region's database (counted on the regional spec's
 * project), which from the home region is half a minute to over a minute, at
 * or past the load balancer's 60 s.
 *
 * What home can tell at once is refused here, as `undo` would refuse it. The
 * rest, and the record of how it went, is `undo`'s own, run by the region's
 * worker as an `evolution_undo` job; one that finds another change running on
 * the project is tried again rather than handed back to the person.
 */
export async function undoWhereTheTablesAre(input: { projectId: string; decisionId: string; userId: string }): Promise<ActionResult> {
  const { projectId, decisionId, userId } = input
  if (await servedHere(projectId)) return undo(input)
  const { summary } = await decision(projectId, decisionId)
  if (!summary?.state) return { ok: false, status: 404, error: 'No such change.' }
  if (!canUndoFrom(summary.state)) return { ok: false, status: 409, error: 'There is nothing to undo for this change.' }
  if (await pausedNow(projectId)) return { ok: false, status: 409, error: PAUSED }
  // A start in flight runs first and the undo after it; a check again, or an
  // undo already asked for, is finished first.
  const busy = (await decisionsInFlight(projectId, decisionId)).find(j => j.type !== 'evolution_advance')
  if (busy) return { ok: false, status: 409, error: busy.words }
  const region = await queueInItsRegion('evolution_undo', projectId, { decisionId, userId }, { maxAttempts: 5 })
  return { ok: true, state: summary.state, message: `Undo runs in ${regionLabel(region)}, where this project's tables are, starting within a minute.` }
}

/**
 * A person's decisions about this change still waiting for, or running in, the
 * region its project is kept in (queueInItsRegion), newest first, each with
 * the words that refuse the next decision while it is in flight: one is
 * carried out before another is taken, as when they run here, so a later
 * choice is never overtaken by an earlier one still queued. Pause, a stop, is
 * never refused; a queued start or undo finds the change paused.
 */
async function decisionsInFlight(projectId: string, decisionId: string): Promise<Array<{ type: string; waiting: boolean; words: string }>> {
  const jobs = await prisma.backgroundJob.findMany({
    where: {
      projectId,
      type: { in: ['evolution_advance', 'evolution_undo', 'evolution_rerequest'] },
      status: { in: [REGIONAL_STATUS.pending, REGIONAL_STATUS.running] },
      payload: { path: ['decisionId'], equals: decisionId },
    },
    orderBy: { createdAt: 'desc' },
    select: { type: true, status: true, payload: true },
  })
  if (jobs.length === 0) return []
  // A paused project's jobs wait for it (lib/queue, REGIONAL_WRITES_HELD_WHILE_PAUSED).
  const when = (await pausedNow(projectId)) ? 'once this project is resumed' : 'within a minute or two'
  return jobs.map(j => {
    const where = `${regionLabel((j.payload as { region: CloudRegionId }).region)}, where this project's tables are`
    const words =
      j.type === 'evolution_rerequest'
        ? `Backenly is checking this change again in ${where}; the updated version will be in your queue ${when}.`
        : j.type === 'evolution_undo'
          ? `Backenly is undoing this change in ${where}. Decide again once it is done, ${when}.`
          : `Backenly is starting this change in ${where}. Decide again once it has started, ${when}.`
    return { type: j.type, waiting: j.status === REGIONAL_STATUS.pending, words }
  })
}

/** Whether the project is paused: its database waits for it, and so does what runs against its tables. */
async function pausedNow(projectId: string): Promise<boolean> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { pausedAt: true } }).catch(() => null)
  return !!p?.pausedAt
}

const PAUSED = "This project is paused, so nothing runs against its tables until it is resumed. Your app's data is as it was."

/**
 * Queue a person's decision for the region its project is kept in, once: while
 * one for the same change (or, with no change named, the same project) waits
 * to be claimed, another press finds it and adds none. One already running
 * does not count: it read the change before this press, which may have moved
 * it since (a resume after a pause), so the press gets a run of its own.
 * Returns the region.
 */
async function queueInItsRegion(
  type: 'evolution_advance' | 'evolution_undo' | 'evolution_rerequest' | 'evolution_assess',
  projectId: string,
  payload: { decisionId?: string } & Record<string, unknown>,
  options: { maxAttempts?: number } = {},
): Promise<CloudRegionId> {
  const region = await projectRegion(projectId)
  const queued = await prisma.backgroundJob.findFirst({
    where: {
      type,
      projectId,
      status: REGIONAL_STATUS.pending,
      ...(payload.decisionId ? { payload: { path: ['decisionId'], equals: payload.decisionId } } : {}),
    },
    select: { id: true },
  })
  if (!queued) await enqueueRegionalJob(type, projectId, region, payload, options)
  return region
}

/**
 * Why a run stopped, as a clause a person reads. A failed step is told by what
 * its stage was doing, in the primitive's words (`stages`), never by its
 * internal name, a job id or the database's message: those stay in the
 * decision's history.
 */
function plainReason(outcome: ExecutionOutcome, words: UserFacingSummary | null): string {
  switch (outcome.stoppedBecause) {
    case 'consent':
      return 'its approval is no longer in place'
    case 'drift':
      return 'the table changed after the change was approved, so the approved version no longer matches'
    case 'capability':
      return 'part of it cannot run in this deployment'
    case 'verification':
      return 'the old and new shapes did not match when checked, so nothing more was opened'
    case 'rung_failed': {
      const step = outcome.steps.find(s => s.status === 'failed')
      const doing = step ? words?.stages?.[step.stage] : undefined
      return doing ? `${doing} did not finish` : 'one of its steps did not finish'
    }
    default:
      return 'it stopped before it finished'
  }
}

async function askToResumeOrUndo(projectId: string, d: DecisionRef, reason: string, ask: 'resume_or_undo' | 'keep_or_undo'): Promise<void> {
  const req = await requestForDecision(projectId, d.decisionId)
  if (!req) return
  await raiseRequest(projectId, { ...req.evolution, ask, stoppedBecause: reason })
}

// ── Pause, resume, undo ──────────────────────────────────────────────────────

export type ActionResult =
  | { ok: true; message: string; state: LifecycleState | null }
  // `busy`: refused only because another change was running on the project; nothing was touched.
  | { ok: false; status: 404 | 409; error: string; busy?: true }

export const isActionRefusal = (r: ActionResult): r is Extract<ActionResult, { ok: false }> => !r.ok

export async function pause(input: { projectId: string; decisionId: string; userId: string }): Promise<ActionResult> {
  const { projectId, decisionId, userId } = input
  const { summary, trail } = await decision(projectId, decisionId)
  if (!summary?.state) return { ok: false, status: 404, error: 'No such change.' }
  if (!ADVANCEABLE.includes(summary.state)) return { ok: false, status: 409, error: 'Only a change that is still being applied can be paused.' }
  const primitive = primitiveById(summary.primitive)
  if (!primitive) return { ok: false, status: 409, error: 'Unknown change type.' }
  const w = await primitive.withdraw({ projectId, planId: summary.planId, by: userId })
  if (!w.ok) return { ok: false, status: 409, error: w.detail }
  const d = refOf(summary)
  await remember({
    projectId,
    // Each pause is its own event: a second pause after a resume is recorded too.
    record: { ...base(d), event: 'withdrawn', attempt: trail.filter(e => e.record.event === 'withdrawn').length + 1 },
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
  // Resuming continues what a person approved; it is never a way to approve.
  // A change nobody approved goes through the queue, rehearsed and shown first.
  if (!summary.everApproved) {
    return { ok: false, status: 409, error: 'This change was never approved, so there is nothing to resume. Approve it from the queue when Backenly proposes it.' }
  }
  if (summary.undoIncomplete) {
    return { ok: false, status: 409, error: 'Part of this change was already undone, so it cannot carry on as approved. Undo it to finish.' }
  }
  // A start still waiting carries the resumed change; anything else in flight is finished first.
  const busy = (await decisionsInFlight(projectId, decisionId)).find(j => !(j.type === 'evolution_advance' && j.waiting))
  if (busy) return { ok: false, status: 409, error: busy.words }
  const d = refOf(summary)

  // A change regressed in observation, kept on purpose: watching resumes.
  const stoppedIn = lastActiveState(trail)
  const runs = await continuation(projectId)
  if (summary.state === 'blocked' && stoppedIn === 'observing') {
    await enter(projectId, d, 'observing', {
      sentence: runs.unattended
        ? `You kept the change to ${summary.subject}; Backenly is watching it again.`
        : `You kept the change to ${summary.subject}.`,
      milestone: true,
      userId,
    })
    await clearQueue(projectId, decisionId)
    return { ok: true, message: runs.unattended ? 'Kept. Backenly watches it again from now.' : `Kept. ${runs.why}`, state: 'observing' }
  }
  if (!['blocked', 'failed', ...ADVANCEABLE].includes(summary.state)) {
    return { ok: false, status: 409, error: 'This change is not stopped.' }
  }
  // Never "Resumed." when nothing can run: consent stays as it was.
  if (!executionEnabled(projectId).enabled) {
    return {
      ok: false,
      status: 409,
      error: `${runs.why?.replace(/\.$/, '') ?? "Backenly isn't running architecture changes right now"}, so this one can't carry on yet. Your app works as before, and undo is still available.`,
    }
  }

  // Consent must be live for the exact version, rebuilt from the live system.
  if (summary.state === 'blocked' || summary.state === 'failed') {
    const spec = primitive.normaliseSpec(summary.spec)
    if (!spec || !summary.planVersion) return { ok: false, status: 409, error: 'This change cannot be resumed; undo it instead.' }
    const granted = await primitive.grant({ projectId, spec, planVersion: summary.planVersion, approvedBy: userId, decisionId })
    if (isConsentRefusal(granted)) {
      if (!granted.currentPlanVersion) return { ok: false, status: 409, error: `It cannot resume: ${granted.refusal}` }
      // The table changed since the approval: what was approved no longer
      // exists. A change that already built part of itself (its new table, its
      // syncs) is not asked about again over those: asked, it would wait for
      // approval with them in place, where nothing undoes them. Undo removes
      // them. One that built nothing is rehearsed for the table as it is now
      // and asked about again, on the same decision; the queue shows the new
      // version.
      if ((stoppedIn && stoppedIn !== 'approved') || (await builtAnything(projectId, trail))) return { ok: false, status: 409, error: PART_BUILT }
      if (!(await servedHere(projectId))) {
        if (await pausedNow(projectId)) return { ok: false, status: 409, error: PAUSED }
        const region = await queueInItsRegion('evolution_rerequest', projectId, { decisionId, from: summary.state, planVersion: summary.planVersion })
        return {
          ok: true,
          message:
            `The table changed since you approved this, so Backenly is checking the change again in ${regionLabel(region)}, ` +
            "where this project's tables are. The updated version will be in your queue to review within a minute or two.",
          state: summary.state,
        }
      }
      const again = await reRequest(projectId, primitive, d, summary, new Date())
      if (again === 'requested') {
        return {
          ok: true,
          message: 'The table changed since you approved this, so Backenly checked the change again against the table as it is now. Review and approve the updated version in your queue.',
          state: 'awaiting_approval',
        }
      }
      return { ok: false, status: 409, error: NO_LONGER_FITS }
    }
    const back = stoppedIn && ADVANCEABLE.includes(stoppedIn) ? stoppedIn : 'approved'
    await enter(projectId, d, back, { sentence: `You resumed the change to ${summary.subject}.`, milestone: true, userId })
  }
  await clearQueue(projectId, decisionId)
  const r = await startWhereTheTablesAre({ projectId, decisionId, actor: userId })
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
  if (req && req.status === 'pending_approval' && req.evolution.ask !== 'approve') {
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
  const before = summary.state

  // Claimed before anything is touched: an observation pass that lands while
  // the change is being removed must find it being undone, not "removed
  // outside Backenly".
  await enter(projectId, d, 'rolling_back', { sentence: `Undoing the change to ${summary.subject}.`, userId })
  const result: RollbackResult = await primitive.rollback(projectId, summary.planId, userId).catch(async err => ({
    status: 'failed' as const,
    reason: await failureWords(projectId, err),
    // Not known what ran before it threw: treated as part-way, so only undo
    // (which re-reads the catalog and skips what is already gone) is offered.
    actions: [{ action: 'unknown', outcome: 'done' as const, detail: 'the undo stopped part-way' }],
  }))

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
  const removed = result.actions.filter(a => a.outcome === 'done' && a.action !== 'withdraw_consent')
  if (removed.length === 0) {
    // Refused, or stopped at its first step: nothing was touched, so the
    // change is exactly where it was.
    const busy = result.status === 'in_flight_elsewhere'
    await enter(projectId, d, before, {
      sentence: busy
        ? `The undo of the change to ${summary.subject} waited: another change was running.`
        : `Backenly did not undo the change to ${summary.subject}: ${reason}. Nothing was removed; it is as it was.`,
      milestone: !busy,
      userId,
      payload: { reason: summary.stoppedBecause, undoRefused: reason },
    })
    return busy
      ? { ok: false, status: 409, error: 'Another change is running on this project. Try again in a minute.', busy: true }
      : { ok: false, status: 409, error: `Not undone, and nothing was removed: ${reason}.` }
  }

  // Part of it was removed before a step failed. Saying "nothing was removed"
  // would be false, and resuming would carry on with parts missing: only
  // undo, which skips what is already gone, is offered.
  await enter(projectId, d, 'blocked', {
    sentence:
      `Backenly could not finish undoing the change to ${summary.subject}: ${reason}. ` +
      `It had already done this: ${removed.map(a => a.detail).join('; ')}. Undo it again to finish once that is fixed.`,
    milestone: true,
    problem: true,
    userId,
    payload: { reason, rollback: result, undoIncomplete: true },
  })
  const req = await requestForDecision(projectId, decisionId)
  if (req && req.status === 'pending_approval') await setRequestStatus(projectId, req.findingId, 'resolved')
  return { ok: false, status: 409, error: `Undone only part-way: ${reason}. Undo it again to finish once that is fixed.` }
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
  // The current watch: from cutover, or from when a person kept the change
  // after a stop. A pass from before that decision no longer judges it.
  const since = summary.observingSince ?? summary.cutoverAt
  const signals =
    'refusal' in resolved
      ? [{ name: CONSISTENCY_SIGNAL, status: 'regressed' as const, detail: resolved.refusal }]
      : await primitive.observe(projectId, resolved.plan, { since, now })
  await remember({
    projectId,
    record: { ...base(d), event: 'observed', payload: { signals } },
    milestone: false,
    sentence: signals.map(s => `${s.name}: ${s.status}`).join(', '),
  })
  const passes = [...passesSince(trail, since), { at: now.toISOString(), signals }]
  const verdict = observationVerdict({ passes, cutoverAt: since, now, policy })
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
  const judged = await judge(projectId, primitive, resolved.plan, decisionId, now, since)
  if ('error' in judged) {
    // Not called done on numbers nobody could read: the watch goes on.
    await note(projectId, d, `the outcome could not be measured: ${judged.error}`)
    return { state: 'observing', verdict: 'continue', reason: 'the outcome could not be measured yet; it is tried again on the next pass' }
  }
  const benefit = judged.benefit
  if (benefit.verdict === 'regressed') {
    await remember({ projectId, record: { ...base(d), event: 'outcome', payload: { benefit, phase: 'S2' } }, milestone: false, sentence: benefit.summary })
    await stopForRegression(projectId, d, summary.subject, asClause(benefit.plain), policy, input)
    return { state: 'blocked', verdict: 'regressed', reason: benefit.summary, benefit }
  }
  const s = summaryOf(trail)
  const lead =
    benefit.verdict === 'beneficial'
      ? `Backenly improved your ${s?.subjectTitle ?? summary.subject} architecture: it ${s?.did ?? 'restructured it'}.`
      : `Backenly ${s?.did ?? `restructured ${summary.subject}`}.`
  // Plain: the numbers are in the outcome record, for whoever opens the details.
  const outcome = benefit.plain
  const later = benefit.verdict === 'beneficial' ? '' : ' Backenly will look again a month after the change.'
  // "Existing apps kept working" only where their traffic was compared and held.
  const held =
    benefit.safety === 'held'
      ? 'Existing apps kept working, the data matches, and it can be undone.'
      : 'Nothing failed while it was watched, the data matches, and it can be undone.'
  await enter(projectId, d, 'stable', {
    sentence: `${lead} ${held}${outcome ? ` ${outcome}` : ''}${later}`,
    milestone: true,
  })
  await remember({ projectId, record: { ...base(d), event: 'outcome', payload: { benefit, phase: 'S2' } }, milestone: false, sentence: benefit.summary })
  const req = await requestForDecision(projectId, decisionId)
  if (req) await setRequestStatus(projectId, req.findingId, 'resolved')
  return { state: 'stable', verdict: 'stable', reason: verdict.reason, benefit }
}

/** "It made things worse: requests got slower." → "requests got slower", to sit inside a sentence. */
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
    problem: true,
    payload: { reason, verdict: 'regressed' },
  })
  if (shouldAutoRollback(policy, true)) {
    const r = await undo({ projectId, decisionId: input.decisionId, userId: AUTOMATIC_REQUESTER, automatic: true })
    if (r.ok) return
  }
  // It was already in place: nothing is left to resume, only to keep or undo.
  await askToResumeOrUndo(projectId, d, reason, 'keep_or_undo')
}

type Judged = { benefit: BenefitReport } | { error: string }

async function judge(
  projectId: string,
  primitive: EvolutionPrimitive<any, any>,
  plan: EnginePlan,
  decisionId: string,
  now: Date,
  /** The start of the current watch; passes before it were already decided on. */
  since: Date,
  /** Correctness checked just now, instead of as the last observation pass found it. */
  correctness?: CorrectnessChecks['correctness'],
): Promise<Judged> {
  const { trail } = await decision(projectId, decisionId)
  const snapshots = snapshotsOf(trail)
  let measurements: Measurement[]
  try {
    measurements = await primitive.measure(projectId, plan, snapshots, { firedBy: firedByOf(trail), now })
  } catch (err) {
    // Never "nothing was measured": that would read as too early to say, and
    // the change would be called done on numbers nobody looked at.
    return { error: await failureWords(projectId, err) }
  }
  const passes = passesSince(trail, since)
  const lastConsistency = [...passes].reverse().flatMap(p => p.signals).find(s => s.name === CONSISTENCY_SIGNAL)
  const rehearsed = trail
    .map(e => ((e.record.payload ?? {}) as { rehearsal?: { authorization?: string } }).rehearsal)
    .filter(Boolean)
    .pop()
  const benefit = assessBenefit(
    {
      correctness:
        correctness ?? (lastConsistency?.status === 'ok' ? 'pass' : lastConsistency?.status === 'regressed' ? 'fail' : 'not_run'),
      compatibility: passes.some(p => p.signals.some(s => s.status === 'regressed')) ? 'fail' : 'pass',
      authorization: rehearsed?.authorization === 'passed' ? 'pass' : rehearsed?.authorization === 'failed' ? 'fail' : 'not_run',
    },
    measurements,
  )
  return { benefit }
}

/** A trace the engine keeps for itself: what it could not do, and will try again. */
async function note(projectId: string, d: DecisionRef, text: string): Promise<void> {
  await remember({ projectId, record: { ...base(d), event: 'noted', payload: { note: text } }, milestone: false, sentence: text })
}

function passesSince(trail: MemoryEntry[], since: Date): ReturnType<typeof passesOf> {
  return passesOf(trail).filter(p => new Date(p.at).getTime() >= since.getTime())
}

/**
 * Benefits that take weeks to show are re-judged 30 and 90 days after cutover,
 * with the data reconciled again then rather than as it was when the change
 * was called done. A regression found then stops the change for a person, as
 * one found while it was watched does; a verdict that leaves "beneficial" is
 * said where the person reads it, so nothing keeps saying it helped.
 */
async function longHorizon(projectId: string, d: DecisionSummary, now: Date, policy: EvolutionPolicy): Promise<void> {
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
  const correctness = await primitive.verify(projectId, resolved.plan).then(
    v => (v.consistent ? ('pass' as const) : ('fail' as const)),
    () => 'not_run' as const,
  )
  const judged = await judge(projectId, primitive, resolved.plan, d.decisionId, now, d.observingSince ?? d.cutoverAt, correctness)
  if ('error' in judged) {
    await note(projectId, ref, `the outcome could not be measured ${due === 'L30' ? 'a month' : 'three months'} on: ${judged.error}`)
    return
  }
  const benefit = judged.benefit
  const when = due === 'L30' ? 'A month' : 'Three months'
  const previous = d.outcome?.verdict
  if (benefit.verdict === 'regressed') {
    await remember({ projectId, record: { ...base(ref), event: 'outcome', payload: { benefit, phase: due } }, milestone: false, sentence: benefit.summary })
    await stopForRegression(projectId, ref, d.subject, asClause(benefit.plain), policy, { projectId, decisionId: d.decisionId })
    return
  }
  const changed = benefit.verdict !== previous
  const shown = changed && (benefit.verdict === 'beneficial' || previous === 'beneficial')
  await remember({
    projectId,
    record: { ...base(ref), event: 'outcome', payload: { benefit, phase: due } },
    milestone: shown,
    sentence: !shown
      ? benefit.summary
      : benefit.verdict === 'beneficial'
        ? `${when} on, the change to ${d.subject} has paid off. ${benefit.plain}`
        : `${when} on, Backenly can no longer show that the change to ${d.subject} helped.` +
          (benefit.verdict === 'insufficient_evidence' ? '' : ` ${benefit.plain}`),
  })
}

/** The 30- and 90-day look at one change that is done, when it is due. For the sweep, and for tests. */
export async function lookAgain(input: { projectId: string; decisionId: string; now?: Date; policy?: EvolutionPolicy }): Promise<void> {
  const d = (await decision(input.projectId, input.decisionId)).summary
  if (d) await longHorizon(input.projectId, d, input.now ?? new Date(), input.policy ?? DEFAULT_POLICY)
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
  /** An approved change was due to continue and the project is mid-incident. */
  frozen?: boolean
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
  for (const d of decisions.filter(x => x.state === 'stable')) await longHorizon(projectId, d, now, input.policy ?? DEFAULT_POLICY)

  // Outside the rollout's list, what already ran is still watched (above,
  // reads only), but nothing is carried on and nothing new is looked for.
  if (!evolutionAllowedFor(projectId)) return { projectId, disposition: 'swept', observed, advanced }

  const exec = executionEnabled(projectId)
  const resumable = decisions.filter(x => x.state && ADVANCEABLE.includes(x.state))
  let frozen = false
  if (
    resumable.length > 0 &&
    mayResumeUnattended({ consented: true, mutationsEnabled: exec.enabled, schedulerEnabled: true, autonomyOff })
  ) {
    // Mid-incident, nothing autonomous changes the project: the change waits
    // where it is, consistent at every step, for a pass after the incident. A
    // backfill already queued finishes its batches, which never wait on a
    // writer; a person's pause stops it at its cursor.
    frozen = await heldForIncident(projectId, { loop: 'maintenance', via: 'architecture_evolution', wouldHaveApplied: 1 })
    if (!frozen) {
      // One change per pass: a change rewrites the catalog the next one reads.
      await advance({ projectId, decisionId: resumable[0].decisionId, now, policy: input.policy })
      advanced++
    }
  }

  let proposals: ProposalPassResult | undefined
  const lastPass = [...memory].reverse().find(e => e.record.decisionId === PASS_MARKER.decisionId)
  if (!lastPass || now.getTime() - lastPass.at.getTime() >= PROPOSAL_INTERVAL_MS) {
    proposals = await proposeChanges(projectId, { now })
  }
  return { projectId, disposition: 'swept', observed, advanced, ...(frozen ? { frozen } : {}), proposals }
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

/** What a verdict means in a sentence, for an outcome recorded before `plain` was. */
const VERDICT_WORDS: Record<BenefitVerdict, string> = {
  beneficial: 'It helped.',
  neutral: 'Existing apps were unaffected, but it has not paid off yet.',
  regressed: 'It made things worse.',
  insufficient_evidence: 'Too early to say whether it helped.',
}

const titleCase = (s: string) => s.replace(/^./, c => c.toUpperCase())

/**
 * The card's words for one change: a short headline for where it is, and the
 * sentence or two under it. The owner reads "Backenly improved your Orders
 * architecture." and, under it, what was done and that it can be undone: never
 * a rung, a count or the latest notebook line.
 */
function cardWords(
  state: LifecycleState,
  d: DecisionSummary,
  s: UserFacingSummary | null,
  runs: Continuation,
  keptStopped: boolean,
): { headline: string; detail: string } {
  const title = s?.subjectTitle ?? titleCase(d.subject)
  const did = s?.did ? `It ${s.did}.` : ''
  const stopped = d.stoppedBecause ? `It stopped because ${d.stoppedBecause.replace(/[.\s]+$/, '')}.` : 'It stopped part-way.'
  switch (state) {
    case 'stable':
      return {
        headline: d.outcome?.verdict === 'beneficial' ? `Backenly improved your ${title} architecture.` : `Backenly changed your ${title} architecture.`,
        detail: `${did} Verification passed. Undo is available.`.trim(),
      }
    case 'observing':
      return {
        headline: `Backenly changed your ${title} architecture.`,
        detail: `${did} Verification passed.${runs.unattended ? ' Backenly is watching the result.' : ''} Undo is available.`.trim(),
      }
    case 'blocked':
      if (d.withdrawn) {
        return { headline: `You paused the change to your ${title} architecture.`, detail: 'Nothing further runs until you resume it. Your app works as before.' }
      }
      return {
        headline: `The change to your ${title} architecture stopped.`,
        detail: `${stopped} ${keptStopped ? 'It is still in place; keep it, or undo it.' : 'Your app works as before.'}`,
      }
    case 'failed':
      return { headline: `The change to your ${title} architecture stopped.`, detail: `${stopped} Your app works as before.` }
    case 'rolling_back':
      return { headline: `Backenly is undoing the change to your ${title} architecture.`, detail: 'Your app works as before.' }
    case 'rolled_back':
      return { headline: `The change to your ${title} architecture was undone.`, detail: `${d.subject} is exactly as it was before, and no data was lost.` }
    default:
      return { headline: `Backenly is changing your ${title} architecture.`, detail: 'Existing apps keep working while it runs.' }
  }
}

/** The status tag, with what this deployment and project allow taken into account. */
function statusFor(state: LifecycleState, d: DecisionSummary, runs: Continuation): ArchitectureChangeView['status'] {
  if (state === 'blocked' && d.withdrawn) return { label: 'Paused by you', tone: 'neutral' }
  if (!runs.unattended && ADVANCEABLE.includes(state)) {
    return { label: state === 'approved' ? 'Waiting to start' : 'Waiting to continue', tone: 'attention' }
  }
  if (!runs.unattended && state === 'observing') return { label: 'Applied', tone: 'progress' }
  return userFacingStatus(state)
}

/** Recent architecture changes for the Autonomy page, newest first. `detail` adds the internal state. */
export async function listChanges(
  projectId: string,
  opts: { limit?: number; now?: Date; detail?: boolean } = {},
): Promise<ArchitectureChangeView[]> {
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
  const runs = await continuation(projectId)
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
      const moving = ADVANCEABLE.includes(state)
      // Stopped after it was in place: nothing is left to resume, only to keep.
      const keptStopped = state === 'blocked' && !d.withdrawn && lastActiveState(memory.filter(e => e.record.decisionId === d.decisionId)) === 'observing'
      const waiting = (moving || state === 'observing') && !runs.unattended ? runs.why : null
      const words = cardWords(state, d, s, runs, keptStopped)
      const verdict = d.outcome?.verdict as BenefitVerdict | undefined
      return {
        decisionId: d.decisionId,
        primitive: d.primitive,
        subject: d.subject,
        headline: words.headline,
        detail: words.detail,
        change: s?.change ?? '',
        status: statusFor(state, d, runs),
        ...(opts.detail ? { state } : {}),
        ...(d.stoppedBecause ? { stoppedBecause: d.stoppedBecause } : {}),
        ...(waiting ? { waiting } : {}),
        ...(d.outcome && verdict
          ? { outcome: { verdict, plain: d.outcome.plain || VERDICT_WORDS[verdict] || '', summary: d.outcome.summary } }
          : {}),
        ...(s?.rollback && canUndoFrom(state) ? { undoEffect: s.rollback } : {}),
        at: d.updatedAt.toISOString(),
        actions: {
          undo: canUndoFrom(state),
          // Pause stops something that is moving by itself; resume carries on
          // something that is not. Never both. After a part-way undo only undo
          // remains, and nothing resumes where nothing can run.
          pause: moving && runs.unattended,
          resume: !d.undoIncomplete && !keptStopped && runs.byHand && (state === 'blocked' || state === 'failed' || (moving && !runs.unattended)),
          keep: !d.undoIncomplete && keptStopped,
        },
        ...(pendingBy.get(d.decisionId) ? { findingId: pendingBy.get(d.decisionId)! } : {}),
      }
    })
}

function summaryOfDecision(memory: MemoryEntry[], decisionId: string): UserFacingSummary | null {
  return summaryOf(memory.filter(e => e.record.decisionId === decisionId))
}

/**
 * GET /api/projects/[id]/architecture — the concise default. Reads memory only;
 * never re-analyses. `detail` adds each change's internal state.
 */
export async function architectureSummary(projectId: string, opts: { detail?: boolean } = {}): Promise<ArchitectureSummary> {
  const memory = await readMemory(projectId)
  const changes = await listChanges(projectId, { detail: opts.detail })
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
    execution: executionEnabled(projectId),
    analyzedAt: lastPass ? lastPass.at.toISOString() : null,
  }
}

/**
 * The exact statements of a waiting request, rendered now from the project's
 * own tables, for a person who opens them. A project kept in another region
 * does not store them outside it (technicalFor), so they are read where they
 * are, shown, and not kept. `current` says whether they are still the version
 * consent would bind to: a table that changed since gives another version,
 * which approval refuses until it is rehearsed and asked about again.
 */
export async function liveStatements(
  projectId: string,
  findingId: string,
): Promise<{ planVersion: string; current: boolean; steps: Array<{ title: string; sql: string[] }> } | null> {
  const req = await requestById(projectId, findingId)
  if (!req) return null
  const primitive = primitiveById(req.evolution.primitive)
  const spec = primitive?.normaliseSpec(req.evolution.spec)
  const resolved = primitive && spec ? await primitive.resolvePlan(projectId, spec) : null
  if (!resolved || 'refusal' in resolved) return { planVersion: req.evolution.planVersion, current: false, steps: [] }
  const { plan } = resolved
  return {
    planVersion: plan.planVersion,
    current: plan.planVersion === req.evolution.planVersion,
    steps: plan.steps.map(st => ({ title: st.title, sql: st.sql })),
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
