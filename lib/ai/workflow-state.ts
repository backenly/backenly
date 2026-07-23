/**
 * PERSISTENT WORKFLOW STATE MACHINE
 * ===================================
 * Tracks multi-turn interactions that require user input before proceeding.
 *
 * Architecture:
 *   - Every incoming chat message checks for an active PendingWorkflow first
 *   - If a workflow is active: validate the input, execute or reject
 *   - If no workflow: continue to normal intent classification
 *
 * Workflow types:
 *   oauth_setup            — collecting Google/GitHub OAuth credentials
 *   api_key_setup          — collecting Stripe/Resend/OpenAI/etc. API keys
 *   webhook_secret_setup   — collecting webhook signing secrets
 *   storage_creation       — confirming storage bucket name
 *   destructive_confirmation — confirming delete/drop/rollback
 *   deploy_confirmation    — confirming deployment
 *   rollback_confirmation  — confirming rollback to prior version
 *   integration_setup      — multi-step integration setup
 *   build_resume           — resuming a paused build job
 *
 * Validation rules are provider-specific:
 *   Google OAuth  → clientId ends with .apps.googleusercontent.com
 *                → clientSecret starts with GOCSPX-
 *   Resend        → key starts with re_
 *   Stripe        → secret key starts with sk_test_ or sk_live_
 *                → webhook starts with whsec_
 *   OpenAI        → key starts with sk-
 *   Anthropic     → key starts with sk-ant-
 */

import { prisma } from '@/lib/db/prisma'

// ── Types ──────────────────────────────────────────────────────────────────────

export type WorkflowType =
  | 'oauth_setup'
  | 'api_key_setup'
  | 'webhook_secret_setup'
  | 'storage_creation'
  | 'destructive_confirmation'
  | 'deploy_confirmation'
  | 'rollback_confirmation'
  | 'integration_setup'
  | 'build_resume'

export type WorkflowStatus =
  | 'awaiting_input'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired'

export interface WorkflowValidationRule {
  pattern: string   // regex string
  hint: string      // what the user should provide
  required: boolean
}

export interface PendingWorkflowData {
  id: string
  projectId: string
  userId: string
  type: WorkflowType
  status: WorkflowStatus
  provider?: string
  action?: string
  buildJobId?: string
  requiredInputs: Record<string, WorkflowValidationRule>
  validationRules: Record<string, string>
  context: Record<string, unknown>
  collectedInputs: Record<string, string>
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
}

export interface WorkflowValidationResult {
  valid: boolean
  /** Which inputs were satisfied in this message */
  satisfied: string[]
  /** Which inputs are still missing */
  remaining: string[]
  /** Human-readable rejection reason when valid=false */
  rejectionMessage?: string
  /** All required inputs collected — workflow can proceed */
  complete: boolean
}

export interface CreateWorkflowOptions {
  type: WorkflowType
  provider?: string
  action?: string
  buildJobId?: string
  requiredInputs?: Record<string, WorkflowValidationRule>
  validationRules?: Record<string, string>
  context?: Record<string, unknown>
  /** TTL in minutes — default 30 */
  ttlMinutes?: number
}

// ── Provider-specific validation presets ─────────────────────────────────────

const PROVIDER_VALIDATION_PRESETS: Record<string, Record<string, WorkflowValidationRule>> = {
  google: {
    clientId: {
      pattern: '\\.apps\\.googleusercontent\\.com$',
      hint: 'Google Client ID (ends with .apps.googleusercontent.com)',
      required: true,
    },
    clientSecret: {
      pattern: '^GOCSPX-[A-Za-z0-9_\\-]{10,}$',
      hint: 'Google Client Secret (starts with GOCSPX-)',
      required: true,
    },
  },
  github: {
    clientId: {
      pattern: '^(Ov23li|Iv1\\.)[A-Za-z0-9]{16,}$',
      hint: 'GitHub OAuth App Client ID',
      required: true,
    },
    clientSecret: {
      pattern: '^[a-f0-9]{40}$',
      hint: 'GitHub OAuth App Client Secret (40-char hex)',
      required: true,
    },
  },
  stripe: {
    secretKey: {
      pattern: '^sk_(test|live)_[A-Za-z0-9]{24,}$',
      hint: 'Stripe Secret Key (starts with sk_test_ or sk_live_)',
      required: true,
    },
  },
  stripe_webhook: {
    webhookSecret: {
      pattern: '^whsec_[A-Za-z0-9\\+/=]{32,}$',
      hint: 'Stripe Webhook Secret (starts with whsec_)',
      required: true,
    },
  },
  resend: {
    apiKey: {
      pattern: '^re_[A-Za-z0-9_]{16,}$',
      hint: 'Resend API Key (starts with re_)',
      required: true,
    },
  },
  openai: {
    apiKey: {
      pattern: '^sk-[A-Za-z0-9\\-_]{20,}$',
      hint: 'OpenAI API Key (starts with sk-)',
      required: true,
    },
  },
  anthropic: {
    apiKey: {
      pattern: '^sk-ant-[A-Za-z0-9\\-_]{20,}$',
      hint: 'Anthropic API Key (starts with sk-ant-)',
      required: true,
    },
  },
  sendgrid: {
    apiKey: {
      pattern: '^SG\\.[A-Za-z0-9_\\-\\.]{20,}$',
      hint: 'SendGrid API Key (starts with SG.)',
      required: true,
    },
  },
}

