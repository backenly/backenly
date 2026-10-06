/**
 * STRUCTURAL EXTRACTION AS AN ENGINE PRIMITIVE
 * ============================================
 *
 * The Architecture Evolution Engine (lib/evolution-engine) is the loop —
 * detect, classify, rehearse, ask, execute, verify, observe, remember, report —
 * and it knows nothing about tables. This file is where one kind of change,
 * moving a concern out of a table into a table of its own, plugs into it. Every
 * method delegates to the module that already does the work; nothing here
 * decides policy.
 *
 * ── Structural, never semantic ──────────────────────────────────────────────
 *
 * The change this primitive makes keeps today's meaning exactly: the same rows,
 * one satellite row per parent at most, the same access, every old client
 * working. It does not decide that a refund is really many refunds, that it
 * belongs in another service, or that it should commit in its own transaction.
 * Those are semantic redesigns; `changeClass` is always 'structural' here, and
 * every proposal carries a sentence saying what it deliberately does not decide.
 */

import {
  registerPrimitive,
  type Assessment,
  type EnginePlan,
  type EvolutionPrimitive,
  type ExecutionOutcome,
  type Opportunity,
  type Rehearsal,
  type RungStage,
  type UserFacingSummary,
} from '@/lib/evolution-engine/primitive'
import type { PlanTraits } from '@/lib/evolution-engine/policy'
import { analyzeStructuralEvolution, type ProposalView } from './index'
import type { ConcernAssessment } from './concerns'
import { extractionPlanId, requiredTier, type ExtractionPlan, type ExtractionStep, type ExtractionStepKind } from './plan'
import { normaliseSpec, resolveExtractionPlan, isResolveRefusal } from './resolve'
import { readTableFacts } from './facts'
import { rehearseExtraction } from './rehearse'
import { grantEvolutionApproval, isGrantRefusal, readLiveEvolutionApproval, revokeEvolutionApproval, isRevokeRefusal } from './consent'
import { executeExtraction } from './execute'
import { reconcileExtraction } from './reconcile'
import { rollbackExtraction } from './rollback'
import { measureExtraction, observeExtraction, snapshotExtraction } from './telemetry'
import { ladderNames, type ExtractionSpec } from './sql'

export const STRUCTURAL_EXTRACTION = 'structural_extraction'

/** The rung kinds that change nothing: rehearsal and verification. */
const READ_ONLY: ReadonlyArray<ExtractionStepKind> = ['rehearse', 'verify']

export type StructuralRung = ExtractionStep & { stage: RungStage; mutates: boolean }
export type StructuralPlan = Omit<ExtractionPlan, 'steps'> &
  Omit<EnginePlan<ExtractionSpec>, 'steps'> & { steps: StructuralRung[] }

/**
 * Which lifecycle stage a rung belongs to. The verification after writes open
 * is part of cutover: it proves the two-way sync, not the copy.
 */
export function stageOf(kind: ExtractionStepKind, ordinal: number, steps: Array<{ kind: string; ordinal: number }>): RungStage {
  const opened = steps.find(s => s.kind === 'open_writes')?.ordinal ?? Infinity
  switch (kind) {
    case 'rehearse':
      return 'rehearsal'
    case 'create_satellite':
    case 'sync_forward':
      return 'expand'
    case 'backfill':
      return 'backfill'
    case 'verify':
      return ordinal > opened ? 'cutover' : 'verify'
    case 'expose_reads':
    case 'open_writes':
      return 'cutover'
    case 'contract':
      return 'contract'
  }
}

export function toEnginePlan(plan: ExtractionPlan): StructuralPlan {
  return {
    ...plan,
    primitive: STRUCTURAL_EXTRACTION,
    changeClass: 'structural',
    steps: plan.steps.map(s => ({
      ...s,
      stage: stageOf(s.kind, s.ordinal, plan.steps),
      mutates: !READ_ONLY.includes(s.kind),
    })),
  }
}

const titleCase = (s: string) => s.replace(/^./, c => c.toUpperCase())
const list = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** Plain sentences about one extraction. No SQL, no internal state names. */
export function describeExtraction(spec: ExtractionSpec, why?: string): UserFacingSummary {
  const { host, satellite, label, members } = spec
  return {
    headline: `Move ${label} data out of ${host} into its own table`,
    change:
      `Backenly would create ${satellite} for ${list(members)}, keep it in step with ${host} in both directions, ` +
      `and copy the existing ${label} data across. Nothing is removed from ${host}.`,
    reason: why ?? `${list(members)} behave as one responsibility of their own.`,
    compatibility:
      `Every app that reads or writes ${host} today keeps working unchanged; new code can use ${satellite} when it is ready. ` +
      `Who may read or change ${label} data stays exactly the same.`,
    rollback: `Undo removes ${satellite} and leaves ${host} exactly as it was. Backenly refuses to undo if that would lose a write.`,
    subjectTitle: titleCase(host),
    did: `moved ${label} data out of ${host} into its own table, ${satellite}`,
  }
}

