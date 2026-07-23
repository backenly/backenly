/**
 * BUILD RUNTIME — Core Type Definitions
 * ======================================
 * Single source of truth for all build graph, job, and response types.
 *
 * Rules:
 *  - NodeStatus is the ground truth for build progress — never LLM inference
 *  - BlockedReason must always say exactly what credential/step is missing
 *  - BuildResponse is rendered from BuildJob state, never from freeform LLM text
 */

// ── Node Types ────────────────────────────────────────────────────────────────

export type NodeType =
  | 'schema'        // database table definition
  | 'auth'          // authentication system (JWT, OAuth, etc.)
  | 'permissions'   // roles + row-level security
  | 'storage'       // file storage buckets
  | 'integration'   // external service connection (Stripe, Resend, etc.)
  | 'function'      // serverless AI function
  | 'realtime'      // realtime subscription channel
  | 'trigger'       // database event trigger
  | 'flow'          // custom business flow / endpoint group
  | 'verification'  // post-build verification check

// ── Node Status ───────────────────────────────────────────────────────────────

export type NodeStatus =
  | 'pending'   // not yet started (all deps met or no deps)
  | 'running'   // currently executing
  | 'blocked'   // needs external credential or manual step before it can run
  | 'partial'   // started but incomplete (e.g. infrastructure done, credential missing)
  | 'verified'  // executed AND verified against real DB/runtime state
  | 'failed'    // execution attempted and failed with error

// ── Blocked Reason ────────────────────────────────────────────────────────────

export interface BlockedReason {
  type: 'missing_credential' | 'manual_step' | 'external_config'
  description: string
  /** Env var key needed to unblock — e.g. "STRIPE_SECRET_KEY" */
  requiredEnvVar?: string
  /** Integration ID that triggers resume — e.g. "stripe", "resend" */
  resumeOnIntegration?: string
  /** Step-by-step manual instructions (e.g. dashboard registration) */
  manualSteps?: string[]
  /** What the user should paste/do to unblock */
  userAction?: string
}

// ── Build Node ────────────────────────────────────────────────────────────────

export interface BuildNode {
  /** Unique node ID. Format: "{type}.{subtype}" e.g. "schema.users", "integration.stripe.checkout" */
  id: string
  /** Human-readable label */
  label: string
  type: NodeType
  status: NodeStatus
  /** Which build phase this node belongs to (1-based) */
  phase: number
  /** IDs of nodes this node depends on — execution is blocked until all deps are verified */
  dependencies: string[]
  blockedReason?: BlockedReason
  /** When execution started */
  startedAt?: string
  /** When execution completed (not necessarily verified) */
  executedAt?: string
  /** When real-state verification succeeded */
  verifiedAt?: string
  /** Human-readable description of what was created */
  executionDetail?: string
  /** Error message if status=failed */
  failureReason?: string
  /**
   * Execution parameters this node was built with.
   * Stored so we can re-execute idempotently on retry.
   */
  executionParams?: Record<string, unknown>
  /**
   * Whether this node is optional — if missing credentials,
   * the build can finish without it and report it as blocked (not failed).
   */
  optional?: boolean
}

// ── Build Phase ───────────────────────────────────────────────────────────────

export interface BuildPhase {
  number: number
  name: string
  description?: string
  nodes: BuildNode[]
}

// ── Build Job Status ──────────────────────────────────────────────────────────

export type BuildJobStatus =
  | 'pending'    // created, not yet started
  | 'running'    // currently executing
  | 'partial'    // some nodes done, some remaining/blocked
  | 'blocked'    // all non-blocked progress done; remaining nodes blocked on credentials
  | 'verified'   // all required nodes verified against real state
  | 'failed'     // fatal failure — build cannot continue

// ── Domain ────────────────────────────────────────────────────────────────────

/**
 * Extended domain type — covers the full spectrum of app categories.
 * The 4 original domains (ecommerce, saas, marketplace, generic) are preserved for
 * backwards compatibility. New domains unlock purpose-built phase templates.
 */
