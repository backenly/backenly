/**
 * PRIMITIVES — the one interface every kind of architecture change implements
 * ===========================================================================
 *
 * The Architecture Evolution Engine is the loop — detect, classify, rehearse,
 * ask, execute, verify, observe, remember, report — and it knows nothing about
 * tables, columns or triggers. A PRIMITIVE is one kind of change the engine can
 * make, and it supplies everything kind-specific through this interface:
 *
 *   assess       find opportunities and say why each is (or is not) worth it
 *   resolvePlan  turn a spec into a deterministic plan, rebuilt from the live
 *                system every time it is needed
 *   rehearse     run that plan somewhere it cannot hurt anything
 *   grant        record a person's consent to one exact plan version
 *   execute      advance the plan under the GOVERNED EXECUTION CONTRACT below
 *   verify       prove the old and new shapes agree
 *   observe      the signals that say whether the change is behaving
 *   snapshot     the numbers at one moment, kept so before/after can be
 *                compared after the raw logs have aged out
 *   measure      turn two snapshots into before/after measurements
 *   rollback     undo, losslessly or not at all
 *   describe     say what it does in words a person reads
 *
 * ── The governed execution contract ────────────────────────────────────────
 *
 * Every primitive's `execute` must, and structural extraction's does:
 *
 *   - run under the project's single-flight lock (one change per project)
 *   - rebuild the plan from the live system and refuse unless it hashes to the
 *     version consent was given for
 *   - re-read consent before every rung, so a withdrawal stops the next rung
 *   - run nothing when the plan is not executable as a whole
 *   - run no rung that mutates unless the deployment allows mutations
 *   - never run a human-only rung
 *   - make every rung idempotent, or recover it from its postcondition
 *
 * The engine (./engine.ts) relies on that contract rather than re-implementing
 * it, and owns everything around it: lifecycle, consent requests, memory,
 * observation, outcome.
 *
 * Structural extraction (lib/structural-evolution) is the first primitive.
 * Read models, partitioning, archival, index evolution and the rest would each
 * be one more implementation of this interface — none of them requires a change
 * to the engine's governance, lifecycle, consent, observation or memory, which
 * is the point of drawing the line here.
 *
 * What a primitive may NOT do is decide policy. Whether a person must approve,
 * whether a change may run unattended, what counts as stable: those live in
 * ./policy.ts and ./lifecycle.ts and apply to every primitive identically.
 */

import type { ChangeClass, PlanTraits } from './policy'
import type { EvolutionLevel, PriorOutcome } from './levels'

/** Which lifecycle stage a rung belongs to. */
export type RungStage = 'rehearsal' | 'expand' | 'backfill' | 'verify' | 'cutover' | 'contract'

export interface EngineRung {
  ordinal: number
  kind: string
  stage: RungStage
  tier: 0 | 1 | 2 | 3
  capability: 'implemented' | 'not_implemented' | 'human_only'
  /** Changes the live schema or data. Rehearsal and verification do not. */
  mutates: boolean
  title: string
  why: string
  /** The exact statements, for the plan's version hash and for diagnostics. */
  sql: string[]
  preconditions: string[]
  postconditions: string[]
  rollback: { strategy: string; description: string; sql: string[] } | null
  idempotencyKey: string
}

export interface EnginePlan<Spec = unknown> {
  primitive: string
  projectId: string
  planId: string
  /** Hash of the exact statements and the live state they were built from. */
  planVersion: string
  /** The ledger key for this opportunity. */
  proposalKey: string
  spec: Spec
  basisFingerprint: string
  changeClass: ChangeClass
  steps: EngineRung[]
  validity: 'executable' | 'blocked_by_capability' | 'invalid'
  blockedReasons: string[]
  contractBlockers: string[]
  caveats: string[]
}

/** One rung as an execution reported it. */
export interface ExecutionStep {
  ordinal: number
  kind: string
  stage: RungStage
  status: 'completed' | 'dispatched' | 'skipped' | 'failed' | 'awaiting_human'
  detail: string
}

/** Why an execution stopped short, when it did. Decides blocked versus failed. */
export type StopReason =
  /** Consent missing, withdrawn, or for another version. */
  | 'consent'
  /** The live system no longer matches the plan consent was given for. */
  | 'drift'
  /** This deployment does not allow the engine to change schemas. */
  | 'mutations_disabled'
  /** A rung is not implemented here, or the plan is not executable. */
  | 'capability'
  /** Verification found the two shapes disagree. */
  | 'verification'
  /** A rung did not do what it said. */
  | 'rung_failed'