// ── CRUD helpers ──────────────────────────────────────────────────────────────

export async function createWorkflow(
  projectId: string,
  userId: string,
  opts: CreateWorkflowOptions,
): Promise<PendingWorkflowData> {
  const preset = opts.provider ? PROVIDER_VALIDATION_PRESETS[opts.provider] : undefined
  const requiredInputs = opts.requiredInputs ?? preset ?? {}
  const validationRules: Record<string, string> = opts.validationRules ?? {}
  for (const [key, rule] of Object.entries(requiredInputs)) {
    validationRules[key] = rule.pattern
  }

  const ttl = opts.ttlMinutes ?? 30
  const expiresAt = new Date(Date.now() + ttl * 60 * 1000)

  // Cancel any existing active workflow of the same type for this project
  await prisma.pendingWorkflow.updateMany({
    where: { projectId, type: opts.type, status: { in: ['awaiting_input', 'executing'] } },
    data: { status: 'cancelled', updatedAt: new Date() },
  })

  const row = await prisma.pendingWorkflow.create({
    data: {
      projectId,
      userId,
      type: opts.type,
      status: 'awaiting_input',
      provider: opts.provider,
      action: opts.action,
      buildJobId: opts.buildJobId,
      requiredInputs: requiredInputs as any,
      validationRules: validationRules as any,
      context: (opts.context ?? {}) as any,
      collectedInputs: {} as any,
      expiresAt,
    },
  })

  return rowToData(row)
}

