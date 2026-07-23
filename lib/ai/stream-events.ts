/**
 * AGENT STREAM EVENTS
 * ===================
 * SSE event types and helpers for streaming agent execution.
 *
 * Format: `data: <JSON>\n\n` (standard SSE)
 *
 * Event flow during execution:
 *   foundation     → one-shot architectural framing emitted at the top of every run
 *   narration      → dense, decisive sentences threaded between operations (premium voice)
 *   agent_action   → fine-grained transparency: reading / writing / sculpting / verifying
 *   plan           → upcoming step list with phase groups
 *   phase_transition → high-level state move (planning → building → validating → …)
 *   progress       → numeric progress for the live phase banner
 *   card_open      → a progressive build card starts shimmering
 *   card_item      → a row lands inside the card
 *   card_seal      → the card locks with a final status
 *   build_card     → terminal aggregate kept for replay / history rendering
 *   blocked        → causal stop reason — what was asked for, why this is needed
 *   step           → legacy per-node status (running | done | error)
 *   complete       → final message + payload
 *   error          → fatal error, stream ends
 */

/**
 * Narration tones drive the icon, weight and color of each sentence in the
 * cognitive stream. The voice rule: each narration is a *decision*, not an
 * operation. Never paraphrase what the tool just did — say what the agent
 * concluded, chose, or noticed.
 */
export type NarrationTone =
  | 'foundation'   // architectural framing — "Foundation first: tables → auth → APIs"
  | 'thinking'     // reading the request, scoping intent
  | 'deciding'     // committed to an approach
  | 'doing'        // mid-execution narrative
  | 'verifying'    // post-build checks
  | 'recovering'   // self-fix in progress
  | 'sealing'      // closing a phase cleanly

/** Coarse-grained "the agent is touching X right now" signal. */
export type AgentActionVerb =
  | 'reading'      // schema, conversation, config
  | 'sculpting'    // creating tables / endpoints / functions
  | 'wiring'       // connecting integrations, relations, triggers
  | 'verifying'    // running checks / proofs
  | 'sealing'      // finalizing a phase or card
  | 'recovering'   // applying a self-fix

/** Lifecycle states for a progressive build card. */
export type ProgressiveCardCategory =
  | 'database'
  | 'auth'
  | 'storage'
  | 'api'
  | 'integration'
  | 'function'
  | 'realtime'
  | 'security'
  | 'blocked'

