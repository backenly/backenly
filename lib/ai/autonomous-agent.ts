/**
 * AUTONOMOUS BACKEND AI AGENT
 * ============================
 * 12-layer architecture: understands, decides, executes, verifies, adapts.
 *
 * NOT a chatbot. Does not suggest. Executes.
 *
 * Execution path (single, canonical):
 *   Intent → Goal → Permission → Strategy → Plan → Tool → Execute
 *   → Observe → Adapt → Verify → Log → Respond
 *
 * Intent types:
 *   BUILD       — create tables, APIs, auth, storage
 *   MODIFY      — add/rename/remove columns, change settings
 *   FIX         — repair FKs, constraints, broken state
 *   QUESTION    — read-only queries, describe schema
 *   CONFIRM     — user confirming a pending plan
 *   INTEGRATION — enable Stripe, Google Auth, email, etc.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type IntentType = 'BUILD' | 'MODIFY' | 'FIX' | 'QUESTION' | 'CONFIRM' | 'INTEGRATION'

export type ExecutionStrategy =
  | 'pattern-based'     // Known architecture pattern
  | 'schema-fix'        // Repair broken schema
  | 'direct-mutation'   // Single DDL mutation
  | 'integration-setup' // Third-party service setup

export interface StructuredGoal {
  intent: IntentType
  goal: string
  scope: string
  strategy: ExecutionStrategy
  entities: string[]
  integrationId?: string
  confidence: number
}

export interface AgentResult {
  success: boolean
  type: IntentType
  message: string
  executed: boolean
  needsApiKey?: boolean
  keyHint?: string
  needsCredentials?: boolean
  credentialHint?: string
  needsConfirmation?: boolean
  permissionDenied?: boolean
  data?: any
  // ── Confidence Explainability ──
  reasoning?: string          // Why this strategy was chosen
  confidence?: number         // 0-1 agent confidence in the result
  alternativeStrategies?: string[]  // Other approaches considered
}

// ─── Layer 1: Intent Classifier ──────────────────────────────────────────────

/**
 * Returns true when the message is clearly about BUILDING a schema/backend,
 * even if it contains integration keywords like "payments".
 * This prevents e.g. "build ecommerce with payments" from being hijacked
 * into the Stripe integration flow.
 */
function isSchemaBuildIntent(message: string): boolean {
  const lower = message.toLowerCase()
  // Build/create verb + structural noun: "build ecommerce with payments" ≠ "Connect Stripe"
  if (
    /\b(build|create|make|setup|generate|design)\b/.test(lower) &&
    /\b(table|schema|database|backend|entity|entities|with|model|structure|endpoint|endpoints|api|route|routes)\b/.test(lower)
  ) return true
  // Schema-mutation patterns should never be treated as integration requests
  // e.g. "Add a payments column", "Create an invoices table", "Rename billing field"
  if (/\b(add|remove|rename|alter|modify)\s+(a\s+|an\s+)?(column|field|table|attribute|index)\b/.test(lower)) return true
  if (/\b(create|add)\s+(a\s+|an\s+)?\w+\s+table\b/.test(lower)) return true
  return false
}

/**
 * Fast regex-based intent classification — zero latency, used as fallback.
 * Call classifyIntentLLM() for higher accuracy on ambiguous messages.
 */