function whyOf(c: ConcernAssessment): string {
  const measured = c.families.filter(f => f.verdict === 'supports').map(f => f.detail)
  const cost = c.pressure.map(p => p.detail)
  const emerging = (c.emerging ?? []).map(e => e.detail)
  const parts = [
    measured.length ? `They behave as one responsibility: ${measured.slice(0, 2).join('; ')}.` : null,
    cost.length ? `Keeping them on ${c.host} has a measured cost: ${cost.slice(0, 2).join('; ')}.` : null,
    !cost.length && emerging.length ? `They are starting to evolve on their own: ${emerging.slice(0, 2).join('; ')}.` : null,
  ].filter((x): x is string => !!x)
  return parts.join(' ') || c.levelReason
}

function opportunityOf(projectId: string, c: ConcernAssessment, view?: ProposalView): Opportunity<ExtractionSpec> {
  const spec: ExtractionSpec = view?.spec ?? { host: c.host, members: c.members, satellite: c.defaultSatellite, label: c.label }
  return {
    primitive: STRUCTURAL_EXTRACTION,
    subject: c.host,
    key: c.key,
    concernKey: c.concernKey,
    planId: view?.planId ?? extractionPlanId(projectId, c.host, c.members),
    level: c.level,
    levelReason: c.levelReason,
    changeClass: 'structural',
    spec,
    evidence: c.families.map(f => ({ family: f.family, verdict: f.verdict, detail: f.detail })),
    pressure: [
      ...c.pressure.map(p => ({ kind: p.kind, class: 'measured_cost' as const, detail: p.detail })),
      ...(c.emerging ?? []).map(e => ({ kind: e.kind, class: 'emerging' as const, detail: e.detail })),
    ],
    semanticBoundary: c.semanticBoundary,
    priority: c.priority.score,
    diagnostics: {
      why: whyOf(c),
      verdict: c.verdict,
      clientMigration: view?.clientMigration ?? [],
      contractBlockers: view?.plan.contractBlockers ?? [],
      caveats: view?.plan.caveats ?? [],
    },
  }
}

