/**
 * SEMANTIC DOMAIN ANALYZER
 * ========================
 * Comprehensive intent intelligence upgrade — fixes issues #46–#50.
 *
 * #46 — Table purpose detection: classifies individual tables into purpose categories
 *        (financial, job-queue, auth, content, analytics, etc.) using name + column analysis.
 *        Goes far beyond the 4 hardcoded app-level domains.
 *
 * #47 — State machine detection: auto-detects tables with status columns, infers the
 *        valid transitions, generates enforcement rules and required endpoints.
 *
 * #48 — Workflow inference: extracts multi-step workflows from natural language
 *        (e.g. "user submits job → credits checked → job queued") with actors, branching,
 *        validation steps, and side effects.
 *
 * #49 — Business rule extraction: turns prompt constraints ("credits are checked before
 *        generation", "validate file ownership") into typed enforcement specifications.
 *
 * #50 — Semantic domain vocabulary: replaces hardcoded regex with LLM classification
 *        so "account", "identity", "member" are understood as synonyms for domain signals.
 */

import { getOpenAIClient } from './openai-service'
import { getModel } from './model-router'

// ─── Table Purpose ────────────────────────────────────────────────────────────

export type TablePurpose =
  | 'financial'        // credit_wallets, transactions, payments, invoices, ledgers
  | 'job-queue'        // generation_jobs, render_jobs, *_jobs, task_queues
  | 'auth'             // users, sessions, api_keys, tokens, identities
  | 'content'          // posts, articles, documents, courses, pages
  | 'analytics'        // events, metrics, audit_logs, page_views, telemetry
  | 'communication'    // notifications, alerts, email_logs, push_notifications
  | 'social'           // likes, follows, reactions, comments, reposts
  | 'messaging'        // messages, conversations, threads, chat_rooms
  | 'subscription'     // subscriptions, plans, memberships, tiers
  | 'inventory'        // stock, inventory, warehouse, skus, variants
  | 'user-management'  // roles, permissions, organizations, teams, workspaces
  | 'order'            // orders, carts, order_items, checkouts, invoices
  | 'media'            // videos, images, files, uploads, assets, renders
  | 'generic'

export interface TablePurposeResult {
  tableName: string
  purpose: TablePurpose
  confidence: number
  reasoning: string
  /** Auto-detected state machine — present whenever the table has a status column */
  stateMachine?: StateMachineConfig
  /** Endpoints the AI must generate beyond standard CRUD */
  recommendedEndpoints: Array<{ method: string; path: string; description: string }>
}

// ─── State Machine ────────────────────────────────────────────────────────────

export interface StateTransition {
  from: string | string[]
  to: string
  /** Action name (e.g. "cancel", "complete", "retry") */
  action: string
  /** HTTP endpoint to expose this transition */
  endpoint?: { method: string; path: string }
  /** Side effects that must run on this transition */
  sideEffects: string[]
  /** Guards: conditions that must pass before this transition fires */
  validations: string[]
}