export type AgentEvent =
  | { type: 'thinking'; message: string }
  | {
      /**
       * Emitted once at the top of every build run. The single highest-leverage
       * UX event — it tells the user the agent has a *plan* before any work
       * starts. Renders as a sticky banner inside the build panel.
       */
      type: 'foundation'
      /** Domain framing — "social platform", "marketplace", "SaaS billing", etc. */
      domain: string
      /** One-line architectural commitment in product voice. */
      headline: string
      /** Ordered phase chips — e.g. ["tables", "auth", "APIs", "storage"]. */
      order: string[]
    }
  | {
      /**
       * Dense, decision-driven narration emitted between every meaningful
       * operation. Keep each `text` under ~110 chars — it has to read like a
       * line a senior engineer would actually say while building, not a status
       * dump and not a marketing string.
       */
      type: 'narration'
      tone: NarrationTone
      text: string
      /** Optional milli-second hint for typewriter pacing on the client. */
      durationHintMs?: number
    }
  | {
      /**
       * Transparency event — what the agent is touching right now. The UI
       * shows a single rolling line: "Sculpting posts table…" with elapsed time.
       */
      type: 'agent_action'
      verb: AgentActionVerb
      target: string
      elapsedMs?: number
    }
  | {
      /**
       * Live progress signal for the phase banner. Driven by the agent loop —
       * each phase contributes a weighted slice (planning 10% · schema 25% ·
       * auth 15% · APIs 30% · storage 10% · verify 10%).
       */
      type: 'progress'
      phase: 'planning' | 'building' | 'validating' | 'finalizing'
      label: string
      /** 0..100 — clamped server-side. */
      percent: number
    }
  | {
      /**
       * A progressive card opens — UI slides in an empty card with a shimmer
       * row. Items follow as `card_item`, status locks with `card_seal`.
       */
      type: 'card_open'
      cardId: string
      category: ProgressiveCardCategory
      title: string
      /** Short subtitle shown faintly inside the card header. */
      subtitle?: string
    }
  | {
      type: 'card_item'
      cardId: string
      /** Stable id so re-emits update the same row. */
      itemId: string
      label: string
      status: 'pending' | 'ready' | 'failed'
      /** Short hint shown faintly to the right of the label. */
      hint?: string
    }
  | {
      type: 'card_seal'
      cardId: string
      status: 'ready' | 'partial' | 'blocked' | 'failed'
      /** When blocked, this drives the inline causal stop card. */
      blockedOn?: {
        secretName: string
        integration: string
        requiredBecause: string
      }
      /** Short closing line shown faintly under the card. */
      footer?: string
    }
  | {
      /**
       * Structured causal stop. Replaces the previous "Waiting for credentials"
       * string. Every field is mandatory because the trust unlock is precisely
       * the *why this is needed* + *what happens if you skip* explanation.
       */
      type: 'blocked'
      integration: string
      integrationLabel: string
      secretName: string
      /** Human "what you asked for that triggered this" sentence. */
      requiredBecause: string
      /** Docs link to fetch the key. */
      docsUrl?: string
      /** What still works if the user skips. */
      skipBehavior: string
    }
  | {
      type: 'plan'
      steps: Array<{ action: string; label: string }>
      /** Domain detected (e.g. "ecommerce") — shown as plan header */
      domain?: string
      /** Human-readable summary of what will be built */
      architectureSummary?: string
      /** Integrations that need credentials to be fully functional */
      credentialsNeeded?: Array<{ name: string; hint: string }>
      /**
       * Subgoals grouped by phase — used by the frontend to render a phase-aware
       * progress view instead of a flat step list.
       * e.g. [{ phase: 'DOMAIN_MODEL', label: 'Domain Model', subgoalIds: ['sg1','sg2'] }]
       */
      phaseGroups?: Array<{ phase: string; label: string; subgoalIds: string[] }>
    }
  | { type: 'step'; action: string; label: string; status: 'running' | 'done' | 'error'; error?: string }
  | {
      /**
       * Emitted at end-of-build with the full phase progress summary.
       * Frontend uses this to render the "Building backend / Completed / Blocked / Pending" panel.
       */
      type: 'build_status'
      /** Formatted multi-line status block (markdown) */
      statusText: string
      /** Phases that are blocked on credentials */
      blockedIntegrations: Array<{
        integration: string
        reason: string
        secretsNeeded: string[]
      }>
      /** True when any phase is blocked */
      hasBlocked: boolean
    }
  | {
      type: 'complete'
      message: string
      success: boolean
      responseData?: any
      /** Whether the build is blocked on credentials — UI shows a paste prompt */
      isBlocked?: boolean
      /** Suggestion chips for natural next actions */
      nextActions?: string[]
      /** Self-critic follow-up — resource gaps the AI detected */
      gaps?: Array<{ type: string; name: string; reason: string }>
    }
  | { type: 'error'; message: string }
  | {
      /**
       * UI Cognitive Layer — phase transition events.
       * The frontend uses these to animate state transitions instead of
       * dumping raw text. Shows: Planning → Building → Validating → Blocked → Done.
       */
      type: 'phase_transition'
      /** New phase the build is entering */
      phase: 'planning' | 'building' | 'validating' | 'blocked' | 'complete' | 'error_recovery'
      /** Human-readable phase label */
      label: string
      /** Optional detail (e.g., which components are blocked) */
      detail?: string
    }
  | {
      /**
       * Progress card event — emitted after a successful build.
       * Frontend renders a structured card instead of a raw text dump.
       * Matches the Lovable/Base44 "cards" pattern.
       */
      type: 'build_card'
      /** Category of card */
      category: 'database' | 'auth' | 'storage' | 'api' | 'integration' | 'function' | 'blocked'
      /** Card title */
      title: string
      /** Card status */
      status: 'ready' | 'blocked' | 'partial' | 'failed'
      /** What's inside this card */
      items: string[]
      /** If blocked, what the user must provide */
      blockedOn?: string
    }
  | {
      /**
       * Phase 1 (shadow mode) — structured product understanding emitted before
       * the build pipeline runs. The dashboard renders a "Product Understanding"
       * card from this; the executor does NOT consume it yet.
       *
       * Gated by ENABLE_CAPABILITY_GRAPH. Payload shape: ProductUnderstanding
       * from lib/ai/understanding/types — typed loosely here to avoid a build
       * graph between this file and the understanding module.
       */
      type: 'product_understanding'
      productLabel: string
      primaryDomain: string
      backendPatterns: string[]
      criticalCapabilities: string[]
      confidence: { score: number; band: 'high' | 'medium' | 'low' }
      evidence: string[]
      warnings: string[]
      /** Full ProductUnderstanding object — kept under a nested key for forward-compat */
      detail: unknown
    }
  | {
      /**
       * Phase 2 (shadow mode) — workflows extracted from ProductUnderstanding.
       * Emitted right after `product_understanding` when both
       * ENABLE_CAPABILITY_GRAPH and ENABLE_WORKFLOW_EXTRACTOR are on.
       *
       * The executor does NOT consume this yet. Phase 6 will use
       * `workflows[].steps` to drive endpoint + worker generation.
       *
       * Payload shape: WorkflowsReport from lib/ai/planning/types — typed
       * loosely here to avoid a type-graph cycle.
       */
      type: 'workflows_detected'
      workflowCount: number
      categories: string[]
      overallConfidence: number
      needsClarification: boolean
      warnings: string[]
      detail: unknown
    }
  | {
      /**
       * Phase 3 (shadow mode) — business rules extracted from
       * ProductUnderstanding + WorkflowsReport. Emitted right after
       * `workflows_detected` when ENABLE_CAPABILITY_GRAPH +
       * ENABLE_WORKFLOW_EXTRACTOR + ENABLE_BUSINESS_RULE_EXTRACTOR are all on.
       *
       * The executor does NOT consume this. Phase 7 (Behaviour Verifier)
       * will read rule.verificationHint to drive scenario tests.
       */
      type: 'business_rules_detected'
      ruleCount: number
      categories: string[]
      enforcements: string[]
      overallConfidence: number
      warnings: string[]
      detail: unknown
    }
  | {
      /**
       * Phase 4 (shadow mode) — state machine plans inferred from
       * ProductUnderstanding + WorkflowsReport + BusinessRulesReport.
       * Emitted right after `business_rules_detected` when all four
       * upstream phase flags are on.
       *
       * The executor does NOT mount any of the listed endpoints in
       * Phase 4. Phase 6 will start consuming these to drive real
       * endpoint generation.
       */
      type: 'state_machines_detected'
      planCount: number
      tables: string[]
      domains: string[]
      overallConfidence: number
      warnings: string[]
      detail: unknown
    }
  | {
      /**
       * Phase 5 (shadow mode) — plan validation report. Emitted right
       * after `state_machines_detected` when ENABLE_PLAN_VALIDATOR is on
       * (alongside the prior phase flags).
       *
       * The executor does NOT gate on this. Phase 9 (dashboard) will
       * render the readinessLabel + readinessScore + findings.
       */
      type: 'plan_validation'
      readinessLabel: string
      readinessScore: number
      blockingCount: number
      warningCount: number
      recommendedNextActions: string[]
      detail: unknown
    }
  | {
      /**
       * Phase 6 (shadow mode) — domain-aware API plan. Emitted right after
       * `plan_validation` when ENABLE_DOMAIN_API_GENERATOR is on (alongside
       * the prior phase flags).
       *
       * The executor does NOT mount any of the listed endpoints. Phase 7
       * will run the behaviour verifier against these plans and Phase 8
       * will eventually generate real handlers.
       */
      type: 'domain_apis_planned'
      apiCount: number
      categories: string[]
      methods: string[]
      overallConfidence: number
      warnings: string[]
      detail: unknown
    }
  | {
      /**
       * Phase 7 (shadow mode) — behaviour verification scenarios planned
       * from the upstream Phase 1–6 outputs. Emitted right after
       * `domain_apis_planned` when ENABLE_BEHAVIOR_VERIFICATION is on
       * (alongside the prior phase flags).
       *
       * STRICT SHADOW MODE: no scenarios are executed against the workspace
       * DB. The executor does NOT consume this. Phase 8 will run scenarios
       * for real and Phase 9 (dashboard) will render this report.
       */
      type: 'behavior_verification_planned'
      scenarioCount: number
      criticalCount: number
      runnableCount: number
      blockedCount: number
      readinessImpact: 'blocks_production' | 'needs_verification' | 'verification_ready'
      categories: string[]
      warnings: string[]
      detail: unknown
    }
  | {
      /**
       * Phase 8 (preview / shadow mode) — HealthFindingPreview list mapped
       * from the Phase 1–7 reports, plus a deterministic ranked list of
       * "next best actions". Emitted right after `behavior_verification_planned`
       * when ENABLE_HEALTH_FINDINGS_FROM_AI_REPORTS is on.
       *
       * STRICT PREVIEW MODE: no DB writes, no auto-fix execution, no live
       * verification runs. The dashboard renders these previews directly.
       *
       * `findings` carries `HealthFindingPreview[]` (shape declared in
       * lib/core/ai-report-to-health-findings.ts) and `nextBestActions`
       * carries `NextBestAction[]` (shape in lib/core/next-best-action.ts).
       * Typed loosely here to avoid a build graph between this file and
       * the core module.
       */
      type: 'health_findings_preview'
      findingCount: number
      criticalCount: number
      warningCount: number
      infoCount: number
      sources: string[]
      types: string[]
      autoFixableCount: number
      requiresApprovalCount: number
      notifyOnlyCount: number
      findings: unknown
      nextBestActions: unknown
      shadowMode: true
    }
  | {
      /**
       * Phase 12 — Fix plans generated from HealthFindingPreview[] (AI pipeline)
       * or RawFinding[] (observer). Emitted after `health_findings_preview` when
       * ENABLE_AUTO_FIX_PLANNER is on.
       *
       * `fixPlans` carries `FixPlan[]` (shape in lib/core/fix-plan-generator.ts).
       * Typed loosely to avoid a build graph between this file and the core module.
       */
      type: 'auto_fix_planned'
      fixPlans: unknown
      autoExecutable: number
      requiresApproval: number
      notifyOnly: number
      shadowMode: true
    }
  | {
      /**
       * Phase 13 — verification scenarios executed (safe_live or dry_run).
       * Emitted after the verification executor completes a run, either from
       * the workspace observer or the AI pipeline when
       * ENABLE_VERIFICATION_EXECUTION is on.
       *
       * `passed`  — structural checks confirmed the backend behaves correctly.
       * `failed`  — structural checks found gaps; new findings are created.
       * `skipped` — scenarios were not eligible for live execution (blocked
       *             category, canRunNow=false, or dry_run mode).
       *
       * This event carries no shadowMode flag — it represents real execution.
       */
      type: 'verification_executed'
      total: number
      passed: number
      failed: number
      skipped: number
    }
  | {
      /**
       * Phase 14 — Agentic Phase Planner emitted a decision between phases.
       * Carries the structured decision so the UI can render the reasoning
       * trail alongside the build cards. The deterministic executor still
       * does the work — this event is purely the agent's "why".
       */
      type: 'agent_decision'
      afterPhase: number
      appliesTo: number | 'end'
      kind:
        | 'proceed_as_planned'
        | 'replan_next_phase'
        | 'insert_repair_phase'
        | 'request_credentials'
        | 'abort'
      reasoning: string
      insertedNodeIds?: string[]
      removedNodeIds?: string[]
      requestedIntegrationIds?: string[]
      /** Set when planner output failed validation and we fell back. */
      fallbackReason?: string
    }
  | {
      /**
       * Phase 14 — Agentic Fix Author proposed a novel fix the curated
       * registry did not cover. Goes through executeAction governance like
       * any other fix; this event simply tells the UI the agent authored it
       * (vs picked it from the curated registry).
       */
      type: 'agent_proposed_fix'
      sourceCheckId: string
      action: string
      reason: string
      requiresApproval: boolean
    }

