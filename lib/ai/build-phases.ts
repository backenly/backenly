/**
 * BUILD PHASES
 * ============
 * Explicit phase model for backend construction.
 *
 * A build progresses through 7 phases. Each phase can be:
 *   pending | running | blocked | completed | skipped | failed
 *
 * Blocked phases pause until external dependencies are resolved (e.g. API keys).
 * All non-blocked phases continue executing in parallel intent. This is what
 * separates a "flow-first builder" from a "table-first completionist."
 */

// ── Phase Types ───────────────────────────────────────────────────────────────

export type BuildPhase =
  | 'DOMAIN_MODEL'    // Tables, columns, indexes, FK relationships
  | 'AUTH_ROLES'      // Auth system, roles, RLS permissions
  | 'BUSINESS_FLOWS'  // Custom endpoints, state machines, business logic
  | 'INTEGRATIONS'    // Third-party services (Stripe, Resend, OpenAI…)
  | 'AUTOMATION'      // Triggers, cron jobs, AI functions
  | 'VERIFICATION'    // Behavioral end-to-end checks
  | 'DEPLOYMENT'      // Deploy readiness

export type PhaseStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'skipped'
  | 'failed'

export interface PhaseState {
  phase: BuildPhase
  status: PhaseStatus
  /** Subgoal IDs that belong to this phase */
  subgoalIds: string[]
  completedSubgoalIds: string[]
  /** Why this phase is blocked (integration name, e.g. "Stripe") */
  blockedReason?: string
  /** Which secret/credential is needed */
  blockedOn?: string
  startedAt?: string
  completedAt?: string
}

/** Top-level build graph — the source of truth for phase progress. */
export interface BuildPlanGraph {
  projectId: string
  goal: string
  phases: PhaseState[]
  currentPhase: BuildPhase | null
  overallStatus: 'building' | 'blocked' | 'completed' | 'failed'
  /** Integrations that are blocked on missing credentials */
  blockedIntegrations: Array<{
    integration: string
    reason: string
    secretsNeeded: string[]
  }>
}

// ── Phase Order + Labels ──────────────────────────────────────────────────────

/** Default execution order — phases run in this sequence. */
export const PHASE_ORDER: BuildPhase[] = [
  'DOMAIN_MODEL',
  'AUTH_ROLES',
  'BUSINESS_FLOWS',
  'INTEGRATIONS',
  'AUTOMATION',
  'VERIFICATION',
]

export const PHASE_LABELS: Record<BuildPhase, string> = {
  DOMAIN_MODEL:    'Domain Model',
  AUTH_ROLES:      'Auth & Roles',
  BUSINESS_FLOWS:  'Business Logic',
  INTEGRATIONS:    'Integrations',
  AUTOMATION:      'Automation & Triggers',
  VERIFICATION:    'Verification',
  DEPLOYMENT:      'Deployment',
}

// ── Phase Classifier ──────────────────────────────────────────────────────────

/**
 * Map a subgoal description to the phase it belongs to.
 * Used to group subgoals into phases before the loop starts.
 */
export function classifySubgoalPhase(description: string): BuildPhase {
  const d = description.toLowerCase()

  if (/\b(auth|login|signup|register|jwt|password|session|role|permission|rbac|access.control|rls|row.level)\b/.test(d)) {
    return 'AUTH_ROLES'
  }

  if (/\b(stripe|payment|checkout|webhook|resend|sendgrid|email.send|twilio|sms|openai|anthropic|integration|api.?key|oauth.provider|external.service)\b/.test(d)) {
    return 'INTEGRATIONS'
  }

  if (/\b(trigger|cron|schedule|recurring|ai.function|serverless|automat|on\s+(insert|update|delete)|event.driven|background.job)\b/.test(d)) {
    return 'AUTOMATION'
  }

  if (/\b(verify|test\s+the|check\s+that|behavioral|confirm|end.to.end|e2e|works?\s+(correctly|end))\b/.test(d)) {
    return 'VERIFICATION'
  }

  if (/\b(endpoint|custom.route|state.machine|business.logic|checkout.flow|order.flow|cart|refund|custom.api)\b/.test(d)) {
    return 'BUSINESS_FLOWS'
  }

  if (/\b(deploy|production|live|readiness)\b/.test(d)) {
    return 'DEPLOYMENT'
  }

  // Default: data layer
  return 'DOMAIN_MODEL'
}