export const structuralExtraction: EvolutionPrimitive<ExtractionSpec, StructuralPlan> = {
  id: STRUCTURAL_EXTRACTION,
  title: 'Isolating a responsibility into its own table',

  async assess(projectId, opts): Promise<Assessment<ExtractionSpec>> {
    const report = await analyzeStructuralEvolution(projectId, { tables: opts.subjects, now: opts.now, priors: opts.priors })
    const opportunities = [
      ...report.proposals.map(p => opportunityOf(projectId, p, p)),
      ...report.recommendations.map(c => opportunityOf(projectId, c)),
      ...report.watching.map(c => opportunityOf(projectId, c)),
      ...report.held.map(c => opportunityOf(projectId, c)),
    ]
    return {
      opportunities,
      subjects: report.tables.map(t => ({
        subject: t.table,
        level: t.subject.level,
        noChangeReason: t.subject.noChangeReason,
      })),
      limits: report.limits,
    }
  },

  normaliseSpec,

  async resolvePlan(projectId, spec) {
    const r = await resolveExtractionPlan(projectId, spec)
    return isResolveRefusal(r) ? { refusal: r.refusal } : { plan: toEnginePlan(r.plan) }
  },

  traits(plan, rehearsal): PlanTraits {
    const software = plan.steps.filter(s => s.capability !== 'human_only')
    return {
      changeClass: 'structural',
      rungs: plan.steps.map(s => ({ tier: s.tier, humanOnly: s.capability === 'human_only', mutates: s.mutates })),
      reversible: software.filter(s => s.mutates).every(s => s.rollback !== null),
      authorizationRehearsed: rehearsal?.authorization === 'passed',
    }
  },

  async rehearse(projectId, plan): Promise<Rehearsal> {
    const facts = await readTableFacts(plan.schema, plan.spec.host)
    if (!facts) {
      return {
        passed: false,
        authorization: 'unavailable',
        authorizationDetail: `${plan.spec.host} no longer exists`,
        detail: `${plan.spec.host} no longer exists`,
        report: null,
      }
    }
    const r = await rehearseExtraction(facts, plan.spec, plan.planId)
    const auth = (r as { authorization?: { status?: 'passed' | 'failed' | 'unavailable'; detail?: string } }).authorization
    const exercised = r.exercises.filter(e => e.outcome === 'passed').length
    return {
      passed: r.passed,
      authorization: auth?.status ?? 'unavailable',
      authorizationDetail: auth?.detail ?? 'who may read and write the new table was not rehearsed',
      detail: r.error
        ? `the rehearsal could not run: ${r.error}`
        : r.passed
          ? `rehearsed on ${r.sampledRows} copied row(s); ${exercised} exercise(s) left both shapes identical`
          : `the rehearsal failed: ${r.exercises.filter(e => e.outcome === 'failed').map(e => `${e.name}: ${e.detail}`).join('; ')}`,
      report: r,
    }
  },

  async grant(input) {
    const r = await grantEvolutionApproval({
      projectId: input.projectId,
      spec: input.spec,
      planVersion: input.planVersion,
      approvedBy: input.approvedBy,
      decisionId: input.decisionId,
      resolve: resolveExtractionPlan,
    })
    return isGrantRefusal(r)
      ? { ok: false, refusal: r.refusal, currentPlanVersion: r.currentPlanVersion }
      : { ok: true, approvalId: r.approval.id, planVersion: r.approval.planVersion }
  },

  async withdraw(input) {
    const live = await readLiveEvolutionApproval(input.projectId, input.planId)
    if (!live) return { ok: true, detail: 'no live consent to withdraw' }
    const r = await revokeEvolutionApproval({ projectId: input.projectId, approvalId: live.id, revokedBy: input.by })
    return isRevokeRefusal(r) ? { ok: false, detail: r.refusal } : { ok: true, detail: 'consent withdrawn' }
  },

  async execute(projectId, planId, opts): Promise<ExecutionOutcome> {
    const out = await executeExtraction({ projectId, planId, mutationsEnabled: opts?.mutationsEnabled })
    const order = out.steps.map(s => ({ kind: s.kind, ordinal: s.ordinal }))
    // `open_writes` may not be among the steps reported; the plan's order is fixed.
    const withOpen = order.some(o => o.kind === 'open_writes') ? order : [...order, { kind: 'open_writes', ordinal: 6 }]
    return {
      status: out.status,
      haltReason: out.haltReason,
      stoppedBecause: out.stoppedBecause,
      executionId: out.executionId,
      steps: out.steps.map(s => ({
        ordinal: s.ordinal,
        kind: s.kind,
        stage: stageOf(s.kind, s.ordinal, withOpen),
        status: s.status,
        detail: s.detail,
      })),
    }
  },

  async verify(projectId, plan) {
    const facts = await readTableFacts(plan.schema, plan.spec.host)
    if (!facts) return { consistent: false, summary: `${plan.spec.host} no longer exists`, detail: null }
    const r = await reconcileExtraction(projectId, facts, plan.spec)
    return { consistent: r.consistent, summary: r.summary, detail: r }
  },

  observe: (projectId, plan, window) => observeExtraction(projectId, plan, window),
  snapshot: (projectId, plan, phase, now) => snapshotExtraction(projectId, plan, phase, now),
  measure: (projectId, plan, snapshots, context) => measureExtraction(projectId, plan, snapshots, context),

  rollback: (projectId, planId, requestedBy) => rollbackExtraction({ projectId, planId, requestedBy }),

  describe(plan, opportunity) {
    const why = (opportunity?.diagnostics as { why?: string } | undefined)?.why
    return describeExtraction(plan.spec, why)
  },
}

registerPrimitive(structuralExtraction)

/** For the request's opt-in technical section: what a person may want to read. */
export function technicalOf(plan: StructuralPlan, opportunity: Opportunity<ExtractionSpec>) {
  const d = (opportunity.diagnostics ?? {}) as {
    clientMigration?: Array<{ purpose: string; before: string; after: string }>
  }
  return {
    steps: plan.steps.map(s => ({
      title: s.title,
      why: s.why,
      tier: s.tier,
      humanOnly: s.capability === 'human_only',
      sql: s.sql,
    })),
    evidence: opportunity.evidence,
    pressure: opportunity.pressure,
    semanticBoundary: opportunity.semanticBoundary,
    contractBlockers: plan.contractBlockers,
    caveats: plan.caveats,
    clientMigration: d.clientMigration ?? [],
    requiredTier: requiredTier(plan as unknown as ExtractionPlan),
    names: { satellite: plan.spec.satellite, parentKey: ladderNames(plan.spec).fkColumn },
  }
}
