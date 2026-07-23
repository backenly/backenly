/**
 * MULTI-TOOL EXECUTOR CHAIN
 * ==========================
 * Detects when a single user intent requires multiple integration executors
 * and chains them in the correct dependency order.
 *
 * Example:
 *   "Users can pay and get an email receipt"
 *   → chain: [stripe, resend, function(on_payment → send_email)]
 *
 *   "Add Google login and send welcome email"
 *   → chain: [google_auth, resend]
 *
 * Philosophy:
 *   User describes the OUTCOME. Agent figures out the CHAIN.
 *   One message → multiple executors → one clean response.
 */

import type { IntegrationId } from '@/lib/integrations'

export interface ChainStep {
  integrationId: IntegrationId
  label: string
  dependsOn?: IntegrationId[]  // Must complete before this step runs
}

export interface ExecutorChain {
  steps: ChainStep[]
  description: string
}

export interface ChainResult {
  success: boolean
  results: Array<{ integrationId: string; success: boolean; message: string }>
  summary: string
  needsKeys: Array<{ integrationId: string; keyHint: string }>
}

// ─── Chain Detection Patterns ─────────────────────────────────────────────────

interface ChainPattern {
  pattern: RegExp
  chain: Omit<ChainStep, never>[]
  description: string
}

const CHAIN_PATTERNS: ChainPattern[] = [
  // Payment + email receipt
  {
    pattern: /pay.*email|email.*receipt|payment.*confirm|charge.*notify|subscription.*email/i,
    chain: [
      { integrationId: 'stripe', label: 'Stripe payments' },
      { integrationId: 'resend', label: 'Email receipts', dependsOn: ['stripe'] },
    ],
    description: 'payment processing + email receipts',
  },
  // Stripe + order notifications (paraphrase-robust — catches verbose messages)
  {
    pattern: /stripe.*order|order.*stripe|notify.*order.*stripe|stripe.*notify.*order|payment.*order.*notify|order.*payment.*notify|integrate.*stripe.*notify|notify.*stripe/i,
    chain: [
      { integrationId: 'stripe', label: 'Stripe payments' },
    ],
    description: 'Stripe payments for order tracking',
  },
  // Auth + email (common SaaS combo)
  {
    pattern: /google.*analytic|sign.*in.*track|login.*analytic|auth.*track/i,
    chain: [
      { integrationId: 'google_auth', label: 'Google OAuth' },
      { integrationId: 'resend', label: 'Welcome email', dependsOn: ['google_auth'] },
    ],
    description: 'Google auth + welcome email',
  },
  // Full SaaS stack
  {
    pattern: /saas|full.*stack.*backend|complete.*backend|production.*ready/i,
    chain: [
      { integrationId: 'stripe', label: 'Payments' },
      { integrationId: 'resend', label: 'Email', dependsOn: ['stripe'] },
      { integrationId: 'openai', label: 'AI features' },
    ],
    description: 'full SaaS stack (payments + email + AI)',
  },
  // Notify on signup
  {
    pattern: /welcome.*email|email.*signup|notify.*register|send.*email.*user.*sign/i,
    chain: [
      { integrationId: 'resend', label: 'Email service' },
      { integrationId: 'function', label: 'Welcome email trigger', dependsOn: ['resend'] },
    ],
    description: 'welcome email on user signup',
  },
  // AI + email notifications
  {
    pattern: /ai.*feature.*track|llm.*analytic|openai.*track/i,
    chain: [
      { integrationId: 'openai', label: 'OpenAI' },
      { integrationId: 'resend', label: 'Usage notifications', dependsOn: ['openai'] },
    ],
    description: 'AI features + email notifications',
  },
  // Stripe + AI (e.g. "pay for AI features")
  {
    pattern: /stripe.*openai|openai.*stripe|pay.*ai|ai.*subscription|subscription.*ai/i,
    chain: [
      { integrationId: 'stripe', label: 'Stripe billing' },
      { integrationId: 'openai', label: 'OpenAI', dependsOn: ['stripe'] },
    ],
    description: 'Stripe billing + OpenAI features',
  },
  // Email + AI (smart email workflows)
  {
    pattern: /email.*analytic|email.*track|analytic.*email|track.*email/i,
    chain: [
      { integrationId: 'resend', label: 'Email' },
      { integrationId: 'openai', label: 'AI email content', dependsOn: ['resend'] },
    ],
    description: 'email delivery + AI-powered content',
  },
  // Stripe + order status notifications (verbose/paraphrased)
  {
    pattern: /implement.*stripe.*and.*notif|add.*stripe.*and.*send.*email|stripe.*order.*notif|order.*stripe.*and.*email/i,
    chain: [
      { integrationId: 'stripe', label: 'Stripe payments' },
      { integrationId: 'resend', label: 'Order notifications', dependsOn: ['stripe'] },
      { integrationId: 'function', label: 'Trigger: notify on order status', dependsOn: ['stripe'] },
    ],
    description: 'Stripe payments + order status notifications',
  },
  // Full e-commerce automation: payments + email + stock management
  {
    pattern: /ecommerce.*automat|automat.*ecommerce|implement.*ecommerce|professional.*ecommerce/i,
    chain: [
      { integrationId: 'stripe', label: 'Stripe payments' },
      { integrationId: 'resend', label: 'Email notifications', dependsOn: ['stripe'] },
    ],
    description: 'e-commerce: payments + email notifications',
  },
  // Auth + email (welcome email on signup)
  {
    pattern: /auth.*welcome.*email|signup.*welcome.*email|register.*send.*email|email.*after.*signup/i,
    chain: [
      { integrationId: 'resend', label: 'Email service' },
      { integrationId: 'function', label: 'Welcome email on signup', dependsOn: ['resend'] },
    ],
    description: 'signup → welcome email',
  },
]