export async function getActiveWorkflow(projectId: string): Promise<PendingWorkflowData | null> {
  const row = await prisma.pendingWorkflow.findFirst({
    where: {
      projectId,
      status: { in: ['awaiting_input', 'executing'] },
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) return null
  return rowToData(row)
}

export async function completeWorkflow(id: string): Promise<void> {
  await prisma.pendingWorkflow.update({
    where: { id },
    data: { status: 'completed', updatedAt: new Date() },
  })
}

export async function cancelWorkflow(id: string, reason: 'failed' | 'cancelled' | 'expired' = 'cancelled'): Promise<void> {
  await prisma.pendingWorkflow.update({
    where: { id },
    data: { status: reason, updatedAt: new Date() },
  })
}

export async function cancelAllActiveWorkflows(projectId: string): Promise<void> {
  await prisma.pendingWorkflow.updateMany({
    where: { projectId, status: { in: ['awaiting_input', 'executing'] } },
    data: { status: 'cancelled', updatedAt: new Date() },
  })
}

export async function updateCollectedInputs(
  id: string,
  inputs: Record<string, string>,
): Promise<void> {
  const row = await prisma.pendingWorkflow.findUnique({ where: { id } })
  if (!row) return
  const current = (row.collectedInputs as Record<string, string>) ?? {}
  await prisma.pendingWorkflow.update({
    where: { id },
    data: {
      collectedInputs: { ...current, ...inputs } as any,
      updatedAt: new Date(),
    },
  })
}

export async function expireStaleWorkflows(): Promise<void> {
  await prisma.pendingWorkflow.updateMany({
    where: {
      status: { in: ['awaiting_input', 'executing'] },
      expiresAt: { lt: new Date() },
    },
    data: { status: 'expired', updatedAt: new Date() },
  })
}

// ── Input validation ──────────────────────────────────────────────────────────

/**
 * Validate user input against the active workflow's required inputs.
 * Extracts matching values from the message text using the workflow's rules.
 */
export function validateWorkflowInput(
  message: string,
  workflow: PendingWorkflowData,
): WorkflowValidationResult {
  const rules = workflow.requiredInputs
  const collected = { ...workflow.collectedInputs }
  const newlySatisfied: string[] = []
  const rejections: string[] = []

  for (const [field, rule] of Object.entries(rules)) {
    if (collected[field]) continue // already satisfied

    const regex = new RegExp(rule.pattern, 'i')
    // Try to find the value in the message (could be mixed with other text)
    const words = message.split(/[\s,;\n\r]+/).filter(Boolean)
    const match = words.find(w => regex.test(w)) ?? (regex.test(message.trim()) ? message.trim() : null)

    if (match) {
      collected[field] = match.trim()
      newlySatisfied.push(field)
    } else if (rule.required) {
      rejections.push(field)
    }
  }

  const allRequired = Object.entries(rules).filter(([, r]) => r.required).map(([k]) => k)
  const remaining = allRequired.filter(k => !collected[k])
  const complete = remaining.length === 0

  if (newlySatisfied.length === 0 && Object.keys(rules).length > 0) {
    // Nothing from this message matched any required input pattern
    const hints = Object.entries(rules)
      .filter(([k]) => !collected[k])
      .map(([, r]) => `• ${r.hint}`)
      .join('\n')

    let rejectionMessage: string
    switch (workflow.type) {
      case 'oauth_setup':
        rejectionMessage = buildOAuthRejectionMessage(workflow.provider ?? 'oauth', collected, rules)
        break
      case 'api_key_setup':
        rejectionMessage = `That doesn't look like a valid ${workflow.provider ?? 'API'} key.\n\nExpected format:\n${hints}`
        break
      case 'webhook_secret_setup':
        rejectionMessage = `That doesn't look like a valid webhook secret.\n\nExpected format:\n${hints}`
        break
      default:
        rejectionMessage = `I'm waiting for:\n${hints}\n\nPlease provide the missing input to continue.`
    }

    return { valid: false, satisfied: [], remaining: allRequired.filter(k => !collected[k]), rejectionMessage, complete: false }
  }

  return {
    valid: true,
    satisfied: newlySatisfied,
    remaining,
    complete,
  }
}

function buildOAuthRejectionMessage(
  provider: string,
  collected: Record<string, string>,
  rules: Record<string, WorkflowValidationRule>,
): string {
  const providerName = provider.charAt(0).toUpperCase() + provider.slice(1)
  const missing = Object.entries(rules)
    .filter(([k]) => !collected[k])
    .map(([, r]) => `• ${r.hint}`)
    .join('\n')

  const lines: string[] = [
    `That input doesn't match the expected ${providerName} credential format.`,
    '',
    `I'm still waiting for:`,
    missing,
    '',
  ]

  if (provider === 'google') {
    lines.push(`**Where to find these:**`)
    lines.push(`1. Go to [Google Cloud Console](https://console.cloud.google.com/)`)
    lines.push(`2. APIs & Services → Credentials → Create OAuth 2.0 Client ID`)
    lines.push(`3. Paste the Client ID (ends with .apps.googleusercontent.com) here`)
    lines.push(`4. Then paste the Client Secret (starts with GOCSPX-)`)
  }

  return lines.join('\n')
}

// ── Human-readable workflow status ───────────────────────────────────────────

export function describeWorkflowExpectation(workflow: PendingWorkflowData): string {
  const rules = workflow.requiredInputs
  const collected = workflow.collectedInputs
  const providerName = workflow.provider
    ? workflow.provider.charAt(0).toUpperCase() + workflow.provider.slice(1)
    : ''

  const pending = Object.entries(rules)
    .filter(([k]) => !collected[k])
    .map(([, r]) => `• ${r.hint}`)

  if (pending.length === 0) return 'All inputs collected — processing…'

  switch (workflow.type) {
    case 'oauth_setup':
      return `**${providerName} OAuth setup in progress.**\n\nStill waiting for:\n${pending.join('\n')}`
    case 'api_key_setup':
      return `**${providerName} API key setup in progress.**\n\nStill waiting for:\n${pending.join('\n')}`
    case 'webhook_secret_setup':
      return `**Webhook secret setup in progress.**\n\nStill waiting for:\n${pending.join('\n')}`
    case 'destructive_confirmation':
      return `**Waiting for your confirmation** to proceed with: ${workflow.action ?? 'destructive action'}.\n\nType "confirm" to proceed or "cancel" to abort.`
    case 'deploy_confirmation':
      return `**Waiting for your confirmation** to deploy.\n\nType "deploy" or "confirm" to proceed, or "cancel" to abort.`
    case 'rollback_confirmation':
      return `**Waiting for your confirmation** to roll back.\n\nType "confirm rollback" to proceed or "cancel" to abort.`
    default:
      return `**Setup in progress.**\n\nStill waiting for:\n${pending.join('\n')}`
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function rowToData(row: any): PendingWorkflowData {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    type: row.type as WorkflowType,
    status: row.status as WorkflowStatus,
    provider: row.provider ?? undefined,
    action: row.action ?? undefined,
    buildJobId: row.buildJobId ?? undefined,
    requiredInputs: (row.requiredInputs as Record<string, WorkflowValidationRule>) ?? {},
    validationRules: (row.validationRules as Record<string, string>) ?? {},
    context: (row.context as Record<string, unknown>) ?? {},
    collectedInputs: (row.collectedInputs as Record<string, string>) ?? {},
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
