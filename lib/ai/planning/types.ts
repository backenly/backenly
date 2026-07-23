/**
 * PLANNING — Shared types
 * =======================
 * Phase 2 of the architecture upgrade. Workflow extraction sits between
 * Product Understanding (Phase 1, lib/ai/understanding/) and the Domain-Aware
 * API Generator (Phase 6).
 *
 * A Workflow describes a multi-step *behaviour* the backend must implement.
 * It is richer than CRUD: it names the actor, the trigger, the steps in
 * order, the runtime + integration dependencies, and the failure handling
 * the implementer must wire up.
 *
 * Phase 2 stays in shadow mode — workflows are emitted via SSE and logged
 * but the executor never reads them. Phase 6 starts consuming them.
 */

export type WorkflowCategory =
  | 'auth'
  | 'billing'
  | 'async_job'
  | 'storage'
  | 'admin'
  | 'notification'
  | 'webhook'
  | 'realtime'
  | 'core_crud'
  | 'analytics'

export type WorkflowStepType =
  | 'validate'
  | 'read'
  | 'write'
  | 'enqueue'
  | 'call_integration'
  | 'emit_event'
  | 'send_notification'
  | 'authorize'
  | 'transform'

export interface WorkflowStep {
  /** Stable id within the workflow, e.g. 'auth', 'check_credits' */
  id: string
  /** Human-readable action description */
  action: string
  type: WorkflowStepType
  /** Optional target — table name, queue name, integration id, event name */
  target?: string
  /** Other step ids this depends on (for ordering) */
  dependsOn?: string[]
}

export interface Workflow {
  /** Stable id across runs for the same product, e.g. 'submit_generation_job' */
  id: string
  /** Human-readable display name */
  name: string
  /** One-sentence description of what the workflow does */
  description: string
  category: WorkflowCategory
  /** What kicks off this workflow — http_request, webhook, cron, queue, etc. */
  trigger: string
  /** Who triggers it: 'end_user', 'admin', 'system', 'background_worker', 'external_provider' */
  actor: string
  steps: WorkflowStep[]
  /** Capability ids this workflow needs (subset of CriticalCapability) */
  requiredCapabilities: string[]
  /**
   * Runtime infrastructure required: 'queue', 'worker', 'event_bus', 'sse',
   * 'cron', 'transactional_db', 'advisory_locks'
   */
  requiredRuntime: string[]
  /** External integrations required: 'stripe', 'resend', 'runway', etc. */
  requiredIntegrations: string[]
  /** Failure-handling steps — refunds, retries, dead-letter, etc. */
  failureHandling: string[]
  /** Business rules / invariants the workflow enforces */
  businessRules: string[]
  /** 0..1 — derived from how many capability + prompt signals supported it */
  confidence: number
  /** Specific signals from the prompt or capability graph that supported it */
  evidence: string[]
  /** Always true in Phase 2 — flips to false when the executor consumes workflows */
  shadowMode: true
}

export interface WorkflowsReport {
  workflows: Workflow[]
  /** Composite confidence across all detected workflows */
  overallConfidence: number
  /** Aggregated warnings — sparse prompt, conflicting signals, low confidence */
  warnings: string[]
  /** True when no workflows were detected with reasonable confidence */
  needsClarification: boolean
}

// ─── Phase 3 — Business Rules ────────────────────────────────────────────────
//
// Business rules are the *enforceable invariants* a workflow implies. Where
// a Workflow describes "what happens", a BusinessRule describes "what must
// always be true regardless of caller, race, or order of operations".
//
// Phase 3 stays in shadow mode — rules are emitted via SSE and logged but
// the executor never reads them. Phase 7 (behavior verification) will
// consume verificationHint to drive scenario tests.

export type BusinessRuleCategory =
  | 'authorization'
  | 'billing'
  | 'data_integrity'
  | 'security'
  | 'workflow'
  | 'storage'
  | 'integration'
  | 'admin'
  | 'notification'

export type BusinessRuleEnforcement =
  | 'api_middleware'
  | 'database_constraint'
  | 'transaction'
  | 'rls_policy'
  | 'webhook_idempotency'
  | 'state_machine'
  | 'background_worker'
  | 'validation_schema'
  | 'audit_log'

export type BusinessRuleSeverity = 'critical' | 'high' | 'medium' | 'low'

