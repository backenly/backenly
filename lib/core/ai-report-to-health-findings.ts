/**
 * AI REPORT → HEALTH FINDING MAPPER — Phase 8 (preview / shadow mode)
 * ====================================================================
 * Converts the Phase 1–7 AI-planning reports into a list of
 * `HealthFindingPreview` objects that the dashboard, observer, and
 * fix-classifier can consume in the same shape they already use for
 * runtime drift findings.
 *
 * STRICT PREVIEW MODE in Phase 8:
 *   • No DB writes.
 *   • No auto-fix execution.
 *   • No live verification execution.
 *   • All previews carry `shadowMode: true`.
 *
 * The optional persistence step lives behind a *separate* flag
 * (`ENABLE_AI_HEALTH_FINDINGS_PERSISTENCE`) and is not implemented in
 * this commit — see Phase 8 docstring at the bottom of this file.
 *
 * Strictly deterministic — no LLM, no DB, no network.
 */

import type { ProductUnderstanding } from '../ai/understanding/types'
import type {
  WorkflowsReport,
  BusinessRulesReport,
  StateMachinesReport,
  PlanValidationReport,
  PlanValidationFinding,
  DomainApiPlanReport,
  BehaviorVerificationReport,
  VerificationScenario,
} from '../ai/planning/types'
import { classifyFix } from './fix-classifier'
import type { VerificationExecutionResult, ScenarioResult } from '../verification/verification-executor'

// ─── Public types ─────────────────────────────────────────────────────────────

export type HealthFindingPreviewSource =
  | 'product_understanding'
  | 'workflow_extractor'
  | 'business_rules'
  | 'state_machines'
  | 'plan_validator'
  | 'domain_api_generator'
  | 'behavior_verification'

export type HealthFindingPreviewType =
  | 'missing_workflow'
  | 'missing_business_rule'
  | 'missing_endpoint'
  | 'missing_runtime'
  | 'missing_integration'
  | 'missing_verification'
  | 'missing_auth'
  | 'missing_rls'
  | 'security_gap'
  | 'readiness_overclaim'
  /** Phase 13 — a live verification scenario executed and its structural checks failed. */
  | 'verification_failed'

export type HealthFindingPreviewSeverity = 'critical' | 'warning' | 'info'

export interface HealthFindingPreview {
  /** Stable de-dupe key — `projectId + source + type + relatedEntityId` */
  id: string
  projectId?: string
  source: HealthFindingPreviewSource
  type: HealthFindingPreviewType
  severity: HealthFindingPreviewSeverity
  title: string
  message: string
  recommendation: string
  autoFixable: boolean
  requiresApproval: boolean
  relatedWorkflowIds?: string[]
  relatedRuleIds?: string[]
  relatedApiIds?: string[]
  relatedScenarioIds?: string[]
  /** Always true in Phase 8 */
  shadowMode: true
}