export interface StateMachineConfig {
  tableName: string
  statusColumn: string
  states: string[]
  initialState: string
  /** Rows in terminal states cannot transition further */
  terminalStates: string[]
  transitions: StateTransition[]
  /**
   * Plain-English enforcement rule injected verbatim into the AI system prompt.
   * The AI MUST follow this when generating any endpoint that touches this table.
   */
  enforcementDescription: string
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

export interface WorkflowStep {
  order: number
  action: string
  actor: 'user' | 'system' | 'background'
  description: string
  preconditions: string[]
  effects: string[]
  onFailure: string
}

export interface Workflow {
  name: string
  trigger: string
  description: string
  steps: WorkflowStep[]
  /** Invariants that must hold throughout the entire workflow */
  invariants: string[]
}

// ─── Business Rule ────────────────────────────────────────────────────────────

export type BusinessRuleType =
  | 'pre-condition'  // must be true BEFORE action executes
  | 'post-condition' // must be true AFTER action executes
  | 'invariant'      // always true
  | 'authorization'  // who can do what
  | 'rate-limit'     // frequency constraints
  | 'constraint'     // data integrity constraint

export interface BusinessRule {
  id: string
  type: BusinessRuleType
  description: string
  /** Which entity/endpoint this rule applies to */
  appliesTo: string
  /** How to implement enforcement in generated API code */
  enforcement: string
  priority: 'critical' | 'high' | 'normal'
}

// ─── Extended Domain ──────────────────────────────────────────────────────────

export type ExtendedDomain =
  | 'ecommerce'   // online stores, product catalogs, retail
  | 'saas'        // multi-tenant SaaS, workspace, B2B
  | 'marketplace' // two-sided platforms, listings, sellers/buyers
  | 'social'      // social media, community, forums
  | 'ai-saas'     // AI generation, job queues, credit systems
  | 'media'       // video/audio streaming, content distribution
  | 'fintech'     // financial services, payments, lending
  | 'messaging'   // chat apps, communication platforms
  | 'gaming'      // games, leaderboards, virtual goods
  | 'generic'

export interface DomainClassification {
  domain: ExtendedDomain
  confidence: number
  reasoning: string
  secondaryDomains: ExtendedDomain[]
  /** Key signals that drove this classification */
  signals: string[]
}

// ─── Fast pattern matchers (no LLM) ──────────────────────────────────────────

const JOB_QUEUE_RE     = /(_jobs|_tasks|_queue|job_queue|task_queue|render_queue|work_queue|processing_queue)$/
const FINANCIAL_RE     = /(_wallet|_balance|_ledger|_transaction|credit_wallet|payment_account|escrow|treasury|credit_account)/
const SOCIAL_EXACT_RE  = /^(likes|follows|followers|following|reactions|reposts|shares|bookmarks|favorites|upvotes|endorsements|claps)$/
const MESSAGING_RE     = /^(messages|conversations|threads|direct_messages|chats|chat_rooms|channels|inboxes|mailboxes)$/
const AUTH_RE          = /^(users|accounts|identities|members|sessions|tokens|api_keys|refresh_tokens|auth_tokens|credentials)$/
const ANALYTICS_RE     = /^(events|metrics|analytics|audit_logs|logs|page_views|click_events|impressions|telemetry|traces|spans|activity_logs)$/
const COMMUNICATION_RE = /^(notifications|alerts|email_logs|sms_logs|push_notifications|announcements|broadcasts)$/
const MEDIA_RE         = /^(videos|images|files|uploads|media|assets|attachments|thumbnails|renders|exports|recordings|clips)$/
const CONTENT_RE       = /^(posts|articles|documents|pages|content|courses|lessons|chapters|blogs|entries|tutorials|guides)$/
const SUBSCRIPTION_RE  = /^(subscriptions|plans|memberships|tiers|billing_accounts|pricing_plans|feature_flags)$/
const INVENTORY_RE     = /^(inventory|stock|warehouse|skus|variants|stock_levels|product_variants)$/
const ORDER_RE         = /^(orders|carts|order_items|cart_items|checkouts|invoices|line_items|purchase_orders|receipts)$/
const USER_MGMT_RE     = /^(roles|permissions|access_policies|organizations|teams|workspaces|groups|departments|orgs|tenants)$/

/**
 * Fast pattern-based table purpose classification — no LLM needed.
 * Returns null when confident classification isn't possible from name/columns alone.
 */
function fastClassifyTablePurpose(tableName: string, columnNames: string[]): TablePurpose | null {
  const name = tableName.toLowerCase()
  const cols = new Set(columnNames.map(c => c.toLowerCase()))

  // Job queue: name pattern + status/payload columns
  if (JOB_QUEUE_RE.test(name) || name === 'jobs' || name === 'queue') {
    if (cols.has('status') || cols.has('attempts') || cols.has('priority') || cols.has('payload')) {
      return 'job-queue'
    }
  }

  // Financial: wallet/ledger/balance patterns, or transaction tables with amount columns
  if (FINANCIAL_RE.test(name)) return 'financial'
  if (name === 'credit_wallets' || name === 'wallets' || name === 'balances') return 'financial'
  if ((name === 'transactions' || name === 'ledger_entries' || name === 'credit_transactions') &&
    (cols.has('amount') || cols.has('balance') || cols.has('debit') || cols.has('credit'))) {
    return 'financial'
  }

  // Auth / identity
  if (AUTH_RE.test(name)) return 'auth'

  // Social (engagement/relationship tables)
  if (SOCIAL_EXACT_RE.test(name)) return 'social'

  // Messaging
  if (MESSAGING_RE.test(name)) return 'messaging'

  // Communication (notifications)
  if (COMMUNICATION_RE.test(name)) return 'communication'

  // Analytics / telemetry
  if (ANALYTICS_RE.test(name)) return 'analytics'

  // Media / files
  if (MEDIA_RE.test(name)) return 'media'

  // Content
  if (CONTENT_RE.test(name)) return 'content'

  // Subscription / billing
  if (SUBSCRIPTION_RE.test(name)) return 'subscription'

  // Inventory / stock
  if (INVENTORY_RE.test(name)) return 'inventory'

  // Order / commerce
  if (ORDER_RE.test(name)) return 'order'

  // User management / org structure
  if (USER_MGMT_RE.test(name)) return 'user-management'

  return null
}

// ─── State machine transition templates ──────────────────────────────────────

function buildTransitionsForPurpose(
  purpose: TablePurpose,
  tableName: string,
): StateTransition[] {
  if (purpose === 'job-queue') {
    return [
      {
        from: 'queued',
        to: 'processing',
        action: 'start',
        sideEffects: ['set started_at = NOW()', 'assign worker_id'],
        validations: ['status must be queued'],
      },
      {
        from: 'processing',
        to: 'completed',
        action: 'complete',
        endpoint: { method: 'POST', path: `/${tableName}/:id/complete` },
        sideEffects: [
          'deduct credits from balance (balance -= credits_used)',
          'release reservation (reserved -= credits_reserved)',
          'set completed_at = NOW()',
          'emit job.completed event',
          'notify owner via notifications table',
        ],
        validations: ['status must be processing', 'requester must be worker or system'],
      },
      {
        from: 'processing',
        to: 'failed',
        action: 'fail',
        endpoint: { method: 'POST', path: `/${tableName}/:id/fail` },
        sideEffects: [
          'release credit reservation WITHOUT deducting balance',
          'set failed_at = NOW(), store error_message',
          'emit job.failed event',
          'notify owner',
        ],
        validations: ['status must be processing'],
      },
      {
        from: ['queued', 'processing'],
        to: 'cancelled',
        action: 'cancel',
        endpoint: { method: 'POST', path: `/${tableName}/:id/cancel` },
        sideEffects: [
          'release any reserved credits (reserved -= reserved_amount)',
          'set cancelled_at = NOW()',
          'emit job.cancelled event',
        ],
        validations: ['requester must be job owner or admin', 'status must be queued or processing'],
      },
      {
        from: 'failed',
        to: 'queued',
        action: 'retry',
        endpoint: { method: 'POST', path: `/${tableName}/:id/retry` },
        sideEffects: [
          'increment attempts counter',
          're-reserve credits (reserved += cost)',
          'reset error_message',
          'set retry_at = NOW()',
        ],
        validations: [
          'attempts < max_attempts',
          'requester must be job owner',
          'user must have sufficient credit balance',
        ],
      },
    ]
  }

  if (purpose === 'order') {
    return [
      {
        from: 'pending',
        to: 'confirmed',
        action: 'confirm',
        sideEffects: ['send confirmation email', 'reserve inventory'],
        validations: ['status must be pending'],
      },
      {
        from: 'confirmed',
        to: 'paid',
        action: 'pay',
        endpoint: { method: 'POST', path: `/${tableName}/:id/pay` },
        sideEffects: ['process payment charge', 'deduct inventory', 'emit order.paid event'],
        validations: ['status must be confirmed', 'payment method required'],
      },
      {
        from: 'paid',
        to: 'shipped',
        action: 'ship',
        sideEffects: ['set tracking_number, shipped_at', 'send shipping notification'],
        validations: ['status must be paid', 'requester must be admin or seller'],
      },
      {
        from: 'shipped',
        to: 'delivered',
        action: 'deliver',
        sideEffects: ['set delivered_at = NOW()', 'release escrow to seller', 'send delivery notification'],
        validations: ['status must be shipped'],
      },
      {
        from: ['pending', 'confirmed'],
        to: 'cancelled',
        action: 'cancel',
        endpoint: { method: 'POST', path: `/${tableName}/:id/cancel` },
        sideEffects: ['release inventory reservation', 'refund if payment was taken', 'send cancellation email'],
        validations: ['status must be pending or confirmed', 'requester must be buyer or admin'],
      },
      {
        from: 'delivered',
        to: 'refunded',
        action: 'refund',
        endpoint: { method: 'POST', path: `/${tableName}/:id/refund` },
        sideEffects: ['process payment refund via Stripe', 'restore inventory', 'send refund confirmation'],
        validations: ['status must be delivered', 'within refund window', 'requester must be admin'],
      },
    ]
  }

  if (purpose === 'content') {
    return [
      {
        from: 'draft',
        to: 'review',
        action: 'submit',
        sideEffects: ['set submitted_at = NOW()', 'notify reviewer'],
        validations: ['content body must not be empty', 'requester must be author'],
      },
      {
        from: 'review',
        to: 'published',
        action: 'publish',
        endpoint: { method: 'POST', path: `/${tableName}/:id/publish` },
        sideEffects: ['set published_at = NOW()', 'notify subscribers/followers', 'index for search'],
        validations: ['status must be review', 'requester must be admin or moderator'],
      },
      {
        from: 'review',
        to: 'draft',
        action: 'reject',
        sideEffects: ['set rejection_reason', 'notify author with reason'],
        validations: ['requester must be moderator or admin'],
      },
      {
        from: ['draft', 'published'],
        to: 'archived',
        action: 'archive',
        endpoint: { method: 'POST', path: `/${tableName}/:id/archive` },
        sideEffects: ['set archived_at = NOW()', 'remove from public listings'],
        validations: ['requester must be author or admin'],
      },
    ]
  }

  if (purpose === 'subscription') {
    return [
      {
        from: 'trialing',
        to: 'active',
        action: 'activate',
        sideEffects: ['charge payment method', 'set billing_period_start, billing_period_end', 'grant feature access'],
        validations: ['payment method must be on file'],
      },
      {
        from: 'active',
        to: 'past_due',
        action: 'payment_failed',
        sideEffects: ['send past_due notification', 'begin grace period countdown', 'set past_due_at'],
        validations: [],
      },
      {
        from: 'past_due',
        to: 'active',
        action: 'payment_succeeded',
        sideEffects: ['clear past_due_at', 'extend billing period', 'restore full access'],
        validations: [],
      },
      {
        from: ['active', 'past_due'],
        to: 'cancelled',
        action: 'cancel',
        endpoint: { method: 'POST', path: `/${tableName}/:id/cancel` },
        sideEffects: ['set cancels_at (end of billing period)', 'send cancellation email', 'schedule access revocation'],
        validations: ['requester must be subscription owner or admin'],
      },
      {
        from: 'active',
        to: 'paused',
        action: 'pause',
        endpoint: { method: 'POST', path: `/${tableName}/:id/pause` },
        sideEffects: ['halt billing cycle', 'set paused_at', 'restrict feature access to read-only'],
        validations: ['pause allowed by plan', 'requester must be subscription owner'],
      },
      {
        from: 'paused',
        to: 'active',
        action: 'resume',
        endpoint: { method: 'POST', path: `/${tableName}/:id/resume` },
        sideEffects: ['resume billing', 'charge prorated amount', 'restore full access'],
        validations: ['requester must be subscription owner'],
      },
      {
        from: ['trialing', 'past_due', 'cancelled'],
        to: 'expired',
        action: 'expire',
        sideEffects: ['revoke all feature access', 'archive user data per retention policy', 'send expiry notification'],
        validations: ['only system scheduler can trigger expiry'],
      },
    ]
  }

  return []
}

/**
 * Detect whether a table is a state machine, and if so, build its full config.
 * Returns undefined when the table has no meaningful status column.
 */
function detectStateMachineFromTable(
  tableName: string,
  columnNames: string[],
  purpose: TablePurpose,
): StateMachineConfig | undefined {
  const cols = new Set(columnNames.map(c => c.toLowerCase()))
  if (!cols.has('status')) return undefined

  const purposeStateMap: Partial<Record<TablePurpose, { states: string[]; initialState: string; terminalStates: string[] }>> = {
    'job-queue':    { states: ['queued', 'processing', 'completed', 'failed', 'cancelled'], initialState: 'queued',   terminalStates: ['completed', 'failed', 'cancelled'] },
    'order':        { states: ['pending', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'],   initialState: 'pending',  terminalStates: ['delivered', 'cancelled', 'refunded'] },
    'content':      { states: ['draft', 'review', 'published', 'archived'],                 initialState: 'draft',    terminalStates: ['archived'] },
    'subscription': { states: ['trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired'], initialState: 'trialing', terminalStates: ['cancelled', 'expired'] },
  }

  const stateConfig = purposeStateMap[purpose]
  if (!stateConfig) return undefined

  const transitions = buildTransitionsForPurpose(purpose, tableName)
  const terminalStr = stateConfig.terminalStates.join(', ')
  const transitionEndpoints = transitions
    .filter(t => t.endpoint)
    .map(t => `${t.endpoint!.method} ${t.endpoint!.path}`)

  const enforcementDescription = [
    `${tableName}.status is a STATE MACHINE — NEVER update status via raw CRUD.`,
    `Valid states: [${stateConfig.states.join(' → ')}].`,
    `Initial state on INSERT: "${stateConfig.initialState}" — NEVER insert without explicit status='${stateConfig.initialState}'.`,
    `Terminal states [${terminalStr}]: no further transitions allowed — return 409 if attempted.`,
    transitionEndpoints.length > 0
      ? `Required transition endpoints (MANDATORY — must be generated): ${transitionEndpoints.join(', ')}.`
      : '',
    `Enforce valid transitions with a lookup table — reject invalid from→to pairs with 422.`,
  ].filter(Boolean).join(' ')

  return {
    tableName,
    statusColumn: 'status',
    states: stateConfig.states,
    initialState: stateConfig.initialState,
    terminalStates: stateConfig.terminalStates,
    transitions,
    enforcementDescription,
  }
}

/**
 * Recommended endpoints beyond standard CRUD for each table purpose.
 */
function getRecommendedEndpoints(
  tableName: string,
  purpose: TablePurpose,
): Array<{ method: string; path: string; description: string }> {
  if (purpose === 'job-queue') {
    return [
      { method: 'GET',  path: `/${tableName}/:id/status`, description: 'Poll current status and progress_pct — polls provider if status=processing' },
      { method: 'POST', path: `/${tableName}/:id/cancel`, description: 'Cancel when status in (queued, processing) — release reserved credits' },
      { method: 'POST', path: `/${tableName}/:id/retry`,  description: 'Retry when status=failed — reset to queued, re-reserve credits, increment attempts' },
    ]
  }
  if (purpose === 'financial') {
    return [
      { method: 'GET',  path: `/${tableName}/balance`,  description: 'Get available balance: { balance, reserved, available: balance-reserved }' },
      { method: 'POST', path: `/${tableName}/deduct`,   description: 'Atomically deduct with SELECT FOR UPDATE to prevent race conditions' },
      { method: 'POST', path: `/${tableName}/purchase`, description: 'Purchase / top-up via Stripe PaymentIntent' },
    ]
  }
  if (purpose === 'subscription') {
    return [
      { method: 'POST', path: `/${tableName}/:id/cancel`,  description: 'Cancel — sets cancels_at to end of billing period' },
      { method: 'POST', path: `/${tableName}/:id/resume`,  description: 'Resume a paused subscription with prorated charge' },
      { method: 'POST', path: `/${tableName}/:id/upgrade`, description: 'Upgrade to higher plan tier with Stripe proration' },
    ]
  }
  if (purpose === 'content') {
    return [
      { method: 'POST', path: `/${tableName}/:id/publish`, description: 'Publish a draft/reviewed item — sets published_at' },
      { method: 'POST', path: `/${tableName}/:id/archive`, description: 'Archive a published item — removes from public listings' },
    ]
  }
  if (purpose === 'order') {
    return [
      { method: 'POST', path: `/${tableName}/:id/cancel`,  description: 'Cancel pending/confirmed order — releases inventory reservation' },
      { method: 'GET',  path: `/${tableName}/:id/invoice`, description: 'Get formatted invoice / receipt' },
      { method: 'POST', path: `/${tableName}/:id/refund`,  description: 'Process refund via Stripe for delivered orders' },
    ]
  }
  return []
}

// ─── Public: Table purpose analysis ──────────────────────────────────────────

/**
 * Classify a table's semantic purpose from its name and column list.
 * Uses fast pattern matching first; falls back to LLM for ambiguous cases.
 *
 * Also auto-detects state machines and recommended endpoints.
 */
export async function analyzeTablePurpose(
  tableName: string,
  columnNames: string[],
): Promise<TablePurposeResult> {
  const fastPurpose = fastClassifyTablePurpose(tableName, columnNames)

  if (fastPurpose) {
    const stateMachine = detectStateMachineFromTable(tableName, columnNames, fastPurpose)
    return {
      tableName,
      purpose: fastPurpose,
      confidence: 0.92,
      reasoning: `Name/column patterns matched ${fastPurpose} category`,
      stateMachine,
      recommendedEndpoints: getRecommendedEndpoints(tableName, fastPurpose),
    }
  }

  // LLM fallback for ambiguous table names
  try {
    const openai = getOpenAIClient()
    const response = await openai.chat.completions.create({
      model: getModel('classify'),
      messages: [
        {
          role: 'system',
          content: `You are a database schema analyst. Classify the semantic purpose of a database table.

Valid purposes:
- "financial": credit systems, wallets, transactions, payments, balances, invoices, ledgers
- "job-queue": async job processing, background tasks, work queues, render jobs, generation jobs
- "auth": user accounts, authentication, sessions, tokens, API keys, identity records
- "content": posts, articles, documents, products, courses, any user-generated content
- "analytics": events, metrics, logs, audit trails, telemetry, page views
- "communication": notifications, alerts, emails, SMS, push notifications
- "social": likes, follows, reactions, votes, endorsements, social interactions
- "messaging": chat messages, direct messages, conversations, threads
- "subscription": subscription plans, memberships, billing tiers, feature access
- "inventory": stock levels, warehouse data, SKUs, product variants
- "user-management": roles, permissions, organizations, teams, workspaces
- "order": purchases, carts, order line items, checkouts, receipts
- "media": videos, images, file uploads, assets, renders, recordings
- "generic": anything that doesn't fit the above

Respond ONLY with valid JSON:
{
  "purpose": "<one of the types above>",
  "confidence": 0.0-1.0,
  "reasoning": "One sentence explanation"
}`,
        },
        {
          role: 'user',
          content: `Table: ${tableName}\nColumns: ${columnNames.join(', ')}`,
        },
      ],
      temperature: 0.1,
      max_tokens: 150,
      response_format: { type: 'json_object' },
    })

    const raw = response.choices[0].message.content || '{}'
    const parsed = JSON.parse(raw)
    const validPurposes: TablePurpose[] = [
      'financial', 'job-queue', 'auth', 'content', 'analytics', 'communication',
      'social', 'messaging', 'subscription', 'inventory', 'user-management',
      'order', 'media', 'generic',
    ]
    const purpose: TablePurpose = validPurposes.includes(parsed.purpose) ? parsed.purpose : 'generic'
    const stateMachine = detectStateMachineFromTable(tableName, columnNames, purpose)

    return {
      tableName,
      purpose,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
      reasoning: String(parsed.reasoning || 'LLM classification'),
      stateMachine,
      recommendedEndpoints: getRecommendedEndpoints(tableName, purpose),
    }
  } catch {
    return {
      tableName,
      purpose: 'generic',
      confidence: 0.3,
      reasoning: 'Classification unavailable — defaulting to generic',
      recommendedEndpoints: [],
    }
  }
}

// ─── Public: Batch state machine detection ────────────────────────────────────

/**
 * Detect all state machine tables from a schema snapshot.
 * Pure structural analysis — no LLM calls.
 */
export function detectStateMachinesFromSchema(
  tables: Array<{ name: string; columns: string[] }>,
): StateMachineConfig[] {
  const configs: StateMachineConfig[] = []
  for (const table of tables) {
    const cols = new Set(table.columns.map(c => c.toLowerCase()))
    if (!cols.has('status')) continue
    const purpose = fastClassifyTablePurpose(table.name, table.columns)
    if (!purpose) continue
    const config = detectStateMachineFromTable(table.name, table.columns, purpose)
    if (config) configs.push(config)
  }
  return configs
}

// ─── Public: Workflow extraction ──────────────────────────────────────────────

/**
 * Extract multi-step business workflows from a natural language prompt.
 * Returns [] when no workflows can be inferred.
 *
 * #48 fix: turns "user submits generation job → credits checked → job queued"
 * into an explicit, ordered workflow definition with actors and failure branches.
 */
export async function extractWorkflowsFromPrompt(prompt: string): Promise<Workflow[]> {
  const lower = prompt.toLowerCase()
  const hasWorkflowSignals = /\b(submit|process|trigger|approve|reject|fulfill|checkout|register|onboard|subscribe|publish|deploy|generate|upload|review|verify|confirm|request|initiate|queue|schedule)\b/.test(lower)
  if (!hasWorkflowSignals) return []

  try {
    const openai = getOpenAIClient()
    const response = await openai.chat.completions.create({
      model: getModel('plan'),
      messages: [
        {
          role: 'system',
          content: `You are a workflow analyst. Extract multi-step business workflows from the user's app description.

A workflow is a sequence of steps describing HOW a business process executes, including:
- Actor (user/system/background)
- Preconditions that must be true before the step runs
- Effects (state changes caused by this step)
- On-failure branch (what happens when the step fails)

Only extract workflows that are EXPLICITLY described or CLEARLY implied by the prompt. Do not invent workflows that aren't there.

Respond ONLY with valid JSON:
{
  "workflows": [
    {
      "name": "Job Submission",
      "trigger": "User calls POST /jobs/submit",
      "description": "Multi-step process to validate, reserve credits, and queue a generation job",
      "steps": [
        {
          "order": 1,
          "action": "Authenticate user",
          "actor": "system",
          "description": "Verify JWT token and extract userId",
          "preconditions": [],
          "effects": ["userId available for subsequent steps"],
          "onFailure": "Return 401 Unauthorized"
        },
        {
          "order": 2,
          "action": "Check credit balance",
          "actor": "system",
          "description": "Read credit_wallets WHERE user_id = userId. Compute available = balance - reserved",
          "preconditions": ["User authenticated"],
          "effects": [],
          "onFailure": "Return 402 with { error: 'Insufficient credits', available, required }"
        },
        {
          "order": 3,
          "action": "Atomically reserve credits",
          "actor": "system",
          "description": "UPDATE credit_wallets SET reserved = reserved + cost WHERE user_id = $1 AND (balance - reserved) >= cost using SELECT FOR UPDATE",
          "preconditions": ["available >= cost"],
          "effects": ["reserved increased by job_cost", "available decremented"],
          "onFailure": "Return 409 Conflict (race condition — retry)"
        },
        {
          "order": 4,
          "action": "Create job record",
          "actor": "system",
          "description": "INSERT INTO generation_jobs (user_id, status, cost, payload) VALUES ($1, 'queued', $2, $3)",
          "preconditions": ["Credits reserved successfully"],
          "effects": ["job_id returned", "status=queued"],
          "onFailure": "Release reservation and return 500"
        }
      ],
      "invariants": [
        "User available credits (balance - reserved) never goes below 0",
        "A job row is NEVER inserted without status='queued'"
      ]
    }
  ]
}

If no clear multi-step workflows exist in the prompt, return: { "workflows": [] }`,
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    })

    const raw = response.choices[0].message.content || '{}'
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.workflows) ? parsed.workflows : []
  } catch {
    return []
  }
}

// ─── Public: Business rule extraction ────────────────────────────────────────

/**
 * Extract explicit business rules and constraints from a natural language prompt.
 * Returns [] when no rules can be inferred.
 *
 * #49 fix: turns "credits are checked before generation", "validate file ownership"
 * into typed enforcement specifications that the AI can generate code for.
 */
export async function extractBusinessRulesFromPrompt(prompt: string): Promise<BusinessRule[]> {
  const lower = prompt.toLowerCase()
  const hasRuleSignals = /\b(only|must|cannot|should|require|prevent|validate|check|verify|ensure|enforce|restrict|allow|deny|limit|before|after|ownership|permission|access|authorize|guard|protect|block|gate)\b/.test(lower)
  if (!hasRuleSignals) return []

  try {
    const openai = getOpenAIClient()
    const response = await openai.chat.completions.create({
      model: getModel('plan'),
      messages: [
        {
          role: 'system',
          content: `You are a business rules analyst. Extract explicit constraints from the user's app description.

Rule types:
- "pre-condition":  must be true BEFORE an action executes (e.g. "credits checked before generation")
- "post-condition": must be true AFTER action executes (e.g. "balance updated after job completes")
- "invariant":      must always hold (e.g. "available_credits = balance - reserved >= 0")
- "authorization":  access control ("only file owner can delete", "admin can see all users")
- "rate-limit":     frequency constraint ("max 3 retries per job", "10 requests per minute")
- "constraint":     data integrity ("quantity must be positive", "email must be unique")

Only extract rules EXPLICITLY stated or CLEARLY IMPLIED. Do not invent rules.

Respond ONLY with valid JSON:
{
  "rules": [
    {
      "id": "rule_credit_check",
      "type": "pre-condition",
      "description": "User must have sufficient available credits before a generation job can be created",
      "appliesTo": "generation_jobs POST /submit endpoint",
      "enforcement": "Before INSERT: SELECT balance, reserved FROM credit_wallets WHERE user_id=$1 FOR UPDATE. If (balance-reserved) < cost → 402 { error, available, required }. Else: UPDATE reserved = reserved + cost.",
      "priority": "critical"
    },
    {
      "id": "rule_file_ownership",
      "type": "authorization",
      "description": "Only the file owner can delete a file",
      "appliesTo": "files DELETE /:id endpoint",
      "enforcement": "JOIN files ON user_id = JWT.userId. If no match → 403 Forbidden. Never delete files owned by other users.",
      "priority": "critical"
    }
  ]
}

If no clear rules exist, return: { "rules": [] }`,
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 2500,
      response_format: { type: 'json_object' },
    })

    const raw = response.choices[0].message.content || '{}'
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.rules) ? parsed.rules : []
  } catch {
    return []
  }
}

// ─── Public: Semantic domain classification ───────────────────────────────────

/**
 * Classify overall app domain using LLM semantic understanding.
 *
 * #50 fix: handles synonyms ("account" → auth domain signal, "identity" → auth,
 * "member" → user management, "generation" → ai-saas) so domain detection works
 * regardless of exact wording.
 *
 * Use as async fallback after fast regex `detectDomain` returns 'generic'.
 */
export async function classifyDomainSemantically(prompt: string): Promise<DomainClassification> {
  try {
    const openai = getOpenAIClient()
    const response = await openai.chat.completions.create({
      model: getModel('classify'),
      messages: [
        {
          role: 'system',
          content: `You are a software domain classifier. Determine the overall domain of the described application.

Domains:
- "ecommerce":   online stores, product catalogs, shopping, retail, B2C commerce
- "saas":        multi-tenant SaaS, team workspaces, B2B platforms, subscription software
- "marketplace": two-sided platforms, sellers+buyers, listings, gigs, rentals, Airbnb/Etsy-style
- "social":      social media, community platforms, forums, blogs with social features (likes, follows)
- "ai-saas":     AI-powered generation (video, image, text), job queues, credit systems, ML pipelines
- "media":       video/audio streaming, content distribution, podcasts, live streams, VOD
- "fintech":     financial services, banking, lending, crypto, payment processing, insurance, trading
- "messaging":   communication platforms, chat apps, collaboration tools (Slack-like), email clients
- "gaming":      games, leaderboards, virtual goods, rewards, player progression, guilds
- "generic":     anything that does not clearly fit the above categories

IMPORTANT SEMANTIC RULES:
- generation_jobs / render_jobs / AI generation requests → "ai-saas"
- credit_wallets + generation → "ai-saas"
- "identity" / "account" / "member" / "profile" = synonyms for user data (NOT domain signals alone)
- "workspace" + teams/billing → "saas"
- "listing" + "seller" or "buyer" → "marketplace"
- social features (likes, follows) as PRIMARY use case → "social"
- social features as SECONDARY (e.g. SaaS with activity feed) → do NOT classify as social
- "generate images/videos/text" + credits → "ai-saas"
- "lend money" / "borrow" / "interest rate" / "portfolio" / "crypto" → "fintech"

Respond ONLY with valid JSON:
{
  "domain": "<one of the domains above>",
  "confidence": 0.0-1.0,
  "reasoning": "One sentence explanation",
  "secondaryDomains": ["domain2"],
  "signals": ["signal1", "signal2"]
}`,
        },
        {
          role: 'user',
          content: `Classify the domain of this app description: "${prompt}"`,
        },
      ],
      temperature: 0.1,
      max_tokens: 300,
      response_format: { type: 'json_object' },
    })

    const raw = response.choices[0].message.content || '{}'
    const parsed = JSON.parse(raw)

    const validDomains: ExtendedDomain[] = [
      'ecommerce', 'saas', 'marketplace', 'social', 'ai-saas',
      'media', 'fintech', 'messaging', 'gaming', 'generic',
    ]
    const domain: ExtendedDomain = validDomains.includes(parsed.domain) ? parsed.domain : 'generic'

    return {
      domain,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
      reasoning: String(parsed.reasoning || ''),
      secondaryDomains: Array.isArray(parsed.secondaryDomains)
        ? parsed.secondaryDomains.filter((d: string) => validDomains.includes(d as ExtendedDomain))
        : [],
      signals: Array.isArray(parsed.signals) ? parsed.signals : [],
    }
  } catch {
    return {
      domain: 'generic',
      confidence: 0.3,
      reasoning: 'Domain classification unavailable — defaulting to generic',
      secondaryDomains: [],
      signals: [],
    }
  }
}

// ─── Batch analysis ───────────────────────────────────────────────────────────

/**
 * Analyze all tables in parallel, collect state machines and purpose map.
 * Designed to be called after entity/table extraction.
 */
export async function analyzeAllTablePurposes(
  tables: Array<{ name: string; columns: string[] }>,
): Promise<{
  purposes: Record<string, TablePurposeResult>
  stateMachines: StateMachineConfig[]
}> {
  const results = await Promise.all(
    tables.map(t => analyzeTablePurpose(t.name, t.columns))
  )

  const purposes: Record<string, TablePurposeResult> = {}
  const stateMachines: StateMachineConfig[] = []

  for (const r of results) {
    purposes[r.tableName] = r
    if (r.stateMachine) stateMachines.push(r.stateMachine)
  }

  return { purposes, stateMachines }
}

// ─── System prompt enrichment ─────────────────────────────────────────────────

/**
 * Build a system prompt enrichment block from semantic analysis results.
 * This string is injected directly into the AI's context so it generates
 * code that respects state machines, business rules, and workflows.
 */
export function buildSystemPromptEnrichment(
  stateMachines: StateMachineConfig[],
  businessRules: BusinessRule[],
  workflows: Workflow[],
): string {
  const parts: string[] = []

  // State machines — the most critical enforcement context
  if (stateMachines.length > 0) {
    parts.push('DETECTED STATE MACHINES — THESE ARE NON-NEGOTIABLE ENFORCEMENT RULES:')
    for (const sm of stateMachines) {
      parts.push(sm.enforcementDescription)
      const endpointTransitions = sm.transitions.filter(t => t.endpoint)
      if (endpointTransitions.length > 0) {
        const eps = endpointTransitions.map(t => `${t.endpoint!.method} ${t.endpoint!.path} (${Array.isArray(t.from) ? t.from.join('|') : t.from}→${t.to})`).join(', ')
        parts.push(`  Mandatory transition endpoints: ${eps}`)
        for (const t of endpointTransitions) {
          if (t.sideEffects.length > 0) {
            parts.push(`  On ${t.action}: ${t.sideEffects.join('; ')}`)
          }
          if (t.validations.length > 0) {
            parts.push(`  Guard: ${t.validations.join('; ')}`)
          }
        }
      }
    }
    parts.push('')
  }

  // Business rules — critical ones first
  const critical = businessRules.filter(r => r.priority === 'critical')
  const high = businessRules.filter(r => r.priority === 'high')
  const normal = businessRules.filter(r => r.priority === 'normal')

  if (critical.length > 0) {
    parts.push('CRITICAL BUSINESS RULES — MUST BE ENFORCED IN EVERY RELEVANT ENDPOINT:')
    for (const rule of critical) {
      parts.push(`[${rule.type.toUpperCase()}] ${rule.description}`)
      parts.push(`  Applies to: ${rule.appliesTo}`)
      parts.push(`  Implement: ${rule.enforcement}`)
    }
    parts.push('')
  }

  if (high.length > 0) {
    parts.push('HIGH-PRIORITY BUSINESS RULES:')
    for (const rule of high) {
      parts.push(`[${rule.type.toUpperCase()}] ${rule.description} → ${rule.enforcement}`)
    }
    parts.push('')
  }

  if (normal.length > 0) {
    parts.push('ADDITIONAL CONSTRAINTS:')
    for (const rule of normal) {
      parts.push(`- ${rule.description} (${rule.appliesTo})`)
    }
    parts.push('')
  }

  // Workflows — ordered step sequences the AI must implement
  if (workflows.length > 0) {
    parts.push('REQUIRED WORKFLOWS — IMPLEMENT THESE EXACT STEP SEQUENCES:')
    for (const wf of workflows) {
      parts.push(`${wf.name} (triggered by: ${wf.trigger}):`)
      for (const step of wf.steps.sort((a, b) => a.order - b.order)) {
        const pcStr = step.preconditions.length > 0 ? ` [requires: ${step.preconditions.join(', ')}]` : ''
        parts.push(`  ${step.order}. [${step.actor.toUpperCase()}] ${step.action}${pcStr}: ${step.description}`)
        if (step.onFailure) parts.push(`     ↳ Failure: ${step.onFailure}`)
        if (step.effects.length > 0) parts.push(`     ↳ Effects: ${step.effects.join(', ')}`)
      }
      if (wf.invariants.length > 0) {
        parts.push(`  Invariants: ${wf.invariants.join('; ')}`)
      }
    }
    parts.push('')
  }

  return parts.join('\n')
}