export interface BusinessRuleAppliesTo {
  workflows?: string[]
  tables?: string[]
  endpoints?: string[]
  capabilities?: string[]
}

export interface BusinessRule {
  /** Stable id, e.g. 'credits_non_negative' */
  id: string
  /** Human-readable display name */
  name: string
  /** One-sentence description of the invariant */
  description: string
  category: BusinessRuleCategory
  enforcement: BusinessRuleEnforcement
  severity: BusinessRuleSeverity
  /** What this rule is scoped to */
  appliesTo: BusinessRuleAppliesTo
  /** Concrete how-to-implement guidance for the executor */
  implementationHint: string
  /** Concrete how-to-verify guidance for the Phase 7 verifier */
  verificationHint: string
  /** 0..1 — derived from underlying confidence + evidence count */
  confidence: number
  /** Concrete signals that supported this rule */
  evidence: string[]
  /** Always true in Phase 3 — flips to false when verifier consumes the report */
  shadowMode: true
}

export interface BusinessRulesReport {
  rules: BusinessRule[]
  /** Composite confidence across all detected rules */
  overallConfidence: number
  /** Aggregated warnings — sparse prompt, conflicting signals, missing rules */
  warnings: string[]
  /** Always true in Phase 3 */
  shadowMode: true
}

// ─── Phase 4 — State Machine Plans ───────────────────────────────────────────
//
// A StateMachinePlan turns a status-bearing table into a structured
// transition graph plus the endpoints + runtime + business rules required
// to enforce it. Phase 4 stays in shadow mode — the executor does not
// consume these plans. domain-business-logic.ts exposes a flag-gated
// planning helper so reviewers can preview the endpoints that would be
// emitted by Phase 6.

export type StateMachineDomain =
  | 'async_job'
  | 'order'
  | 'booking'
  | 'subscription'
  | 'payment'
  | 'approval'
  | 'ticket'
  | 'enrollment'
  | 'generic'

export type StateTransitionActor = 'user' | 'admin' | 'system' | 'worker' | 'webhook'

export interface StateTransition {
  from: string
  to: string
  /** Verb naming the transition, e.g. 'cancel', 'retry', 'pay' */
  action: string
  actor: StateTransitionActor
  /** Pre-conditions that must hold for the transition to fire */
  guards: string[]
  /** Side effects that run as part of the transition */
  sideEffects: string[]
}

export interface StateMachineEndpoint {
  method: 'GET' | 'POST' | 'PATCH'
  path: string
  /** What the endpoint does in one sentence */
  purpose: string
  requiredAuth: boolean
  /** Specific role required (admin, support, etc.) — omit for end_user */
  requiredRole?: string
  /** Business rule ids this endpoint must enforce */
  businessRules: string[]
}

export interface StateMachinePlan {
  /** Stable id, e.g. 'sm_generation_jobs' */
  id: string
  tableName: string
  statusField: string
  domain: StateMachineDomain
  states: string[]
  initialState: string
  /** Rows in these states cannot transition further */
  terminalStates: string[]
  transitions: StateTransition[]
  /** Endpoints required to drive the state machine */
  requiredEndpoints: StateMachineEndpoint[]
  /** Runtime building blocks needed: queue, worker, event_bus, cron, … */
  requiredRuntime: string[]
  /** Business rule ids the executor must enforce */
  requiredBusinessRules: string[]
  /** Phase 7 verifier scenario hints */
  requiredVerification: string[]
  /** 0..1 — derived from underlying confidence + capability coverage */
  confidence: number
  /** Concrete signals that supported this plan */
  evidence: string[]
  /** Always true in Phase 4 */
  shadowMode: true
}

export interface StateMachinesReport {
  plans: StateMachinePlan[]
  overallConfidence: number
  warnings: string[]
  shadowMode: true
}

// ─── Phase 5 — Plan Validation ───────────────────────────────────────────────
//
// Validates the *planned* backend artifacts against the upstream
// ProductUnderstanding + WorkflowsReport + BusinessRulesReport +
// StateMachinesReport. Phase 5 stays in shadow mode: it produces a report
// of what is missing and what Backenly should not yet claim, but does not
// block builds or change executor behaviour.