export interface AiReportInputs {
  projectId?: string
  prompt?: string
  understanding?: ProductUnderstanding
  workflows?: WorkflowsReport
  rules?: BusinessRulesReport
  machines?: StateMachinesReport
  validation?: PlanValidationReport
  apis?: DomainApiPlanReport
  verification?: BehaviorVerificationReport
  /**
   * Normalised integration IDs (e.g. 'stripe', 'openai') whose credentials
   * are already stored in the project vault. Findings for these integrations
   * are suppressed so the dashboard never shows "Connect Stripe" when Stripe
   * is already connected.
   */
  existingIntegrationIds?: string[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeKey(s: string): string {
  return s.replace(/[^a-zA-Z0-9_:.\-/]+/g, '_').slice(0, 160)
}

function buildId(
  projectId: string | undefined,
  source: HealthFindingPreviewSource,
  type: HealthFindingPreviewType,
  relatedEntity: string,
): string {
  const proj = projectId ? `${projectId}:` : ''
  return sanitizeKey(`${proj}${source}:${type}:${relatedEntity}`)
}

/**
 * Map a Phase 5 PlanValidationFinding type onto the existing FindingType
 * vocabulary used by `fix-classifier`. Returns null when no equivalent
 * runtime FindingType exists, in which case we treat the preview as
 * notify-only (autoFixable=false, requiresApproval=false).
 */
function planValidatorTypeToRuntimeFindingType(
  t: PlanValidationFinding['type'],
):
  | 'missing_rls'
  | 'missing_api_definition'
  | 'missing_api_crud'
  | 'missing_rate_limit'
  | 'unprotected_user_data'
  | null {
  switch (t) {
    case 'missing_rls':         return 'missing_rls'
    case 'missing_endpoint':    return 'missing_api_definition'
    case 'missing_rate_limit':  return 'missing_rate_limit'
    case 'missing_validation':  return null // notify-only — no runtime equivalent
    case 'missing_pagination':  return null // notify-only — no runtime equivalent
    case 'missing_index':       return null // notify-only — handled by drift-detector at runtime
    case 'missing_auth':        return null // explicit security gap; needs approval-style messaging
    case 'missing_runtime':     return null
    case 'missing_integration': return null
    case 'missing_business_rule': return null
    case 'missing_verification':  return null
    case 'missing_soft_delete':   return null
    case 'readiness_overclaim':   return null
  }
  return null
}

/**
 * Decide auto-fix / approval / notify-only for a preview *without* executing
 * anything. Reuses fix-classifier when a runtime equivalent exists; otherwise
 * uses a deterministic notify-only default.
 */
function classifyPreview(
  source: HealthFindingPreviewSource,
  type: HealthFindingPreviewType,
  hint: { runtimeMissing?: boolean; integrationMissing?: boolean; planOnly?: boolean },
): { autoFixable: boolean; requiresApproval: boolean } {
  // Notify-only — user must connect external accounts / provision runtime.
  if (type === 'missing_integration') return { autoFixable: false, requiresApproval: false }
  if (type === 'missing_runtime') return { autoFixable: false, requiresApproval: false }
  if (type === 'missing_verification') return { autoFixable: false, requiresApproval: false }
  if (type === 'readiness_overclaim') return { autoFixable: false, requiresApproval: false }
  if (type === 'missing_workflow') return { autoFixable: false, requiresApproval: false }
  if (type === 'missing_business_rule') return { autoFixable: false, requiresApproval: false }

  // Endpoint / RLS / auth / security can sometimes auto-fix while still in
  // plan-only stage.
  if (type === 'missing_endpoint' && hint.planOnly) {
    return { autoFixable: true, requiresApproval: false }
  }
  if (type === 'missing_endpoint') {
    const c = classifyFix('missing_api_definition')
    return {
      autoFixable: c.decision === 'auto',
      requiresApproval: c.decision === 'approval',
    }
  }
  if (type === 'missing_rls') {
    const c = classifyFix('missing_rls')
    return {
      autoFixable: c.decision === 'auto',
      requiresApproval: c.decision === 'approval',
    }
  }
  if (type === 'missing_auth' || type === 'security_gap') {
    return { autoFixable: false, requiresApproval: true }
  }
  // Phase 13 — verification_failed findings always require human review
  if (type === 'verification_failed') {
    return { autoFixable: false, requiresApproval: false }
  }

  return { autoFixable: false, requiresApproval: false }
}

function severityFromValidation(
  s: PlanValidationFinding['severity'],
): HealthFindingPreviewSeverity {
  if (s === 'blocking') return 'critical'
  if (s === 'warning') return 'warning'
  return 'info'
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function mapPlanValidationFindings(
  projectId: string | undefined,
  validation: PlanValidationReport,
): HealthFindingPreview[] {
  const out: HealthFindingPreview[] = []
  for (const f of validation.findings) {
    const previewType = planValidationFindingTypeToPreviewType(f.type)
    const relatedEntity =
      f.appliesTo?.endpointPaths?.[0] ??
      f.appliesTo?.workflowIds?.[0] ??
      f.appliesTo?.stateMachineIds?.[0] ??
      f.appliesTo?.ruleIds?.[0] ??
      f.appliesTo?.tables?.[0] ??
      f.id

    const planOnly =
      f.type === 'missing_endpoint' || f.type === 'missing_validation' ||
      f.type === 'missing_pagination' || f.type === 'missing_index'

    const cls = classifyPreview('plan_validator', previewType, {
      planOnly,
      runtimeMissing: f.type === 'missing_runtime',
      integrationMissing: f.type === 'missing_integration',
    })

    out.push({
      id: buildId(projectId, 'plan_validator', previewType, relatedEntity),
      projectId,
      source: 'plan_validator',
      type: previewType,
      severity: severityFromValidation(f.severity),
      title: titleForPlanValidatorFinding(previewType, f),
      message: f.message,
      recommendation: f.recommendation,
      autoFixable: cls.autoFixable,
      requiresApproval: cls.requiresApproval,
      relatedWorkflowIds: f.appliesTo?.workflowIds,
      relatedRuleIds: f.appliesTo?.ruleIds,
      relatedApiIds: f.appliesTo?.endpointPaths,
      shadowMode: true,
    })
  }
  return out
}

/**
 * Plan-validator finding ids follow deterministic patterns
 * (`missing_integration:stripe`, `runtime_declared:queue`,
 * `missing_runtime:worker`, etc.). Extract the trailing token so the title
 * stays short — it is what the dashboard ranks "Connect X" / "Provision X"
 * actions against.
 */
function titleForPlanValidatorFinding(
  t: HealthFindingPreviewType,
  f: PlanValidationFinding,
): string {
  if (t === 'missing_integration') {
    const m = f.id.match(/^missing_integration:(.+)$/)
    if (m) return `Missing integration — ${m[1]}`
  }
  if (t === 'missing_runtime') {
    const a = f.id.match(/^runtime_declared:(.+)$/)
    if (a) return `Missing runtime — ${a[1]}`
    const b = f.id.match(/^missing_runtime:(.+)$/)
    if (b) return `Missing runtime — ${b[1]}`
  }
  return titleForFinding(t, f.message)
}

function planValidationFindingTypeToPreviewType(
  t: PlanValidationFinding['type'],
): HealthFindingPreviewType {
  switch (t) {
    case 'missing_endpoint':      return 'missing_endpoint'
    case 'missing_auth':          return 'missing_auth'
    case 'missing_validation':    return 'security_gap'
    case 'missing_pagination':    return 'security_gap'
    case 'missing_rate_limit':    return 'security_gap'
    case 'missing_index':         return 'security_gap'
    case 'missing_rls':           return 'missing_rls'
    case 'missing_soft_delete':   return 'security_gap'
    case 'missing_runtime':       return 'missing_runtime'
    case 'missing_integration':   return 'missing_integration'
    case 'missing_business_rule': return 'missing_business_rule'
    case 'missing_verification':  return 'missing_verification'
    case 'readiness_overclaim':   return 'readiness_overclaim'
  }
}

function titleForFinding(t: HealthFindingPreviewType, msg: string): string {
  const trimmed = msg.length > 90 ? msg.slice(0, 87) + '…' : msg
  switch (t) {
    case 'missing_workflow':       return `Missing workflow — ${trimmed}`
    case 'missing_business_rule':  return `Missing business rule — ${trimmed}`
    case 'missing_endpoint':       return `Missing endpoint — ${trimmed}`
    case 'missing_runtime':        return `Missing runtime — ${trimmed}`
    case 'missing_integration':    return `Missing integration — ${trimmed}`
    case 'missing_verification':   return `Missing verification — ${trimmed}`
    case 'missing_auth':           return `Auth gap — ${trimmed}`
    case 'missing_rls':            return `Missing RLS — ${trimmed}`
    case 'security_gap':           return `Security gap — ${trimmed}`
    case 'readiness_overclaim':    return `Readiness overclaim — ${trimmed}`
    case 'verification_failed':    return `Verification failed — ${trimmed}`
  }
}

// ── Phase 7 → previews ────────────────────────────────────────────────────────

function blockerToFinding(
  projectId: string | undefined,
  scenario: VerificationScenario,
  blocker: string,
): HealthFindingPreview | null {
  // Blockers are namespaced strings: "integration:...", "runtime:...", "state_machine:..."
  const [kind, rest] = blocker.split(':', 2)
  if (!kind || !rest) return null

  if (kind === 'integration') {
    const integrationName = rest
      .replace(/_credentials_missing$/, '')
      .replace(/_missing$/, '')
      .replace(/_/g, ' ')
    return {
      id: buildId(projectId, 'behavior_verification', 'missing_integration', `${scenario.id}:${rest}`),
      projectId,
      source: 'behavior_verification',
      type: 'missing_integration',
      severity: scenario.severity === 'critical' ? 'critical' : 'warning',
      title: `Missing integration — ${integrationName}`,
      message: `Scenario "${scenario.name}" cannot run because integration "${integrationName}" is not configured.`,
      recommendation: `Connect ${integrationName} in Project → Integrations so this verification can run.`,
      autoFixable: false,
      requiresApproval: false,
      relatedScenarioIds: [scenario.id],
      relatedWorkflowIds: scenario.workflowIds,
      relatedRuleIds: scenario.businessRuleIds,
      shadowMode: true,
    }
  }

  if (kind === 'runtime') {
    const runtimeName = rest.replace(/_missing$/, '').replace(/_/g, ' ')
    return {
      id: buildId(projectId, 'behavior_verification', 'missing_runtime', `${scenario.id}:${rest}`),
      projectId,
      source: 'behavior_verification',
      type: 'missing_runtime',
      severity: scenario.severity === 'critical' ? 'critical' : 'warning',
      title: `Missing runtime — ${runtimeName}`,
      message: `Scenario "${scenario.name}" cannot run because runtime "${runtimeName}" is not provisioned.`,
      recommendation: `Provision ${runtimeName} runtime so behaviour verification can exercise this scenario.`,
      autoFixable: false,
      requiresApproval: false,
      relatedScenarioIds: [scenario.id],
      relatedWorkflowIds: scenario.workflowIds,
      relatedRuleIds: scenario.businessRuleIds,
      shadowMode: true,
    }
  }

  if (kind === 'state_machine') {
    return {
      id: buildId(projectId, 'behavior_verification', 'missing_workflow', `${scenario.id}:${rest}`),
      projectId,
      source: 'behavior_verification',
      type: 'missing_workflow',
      severity: 'warning',
      title: `Missing state machine — ${rest}`,
      message: `Scenario "${scenario.name}" needs state machine "${rest}" but it is not planned yet.`,
      recommendation: `Re-run the AI plan so state machine "${rest}" is included before verification.`,
      autoFixable: false,
      requiresApproval: false,
      relatedScenarioIds: [scenario.id],
      shadowMode: true,
    }
  }

  return null
}

function mapBehaviorVerification(
  projectId: string | undefined,
  verification: BehaviorVerificationReport,
): HealthFindingPreview[] {
  const out: HealthFindingPreview[] = []
  for (const s of verification.scenarios) {
    if (s.canRunNow) continue
    for (const blocker of s.blockedBy) {
      const f = blockerToFinding(projectId, s, blocker)
      if (f) out.push(f)
    }
  }
  return out
}

// ── Phase 1 → Product Understanding warnings ──────────────────────────────────

function mapProductUnderstanding(
  projectId: string | undefined,
  understanding: ProductUnderstanding,
): HealthFindingPreview[] {
  const out: HealthFindingPreview[] = []
  if (understanding.confidence.band === 'low') {
    out.push({
      id: buildId(projectId, 'product_understanding', 'readiness_overclaim', 'low_confidence'),
      projectId,
      source: 'product_understanding',
      type: 'readiness_overclaim',
      severity: 'warning',
      title: 'Product understanding has low confidence',
      message: `Backenly is not confident about what "${understanding.productLabel}" should be (band=${understanding.confidence.band}).`,
      recommendation: 'Ask the user a clarifying question before generating schema or APIs.',
      autoFixable: false,
      requiresApproval: false,
      shadowMode: true,
    })
  }
  for (const w of understanding.warnings ?? []) {
    out.push({
      id: buildId(projectId, 'product_understanding', 'readiness_overclaim', w.slice(0, 40)),
      projectId,
      source: 'product_understanding',
      type: 'readiness_overclaim',
      severity: 'info',
      title: 'Product understanding warning',
      message: w,
      recommendation: 'Resolve the ambiguity before claiming the backend is production ready.',
      autoFixable: false,
      requiresApproval: false,
      shadowMode: true,
    })
  }
  return out
}

// ── Phase 2 → Workflows that look incomplete ──────────────────────────────────

function mapWorkflows(
  projectId: string | undefined,
  workflows: WorkflowsReport,
): HealthFindingPreview[] {
  const out: HealthFindingPreview[] = []
  if (workflows.needsClarification) {
    out.push({
      id: buildId(projectId, 'workflow_extractor', 'missing_workflow', 'needs_clarification'),
      projectId,
      source: 'workflow_extractor',
      type: 'missing_workflow',
      severity: 'warning',
      title: 'Workflows need clarification',
      message: 'No workflow was detected with reasonable confidence from the prompt.',
      recommendation: 'Ask the user for the primary user-facing flows before building runtime.',
      autoFixable: false,
      requiresApproval: false,
      shadowMode: true,
    })
  }
  for (const w of workflows.workflows ?? []) {
    if ((w.requiredRuntime ?? []).length > 0 && (w.failureHandling ?? []).length === 0) {
      out.push({
        id: buildId(projectId, 'workflow_extractor', 'missing_workflow', `${w.id}:no_failure_handling`),
        projectId,
        source: 'workflow_extractor',
        type: 'missing_workflow',
        severity: 'info',
        title: `Workflow "${w.name}" has no failure handling`,
        message: `Workflow "${w.name}" depends on async runtime but defines no retry/refund/dead-letter steps.`,
        recommendation: 'Add explicit failure-handling steps so partial failures do not corrupt state.',
        autoFixable: false,
        requiresApproval: false,
        relatedWorkflowIds: [w.id],
        shadowMode: true,
      })
    }
  }
  return out
}

// ── Phase 3 → Business rule gaps ──────────────────────────────────────────────

function mapBusinessRules(
  projectId: string | undefined,
  rules: BusinessRulesReport,
): HealthFindingPreview[] {
  const out: HealthFindingPreview[] = []
  // We don't fabricate rule findings here — Phase 5 already cross-checks
  // missing_business_rule. This mapper just surfaces report-level warnings.
  for (const w of rules.warnings ?? []) {
    out.push({
      id: buildId(projectId, 'business_rules', 'missing_business_rule', w.slice(0, 40)),
      projectId,
      source: 'business_rules',
      type: 'missing_business_rule',
      severity: 'info',
      title: 'Business rules warning',
      message: w,
      recommendation: 'Review the business rule extractor warning before claiming production readiness.',
      autoFixable: false,
      requiresApproval: false,
      shadowMode: true,
    })
  }
  return out
}

// ── Phase 4 → State machine warnings ──────────────────────────────────────────

function mapStateMachines(
  projectId: string | undefined,
  machines: StateMachinesReport,
): HealthFindingPreview[] {
  const out: HealthFindingPreview[] = []
  for (const w of machines.warnings ?? []) {
    out.push({
      id: buildId(projectId, 'state_machines', 'missing_workflow', w.slice(0, 40)),
      projectId,
      source: 'state_machines',
      type: 'missing_workflow',
      severity: 'info',
      title: 'State machine warning',
      message: w,
      recommendation: 'Resolve the state-machine warning before exposing endpoints that drive it.',
      autoFixable: false,
      requiresApproval: false,
      shadowMode: true,
    })
  }
  return out
}

// ── Phase 6 → Domain API plan warnings ────────────────────────────────────────

function mapDomainApis(
  projectId: string | undefined,
  apis: DomainApiPlanReport,
): HealthFindingPreview[] {
  const out: HealthFindingPreview[] = []
  for (const a of apis.missingButRecommended ?? []) {
    out.push({
      id: buildId(projectId, 'domain_api_generator', 'missing_endpoint', a.id),
      projectId,
      source: 'domain_api_generator',
      type: 'missing_endpoint',
      severity: 'info',
      title: `Recommended endpoint not yet planned — ${a.method} ${a.path}`,
      message: `Endpoint ${a.method} ${a.path} is recommended but evidence is weak.`,
      recommendation: a.implementationHint || 'Confirm whether this endpoint is required before generation.',
      autoFixable: true,
      requiresApproval: false,
      relatedApiIds: [a.id],
      relatedWorkflowIds: a.workflowIds,
      relatedRuleIds: a.businessRuleIds,
      shadowMode: true,
    })
  }
  return out
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert the available AI-planning reports into a flat list of
 * `HealthFindingPreview`s.
 *
 * Always returns previews — never persists.
 *
 * Findings are de-duplicated by their stable id, so repeated chat runs over
 * the same prompt do not produce noise.
 */
export function aiReportsToHealthFindingsPreview(
  inputs: AiReportInputs,
): HealthFindingPreview[] {
  const all: HealthFindingPreview[] = []

  if (inputs.understanding) {
    all.push(...mapProductUnderstanding(inputs.projectId, inputs.understanding))
  }
  if (inputs.workflows) {
    all.push(...mapWorkflows(inputs.projectId, inputs.workflows))
  }
  if (inputs.rules) {
    all.push(...mapBusinessRules(inputs.projectId, inputs.rules))
  }
  if (inputs.machines) {
    all.push(...mapStateMachines(inputs.projectId, inputs.machines))
  }
  if (inputs.validation) {
    all.push(...mapPlanValidationFindings(inputs.projectId, inputs.validation))
  }
  if (inputs.apis) {
    all.push(...mapDomainApis(inputs.projectId, inputs.apis))
  }
  if (inputs.verification) {
    all.push(...mapBehaviorVerification(inputs.projectId, inputs.verification))
  }

  // De-dupe by id — defence in depth so the dashboard never shows duplicates.
  const seen = new Set<string>()
  const deduped: HealthFindingPreview[] = []
  for (const f of all) {
    if (seen.has(f.id)) continue
    seen.add(f.id)
    deduped.push(f)
  }

  // Suppress missing_integration findings for integrations already connected.
  // Extracts the integration key from the finding id: the token after
  // 'missing_integration:' and before the next ':' (scenarioId segment).
  const connectedSet = new Set(
    (inputs.existingIntegrationIds ?? []).map(id => id.trim().toLowerCase()),
  )
  if (connectedSet.size === 0) return deduped

  const out: HealthFindingPreview[] = []
  for (const f of deduped) {
    if (f.type === 'missing_integration') {
      // id format: {projectId?}:{source}:missing_integration:{scenarioId}:{integrationKey}
      // The integration key is the last segment after the final ':'
      const segments = f.id.split(':')
      const integrationKey = segments[segments.length - 1]?.toLowerCase() ?? ''
      // Also check the raw key without cleanup suffixes (_credentials_missing, _missing)
      const baseKey = integrationKey
        .replace(/_credentials_missing$/, '')
        .replace(/_missing$/, '')
      if (connectedSet.has(integrationKey) || connectedSet.has(baseKey)) continue
    }
    out.push(f)
  }
  return out
}

// ─── Phase 13 — Verification results feedback ────────────────────────────────

/**
 * Apply the output of a verification execution run to a list of existing
 * HealthFindingPreview objects.
 *
 * Rules:
 *   • Failed scenarios → new `verification_failed` findings are appended.
 *   • Passed scenarios → any `missing_verification` findings that reference
 *     the same scenario ID are removed (verification gap is now closed).
 *
 * The returned list is de-duplicated by id using the same stable-key scheme
 * used by the rest of this file. No DB writes occur here.
 */
export function applyVerificationResults(
  projectId: string | undefined,
  existing: HealthFindingPreview[],
  executionResult: VerificationExecutionResult,
): HealthFindingPreview[] {
  const passedIds = new Set(executionResult.passed.map(s => s.scenarioId))

  // Remove missing_verification findings whose scenario is now confirmed passing
  const retained = existing.filter(f => {
    if (f.type !== 'missing_verification') return true
    if (!f.relatedScenarioIds || f.relatedScenarioIds.length === 0) return true
    // Keep the finding only if NONE of its related scenarios passed
    const anyPassed = f.relatedScenarioIds.some(id => passedIds.has(id))
    return !anyPassed
  })

  // Create new verification_failed findings for failed scenarios
  const newFailedFindings: HealthFindingPreview[] = executionResult.failed.map(
    (scenario) => buildVerificationFailedFinding(projectId, scenario),
  )

  const all = [...retained, ...newFailedFindings]

  // De-dupe by id
  const seen = new Set<string>()
  const out: HealthFindingPreview[] = []
  for (const f of all) {
    if (seen.has(f.id)) continue
    seen.add(f.id)
    out.push(f)
  }
  return out
}

function buildVerificationFailedFinding(
  projectId: string | undefined,
  scenario: ScenarioResult,
): HealthFindingPreview {
  const failedChecks = scenario.checks.filter(c => !c.passed)
  const firstFail = failedChecks[0]

  const severity: HealthFindingPreviewSeverity =
    scenario.severity === 'critical' ? 'critical'
    : scenario.severity === 'high' ? 'warning'
    : 'info'

  const message = firstFail
    ? firstFail.message
    : scenario.reason

  const recommendation = buildVerificationRecommendation(scenario.category, firstFail)

  return {
    id: buildId(projectId, 'behavior_verification', 'verification_failed', scenario.scenarioId),
    projectId,
    source: 'behavior_verification',
    type: 'verification_failed',
    severity,
    title: `Verification failed — ${scenario.name}`,
    message,
    recommendation,
    autoFixable: false,
    requiresApproval: false,
    relatedScenarioIds: [scenario.scenarioId],
    shadowMode: true,
  }
}

function buildVerificationRecommendation(category: string, failedCheck: { stepId: string; message: string } | undefined): string {
  if (!failedCheck) return 'Review the verification failure and address the underlying structural gap.'
  switch (failedCheck.stepId) {
    case 'auth_users_table':
      return 'Run the AI setup flow to provision the users table in the workspace schema.'
    case 'auth_jwt_config':
      return 'Enable auth for this project — say "enable auth" in chat or use Auth & Users → Sign-in methods; the JWT secret is provisioned automatically.'
    case 'rls_user_tables':
      return 'Enable RLS on the listed tables by applying the "own_rows" policy.'
    case 'sm_status_constraints':
      return 'Add CHECK constraints to the status column to enforce valid state transitions.'
    case 'security_no_unprotected_data':
      return 'Apply RLS policies to all tables that store user-identifiable data.'
    default:
      return `Address the structural gap identified in check "${failedCheck.stepId}": ${failedCheck.message}`
  }
}

/**
 * Reserved entry-point for Phase-8 step 2 (optional persistence).
 * In this commit it is intentionally a no-op: the persistence flag is
 * implemented but writes are deferred to a follow-up commit so the
 * preview layer can ship in isolation.
 *
 * The flag is read here so call sites can remain unchanged when the
 * follow-up wiring lands.
 */
export function persistHealthFindingsIfEnabled(
  _findings: HealthFindingPreview[],
): { persisted: false; reason: string } {
  if (process.env.ENABLE_AI_HEALTH_FINDINGS_PERSISTENCE !== 'true') {
    return { persisted: false, reason: 'ENABLE_AI_HEALTH_FINDINGS_PERSISTENCE is not enabled' }
  }
  // Intentionally NOT writing in this commit. Persistence wiring will
  // land in a follow-up so the preview layer ships in isolation.
  return { persisted: false, reason: 'preview-only mode — persistence wiring deferred to follow-up commit' }
}