/**
 * Extract all directly-mentioned integration IDs from a message.
 * Used for compound intent decomposition when a single message mentions
 * multiple integrations (e.g., "notify on order AND integrate Stripe").
 */
export function extractMentionedIntegrations(message: string): IntegrationId[] {
  const lower = message.toLowerCase()
  const found: IntegrationId[] = []

  if (/\bstripe\b|payment\s+processing|subscription\s+billing|implement.*payment|add.*payment/.test(lower)) found.push('stripe')
  if (/\bresend\b|\bsendgrid\b|send.*email|email.*send|welcome\s+email|transactional\s+email|email.*notif|notif.*email/.test(lower)) found.push('resend')
  if (/\bopenai\b|\bgpt\b|\banthropic\b|claude\s+ai/.test(lower)) found.push('openai')

  return found
}

/**
 * Detect if a message requires a multi-executor chain.
 * Returns null if no chain is needed (single executor or build operation).
 */
export function detectExecutorChain(message: string): ExecutorChain | null {
  const lower = message.toLowerCase()

  for (const { pattern, chain, description } of CHAIN_PATTERNS) {
    if (pattern.test(lower)) {
      return { steps: chain as ChainStep[], description }
    }
  }

  return null
}

/**
 * Execute a chain of integration executors in dependency order.
 * If a required step (dependsOn) fails, dependent steps are skipped.
 */
export async function executeChain(
  chain: ExecutorChain,
  projectId: string,
  integrationParams: Record<string, any> = {}
): Promise<ChainResult> {
  const { dispatchIntegration } = await import('@/lib/integrations')
  const { emit } = await import('@/lib/events/bus')

  const results: ChainResult['results'] = []
  const needsKeys: ChainResult['needsKeys'] = []
  const completed = new Set<string>()

  for (const step of chain.steps) {
    // Check if dependencies are satisfied
    if (step.dependsOn && step.dependsOn.some(dep => !completed.has(dep))) {
      results.push({
        integrationId: step.integrationId,
        success: false,
        message: `Skipped: dependency ${step.dependsOn?.join(', ')} did not complete`,
      })
      continue
    }

    const result = await dispatchIntegration(
      step.integrationId,
      projectId,
      integrationParams[step.integrationId] ?? {}
    )

    if (result.needsApiKey || result.needsCredentials) {
      needsKeys.push({
        integrationId: step.integrationId,
        keyHint: result.keyHint || result.credentialHint || `Provide API key for ${step.integrationId}`,
      })
      results.push({ integrationId: step.integrationId, success: false, message: result.message })
      continue
    }

    if (result.success) {
      completed.add(step.integrationId)
      emit('integration.activated', projectId, { integrationId: step.integrationId, chain: true })
    }

    results.push({
      integrationId: step.integrationId,
      success: result.success,
      message: result.message,
    })
  }

  const successCount = results.filter(r => r.success).length
  const totalCount = chain.steps.length
  const allSuccess = successCount === totalCount && needsKeys.length === 0

  let summary: string
  if (allSuccess) {
    const labels = chain.steps.map(s => s.label).join(', ')
    summary = `Done: ${labels} configured.`
  } else if (needsKeys.length > 0) {
    // Terse, direct — no "To complete X, provide..." chat tone
    const firstMissing = needsKeys[0]
    const integrationName = firstMissing.integrationId.charAt(0).toUpperCase() + firstMissing.integrationId.slice(1)
    summary = `${integrationName} key required.\n\n${firstMissing.keyHint}`
    if (needsKeys.length > 1) {
      const remaining = needsKeys.slice(1).map(k => k.integrationId).join(', ')
      summary += `\n\nAfter that: ${remaining} key needed.`
    }
  } else if (successCount > 0) {
    const done = results.filter(r => r.success).map(r => r.integrationId).join(', ')
    summary = `Partial: ${done} configured. Some steps failed.`
  } else {
    summary = `Failed: ${results[0]?.message ?? 'Unknown error'}`
  }

  return { success: allSuccess, results, summary, needsKeys }
}