export type PlanValidationFindingType =
  | 'missing_endpoint'
  | 'missing_auth'
  | 'missing_validation'
  | 'missing_pagination'
  | 'missing_rate_limit'
  | 'missing_index'
  | 'missing_rls'
  | 'missing_soft_delete'
  | 'missing_runtime'
  | 'missing_integration'
  | 'missing_business_rule'
  | 'missing_verification'
  | 'readiness_overclaim'

export type PlanValidationFindingSeverity = 'blocking' | 'warning' | 'info'

export type PlanValidationFindingCategory =
  | 'api'
  | 'schema'
  | 'runtime'
  | 'security'
  | 'business_logic'
  | 'integration'
  | 'verification'
  | 'ux_truthfulness'

export interface PlanValidationFindingAppliesTo {
  workflowIds?: string[]
  ruleIds?: string[]
  stateMachineIds?: string[]
  endpointPaths?: string[]
  tables?: string[]
  capabilities?: string[]
}

export interface PlanValidationFinding {
  /** Stable id, e.g. 'missing_endpoint:POST_/generation_jobs/:id/cancel' */
  id: string
  type: PlanValidationFindingType
  severity: PlanValidationFindingSeverity
  category: PlanValidationFindingCategory
  /** One-sentence problem statement */
  message: string
  /** Concrete fix the implementer should make */
  recommendation: string
  /** Specific signals from the upstream reports that supported this finding */
  evidence: string[]
  appliesTo?: PlanValidationFindingAppliesTo
  /** Always true in Phase 5 */
  shadowMode: true
}

export type ReadinessLabel =
  | 'Structure Built'
  | 'Prototype Ready'
  | 'Workflow Incomplete'
  | 'Needs Verification'
  | 'Production Ready'

export interface PlanValidationReport {
  findings: PlanValidationFinding[]
  /** Truthful readiness label — see Phase 0 status enum */
  readinessLabel: ReadinessLabel
  /** 0..100 — derived from blocking + warning counts and verification coverage */
  readinessScore: number
  blockingCount: number
  warningCount: number
  /** Top 3-5 next actions, ranked by impact on readiness */
  recommendedNextActions: string[]
  /** Always true in Phase 5 */
  shadowMode: true
}

// ─── Phase 6 — Domain-Aware API Plans ────────────────────────────────────────
//
// Phase 6 turns the upstream Phase 1–5 outputs into a structured set of
// *planned* domain endpoints. It is the first phase that emits something
// resembling real API surface, but it stays in shadow mode: nothing is
// mounted, no handlers are generated, no production behaviour changes.
//
// Phase 7 will run the validator + behaviour verifier against these plans
// and Phase 8 will eventually generate the real handler code.

export type DomainApiCategory =
  | 'auth'
  | 'business'
  | 'admin'
  | 'webhook'
  | 'storage'
  | 'billing'
  | 'runtime'
  | 'analytics'

export type DomainApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

export type DomainApiRequiredRole = 'admin' | 'user' | 'system'

export interface DomainApiPlan {
  /** Stable id, e.g. 'submit_generation_job' or 'POST_credits_purchase' */
  id: string
  method: DomainApiMethod
  /** Path template, e.g. '/generation-jobs/:id/cancel' */
  path: string
  /** Human-readable display name */
  name: string
  category: DomainApiCategory
  /** One-sentence description of what the endpoint does */
  purpose: string
  /** Workflow ids this endpoint participates in */
  workflowIds: string[]
  /** Business rule ids this endpoint must enforce */
  businessRuleIds: string[]
  /** State-machine plan ids this endpoint drives, if any */
  stateMachineIds: string[]
  /** Authentication required (false only for unauthenticated endpoints) */
  requiredAuth: boolean
  /** Specific role required — omitted for ordinary authenticated users */
  requiredRole?: DomainApiRequiredRole
  /** True when the endpoint accepts a body or query input that must be schema-validated */
  inputSchemaRequired: boolean
  /** True for list endpoints that return a collection of rows */
  paginationRequired?: boolean
  /** Mutating endpoints + admin endpoints + auth endpoints all require rate limiting */
  rateLimitRequired: boolean
  /** Webhook + retry-safe POST endpoints require an idempotency key */
  idempotencyRequired?: boolean
  /** Endpoints that touch billing / inventory / state-machine guards must run in a transaction */
  transactionRequired?: boolean
  /** Runtime building blocks this endpoint depends on (queue, worker, advisory_locks, etc.) */
  runtimeRequired: string[]
  /** External integrations the endpoint hands off to (stripe, runway, resend, …) */
  integrationsRequired: string[]
  /** Phase 7 behaviour-verifier scenario hints */
  verificationScenarios: string[]
  /** Concrete how-to-implement guidance for the executor */
  implementationHint: string
  /** Always true in Phase 6 — flips to false when Phase 8 generates real handlers */
  shadowMode: true
}