export type EmitFn = (event: AgentEvent) => void

export function formatSSE(event: AgentEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

/**
 * Create a ReadableStream that emits SSE events.
 * The handler receives `emit` (send an event) and `done` (close stream).
 *
 * Safety: a hard timeout (default 120s) ensures the stream always closes,
 * even if the handler hangs on a slow OpenAI call or DB query.
 */
export function createSSEStream(
  handler: (emit: EmitFn, done: () => void) => Promise<void>,
  maxLifetimeMs: number = 120_000,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false

      const emit: EmitFn = (event) => {
        if (closed) return
        try {
          controller.enqueue(formatSSE(event))
        } catch {
          // Stream already closed — ignore
        }
      }

      const done = () => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          // Already closed
        }
      }

      // Heartbeat: send a comment line every 20s to prevent Nginx proxy_read_timeout (60s default)
      // from closing the connection during long-running AI/DB operations.
      const heartbeatInterval = setInterval(() => {
        if (closed) { clearInterval(heartbeatInterval); return }
        try {
          controller.enqueue(new TextEncoder().encode(': ping\n\n'))
        } catch {
          clearInterval(heartbeatInterval)
        }
      }, 20_000)

      // Hard timeout: if the handler hasn't called done() within maxLifetimeMs,
      // emit an error and force-close the stream.
      const safetyTimer = setTimeout(() => {
        if (!closed) {
          clearInterval(heartbeatInterval)
          console.error(`[SSE] Stream exceeded ${maxLifetimeMs}ms lifetime — force-closing`)
          emit({ type: 'error', message: 'Request timed out. Please try again.' })
          done()
        }
      }, maxLifetimeMs)

      handler(emit, () => { clearInterval(heartbeatInterval); clearTimeout(safetyTimer); done() }).catch((err: any) => {
        clearInterval(heartbeatInterval)
        clearTimeout(safetyTimer)
        emit({ type: 'error', message: err?.message ?? 'Unexpected server error' })
        done()
      })
    },
  })
}

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no', // Disable Nginx buffering for true streaming
}