export function classifyIntent(message: string, hasExistingSchema: boolean): IntentType {
  const lower = message.toLowerCase().trim()

  // CONFIRM — user saying yes to a pending plan
  if (/^(yes|yeah|yep|go ahead|proceed|confirm|do it|build it|sounds good|looks good|let's go|ok|okay|sure|approved|correct|right|perfect|great|exactly)[\s!.]*$/.test(lower)) {
    return 'CONFIRM'
  }

  // INTEGRATION — third-party service setup
  // Guard: if the message is building a schema that mentions payment/analytics keywords,
  // treat it as BUILD, not INTEGRATION. "Build ecommerce with payments" ≠ "Connect Stripe".
  if (
    !isSchemaBuildIntent(message) &&
    /stripe|payment|subscription|billing|google auth|github auth|oauth|resend|sendgrid|send.*email|openai|gpt|anthropic|claude.*ai|posthog|plausible|connect.*frontend|frontend.*connect|generate.*sdk|sdk.*snippet|next\.?js|react.*frontend|vue.*frontend|svelte.*frontend|connect.*react|connect.*next|connect.*vue/.test(lower)
  ) {
    return 'INTEGRATION'
  }

  // FIX — repair broken state
  if (
    /fix|repair|broken|missing.*fk|foreign key|constraint|relation.*missing|integrity|orphan|corrupt|error in.*schema|schema.*error/.test(lower)
  ) {
    return 'FIX'
  }

  // QUESTION — read-only queries
  if (
    /^(what|how|why|show|list|describe|get|tell me|explain|which|who|where|when|is there|are there|do (i|you|we)|can (i|you)|does)/.test(lower) ||
    /^(show me|list all|describe my|what.*table|how many|what.*api|what.*column|what.*schema)/.test(lower)
  ) {
    return 'QUESTION'
  }

  // MODIFY — change existing schema/config
  if (
    (hasExistingSchema && /add.*column|rename|remove|delete.*column|change.*type|update.*schema|modify|alter|drop/.test(lower)) ||
    /add.*field|remove.*field|add.*index|make.*unique|make.*required|make.*optional/.test(lower)
  ) {
    return 'MODIFY'
  }

  // BUILD — default for new backend creation
  return 'BUILD'
}

interface LLMIntentResult {
  intent: IntentType
  integrations: string[]
  compound: boolean
  subGoals: string[]
  confidence: number
}

/**
 * LLM-based intent classification using gpt-4o-mini.
 * More accurate than regex for paraphrased or complex requests.
 * Cost: ~$0.0001 per call. Falls back to regex on error.
 */
export async function classifyIntentLLM(
  message: string,
  hasExistingSchema: boolean
): Promise<LLMIntentResult> {
  try {
    const { getOpenAIClient } = await import('./openai-service')
    const openai = getOpenAIClient()

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 150,
      messages: [
        {
          role: 'system',
          content: `You classify backend developer requests. Return JSON only:
{
  "intent": "BUILD|INTEGRATION|MODIFY|FIX|QUESTION|CONFIRM",
  "integrations": ["stripe","resend","sendgrid","openai","twilio","posthog","google_auth","github_auth"],
  "compound": boolean,
  "subGoals": string[],
  "confidence": 0.0-1.0
}

Rules:
- BUILD: create new tables/backend structures
- INTEGRATION: connect 3rd-party service (Stripe, email, auth providers, etc.)
- MODIFY: change existing schema (add column, rename, alter)
- FIX: repair broken state, missing FK, constraints
- QUESTION: read-only query about the schema
- CONFIRM: user agreeing to proceed with a previous plan
- compound: true if multiple independent goals in one message
- subGoals: list of individual goals if compound is true`,
        },
        { role: 'user', content: message },
      ],
    })

    const parsed = JSON.parse(response.choices[0].message.content || '{}')
    return {
      intent: (parsed.intent as IntentType) || classifyIntent(message, hasExistingSchema),
      integrations: Array.isArray(parsed.integrations) ? parsed.integrations : [],
      compound: Boolean(parsed.compound),
      subGoals: Array.isArray(parsed.subGoals) ? parsed.subGoals : [],
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
    }
  } catch (err) {
    console.error('[ClassifyIntentLLM] LLM classification failed, using regex fallback:', err)
    // Graceful degradation to regex
    return {
      intent: classifyIntent(message, hasExistingSchema),
      integrations: [],
      compound: false,
      subGoals: [],
      confidence: 0.6,
    }
  }
}

// ─── Layer 2: Goal Understanding ─────────────────────────────────────────────

