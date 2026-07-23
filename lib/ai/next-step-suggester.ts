/**
 * POST-EXECUTION INTELLIGENCE — Next Step Suggester
 * ===================================================
 * After every successful execution, reads the current backend state
 * and proactively surfaces the single most valuable next action.
 *
 * This is what makes the AI feel "alive and proactive" vs. dead after execution.
 *
 * Example:
 *   User builds users + posts + comments
 *   Agent responds:
 *     "Done: users, posts, comments created. FKs enforced.
 *      Next: Enable auth so users can sign up → type 'enable auth'"
 */

import { prisma } from '@/lib/db/prisma'

export interface NextStep {
  action: string          // Short label, e.g. "Enable auth"
  reason: string          // Why this is recommended
  trigger: string         // What user should type to trigger it
  priority: 'critical' | 'high' | 'medium'
}

export interface ProjectState {
  hasTables: boolean
  hasAuth: boolean
  hasApis: boolean
  hasFrontend: boolean
  hasDeployment: boolean
  hasPayments: boolean
  hasEmail: boolean
  hasAnalytics: boolean
  tableNames: string[]
  activeIntegrations: string[]
}

/** Read current project state from DB. */
export async function readProjectState(projectId: string): Promise<ProjectState> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      activeIntegrations: true,
      isFrontendConnected: true,
      isDeployed: true,
      authManifest: true,
      tables: { select: { name: true } },
    },
  })

  const integrations = (project?.activeIntegrations as Record<string, any>) ?? {}
  const activeIntegrations = Object.keys(integrations).filter(k => integrations[k]?.enabled)

  return {
    hasTables: (project?.tables?.length ?? 0) > 0,
    hasAuth: !!(project?.authManifest as any)?.enabled,
    hasApis: (project?.tables?.length ?? 0) > 0, // APIs auto-generated with tables
    hasFrontend: project?.isFrontendConnected ?? false,
    hasDeployment: project?.isDeployed ?? false,
    hasPayments: activeIntegrations.includes('stripe'),
    hasEmail: activeIntegrations.includes('resend') || activeIntegrations.includes('sendgrid'),
    hasAnalytics: activeIntegrations.includes('posthog') || activeIntegrations.includes('plausible'),
    tableNames: project?.tables?.map(t => t.name) ?? [],
    activeIntegrations,
  }
}

/**
 * Determine the single best next step based on project state.
 * Returns null if the project is fully set up.
 */
export function suggestNextStep(state: ProjectState, justBuilt?: string[]): NextStep | null {
  // If nothing is built yet, nothing to suggest
  if (!state.hasTables) return null

  // Priority 1: Auth — most SaaS apps need this first
  if (!state.hasAuth) {
    return {
      action: 'Enable auth',
      reason: 'Users need to sign up and sign in',
      trigger: 'enable auth',
      priority: 'critical',
    }
  }

  // Priority 2: Connect frontend — developers want to use what they built
  if (!state.hasFrontend) {
    return {
      action: 'Connect frontend',
      reason: 'Get your SDK snippet to start using your backend',
      trigger: 'connect frontend',
      priority: 'high',
    }
  }

  // Priority 3: Deploy — make it live
  if (!state.hasDeployment) {
    return {
      action: 'Deploy',
      reason: 'Make your backend live and accessible',
      trigger: 'deploy my project',
      priority: 'high',
    }
  }

  // Priority 4: Payments — if subscription-like tables exist
  const hasSubscriptionTables = state.tableNames.some(t =>
    ['subscription', 'subscriptions', 'plan', 'plans', 'billing', 'payment'].includes(t.toLowerCase())
  )
  if (hasSubscriptionTables && !state.hasPayments) {
    return {
      action: 'Enable Stripe payments',
      reason: 'Subscription tables detected — connect Stripe to process payments',
      trigger: 'enable stripe payments',
      priority: 'high',
    }
  }

  // Priority 5: Email — if user/auth exists
  if (state.hasAuth && !state.hasEmail) {
    return {
      action: 'Enable email',
      reason: 'Send welcome emails and notifications to users',
      trigger: 'enable email with Resend',
      priority: 'medium',
    }
  }

  // Priority 6: Analytics
  if (!state.hasAnalytics) {
    return {
      action: 'Enable analytics',
      reason: 'Track how users are using your backend',
      trigger: 'enable PostHog analytics',
      priority: 'medium',
    }
  }

  return null
}

/**
 * Suggest the top N next steps in priority order.
 */
export function suggestNextSteps(state: ProjectState, justBuilt?: string[], maxSteps = 3): NextStep[] {
  const steps: NextStep[] = []

  if (!state.hasTables) return steps

  if (!state.hasAuth) steps.push({
    action: 'enable auth', reason: 'users need to sign up and sign in', trigger: 'enable auth', priority: 'critical',
  })
  if (!state.hasFrontend) steps.push({
    action: 'connect frontend', reason: 'get SDK snippet to use your backend', trigger: 'connect frontend', priority: 'high',
  })
  if (!state.hasDeployment) steps.push({
    action: 'deploy', reason: 'make it live', trigger: 'deploy', priority: 'high',
  })

  const hasSubscriptionTables = state.tableNames.some(t =>
    ['subscription', 'subscriptions', 'plan', 'plans', 'billing', 'payment'].includes(t.toLowerCase())
  )
  if (hasSubscriptionTables && !state.hasPayments) steps.push({
    action: 'enable Stripe', reason: 'subscription tables detected', trigger: 'enable stripe payments', priority: 'high',
  })

  if (state.hasAuth && !state.hasEmail) steps.push({
    action: 'enable email', reason: 'send welcome emails to users', trigger: 'enable email with Resend', priority: 'medium',
  })

  return steps.slice(0, maxSteps)
}

/**
 * Format the next step as a single-line suggestion appended to the success message.
 * Example: "\n\nNext: Enable auth — users need to sign up → type 'enable auth'"
 */
export function formatNextStepHint(step: NextStep): string {
  return `\n\n**Next:** ${step.action} — ${step.reason}\n→ type \`${step.trigger}\``
}

/**
 * Format multiple next steps as a numbered list so it reads like engineer guidance.
 * Example:
 *   Next steps:
 *   1. Connect frontend — get SDK snippet to use your backend
 *   2. Deploy — make it live
 */
export function formatNextStepsHint(steps: NextStep[]): string {
  if (steps.length === 0) return ''
  if (steps.length === 1) return formatNextStepHint(steps[0])
  const lines = steps.map((s, i) => `${i + 1}. **${s.action}** — ${s.reason} → \`${s.trigger}\``).join('\n')
  return `\n\n**Next steps:**\n${lines}`
}

/**
 * Full pipeline: read state → compute suggestion → format hint.
 * Returns empty string if no suggestion.
 */
export async function getNextStepHint(
  projectId: string,
  justBuilt?: string[]
): Promise<string> {
  try {
    const state = await readProjectState(projectId)
    const steps = suggestNextSteps(state, justBuilt, 3)
    if (steps.length === 0) return ''
    return formatNextStepsHint(steps)
  } catch {
    return '' // Non-fatal — never block the main response
  }
}

/**
 * GAP 7: Return structured NextStep chips for the UI.
 * These are rendered as clickable chips that pre-fill the chat input.
 */
export async function getNextStepsChips(
  projectId: string,
  justBuilt?: string[]
): Promise<NextStep[]> {
  try {
    const state = await readProjectState(projectId)
    return suggestNextSteps(state, justBuilt, 3)
  } catch {
    return []
  }
}
