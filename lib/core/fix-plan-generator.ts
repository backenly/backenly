/**
 * FIX PLAN GENERATOR — Phase 12
 * ==============================
 * Converts HealthFindingPreview[] (from the Phase 1–8 AI pipeline) and
 * RawFinding[] (from the workspace observer) into FixPlan objects that the
 * auto-fix engine can act on.
 *
 * Each FixPlan records:
 *   - What action to take (connect_integration, provision_runtime, etc.)
 *   - Whether it can auto-run (autoFixable) or needs human approval
 *   - Concrete steps the dashboard can render before executing
 *
 * Hard guardrails — these can NEVER be overridden by feature flags:
 *   - Integration credential connections → always requiresApproval
 *   - Auth mutations → always requiresApproval when severity is critical
 *   - Destructive operations → always requiresApproval
 *
 * Strictly deterministic — no LLM, no DB, no network.
 */

import { classifyFix } from './fix-classifier'
import type { HealthFindingPreview, HealthFindingPreviewType, HealthFindingPreviewSeverity } from './ai-report-to-health-findings'
import type { FindingType, FindingSeverity, RawFinding } from './types'

// ─── Public types ─────────────────────────────────────────────────────────────

export type FixPlanAction =
  | 'connect_integration'
  | 'provision_runtime'
  | 'apply_rls'
  | 'generate_api'
  | 'fix_auth'
  | 'close_security_gap'
  | 'run_verification'
  | 'clarify_workflow'
  | 'clarify_business_rule'
  | 'notify_only'

export interface FixPlanStep {
  order: number
  description: string
  automated: boolean
}

export interface FixPlan {
  /** Stable id: "fix:<findingType>:<target>" */
  id: string
  /** Source finding id (HealthFindingPreview.id or synthetic key for RawFinding) */
  findingId: string
  /** String union of HealthFindingPreviewType | FindingType */
  findingType: string
  findingSeverity: 'critical' | 'warning' | 'info'
  action: FixPlanAction
  /** Concrete target — integration name, table name, runtime type, etc. */
  target: string
  title: string
  reason: string
  autoFixable: boolean
  requiresApproval: boolean
  notifyOnly: boolean
  steps: FixPlanStep[]
}

// ─── Preview finding classifier ───────────────────────────────────────────────

function classifyPreviewFinding(finding: HealthFindingPreview): {
  action: FixPlanAction
  autoFixable: boolean
  requiresApproval: boolean
  notifyOnly: boolean
  target: string
} {
  const target = _extractTarget(finding)

  switch (finding.type) {
    case 'missing_integration':
      // Credentials come from the user — never auto-connect
      return { action: 'connect_integration', autoFixable: false, requiresApproval: true, notifyOnly: false, target }

    case 'missing_runtime':
      // Provisioning a queue/worker/cache is purely additive
      return { action: 'provision_runtime', autoFixable: true, requiresApproval: false, notifyOnly: false, target }

    case 'missing_rls':
      return { action: 'apply_rls', autoFixable: true, requiresApproval: false, notifyOnly: false, target }

    case 'missing_endpoint':
      return { action: 'generate_api', autoFixable: true, requiresApproval: false, notifyOnly: false, target }

    case 'missing_auth':
      // Critical auth issues need human sign-off; warnings are additive
      return finding.severity === 'critical'
        ? { action: 'fix_auth', autoFixable: false, requiresApproval: true, notifyOnly: false, target }
        : { action: 'fix_auth', autoFixable: true, requiresApproval: false, notifyOnly: false, target }

    case 'security_gap':
      return finding.severity === 'critical'
        ? { action: 'close_security_gap', autoFixable: false, requiresApproval: true, notifyOnly: false, target }
        : { action: 'close_security_gap', autoFixable: true, requiresApproval: false, notifyOnly: false, target }

    case 'missing_verification':
      return { action: 'run_verification', autoFixable: false, requiresApproval: false, notifyOnly: true, target }

    case 'missing_workflow':
      return { action: 'clarify_workflow', autoFixable: false, requiresApproval: false, notifyOnly: true, target }

    case 'missing_business_rule':
      return { action: 'clarify_business_rule', autoFixable: false, requiresApproval: false, notifyOnly: true, target }

    case 'readiness_overclaim':
    default:
      return { action: 'notify_only', autoFixable: false, requiresApproval: false, notifyOnly: true, target }
  }
}

// ─── Raw finding classifier ───────────────────────────────────────────────────

function classifyRawFinding(finding: RawFinding): {
  action: FixPlanAction
  autoFixable: boolean
  requiresApproval: boolean
  notifyOnly: boolean
  target: string
} {
  const classification = classifyFix(finding.type)
  const autoFixable = classification.decision === 'auto'
  const requiresApproval = classification.decision === 'approval'
  const notifyOnly = classification.decision === 'notify_only'
  const action = _findingTypeToAction(finding.type)
  const target = (finding.details.tableName as string | undefined)
    ?? (finding.details.triggerId as string | undefined)
    ?? finding.type.replace(/_/g, '-')
  return { action, autoFixable, requiresApproval, notifyOnly, target }
}