// ── Graph Factory ─────────────────────────────────────────────────────────────

/**
 * Build a BuildPlanGraph from a flat list of subgoals.
 * Groups subgoals by phase, respects PHASE_ORDER for rendering.
 */
export function buildPlanGraph(
  projectId: string,
  goal: string,
  subgoals: Array<{ id: string; description: string }>,
): BuildPlanGraph {
  const phaseMap = new Map<BuildPhase, string[]>()

  for (const sg of subgoals) {
    const phase = classifySubgoalPhase(sg.description)
    if (!phaseMap.has(phase)) phaseMap.set(phase, [])
    phaseMap.get(phase)!.push(sg.id)
  }

  const phases: PhaseState[] = PHASE_ORDER
    .filter(p => phaseMap.has(p))
    .map(p => ({
      phase: p,
      status: 'pending' as PhaseStatus,
      subgoalIds: phaseMap.get(p)!,
      completedSubgoalIds: [],
    }))

  return {
    projectId,
    goal,
    phases,
    currentPhase: phases[0]?.phase ?? null,
    overallStatus: 'building',
    blockedIntegrations: [],
  }
}

// ── Format Helpers ────────────────────────────────────────────────────────────

/**
 * Format the build graph as a structured status block suitable for the
 * chat response (shown instead of or alongside the step list).
 *
 * Example output:
 *   **Building backend**
 *
 *   **Completed**
 *     ✓ Domain Model
 *     ✓ Auth & Roles
 *
 *   **Blocked**
 *     ⏸ Integrations — Stripe requires secret key
 *     🔑 Stripe: paste your Stripe secret key to unblock this phase
 *
 *   **Pending**
 *     ○ Automation & Triggers
 *     ○ Verification
 */
export function formatBuildStatus(graph: BuildPlanGraph): string {
  const lines: string[] = ['**Building backend**', '']

  const completed  = graph.phases.filter(p => p.status === 'completed')
  const blocked    = graph.phases.filter(p => p.status === 'blocked')
  const inProgress = graph.phases.filter(p => p.status === 'running')
  const pending    = graph.phases.filter(p => p.status === 'pending')

  if (completed.length > 0) {
    lines.push('**Completed**')
    for (const p of completed) lines.push(`  ✓ ${PHASE_LABELS[p.phase]}`)
    lines.push('')
  }

  if (blocked.length > 0) {
    lines.push('**Blocked**')
    for (const p of blocked) {
      lines.push(`  ⏸ ${PHASE_LABELS[p.phase]}${p.blockedReason ? ` — ${p.blockedReason}` : ''}`)
    }
    for (const bi of graph.blockedIntegrations) {
      lines.push(`  🔑 ${bi.integration}: ${bi.reason}`)
    }
    lines.push('')
  }

  if (inProgress.length > 0) {
    lines.push('**Building**')
    for (const p of inProgress) lines.push(`  ⟳ ${PHASE_LABELS[p.phase]}`)
    lines.push('')
  }

  if (pending.length > 0) {
    lines.push('**Pending**')
    for (const p of pending) lines.push(`  ○ ${PHASE_LABELS[p.phase]}`)
  }

  return lines.join('\n').trim()
}

/**
 * Produce a compact phase-grouped plan event payload.
 * Used by the `plan` stream event to show the user what phases will run.
 */
export function buildPhaseGroups(
  subgoals: Array<{ id: string; description: string }>,
): Array<{ phase: BuildPhase; label: string; subgoalIds: string[] }> {
  const graph = buildPlanGraph('', '', subgoals)
  return graph.phases.map(p => ({
    phase: p.phase,
    label: PHASE_LABELS[p.phase],
    subgoalIds: p.subgoalIds,
  }))
}