export interface ExecutionOutcome {
  status: 'completed' | 'halted' | 'refused' | 'awaiting_background_work' | 'in_flight_elsewhere'
  haltReason: string | null
  stoppedBecause: StopReason | null
  steps: ExecutionStep[]
  executionId: string | null
}

export type ConsentResult =
  | { ok: true; approvalId: string; planVersion: string }
  | { ok: false; refusal: string; currentPlanVersion?: string }

/** `strict` is off in this repo, so a boolean discriminant does not narrow. */
export const isConsentRefusal = (r: ConsentResult): r is Extract<ConsentResult, { ok: false }> => !r.ok

export interface Rehearsal {
  passed: boolean
  /** Who-may-read/write was exercised, not only what is stored. */
  authorization: 'passed' | 'failed' | 'unavailable'
  authorizationDetail: string
  detail: string
  report: unknown
}

export interface Consistency {
  consistent: boolean
  summary: string
  detail: unknown
}

/** One observed signal during the post-cutover window. */
export interface ObservationSignal {
  name: string
  status: 'ok' | 'regressed' | 'unavailable'
  detail: string
}

/** Why a number is missing. A closed set, so a report can group them; never silently zero. */
export type UnavailableReason =
  | 'extension_missing'
  | 'statement_text_hidden'
  | 'stats_reset'
  | 'statements_evicted'
  | 'relation_recreated'
  | 'request_log_unreadable'
  | 'history_unreadable'
  | 'no_traffic_recorded'
  | 'table_not_served_over_api'
  | 'insufficient_sample'
  | 'window_aged_out'
  | 'not_applicable_before_contract'
  | 'not_yet_measurable'

/**
 * What a measurement is allowed to decide.
 *
 *   guardrail  can only say "regressed" or "no regression" — a latency or error
 *              rate that improved after a change that only ADDS work is traffic
 *              mix, not a benefit, and is never reported as one
 *   benefit    tied to the cost that justified the change (e.g. schema changes
 *              to the concern no longer locking the host); the only kind that
 *              can make a change "beneficial"
 *   cost       reported so the owner sees the price (extra storage, the sync's
 *              write overhead); never a verdict on its own
 */
export type MeasurementRole = 'guardrail' | 'benefit' | 'cost'

/** One before/after measurement. `null` means not measurable here, never zero. */
export interface Measurement {
  name: string
  role: MeasurementRole
  unit: string
  before: number | null
  after: number | null
  /** Lower is better (latency, errors) or higher is better (HOT ratio). */
  better: 'lower' | 'higher'
  /** Samples behind each side, so a verdict can refuse to rest on too few. */
  samplesBefore: number | null
  samplesAfter: number | null
  /** Minimum samples on EACH side for this measurement to count. */
  minSamples: number
  /**
   * For a rate: the event counts behind it (errors, not requests), so a
   * single extra error on a small denominator cannot read as a regression.
   */
  eventsBefore?: number | null
  eventsAfter?: number | null
  scope: string
  reason?: UnavailableReason
  /** Plain-language detail, shown with the reason. */
  unavailableReason?: string
}

/** The phases at which a primitive's numbers are captured. */
export type SnapshotPhase =
  /** First assessment that produced this plan version: start of "before". */
  | 'R'
  /** Immediately before the first rung that changes anything: end of "before". */
  | 'S0'
  /** Verification passed after cutover: start of "after". */
  | 'S1'
  /** End of observation. */
  | 'S2'
  /** Long-horizon re-evaluations, for benefits that take weeks to show. */
  | 'L30'
  | 'L90'

/** Opaque to the engine; each primitive defines and reads its own. Kept small (≤ ~4 KB). */
export interface TelemetrySnapshot {
  v: 1
  phase: SnapshotPhase
  at: string
  data: Record<string, unknown>
  unavailable: Array<{ metric: string; reason: UnavailableReason; detail: string }>
}

/** Words for a person. Never internal state names, never SQL. */
export interface UserFacingSummary {
  /** "Backenly improved your Orders architecture." */
  headline: string
  /** What changed, in one or two sentences. */
  change: string
  /** Why. */
  reason: string
  compatibility: string
  rollback: string
  /** The subject as a name in a sentence: "Orders". */
  subjectTitle: string
  /** What was done, as a past-tense clause: "moved refund data out of orders into its own table, order_refunds". */
  did: string
}