export interface DomainApiPlanReport {
  /** APIs the generator is confident enough to plan */
  apis: DomainApiPlan[]
  /**
   * APIs the generator strongly recommends but has weaker evidence for.
   * Surfaced separately so the dashboard can prompt the user to confirm
   * before they are promoted into `apis`.
   */
  missingButRecommended: DomainApiPlan[]
  /** Composite confidence across all generated APIs */
  overallConfidence: number
  /** Aggregated warnings — sparse prompt, missing rules, etc. */
  warnings: string[]
  /** Always true in Phase 6 */
  shadowMode: true
}

// ─── Phase 7 — Behavior Verification ─────────────────────────────────────────
//
// Phase 7 turns the upstream Phase 1–6 outputs into structured *verification
// scenarios* — a catalog of what must be tested, why, and what would count
// as pass/fail. It is the first phase that names concrete behaviour the
// backend must demonstrate before the readiness label can advance past
// "Needs Verification".
//
// STRICT SHADOW MODE in Phase 7:
//   • No live execution against the workspace DB.
//   • No production routes are mounted.
//   • No schema changes occur.
//   • The verification report is dry-run / planning only.
//
// Phase 8 will eventually run these scenarios against a sandbox.

export type VerificationCategory =
  | 'auth'
  | 'rls'
  | 'billing'
  | 'webhook'
  | 'workflow'
  | 'admin'
  | 'storage'
  | 'state_machine'
  | 'security'
  | 'runtime'

export type VerificationSeverity = 'critical' | 'high' | 'medium' | 'low'

export type VerificationStepAction =
  | 'create_user'
  | 'login'
  | 'call_api'
  | 'create_record'
  | 'attempt_forbidden_access'
  | 'simulate_webhook'
  | 'run_state_transition'
  | 'check_db_effect'
  | 'check_event_emitted'
  | 'check_notification'

export interface VerificationStep {
  /** Stable id within the scenario, e.g. 'create_buyer', 'submit_job' */
  id: string
  action: VerificationStepAction
  /** Target — endpoint path, table name, event name, etc. */
  target: string
  /** Optional inputs supplied to the action */
  input?: Record<string, unknown>
  /** Expected result of this single step */
  expected: string
}

export interface VerificationScenario {
  /** Stable id, e.g. 'user_b_cannot_read_user_a_assets' */
  id: string
  /** Human-readable display name */
  name: string
  category: VerificationCategory
  severity: VerificationSeverity
  /** Workflow ids this scenario verifies */
  workflowIds: string[]
  /** Business rule ids this scenario verifies */
  businessRuleIds: string[]
  /** API plan ids this scenario exercises */
  apiIds: string[]
  /** State machine plan ids this scenario exercises */
  stateMachineIds: string[]
  /** Pre-conditions that must hold before steps run */
  preconditions: string[]
  /** Ordered steps to perform */
  steps: VerificationStep[]
  /** Final pass-criterion description */
  expectedResult: string
  /** What it means if this scenario fails — the user-facing risk */
  failureMeaning: string
  /** True when nothing blocks this scenario from being executed today */
  canRunNow: boolean
  /** Capability / runtime / integration ids that must be wired before run */
  blockedBy: string[]
  /** Concrete how-to-run guidance for the eventual runner */
  implementationHint: string
  /** Always true in Phase 7 */
  shadowMode: true
}

export type VerificationReadinessImpact =
  | 'blocks_production'
  | 'needs_verification'
  | 'verification_ready'

export interface BehaviorVerificationReport {
  scenarios: VerificationScenario[]
  /** Number of scenarios with severity=critical */
  criticalCount: number
  /** Number of scenarios with canRunNow=true */
  runnableCount: number
  /** Number of scenarios with canRunNow=false */
  blockedCount: number
  /** How this report should affect the readiness label */
  readinessImpact: VerificationReadinessImpact
  /** Aggregated warnings — sparse prompt, missing inputs, etc. */
  warnings: string[]
  /** Always true in Phase 7 */
  shadowMode: true
}