export type Domain =
  | 'ecommerce'   // online stores, product catalogs, retail
  | 'saas'        // multi-tenant SaaS, team workspaces, B2B
  | 'marketplace' // two-sided platforms, listings, sellers/buyers
  | 'social'      // social media, community platforms, blogs with social features
  | 'ai-saas'     // AI generation, job queues, credit systems, ML pipelines
  | 'fintech'     // financial services, payments, lending, crypto
  | 'media'       // video/audio streaming, content distribution
  | 'messaging'   // chat apps, collaboration, communication platforms
  | 'gaming'      // games, leaderboards, virtual goods, player progression
  | 'generic'     // everything else — compiler customizes from prompt

// ── Build Job ─────────────────────────────────────────────────────────────────

export interface BuildJob {
  id: string
  projectId: string
  userId: string
  originalPrompt: string
  domain: Domain
  status: BuildJobStatus
  phases: BuildPhase[]
  createdAt: string
  updatedAt: string
  /**
   * Short summary of what was requested.
   * Used in response rendering and continuation binding.
   */
  goalSummary?: string
  /**
   * The node ID to resume execution from on CONTINUATION.
   * Points to the first pending/blocked node.
   */
  resumeFromNodeId?: string
  /**
   * Whether Plan mode was used to generate this job.
   * Plan-mode jobs never execute — they only render the proposed architecture.
   */
  planOnly?: boolean
  /**
   * How this job was compiled:
   * - 'template'            → vague prompt; used preset domain starter template
   * - 'requirement-driven'  → explicit prompt; built only what was requested + support infra
   */
  buildMode?: 'template' | 'requirement-driven'
  /**
   * Phase 14 — audit trail of agent decisions made between phases.
   * Each entry captures what the planner observed, what it decided, and why.
   * Persisted so the UI can render the reasoning trail and so eval/replay
   * tooling can compare deterministic vs agentic outcomes on the same prompt.
   */
  agentDecisions?: AgentDecision[]
}

// ── Agent Decision (Phase 14 — Bounded Agency) ────────────────────────────────

/**
 * One decision emitted by the Phase Planner between two phases of a build.
 * The planner can only emit decisions from this discriminated union — the
 * executor + governance kernel stay deterministic.
 */
export type AgentDecisionKind =
  | 'proceed_as_planned'
  | 'replan_next_phase'
  | 'insert_repair_phase'
  | 'request_credentials'
  | 'abort'

export interface AgentDecision {
  /** ISO timestamp the decision was made */
  at: string
  /** Phase number that just completed (1-based) */
  afterPhase: number
  /** Phase number that the decision applies to (afterPhase + 1, or 'end' when aborting) */
  appliesTo: number | 'end'
  kind: AgentDecisionKind
  /** Short human-readable explanation for the UI + audit log */
  reasoning: string
  /** Node ids the planner inserted (for replan_next_phase / insert_repair_phase) */
  insertedNodeIds?: string[]
  /** Node ids the planner removed (for replan_next_phase) */
  removedNodeIds?: string[]
  /** Integration ids the planner is asking for credentials for */
  requestedIntegrationIds?: string[]
  /** Token + cost telemetry from the planner call */
  telemetry?: {
    promptTokens?: number
    completionTokens?: number
    model: string
    durationMs: number
  }
  /**
   * Set when planner output failed Zod validation and we fell back to
   * deterministic behaviour. The build still continues — we just record why.
   */
  fallbackReason?: string
}

// ── Build Response ────────────────────────────────────────────────────────────
/**
 * The ONLY output contract for Build mode responses.
 * All fields are derived from real BuildJob state — never from LLM freeform summaries.
 *
 * The chat renderer must use this contract exclusively in Build mode.
 */
export interface BuildResponse {
  mode: 'plan' | 'build'

  /** Nodes that were executed and verified against real state */
  built: Array<{ id: string; label: string; detail?: string }>

  /** Node IDs that passed explicit verification checks */
  verified: string[]

  /** Nodes partially done (infra up, credential missing, etc.) */
  partial: Array<{ id: string; label: string; detail?: string }>