function _findingTypeToAction(type: FindingType): FixPlanAction {
  switch (type) {
    case 'missing_rls':
    case 'unprotected_user_data':
    case 'rls_expression_invalid':
      return 'apply_rls'

    case 'api_drift':
    case 'missing_api_definition':
    case 'missing_api_crud':
    case 'dead_api_endpoint':
      return 'generate_api'

    case 'auth_jwt_missing':
    case 'auth_users_table_missing':
    case 'broken_auth':
    case 'oauth_config_invalid':
    case 'oauth_redirect_uri_missing':
      return 'fix_auth'

    case 'integration_key_invalid':
    case 'integration_webhook_failing':
    case 'integration_smtp_unreachable':
      return 'connect_integration'

    case 'missing_rate_limit':
    case 'realtime_gap':
    case 'missing_fk':
    case 'missing_fk_index':
      return 'provision_runtime'

    case 'workflow_broken':
      return 'clarify_workflow'

    case 'shadow_mutation':
    case 'orphan_table':
    case 'broken_webhook':
    case 'auth_spike':
    case 'deploy_failure':
    default:
      return 'notify_only'
  }
}

// ─── Step builder ─────────────────────────────────────────────────────────────

function buildSteps(action: FixPlanAction, target: string): FixPlanStep[] {
  switch (action) {
    case 'connect_integration':
      return [
        { order: 1, description: `Provide API credentials for ${target}`, automated: false },
        { order: 2, description: `Verify connectivity to ${target}`, automated: true },
        { order: 3, description: `Register ${target} in project integration config`, automated: true },
      ]

    case 'provision_runtime':
      return [
        { order: 1, description: `Provision ${target} resource`, automated: true },
        { order: 2, description: `Register ${target} in workspace configuration`, automated: true },
      ]

    case 'apply_rls':
      return [
        { order: 1, description: `Apply row-level security policy to ${target}`, automated: true },
        { order: 2, description: `Verify policy is active in pg_class`, automated: true },
      ]

    case 'generate_api':
      return [
        { order: 1, description: `Generate REST endpoints for ${target}`, automated: true },
        { order: 2, description: `Register API definition in platform`, automated: true },
      ]

    case 'fix_auth':
      return [
        { order: 1, description: `Repair auth infrastructure for ${target}`, automated: true },
        { order: 2, description: `Verify JWT configuration is valid`, automated: true },
      ]

    case 'close_security_gap':
      return [
        { order: 1, description: `Review security gap for ${target}`, automated: false },
        { order: 2, description: `Apply recommended security policy`, automated: true },
      ]

    case 'run_verification':
      return [
        { order: 1, description: `Run behavior verification scenarios for ${target}`, automated: true },
      ]

    case 'clarify_workflow':
      return [
        { order: 1, description: `Clarify intended workflow for ${target} with project owner`, automated: false },
      ]

    case 'clarify_business_rule':
      return [
        { order: 1, description: `Clarify business rule enforcement for ${target} with project owner`, automated: false },
      ]

    default:
      return [
        { order: 1, description: `Review finding for ${target}`, automated: false },
      ]
  }
}

// ─── Target extractor (HealthFindingPreview path) ────────────────────────────

function _extractTarget(finding: HealthFindingPreview): string {
  const text = `${finding.title} ${finding.message} ${finding.recommendation}`.toLowerCase()

  const integrations = ['stripe', 'sendgrid', 'twilio', 'openai', 'anthropic', 'pusher',
    'cloudinary', 'aws s3', 's3', 'smtp', 'paddle', 'paypal', 'runway', 'stability',
    'kling', 'github', 'google', 'slack']
  for (const name of integrations) {
    if (text.includes(name)) return name
  }

  const runtimes = ['queue', 'worker', 'scheduler', 'cache', 'redis', 'cron']
  for (const rt of runtimes) {
    if (text.includes(rt)) return rt
  }

  if (finding.relatedApiIds?.length) return finding.relatedApiIds[0]
  if (finding.relatedWorkflowIds?.length) return finding.relatedWorkflowIds[0]
  if (finding.relatedRuleIds?.length) return finding.relatedRuleIds[0]

  // Last resort: last substantive word from the title
  const words = finding.title.toLowerCase().replace(/[^a-z0-9_ ]/g, '').split(' ').filter(w => w.length > 2)
  return words[words.length - 1] ?? 'unknown'
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert HealthFindingPreview[] (Phase 1–8 AI pipeline output) into FixPlan[].
 * Called from ResponseStreamer after health_findings_preview is emitted.
 */
export function generateFixPlans(findings: HealthFindingPreview[]): FixPlan[] {
  return findings.map((finding) => {
    const cls = classifyPreviewFinding(finding)
    return {
      id: `fix:${finding.type}:${cls.target}`,
      findingId: finding.id,
      findingType: finding.type,
      findingSeverity: finding.severity,
      action: cls.action,
      target: cls.target,
      title: `Fix: ${finding.title}`,
      reason: finding.recommendation,
      autoFixable: cls.autoFixable,
      requiresApproval: cls.requiresApproval,
      notifyOnly: cls.notifyOnly,
      steps: buildSteps(cls.action, cls.target),
    }
  })
}

/**
 * Convert RawFinding[] (workspace observer runtime output) into FixPlan[].
 * Called from runObserverForProject when ENABLE_AUTO_FIX_PLANNER is on.
 */
export function generateFixPlansFromRawFindings(findings: RawFinding[]): FixPlan[] {
  return findings.map((finding) => {
    const cls = classifyRawFinding(finding)
    return {
      id: `fix:${finding.type}:${cls.target}`,
      findingId: `${finding.type}:${cls.target}`,
      findingType: finding.type,
      findingSeverity: finding.severity,
      action: cls.action,
      target: cls.target,
      title: `Fix: ${finding.type.replace(/_/g, ' ')}`,
      reason: classifyFix(finding.type).suggestedAction ?? classifyFix(finding.type).reason,
      autoFixable: cls.autoFixable,
      requiresApproval: cls.requiresApproval,
      notifyOnly: cls.notifyOnly,
      steps: buildSteps(cls.action, cls.target),
    }
  })
}