/** Expand vague user input into a structured, executable goal. */
export function expandGoal(message: string, intent: IntentType): StructuredGoal {
  const lower = message.toLowerCase()

  if (intent === 'INTEGRATION') {
    if (/stripe|payment|subscription/.test(lower)) {
      return { intent, goal: 'configure Stripe payments', scope: 'project-wide', strategy: 'integration-setup', entities: ['subscriptions', 'payment_events'], integrationId: 'stripe', confidence: 0.95 }
    }
    if (/google auth/.test(lower)) {
      return { intent, goal: 'enable Google OAuth authentication', scope: 'auth system', strategy: 'integration-setup', entities: [], integrationId: 'google_auth', confidence: 0.95 }
    }
    if (/github auth/.test(lower)) {
      return { intent, goal: 'enable GitHub OAuth authentication', scope: 'auth system', strategy: 'integration-setup', entities: [], integrationId: 'github_auth', confidence: 0.95 }
    }
    if (/resend|send.*email|email.*send|welcome email/.test(lower)) {
      return { intent, goal: 'configure email via Resend', scope: 'notification system', strategy: 'integration-setup', entities: ['email_events'], integrationId: 'resend', confidence: 0.9 }
    }
    if (/sendgrid/.test(lower)) {
      return { intent, goal: 'configure email via SendGrid', scope: 'notification system', strategy: 'integration-setup', entities: ['email_events'], integrationId: 'sendgrid', confidence: 0.95 }
    }
    if (/openai|gpt|chatbot/.test(lower)) {
      return { intent, goal: 'enable OpenAI AI features', scope: 'AI layer', strategy: 'integration-setup', entities: ['ai_responses'], integrationId: 'openai', confidence: 0.95 }
    }
    if (/anthropic|claude.*ai/.test(lower)) {
      return { intent, goal: 'enable Anthropic Claude AI features', scope: 'AI layer', strategy: 'integration-setup', entities: ['ai_responses'], integrationId: 'anthropic', confidence: 0.95 }
    }
    if (/\bposthog\b/.test(lower)) {
      return { intent, goal: 'enable PostHog analytics', scope: 'analytics layer', strategy: 'integration-setup', entities: ['analytics_events'], integrationId: 'posthog', confidence: 0.9 }
    }
    if (/plausible/.test(lower)) {
      return { intent, goal: 'enable Plausible analytics', scope: 'analytics layer', strategy: 'integration-setup', entities: [], integrationId: 'plausible', confidence: 0.95 }
    }
    if (/connect.*frontend|frontend.*connect|generate.*sdk|sdk.*snippet|next\.?js|react.*frontend|vue.*frontend|svelte.*frontend|connect.*react|connect.*next|connect.*vue/.test(lower)) {
      return { intent, goal: 'generate SDK snippet and connect frontend', scope: 'frontend integration', strategy: 'integration-setup', entities: [], integrationId: 'frontend', confidence: 0.95 }
    }
  }

  if (intent === 'FIX') {
    if (/foreign key|fk|relation/.test(lower)) {
      return { intent, goal: 'repair foreign key constraints', scope: 'all tables', strategy: 'schema-fix', entities: [], confidence: 0.9 }
    }
    return { intent, goal: 'detect and repair schema issues', scope: 'full schema', strategy: 'schema-fix', entities: [], confidence: 0.8 }
  }

  return {
    intent,
    goal: message,
    scope: 'workspace',
    strategy: intent === 'MODIFY' ? 'direct-mutation' : 'pattern-based',
    entities: [],
    confidence: 0.75,
  }
}

// ─── Layer 3: Strategy Planner ────────────────────────────────────────────────

export function planStrategy(goal: StructuredGoal): ExecutionStrategy {
  if (goal.intent === 'INTEGRATION') return 'integration-setup'
  if (goal.intent === 'FIX') return 'schema-fix'
  if (goal.intent === 'MODIFY') return 'direct-mutation'
  return goal.strategy
}

// ─── Layer 6+9: Execution + Self-Correction ───────────────────────────────────

async function executeFkRepair(projectId: string): Promise<AgentResult> {
  const { repairForeignKeysGlobally } = await import('./fk-repair')
  const { runBehavioralVerification } = await import('./behavioral-verifier')
  const { emit } = await import('@/lib/events/bus')

  try {
    await repairForeignKeysGlobally(projectId).catch(() => {})
    const bvResult = await runBehavioralVerification(projectId)

    if (bvResult.passed) {
      emit('fix.applied', projectId, { action: 'full-schema-repair' })
      return {
        success: true,
        type: 'FIX',
        message: 'Schema scan complete.\n\nAll behavioral checks pass.\nNo changes were required.',
        executed: false,
      }
    }

    const failures = bvResult.checks.filter(c => !c.skipped && !c.passed)
    const failureSummary = failures.map(f => `• **${f.name}**: ${f.error ?? 'unknown'}`).join('\n')
    emit('fix.applied', projectId, { action: 'schema-repair', bvPassed: false, failureCount: failures.length })
    return {
      success: false,
      type: 'FIX',
      message: `Schema scan complete.\n\n**${failures.length} issue(s) detected:**\n\n${failureSummary}\n\nSay "deploy" to retry or ask about a specific failure.`,
      executed: true,
    }
  } catch (err: any) {
    return { success: false, type: 'FIX', message: `Schema scan failed: ${err.message}`, executed: false }
  }
}