  /**
   * Nodes blocked waiting on credentials or manual steps.
   * Each entry contains exactly what the user must do.
   */
  blocked: Array<{
    id: string
    label: string
    reason: string
    requiredAction?: string
    /** Integration ID for credential connect flow — e.g. "stripe", "google", "resend" */
    integrationId?: string
    /** Environment variable key needed — e.g. "STRIPE_SECRET_KEY" */
    envVar?: string
  }>

  /** Nodes that failed with errors */
  failed: Array<{ id: string; label: string; reason: string }>

  /** Node labels not yet started */
  remaining: string[]

  /** What should happen next (unambiguous, actionable) */
  next_step?: string

  /** Overall job status */
  jobStatus: BuildJobStatus

  /**
   * Detailed post-build validation report (#82).
   * Present when jobStatus is 'verified' or 'partial'.
   * Shows what was tested, what passed, what failed, what needs attention.
   */
  validationReport?: PostBuildValidationReport

  /** Formatted markdown string for chat rendering */
  markdown: string

  /**
   * Structured execution reasoning — why the AI made these choices, what changed,
   * what was auto-repaired. Shown to the user as evidence, not as a log dump.
   */
  reasoning?: {
    /** Summary of what was decided and why */
    decision: string
    /** What changed compared to the previous build state (additive summary) */
    changed: string[]
    /** What was auto-repaired during this build */
    repaired: string[]
    /** Why specific nodes could not complete */
    blockedReasons: string[]
  }
}

// ── Plan Response ─────────────────────────────────────────────────────────────

/**
 * Plan mode response: proposed architecture only, no mutations.
 */
export interface PlanResponse {
  mode: 'plan'
  domain: Domain
  phases: Array<{
    number: number
    name: string
    items: string[]
  }>
  integrations: Array<{
    name: string
    required: boolean
    credentialRequired?: string
  }>
  estimatedNodes: number
  markdown: string
}

// ── Validation Report (#82) ───────────────────────────────────────────────────

/**
 * Full post-build validation report surfaced to the user.
 * Aggregates behavioral scenarios, security audit, and load test results.
 * Never hidden — always shown so the user sees proof of what was tested.
 */
export interface PostBuildValidationReport {
  /** Overall pass/fail across all validation layers */
  passed: boolean
  /** ISO timestamp when validation ran */
  ranAt: string

  behavioral: {
    passed: boolean
    totalScenarios: number
    passedScenarios: number
    failedScenarios: number
    durationMs: number
    /** Names of failed scenarios */
    failures: string[]
  }

  security: {
    passed: boolean
    score: number         // 0-100
    endpointsAudited: number
    criticalCount: number
    highCount: number
    mediumCount: number
    /** Top findings to surface (critical first) */
    topFindings: Array<{
      severity: string
      category: string
      location: string
      description: string
      recommendation: string
    }>
  }

  loadTest: {
    passed: boolean
    overallP95Ms: number
    overallFailureRate: number
    endpointsTested: number
    regressionDetected: boolean
    regressions: string[]
  }

  /**
   * Production intelligence report — detects senior-engineer-level issues:
   * missing indexes, N+1 risk, weak RLS, unbounded pagination, webhook replay,
   * storage abuse, missing retry queues.
   * Present after every build; score 0-100.
   */
  productionIntelligence?: {
    score: number
    criticalCount: number
    highCount: number
    mediumCount: number
    lowCount: number
    autoFixableCount: number
    topIssues: Array<{
      type: string
      severity: string
      location: string
      description: string
      recommendation: string
      autoFixable: boolean
      fix?: string
    }>
  }
}

// ── Execution context ─────────────────────────────────────────────────────────

export interface BuildContext {
  projectId: string
  userId: string
  /** Available env vars / secrets for this project */
  availableSecrets?: string[]
  /** Current schema context (table names, columns) */
  schemaContext?: string
  /** SSE emit function for streaming progress */
  emit?: (event: string, data: unknown) => void
  /**
   * Pre-computed product blueprint from the Goal Understanding Engine.
   * When present, run-build emits a rich upfront plan before execution.
   */
  productBlueprint?: import('@/lib/ai/goal-understanding-engine').ProductBlueprint
}