export interface Opportunity<Spec = unknown> {
  primitive: string
  /** The thing this is about, e.g. a table name. */
  subject: string
  key: string
  /** What is being reorganised, stable across membership changes; memory's lineage key. */
  concernKey: string
  planId: string
  level: EvolutionLevel
  levelReason: string
  changeClass: ChangeClass
  spec: Spec
  /** Evidence and pressure, already in words; the structured form is in `diagnostics`. */
  evidence: Array<{ family: string; verdict: 'supports' | 'contradicts' | 'silent' | 'unavailable'; detail: string }>
  pressure: Array<{ kind: string; class: 'measured_cost' | 'emerging'; detail: string }>
  /** Plain-language note on what this change does NOT decide (cardinality, meaning). */
  semanticBoundary: string
  priority: number
  diagnostics: unknown
}

export interface SubjectVerdict {
  subject: string
  level: EvolutionLevel
  /** Present when the engine looked hard and decided to leave it alone. */
  noChangeReason: string | null
}

export interface Assessment<Spec = unknown> {
  opportunities: Array<Opportunity<Spec>>
  subjects: SubjectVerdict[]
  limits: string[]
}

export interface EvolutionPrimitive<Spec = unknown, Plan extends EnginePlan<Spec> = EnginePlan<Spec>> {
  id: string
  /** For people: "isolating a responsibility into its own table". */
  title: string
  assess(projectId: string, opts: { subjects?: string[]; now?: Date; priors?: Record<string, PriorOutcome> }): Promise<Assessment<Spec>>
  normaliseSpec(raw: unknown): Spec | null
  resolvePlan(projectId: string, spec: Spec): Promise<{ plan: Plan } | { refusal: string }>
  traits(plan: Plan, rehearsal: Rehearsal | null): PlanTraits
  rehearse(projectId: string, plan: Plan): Promise<Rehearsal>
  /** Record consent to exactly `planVersion`, re-deriving the plan from the live system first. */
  grant(input: { projectId: string; spec: Spec; planVersion: string; approvedBy: string; decisionId: string }): Promise<ConsentResult>
  /** Withdraw consent: pauses the change before its next rung. */
  withdraw(input: { projectId: string; planId: string; by: string }): Promise<{ ok: boolean; detail: string }>
  /** Advance under the governed execution contract above. */
  execute(projectId: string, planId: string, opts?: { mutationsEnabled?: boolean }): Promise<ExecutionOutcome>
  verify(projectId: string, plan: Plan): Promise<Consistency>
  observe(projectId: string, plan: Plan, window: { since: Date; now: Date }): Promise<ObservationSignal[]>
  snapshot(projectId: string, plan: Plan, phase: SnapshotPhase, now: Date): Promise<TelemetrySnapshot>
  /**
   * Before/after measurements from the snapshots taken so far (and anything
   * still readable live). `firedBy` names the costs that justified the change:
   * only a measurement of one of those may count as a benefit.
   */
  measure(projectId: string, plan: Plan, snapshots: TelemetrySnapshot[], context: { firedBy: string[]; now: Date }): Promise<Measurement[]>
  /** Undo. Refuses rather than lose a write; see the primitive's own rollback contract. */
  rollback(projectId: string, planId: string, requestedBy: string): Promise<RollbackResult>
  describe(plan: Plan, opportunity?: Opportunity<Spec>): UserFacingSummary
}

export interface RollbackResult {
  status: 'rolled_back' | 'nothing_to_undo' | 'refused' | 'failed' | 'in_flight_elsewhere'
  reason: string | null
  actions: Array<{ action: string; outcome: 'done' | 'not_needed' | 'failed'; detail: string }>
}

const REGISTRY = new Map<string, EvolutionPrimitive<any, any>>()

export function registerPrimitive(p: EvolutionPrimitive<any, any>): void {
  REGISTRY.set(p.id, p)
}

export function primitiveById(id: string): EvolutionPrimitive<any, any> | null {
  return REGISTRY.get(id) ?? null
}

export function allPrimitives(): Array<EvolutionPrimitive<any, any>> {
  return [...REGISTRY.values()]
}