async function executeAuthPermFix(projectId: string): Promise<AgentResult> {
  const { collectProof } = await import('@/lib/ai/proof-system')
  const { executeAction } = await import('./minimal-executor')
  const { emit } = await import('@/lib/events/bus')

  try {
    const proof = await collectProof(projectId)
    const issues: string[] = []
    const applied: string[] = []

    // Check 1: Auth enabled?
    if (!proof.authEnabled) {
      issues.push('Auth not configured — users cannot sign in (no JWT secret set)')
    }

    // Check 2: Tables with no RLS policies
    const tablesWithPolicies = new Set(proof.rlsPolicies.map(p => p.table))
    const unprotectedTables = proof.tables.filter(t => !tablesWithPolicies.has(t) && t !== 'users')
    if (unprotectedTables.length > 0) {
      issues.push(`${unprotectedTables.length} table(s) have no access policies: ${unprotectedTables.join(', ')}`)

      if (proof.authEnabled) {
        // Apply appropriate default policy based on table name heuristic
        for (const table of unprotectedTables.slice(0, 6)) {
          const isUserScoped = /\b(post|order|comment|message|review|note|task|item|cart|session|profile|booking|invoice|ticket)\b/i.test(table)
          const template = isUserScoped ? 'own_rows' : 'public_read'
          try {
            const result = await executeAction(
              { action: 'SET_PERMISSION', params: { tableName: table, template } },
              projectId,
            )
            if (result.success) applied.push(`${table} — ${template.replace('_', ' ')} policy applied`)
          } catch { /* non-fatal */ }
        }
      }
    }

    // Check 3: Policies exist but auth is off — policies won't fire
    if (!proof.authEnabled && proof.rlsPolicies.length > 0) {
      issues.push('RLS policies configured but auth is disabled — policies will not be enforced')
    }

    if (issues.length === 0) {
      return {
        success: true,
        type: 'FIX',
        message: 'Auth scan complete.\n\nNo permission issues detected.\nNo changes were required.',
        executed: false,
      }
    }

    const lines: string[] = ['**Auth & Permission Scan**', '']
    lines.push(`**Issues detected (${issues.length}):**`)
    issues.forEach(i => lines.push(`⚠️ ${i}`))

    if (applied.length > 0) {
      emit('fix.applied', projectId, { action: 'auth-permission-repair', appliedCount: applied.length })
      lines.push('', `**Applied (${applied.length}):**`)
      applied.forEach(a => lines.push(`✓ ${a}`))
    } else if (unprotectedTables.length > 0 && !proof.authEnabled) {
      lines.push('', '**Cannot auto-apply RLS:** Enable auth first.')
      lines.push('Say "enable auth" to configure JWT authentication, then re-run this scan.')
    } else if (unprotectedTables.length > 0) {
      lines.push('', '**Auto-fix failed.** Try again or apply policies manually via the Permissions panel.')
    }

    return {
      success: applied.length > 0,
      type: 'FIX',
      message: lines.join('\n'),
      executed: applied.length > 0,
    }
  } catch (err: any) {
    return { success: false, type: 'FIX', message: `Auth scan failed: ${err.message}`, executed: false }
  }
}

function executeSchemaFix(projectId: string, message: string = ''): Promise<AgentResult> {
  const lower = message.toLowerCase()
  const isAuthPerm = /\b(auth|permission|rls|access|policy|policies|jwt|login|security|credential|role)\b/.test(lower)
  return isAuthPerm ? executeAuthPermFix(projectId) : executeFkRepair(projectId)
}

