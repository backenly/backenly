/**
 * Feature flags for the Backenly architecture upgrade.
 *
 * Each flag defaults to OFF. Set the corresponding env var to "true" to
 * enable. Flags here gate *new* code paths added by the phased upgrade plan
 * — they never disable existing production behaviour.
 *
 * Why this lives outside lib/config/env.ts:
 *   env.ts validates with zod and is loaded at boot. These flags are looked
 *   up per-request so they can flip without a server restart, which matters
 *   while we're rolling new behaviour out in shadow mode.
 */

function readBool(name: string): boolean {
  const v = process.env[name]
  if (typeof v !== 'string') return false
  return v.toLowerCase() === 'true' || v === '1'
}

export const FLAGS = {
  /**
   * Phase 1 — Capability Graph.
   * When on, the chat route runs `extractProductUnderstanding` after intent
   * classification and emits a `product_understanding` SSE event. The
   * executor does NOT consume the result yet (shadow mode).
   */
  get ENABLE_CAPABILITY_GRAPH(): boolean { return readBool('ENABLE_CAPABILITY_GRAPH') },

  // Reserved for upcoming phases — declared here so call sites compile
  // without churn when each phase lands.
  get ENABLE_WORKFLOW_EXTRACTOR(): boolean { return readBool('ENABLE_WORKFLOW_EXTRACTOR') },
  get ENABLE_BUSINESS_RULE_EXTRACTOR(): boolean { return readBool('ENABLE_BUSINESS_RULE_EXTRACTOR') },
  get ENABLE_STATE_MACHINE_DETECTOR(): boolean { return readBool('ENABLE_STATE_MACHINE_DETECTOR') },
  /** Phase 5 — plan validator (shadow / report only) */
  get ENABLE_PLAN_VALIDATOR(): boolean { return readBool('ENABLE_PLAN_VALIDATOR') },
  get ENABLE_DOMAIN_API_GENERATOR(): boolean { return readBool('ENABLE_DOMAIN_API_GENERATOR') },
  get ENABLE_BEHAVIOR_VERIFICATION(): boolean { return readBool('ENABLE_BEHAVIOR_VERIFICATION') },
  /**
   * Phase 8 — health-findings preview from AI reports (shadow / preview only).
   * When on, the chat route maps Phase 1–7 reports into HealthFindingPreview[]
   * and emits a `health_findings_preview` SSE event. No DB writes occur, no
   * auto-fix executes, no live verification runs.
   */
  get ENABLE_HEALTH_FINDINGS_FROM_AI_REPORTS(): boolean { return readBool('ENABLE_HEALTH_FINDINGS_FROM_AI_REPORTS') },
  /**
   * Phase 8 step 2 — optional persistence of preview findings into the
   * existing HealthFinding table. Off by default. Wiring is deferred to a
   * follow-up commit; the flag exists today so call sites can compile.
   */
  get ENABLE_AI_HEALTH_FINDINGS_PERSISTENCE(): boolean { return readBool('ENABLE_AI_HEALTH_FINDINGS_PERSISTENCE') },
  /**
   * Phase 11 — Route / Orchestrator Refactor.
   *
   * When on, the AI chat route may delegate to the new
   * `lib/ai/orchestrator/AIOrchestrator` service instead of running every
   * gate inline. The orchestrator initially *wraps* the existing pipeline
   * rather than replacing it — when this flag is off (the default),
   * `app/api/ai/chat/route.ts` runs unchanged and behaviour is identical
   * to Phase 10.
   *
   * Hard rules while this flag is rolled out:
   *   • No behaviour change when the flag is false.
   *   • The legacy inline gate tower in `app/api/ai/chat/route.ts` remains
   *     the source of truth; the orchestrator service is additive.
   *   • The build-runtime, dynamic-agent-loop, and the legacy
   *     saveBuildMessages fallback are NOT removed.
   */
  get USE_ORCHESTRATOR_SERVICE(): boolean { return readBool('USE_ORCHESTRATOR_SERVICE') },

  /**
   * Agentic Loop v2 — the real tool-use agent.
   *
   * When on, the chat route hands eligible turns to `runAgentLoop`
   * (lib/ai/agent/agent-loop-v2.ts) BEFORE the 25-stage legacy pipeline:
   * one model, a typed tool surface, understand→plan→execute→verify — the
   * architecture Cursor/Replit/Lovable use. When off, the legacy pipeline
   * runs unchanged, so flipping the flag is an instant reversible rollback.
   *
   * Credential-paste / file-upload / deploy turns are still delegated to
   * the legacy stages (the interceptor skips those shapes).
   */
  get USE_AGENT_LOOP(): boolean { return readBool('USE_AGENT_LOOP') },

  /**
   * Phase 10 — Conversation History + BuildRun Snapshot Cleanup.
   *
   * When on:
   *   • The chat route persists build snapshots through the BuildRun service
   *     (mark-as-superseded instead of destructive delete).
   *   • `GET /api/projects/[id]/messages` returns `currentBuildState` alongside
   *     the message list, computed from the latest non-superseded snapshot.
   *   • The project page hydrates from `currentBuildState` for the right panel
   *     and treats older snapshots as historical (no auto-credential modal,
   *     compact card render).
   *
   * When off the legacy `saveBuildMessages` path runs unchanged.
   */
  get ENABLE_PHASE_10_BUILD_HISTORY(): boolean { return readBool('ENABLE_PHASE_10_BUILD_HISTORY') },

  /**
   * Phase 12 — Fix Plan Generator.
   *
   * When on, the workspace observer and the AI pipeline generate FixPlan[]
   * from HealthFindingPreview[] / RawFinding[] after each health scan.
   * Plans are attached to ObserverResult and emitted as an `auto_fix_planned`
   * SSE event. No fixes are executed yet — plans only.
   *
   * Off by default. Safe to enable independently of ENABLE_AUTO_FIX_EXECUTION.
   */
  get ENABLE_AUTO_FIX_PLANNER(): boolean { return readBool('ENABLE_AUTO_FIX_PLANNER') },

  /**
   * Phase 12 — Auto-Fix Execution.
   *
   * When on (requires ENABLE_AUTO_FIX_PLANNER also on), safe auto-fixable
   * plans are executed immediately without user approval. Plans where
   * requiresApproval is true are queued and never auto-run.
   *
   * Hard rules while this flag is on:
   *   • shadowMode findings are never auto-executed.
   *   • Integration credential connections are never auto-executed.
   *   • Billing and auth mutations are never auto-executed.
   *   • Only plans with autoFixable=true and requiresApproval=false run.
   *
   * Off by default. Never enable in production without ENABLE_AUTO_FIX_PLANNER.
   */
  get ENABLE_AUTO_FIX_EXECUTION(): boolean { return readBool('ENABLE_AUTO_FIX_EXECUTION') },

  /**
   * Phase 13 — Live Behavior Verification Execution.
   *
   * When on, the workspace observer runs structural verification scenarios
   * after each health scan and fix-plan cycle. Results feed back into
   * HealthFinding records: passed scenarios resolve `missing_verification`
   * findings; failed scenarios create new `verification_failed` findings.
   *
   * Hard rules while this flag is on:
   *   • Only `safe_live` eligible categories run: auth, rls, state_machine, security.
   *   • billing, webhook, storage, admin, runtime categories are NEVER executed.
   *   • Verification never mutates workspace data — reads only.
   *   • ENABLE_SAFE_VERIFICATION_MODE must also be on for live execution.
   *
   * Off by default.
   */
  get ENABLE_VERIFICATION_EXECUTION(): boolean { return readBool('ENABLE_VERIFICATION_EXECUTION') },

  /**
   * Phase 13 — Safe Verification Mode guard.
   *
   * When on (required for ENABLE_VERIFICATION_EXECUTION to run live), enforces
   * that only structurally safe, read-only checks are executed. If this flag is
   * off while ENABLE_VERIFICATION_EXECUTION is on, the executor falls back to
   * dry_run, ensuring no live checks accidentally run without the safety layer.
   *
   * Default: true (safe mode is on by default when set).
   */
  get ENABLE_SAFE_VERIFICATION_MODE(): boolean { return readBool('ENABLE_SAFE_VERIFICATION_MODE') },

  /**
   * Phase 14 — Agentic Phase Planner (bounded agency, Surface A).
   *
   * When on, the build runtime calls a gpt-4o-mini phase planner *between*
   * phases of executeBuildGraph. The planner observes the just-completed
   * phase's real DB state and emits one of:
   *   - proceed_as_planned
   *   - replan_next_phase (insert/remove nodes from the next phase)
   *   - insert_repair_phase (fixes to apply before continuing)
   *   - request_credentials
   *   - abort
   *
   * Hard limits while on:
   *   - Planner output validated by Zod; invalid → fall back to deterministic.
   *   - `insertNodes` must use existing NodeType values only.
   *   - Max 3 replans per build.
   *   - Every decision persisted to BuildJob.agentDecisions[] for audit.
   *   - Governance kernel (mutate.ts) still owns every DB write.
   */
  get ENABLE_AGENTIC_PHASE_PLANNER(): boolean { return readBool('ENABLE_AGENTIC_PHASE_PLANNER') },

  /**
   * Phase 14 — Agentic Fix Author (bounded agency, Surface B).
   *
   * When on, the agentic-fix-loop calls a gpt-4o-mini fix author when the
   * curated `mapCheckToFixes` registry returns no candidates for a failing
   * behavioral check. The author proposes a FixCandidate whose `action`
   * field is restricted to the existing AIAction vocabulary.
   *
   * Hard limits while on:
   *   - Action whitelist enforced via Zod against the AIAction discriminated union.
   *   - Every fix still routes through executeAction → mutate.ts governance.
   *   - Destructive actions still trip approval-system.ts.
   *   - Max 5 novel fixes per build.
   *   - Non-feature refusals from lib/non-features still apply.
   */
  get ENABLE_AGENTIC_FIX_AUTHOR(): boolean { return readBool('ENABLE_AGENTIC_FIX_AUTHOR') },

  /**
   * Autonomy — Shadow Reconciler (closed-loop, SHADOW ONLY).
   *
   * When on, the background cron runs the MAPE-K reconciler after each scan:
   * it computes the desired-state diff, decides what it WOULD do under the
   * project's autonomy level + circuit breaker, and records the decision to
   * the audit log (AUTONOMY_SHADOW_DECISION). It executes NOTHING.
   *
   * This is the deliberate shadow-validation gate the autonomy rollout
   * requires: precision of the loop's decisions is measured for weeks from
   * these audit rows BEFORE any live execution flag is ever introduced.
   *
   * Off by default. Safe to enable in production — it only observes.
   */
  get ENABLE_AUTONOMY_RECONCILER(): boolean { return readBool('ENABLE_AUTONOMY_RECONCILER') },

  /**
   * Autonomy live execution.
   *
   * Separate explicit production lever for real autonomous mutations. The
   * reconciler flag alone is shadow-only and never applies changes.
   */
  get ENABLE_AUTONOMY_LIVE_EXECUTION(): boolean { return readBool('ENABLE_AUTONOMY_LIVE_EXECUTION') },
}

export function isFlagEnabled(name: keyof typeof FLAGS): boolean {
  return FLAGS[name]
}

/**
 * Phase 10 client mirror — `'use client'` components cannot read server flags,
 * so the project page checks `NEXT_PUBLIC_ENABLE_PHASE_10_BUILD_HISTORY` at
 * build time. Set both env vars together for end-to-end activation.
 */
export function isPhase10BuildHistoryEnabledClient(): boolean {
  if (typeof process === 'undefined') return false
  const v = process.env.NEXT_PUBLIC_ENABLE_PHASE_10_BUILD_HISTORY
  if (typeof v !== 'string') return false
  return v.toLowerCase() === 'true' || v === '1'
}