async function executeIntegrationSetup(
  goal: StructuredGoal,
  projectId: string,
  params: Record<string, any>,
  input?: AgentInput
): Promise<AgentResult> {
  if (!goal.integrationId) {
    return { success: false, type: 'INTEGRATION', message: 'Integration not recognized.', executed: false }
  }

  // Pass user message + history for framework-aware integrations (e.g. frontend)
  const enrichedParams = {
    ...params,
    userMessage: input?.message,
    conversationHistory: input?.conversationHistory?.map(h => ({ role: h.role, content: h.content })),
  }

  const { dispatchIntegration } = await import('@/lib/integrations')
  const result = await dispatchIntegration(goal.integrationId as any, projectId, enrichedParams)

  return {
    success: result.success,
    type: 'INTEGRATION',
    message: result.message,
    executed: result.success,
    needsApiKey: result.needsApiKey,
    keyHint: result.keyHint,
    needsCredentials: result.needsCredentials,
    credentialHint: result.credentialHint,
    needsConfirmation: result.needsConfirmation,
    data: (result as any).data,
  }
}

// ─── Layer 11: Confidence Engine ─────────────────────────────────────────────

const AUTO_EXECUTE_THRESHOLD = 0.85

export function shouldAutoExecute(goal: StructuredGoal): boolean {
  if (goal.intent === 'FIX') return true
  if (goal.intent === 'MODIFY') return true
  if (goal.intent === 'INTEGRATION' && goal.integrationId) return true
  return goal.confidence >= AUTO_EXECUTE_THRESHOLD
}

// ─── Confidence Explainability Helpers ────────────────────────────────────────

function buildReasoning(
  intent: IntentType,
  goal: StructuredGoal,
  strategy: ExecutionStrategy,
  rememberedStrategy: ExecutionStrategy | null
): string {
  const parts: string[] = []

  if (intent === 'INTEGRATION' && goal.integrationId) {
    parts.push(`Detected ${goal.integrationId} setup pattern (${Math.round(goal.confidence * 100)}% confidence).`)
    parts.push(`Strategy: ${strategy} — configure service, store key, activate integration.`)
    if (rememberedStrategy) parts.push(`Using remembered strategy from a previous successful run.`)
  } else if (intent === 'FIX') {
    parts.push(`Detected schema repair intent. Running FK inference and relationship sync.`)
    parts.push(`This is always auto-executed — no confirmation needed.`)
  } else if (intent === 'BUILD') {
    parts.push(`New backend creation request (${Math.round(goal.confidence * 100)}% confidence).`)
    parts.push(`Strategy: ${strategy}.`)
  } else if (intent === 'MODIFY') {
    parts.push(`Schema modification detected. Applying ${strategy} approach.`)
  } else if (intent === 'QUESTION') {
    parts.push(`Read-only query — no schema changes.`)
  } else {
    parts.push(`Intent: ${intent}, strategy: ${strategy}.`)
  }

  return parts.join(' ')
}

function buildAlternatives(intent: IntentType, goal: StructuredGoal): string[] {
  if (intent === 'INTEGRATION') {
    return ['manual key entry', 'use existing integration', 'set up via dashboard']
  }
  if (intent === 'FIX') {
    return ['manual column type correction', 'drop and recreate table']
  }
  if (intent === 'BUILD') {
    return ['ask for confirmation first', 'use architecture template', 'minimal schema only']
  }
  return []
}

// ─── Layer 12: Response Engine ────────────────────────────────────────────────

export function formatAgentResponse(result: AgentResult): string {
  if (result.needsApiKey) return result.keyHint || result.message
  if (result.needsCredentials) return result.credentialHint || result.message
  if (result.needsConfirmation) return result.message
  if (result.permissionDenied) return result.message

  let msg = result.message
  if (result.success && !msg.startsWith('Done') && !msg.startsWith('Fixed')) {
    msg = `Done: ${msg}`
  }

  msg = msg
    .replace(/\bI can help\b/gi, "I'll")
    .replace(/\bLet me know if\b.*/gi, '')
    .replace(/\bFeel free to\b.*/gi, '')
    .replace(/\bHere's what I'll do\b/gi, '')
    .trim()

  return msg
}

// ─── Master Agent Entry Point ─────────────────────────────────────────────────

export interface AgentInput {
  message: string
  projectId: string
  userId?: string
  sessionToken?: string
  existingSchema?: string
  conversationHistory?: Array<{ role: 'user' | 'ai'; content: string }>
  integrationParams?: Record<string, any>
}

/**
 * Run the full 12-layer autonomous agent.
 * Returns a structured result — caller formats the HTTP response.
 */
export async function runAutonomousAgent(input: AgentInput): Promise<AgentResult> {
  const { message, projectId, userId, existingSchema, integrationParams = {} } = input
  const hasExistingSchema = !!(existingSchema && existingSchema.length > 100)
  const startedAt = Date.now()

  // ── Layer 1: Classify Intent ──
  const intent = classifyIntent(message, hasExistingSchema)

  // ── Layer 2: Expand Goal ──
  const goal = expandGoal(message, intent)
  const strategy = planStrategy(goal)

  // ── Layer 10: Recall persistent memory ──
  const { fingerprintMessage, recallStrategy, saveSuccessPattern, recordFailurePattern } = await import('./agent-memory')
  const fingerprint = fingerprintMessage(message)
  const remembered = await recallStrategy(fingerprint)
  if (remembered) goal.strategy = remembered

  // ── Layer 4 (Permission Guard) ──
  if (userId) {
    const { canExecute, intentToPermission } = await import('./execution-guard')
    const permission = intentToPermission(intent)
    // Only check for mutating intents
    if (['INTEGRATION', 'FIX', 'BUILD', 'MODIFY'].includes(intent)) {
      const guard = await canExecute(userId, projectId, permission)
      if (!guard.allowed) {
        const denied: AgentResult = {
          success: false,
          type: intent,
          message: `Permission denied: ${guard.reason}`,
          executed: false,
          permissionDenied: true,
        }
        return denied
      }
    }
  }

  // ── Layer 11: Confidence Check ──
  const autoExecute = shouldAutoExecute(goal)

  let result: AgentResult

  // ── INTEGRATION path ──
  if (intent === 'INTEGRATION') {
    result = await executeIntegrationSetup(goal, projectId, integrationParams, input)
    if (result.success) {
      await saveSuccessPattern(fingerprint, strategy, goal.goal)
      // Emit event
      const { emit } = await import('@/lib/events/bus')
      emit('execution.complete', projectId, { action: 'integration', integrationId: goal.integrationId }, userId)
    } else if (result.executed) {
      await recordFailurePattern(fingerprint)
      const { emit } = await import('@/lib/events/bus')
      emit('execution.failed', projectId, { action: 'integration', error: result.message }, userId)
    }
  }

  // ── FIX path — always execute, never ask ──
  else if (intent === 'FIX') {
    result = await executeSchemaFix(projectId, message)
    if (result.success) {
      await saveSuccessPattern(fingerprint, strategy, goal.goal)
    } else {
      await recordFailurePattern(fingerprint)
    }
  }

  // ── QUESTION path — read-only ──
  else if (intent === 'QUESTION') {
    result = { success: true, type: 'QUESTION', message: '', executed: false }
  }

  // ── CONFIRM — signal to caller ──
  else if (intent === 'CONFIRM') {
    result = { success: true, type: 'CONFIRM', message: '', executed: false }
  }

  // ── BUILD / MODIFY — delegate to intent planner ──
  else {
    result = { success: true, type: intent, message: '', executed: false }
  }

  // ── Layer 7: Observability ──
  const { logExecution } = await import('@/lib/observability/execution-logger')
  await logExecution({
    projectId,
    userId,
    intent,
    strategy,
    action: goal.integrationId || goal.strategy,
    startedAt,
    success: result.success,
    errorMsg: result.success ? undefined : result.message,
    metadata: { integrationId: goal.integrationId, confidence: goal.confidence },
  })

  // ── Layer 12: Confidence Explainability ──
  result.confidence = goal.confidence
  result.reasoning = buildReasoning(intent, goal, strategy, remembered)
  result.alternativeStrategies = buildAlternatives(intent, goal)

  result.message = formatAgentResponse(result)
  return result
}
