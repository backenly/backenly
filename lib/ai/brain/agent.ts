/**
 * BRAIN AGENT — the loop
 * ======================
 * The single entry point for a natural-language turn. Its caller is MCP
 * `backend_chat` (app/api/mcp/chat/route.ts), which queues every call the
 * approval gate stops in the Review Queue; an approved call later runs
 * verbatim through dispatchTool (lib/mcp/approvals.ts), not through this loop.
 * Replaces the 25-stage regex pipeline and the legacy `agent-loop-v2`. The
 * shape is the same one Cursor / Replit / Lovable use:
 *
 *   load memory → classify intent → route → (loop tool-use) → verify → finish
 *
 * Routing decisions per intent (made BEFORE the agent loop runs):
 *   CHAT            → call answer_question once, return.
 *   UNCLEAR         → ask one clarifying question (ask_user), return. On an
 *                     empty project, a message that reads like an app
 *                     description goes to the architect first, as a BUILD.
 *   BUILD / APPLY_PROPOSAL on an empty project
 *                   → propose a blueprint (curated, or the architect's design)
 *                     and save it as the pending plan; ask_user when the
 *                     request is too vague to design.
 *   CONFIRM         → run the pending blueprint plan, else the resume queue,
 *                     else the original build request, re-architected. With
 *                     nothing pending at all, say so and change nothing.
 *   anything else, or a route above with nothing to run
 *                   → the agent loop, with an intent-specific hint.
 *
 * This is what makes "give me competitors" NEVER trigger a build:
 *   1. The LLM classifier returns CHAT with high confidence.
 *   2. We dispatch answer_question directly, bypassing every mutation tool.
 *   3. The agent loop never even sees the mutation tool surface for that turn.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { aiAvailability, AiError, effectiveTokensOf, generate, type GenerateResult } from '../llm'
import { agentSystemPrompt, clarifyPrompt } from './prompts'
import {
  conversationFor,
  modelFailureOf,
  textOf,
  toModelTool,
  toolResultBlock,
  toolUsesOf,
  type ModelFailure,
} from './model'
import { collectProof, formatProof } from '../proof-system'
import { loadBrainMemory, formatUnderstanding, formatRecentHistory, saveTurn, type ConversationTurn } from './memory'
import { classify, type BrainIntent, type Classification } from './classifier'
import {
  BRAIN_MODEL_TOOLS,
  dispatchTool,
  isReadOnlyCall,
  isReadOnlyTool,
  humanTitle,
  type ToolDispatchContext,
  type ToolName,
  type ToolResult,
} from './tools'
import { getBlueprintForPrompt, isExplicitSpec } from '../blueprints'
import { looksLikeBuildDescription } from './build-signals'
import { saveLoopResume, loadLoopResume, clearLoopResume, resumePrompt, type LoopResume, type LoopStop } from './loop-resume'
import {
  savePendingPlan, loadPendingPlan, clearPendingPlan,
  saveResumeQueue, loadResumeQueue, clearResumeQueue,
} from '../blueprints/store'
import type { Blueprint, BlueprintMatch, BlueprintStep } from '../blueprints/types'
import {
  extractRequirements,
  appliedStateFromSteps,
  reconcileLedger,
  renderLedgerReport,
  ledgerHasContent,
  type RequirementsLedger,
} from '../blueprints/ledger'
import { createSeedContext, runSeedStep, type SeedTableResult } from '../blueprints/seed-runner'
import type { FixLoopResult } from '../agentic-fix-loop'
import { recordToolExecutionMemory, type BackendEventStatus } from '@/lib/operational-memory/ledger'
import { needsApproval } from '@/lib/mcp/domains'
import type { DataMigrationEstimate } from '@/lib/execution/data-migration'
import { redactArgs } from './redact'
import { currentPageContext, isAgentDoor, type BrainDoor } from './input-context'

/**
 * One tool call the approval gate stopped, carried verbatim so the caller can
 * queue exactly this call for a human. `args` is the model's argument object,
 * unredacted: it is what an approval executes, so it must be exact.
 */
export interface BlockedCall {
  tool: string
  args: Record<string, unknown>
  /** Human description of what is affected, e.g. "the `followers` table". */
  target: string
  /** Live row count of the affected table when cheaply knowable. */
  rowCount: number | null
  /** True when a restore point can bring the structure back. */
  reversible: boolean
}

/**
 * Control-flow tools — neither mutations nor reads of backend state.
 * (Reads are tracked in tools.READ_ONLY_TOOLS, per call by tools.isReadOnlyCall;
 * mutations are everything else.)
 */
const CONTROL_TOOLS = new Set<string>([
  'finish', 'propose_plan', 'ask_user', 'answer_question',
  'apply_proposal', 'run_test',
])

/**
 * Whether one call can change the backend: what lists it in the turn's
 * `applied` and sends a later finish back for verification. Exported so
 * tests/unit/brain-mutation-accounting.spec.ts can list every tool it counts.
 */
export function isMutationCall(name: string, args: Record<string, unknown>): boolean {
  return !CONTROL_TOOLS.has(name) && !isReadOnlyCall(name, args)
}

/**
 * Tools that read their own result back out of the live catalog before they
 * return, and fail rather than report an unconfirmed change.
 *
 * Membership is a claim about the EXECUTOR, not a convenience: a tool belongs
 * here only if ok:true already means "PostgreSQL was asked what it now contains
 * and the answer matched". `set_rls` and `add_rls` share
 * installCustomPolicySet, which re-reads pg_policies per command and restores
 * the table if a policy it just created is not there.
 *
 * Anything listed here that does NOT do that would suppress the verification
 * pass while proving nothing — strictly worse than not being listed.
 */
const SELF_VERIFYING_TOOLS = new Set<string>(['set_rls', 'add_rls'])

export interface BrainInput {
  projectId: string
  userId: string
  message: string
  sessionToken?: string
  // There is deliberately no "destructive confirmed" flag. A destructive or
  // high-risk call is never executed by the brain: the gate stops it, the
  // caller queues the exact call for a human, and an approval runs that call
  // verbatim (lib/mcp/approvals.ts runApprovedCall). Approval is a decision a
  // person makes in the dashboard, never something a message can carry.
  /**
   * Per-turn idempotency key (UUID) passed down to `saveTurn`/`saveMessages`,
   * so a turn written twice, by a retry say, is logged once. backend_chat
   * sends none.
   */
  requestId?: string | null
  /** The caller that opened this turn. Unlike `surface`, this is not page context. */
  door?: BrainDoor
  /**
   * The product section the user is looking at while making a request.
   * E.g. "Database", "Auth & Users",
   * "Monitoring". Advisory only: lets "add an index to this table" or "why is
   * this failing" resolve without re-asking. Never required.
   */
  surface?: string | null
  /**
   * ── The wall-clock deadline this turn must respect (epoch ms) ───────────────
   *
   * Verification used to be the LAST thing the loop did, so it was always the
   * thing a wall-clock cap cut off. Four out of four RLS calls over MCP came back
   * "reached its time budget during final verification" — meaning the operations
   * that most needed proof were exactly the ones that never got any.
   *
   * With a deadline the loop stops taking NEW work while `VERIFY_RESERVE_MS`
   * still remains and spends that reserve on a deterministic verification pass
   * (see `verifyWithinBudget`). Verification is no longer a step the model may or
   * may not reach; it is a budget line item that is spent first from the end.
   *
   * Omit it and the loop has no wall clock of its own. backend_chat always
   * passes one, from its 90s cap.
   */
  deadlineAt?: number
  /**
   * ── Token reporting that survives an abort ─────────────────────────────────
   *
   * `BrainResult.tokensUsed` is only readable when the turn RETURNS. Callers
   * that race this function against a wall clock (the MCP transport caps at
   * 90s) never see it on the timeout path, because the race rejects and the
   * result is discarded — so a run that spent 80s of model time was billed
   * nothing at all. That is the most expensive kind of turn to lose.
   *
   * This fires after every completion, as the tokens are actually consumed, so
   * a caller can accumulate them itself and charge what was spent even when the
   * turn never finishes. Reporting incrementally is the only way to make the
   * number survive; returning it cannot, by construction.
   *
   * Must not throw — it is invoked inside the model loop.
   */
  onTokens?: (tokens: number) => void
}

export type BrainEvent =
  | { type: 'phase'; phase: 'understand' | 'classify' | 'route' | 'execute' | 'verify' | 'finish' }
  | { type: 'classification'; intent: BrainIntent; confidence: number; reasoning: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; tool: string; title: string }
  | { type: 'tool_done'; tool: string; title: string; detail?: string }
  | { type: 'tool_fail'; tool: string; title: string; detail?: string }
  /**
   * A call the approval gate stopped: it did not run, and the caller queues it
   * for a person from BrainResult.blockedCalls. This names the same target and
   * live row count (best-effort COUNT). No message approves a call, so
   * `confirmPhrase` is a label, not something to type.
   */
  | {
      type: 'danger'
      tool: string
      /** Human target, e.g. "recipes table" / "column notes on recipes". */
      target: string
      /** Live row count of the affected table when cheaply knowable. */
      rowCount: number | null
      /** True when a restore point can bring the structure back. */
      reversible: boolean
      confirmPhrase: string
    }
  | { type: 'final'; summary: string; needsUser: boolean; data?: unknown }
  | { type: 'error'; message: string }

export interface BrainResult {
  success: boolean
  summary: string
  needsUser: boolean
  /** Agent-loop model calls that came back with an answer; a turn that skips the loop counts its steps. */
  iterations: number
  toolsRun: string[]
  classification: Classification
  /** Total model tokens consumed this turn — billed as token-backed credits. */
  tokensUsed: number
  /**
   * True when this turn already ran the behavioral fix-loop against the live
   * runtime (the deterministic blueprint executor does).
   */
  verifiedInline?: boolean
  /**
   * ── Machine-readable failure classification ─────────────────────────────────
   *
   * The prose in `summary` has always been honest about WHY a turn failed
   * ("I stopped before changing anything because the AI provider rate-limited
   * us"). None of it was machine-readable, so every caller had to regex the
   * summary or give up — and `/api/mcp/chat` gave up, returning a bare
   * `Brain run failed.` with no code, no retryable flag and no indication that
   * the identical request would succeed on a second attempt (defect #14).
   *
   * The rate-limit case is the sharpest version: the brain stopped cleanly and
   * said so, and the only place that reached the agent was the `resultSummary`
   * of a later `check_approval` poll — a field nobody would think to read for it
   * (defect #15).
   *
   * Set only when the turn did not complete cleanly.
   */
  failureCode?: BrainFailureCode
  /**
   * Whether an identical retry has a reasonable chance of succeeding. A rate
   * limit and a model timeout are retryable; running out of steps is not (the
   * caller should say "continue" instead), and neither is a tool that refused on
   * the merits.
   */
  retryable?: boolean
  /**
   * Mutations that ACTUALLY landed this turn, whatever the outcome.
   *
   * Populated even on failure, because "the run stopped" and "nothing changed"
   * are different facts and conflating them is what turns a partial success into
   * a duplicate-creating retry.
   */
  applied?: string[]
  /**
   * The loop stopped early to protect its verification reserve, and DID verify.
   *
   * Distinct from every failure code: nothing went wrong, the run simply ran out
   * of wall clock with work still queued. `summary` carries the verified live
   * state, so the caller can report a truthful partial result instead of a
   * timeout the agent has to guess about.
   */
  budgetStopped?: boolean
  /** True when a verification pass actually ran and its result is in `summary`. */
  verified?: boolean
  /**
   * Mutations that were attempted and REFUSED, with the reason each gave.
   *
   * Present whenever any tool returned ok:false, including on an otherwise
   * successful turn. Without it a multi-item request reported only what worked:
   * six items in, four applied, two silently absent. `applied` says what is now
   * true; this says what still is not, and the caller needs both to know whether
   * the request is actually done.
   */
  refused?: Array<{ title: string; reason: string }>
  /**
   * Calls the approval gate stopped this turn, exactly as the model issued
   * them. Nothing in this list ran. The caller queues each one for a human
   * (createApprovalRequest with these args), so what an approval executes is
   * precisely what the human read, never a re-derivation from the message.
   */
  blockedCalls?: BlockedCall[]
}

export type BrainFailureCode =
  /** The AI provider returned 429. Retry after a pause. */
  | 'RATE_LIMITED'
  /** The model call timed out. Retryable. */
  | 'MODEL_TIMEOUT'
  /** The model errored for some other reason. Retryable once. */
  | 'MODEL_ERROR'
  /**
   * No model can be called here right now: no provider is configured, the
   * provider is out of quota or credit, or a monthly AI spending limit is
   * reached. Not retryable until that changes; the typed tools need no AI.
   */
  | 'AI_UNAVAILABLE'
  /** Hit MAX_ITERATIONS. Not retryable as-is — continue instead. */
  | 'STEP_BUDGET_EXHAUSTED'
  /** The turn ended asking the user something. Not a failure to retry. */
  | 'NEEDS_USER'
  /** A tool refused on the merits. Retrying the same call will refuse again. */
  | 'TOOL_REFUSED'
  /** A mutation may have landed, but the requested verification did not. */
  | 'UNVERIFIED'

const MAX_ITERATIONS = 12

/**
 * Wall clock held back from the loop and spent on verification.
 *
 * Sized for one `collectProof` against the live catalog with headroom for a slow
 * connection — a handful of catalog queries, not a model call. Deliberately
 * generous: an unverified "✅" costs more than a step the caller can ask for again.
 */
const VERIFY_RESERVE_MS = 15_000

/**
 * Per-mutation-tool proxy token cost used by the deterministic blueprint
 * executor and `singleToolTurn`.
 *
 * The deterministic paths don't pass the LLM through every step — that's by
 * design (it's what makes a curated build cheap and reproducible). But the
 * tools each do real work: tableLifecycle SQL, REST API generation, RLS
 * policy authoring, OAuth credential exchange, function code emission. The
 * meter must reflect that work, otherwise paid plans look uncapped on the
 * "AI credits" surface and the whole pricing page becomes a lie.
 *
 * Numbers are calibrated against the agent-loop equivalent — the same
 * operation through `runAgentLoop` typically burns this many tokens between
 * the LLM tool-call round-trip + the tool's internal LLM uses. They are
 * proxies, not exact measurements; a future PR can wire per-tool token
 * reporting through the dispatch context and replace the table. Until then
 * this is far better than "0", which is what the deterministic paths returned.
 */
const STEP_TOKEN_COST: Partial<Record<ToolName, number>> = {
  // Schema mutations — real SQL execution + graph + audit writes.
  create_table: 900,
  add_column: 400,
  drop_table: 500,
  create_index: 350,
  // API / Auth / Storage / Realtime / Trigger surfaces — codegen + persistence.
  generate_api: 1200,
  enable_auth: 700,
  add_oauth_provider: 500,
  create_bucket: 400,
  add_rls: 800,
  set_rls: 800,
  create_trigger: 500,
  enable_realtime: 400,
  // Functions / aggregates — internal LLM emission.
  generate_function: 2500,
  generate_aggregate_api: 1400,
  // Higher-level capability turn-ons.
  enable_vector_search: 800,
  create_cron_job: 600,
  set_rate_limit: 300,
  enable_teams: 1200,
  enable_push_notifications: 700,
  send_push: 200,
  rotate_webhook_secret: 300,
  replay_webhook_delivery: 200,
  // Fix / apply paths — re-derive + re-execute, charge near a full build.
  fix_backend: 1800,
  apply_proposal: 1500,
}

/** Default proxy when a tool isn't in the table above but still mutated state. */
const STEP_TOKEN_DEFAULT = 600

function proxyTokensForSteps(tools: readonly string[]): number {
  let sum = 0
  for (const t of tools) {
    sum += STEP_TOKEN_COST[t as ToolName] ?? STEP_TOKEN_DEFAULT
  }
  return sum
}

/** Rotating progress lines shown while the LLM architect designs the backend. */
const ARCHITECT_HEARTBEAT_MESSAGES = [
  'Designing your database schema and table relationships…',
  'Planning REST APIs and row-level security…',
  'Wiring realtime streams, automations, and storage…',
  'Finalising a production-grade backend design…',
] as const

/**
 * Run `work` while emitting a progress event every `intervalMs`.
 *
 * The LLM architect is a SINGLE 30–180s design call that emits nothing on its
 * own (`architectBackend` budgets up to 180s per attempt), so these lines are
 * all the turn's events show meanwhile; backend_chat returns them in `events`.
 * They extend nothing: backend_chat's 90s cap is a hard wall clock.
 */
async function withHeartbeat<T>(
  emit: (e: BrainEvent) => void,
  messages: readonly string[],
  work: () => Promise<T>,
  intervalMs = 15_000,
): Promise<T> {
  emit({ type: 'thinking', text: messages[0] })
  let i = 1
  const timer = setInterval(() => {
    emit({ type: 'thinking', text: messages[i % messages.length] })
    i++
  }, intervalMs)
  try {
    return await work()
  } finally {
    clearInterval(timer)
  }
}

/**
 * Resolve a Blueprint for a prompt, emitting progress during the long
 * architect call. Never throws — a failure resolves to null so the caller
 * falls back to the agent loop exactly as it does today.
 */
async function resolveBlueprintWithHeartbeat(
  message: string,
  projectId: string,
  emit: (e: BrainEvent) => void,
): Promise<Awaited<ReturnType<typeof getBlueprintForPrompt>>> {
  return withHeartbeat(emit, ARCHITECT_HEARTBEAT_MESSAGES, () =>
    getBlueprintForPrompt(message, projectId),
  ).catch((err) => {
    console.error('[Brain] blueprint resolution failed:', err)
    return null
  })
}


/** The main entry point: run one turn of the brain. */
export async function runBrain(
  input: BrainInput,
  emit: (e: BrainEvent) => void,
): Promise<BrainResult> {
  const toolsRun: string[] = []

  // ── No model, no turn ───────────────────────────────────────────────────
  // Every path below needs a model. Without one configured, each would fail
  // somewhere less explicable: the classifier hedged to UNCLEAR, and the turn
  // asked a clarifying question nothing could act on. Say what is true, first.
  const ai = aiAvailability()
  if ('reason' in ai) {
    return stoppedBeforeStarting(
      { code: 'AI_UNAVAILABLE', reason: 'no AI provider is configured on this deployment', retryable: false },
      emit,
      toolsRun,
      ai.reason,
    )
  }

  // ── No confirmation by message ──────────────────────────────────────────
  // A message never confirms anything. A destructive or high-risk call runs
  // only through a human's approval of that exact call (lib/mcp/approvals.ts),
  // so the turn that asked for it and the decision to run it are always made
  // by different parties.

  // ── UNDERSTAND ──────────────────────────────────────────────────────────
  emit({ type: 'phase', phase: 'understand' })
  const memory = await loadBrainMemory(input.projectId)
  const understandingBlock = formatUnderstanding(memory.understanding)
  const recent = formatRecentHistory(memory.history, 8)

  // Fresh-project signal — a brand-new project with nothing built yet. Computed
  // BEFORE classification so the classifier can use it: on an empty project a
  // message that describes an app is unambiguously a BUILD, never a
  // clarification. Also used later to route BUILD through the architect and to
  // keep the CONFIRM re-architect fallback from firing on a MODIFY confirm.
  //
  // Only a state that was read and is empty is fresh. A failed read leaves no
  // proof, and counting that as empty made a project with 30 tables look brand
  // new, so its next BUILD had the architect design a whole new backend. An
  // unread state takes a built project's path, and the understanding block
  // says the state could not be read.
  const proof = memory.understanding.proof
  const isFreshProject = !!proof && (proof.nothingBuilt || (proof.tables?.length ?? 0) === 0)

  // ── CLASSIFY ────────────────────────────────────────────────────────────
  emit({ type: 'phase', phase: 'classify' })
  const [hasPendingProposal, hasResumeQueue, hasPendingBlueprint, loopResume] = await Promise.all([
    hasActiveProposal(input.projectId),
    loadResumeQueue(input.projectId).then(q => q !== null).catch(() => false),
    loadPendingPlan(input.projectId).then(p => p !== null).catch(() => false),
    loadLoopResume(input.projectId).catch(() => null),
  ])
  let classification: Classification
  try {
    classification = await classify({
      projectId: input.projectId,
      message: input.message,
      recentHistory: recent,
      hasPendingProposal,
      // A pending plan, a pending blueprint, OR an outstanding resume queue
      // all signal the classifier that short imperatives like "continue" /
      // "finish it" / "resume" are CONFIRM, not UNCLEAR. Without this, the
      // classifier defaulted to UNCLEAR ("could you tell me a bit more
      // about 'continue'") and the user burned credits in confused loops.
      hasPendingPlan: hasPendingBlueprint || hasResumeQueue || loopResume !== null || detectPendingPlan(memory.history),
      // On an empty project, an app description has one meaning: build it. This
      // stops the classifier dead-ending "Users can post recipes and follow
      // each other" in a canned clarification.
      isFreshProject,
    })
  } catch (err) {
    // The provider could not answer the very first call (classify rethrows
    // only provider failures). Every later step needs it too, so stop here and
    // say why, rather than guessing an intent.
    return stoppedBeforeStarting(modelFailureOf(err), emit, toolsRun)
  }
  emit({
    type: 'classification',
    intent: classification.intent,
    confidence: classification.confidence,
    reasoning: classification.reasoning,
  })

  console.log(
    `[Brain] project=${input.projectId} msg="${input.message.slice(0, 100)}" intent=${classification.intent} conf=${classification.confidence.toFixed(2)} reason="${classification.reasoning.slice(0, 120)}"`,
  )

  // ── CONFIRM with nothing to confirm ─────────────────────────────────────
  // "yes" / "confirm" is meaningless without something pending. The pending
  // destructive call was already checked and cleared above, and the three
  // other resumable states were loaded before classification, so by here we
  // know there is genuinely nothing to resume.
  //
  // Previously this fell into the full agent loop: it routed, called
  // get_table_schema, kept reasoning, and died on the 90s watchdog with
  // BRAIN_TIMEOUT — a minute and a half of tokens to answer a two-word message
  // that could never have succeeded. Answer immediately instead.
  if (
    classification.intent === 'CONFIRM' &&
    !hasPendingProposal &&
    !hasResumeQueue &&
    !hasPendingBlueprint &&
    loopResume === null &&
    !detectPendingPlan(memory.history)
  ) {
    emit({ type: 'phase', phase: 'finish' })
    return {
      success: true,
      summary:
        `There is nothing waiting for confirmation right now, so nothing was changed.\n\n` +
        `If you were approving something from an earlier session, that window has closed — ` +
        `re-state what you want by name and I will do it.`,
      needsUser: true,
      iterations: 0,
      toolsRun,
      classification,
      tokensUsed: 0,
    }
  }

  // ── ROUTE ───────────────────────────────────────────────────────────────
  emit({ type: 'phase', phase: 'route' })

  const dispatchCtx: ToolDispatchContext = {
    projectId: input.projectId,
    userId: input.userId,
    sessionToken: input.sessionToken,
    userMessage: input.message,
    understandingBlock,
    // The turns the classifier is given, so an answer can place a follow-up.
    recentHistory: recent,
    // A coding agent over MCP: the protected-production gate applies.
    agentSurface: isAgentDoor(input.door),
    // A failed action is reported to the agent as it failed. The loop does not
    // hand the error to a model to pick a different action; the agent that
    // asked decides what to do next, as on every other dispatcher path.
    allowReplan: false,
    createdThisTurn: new Set<string>(),
    onToolEvent: (e) => {
      if (e.phase === 'start') emit({ type: 'tool_start', tool: e.tool, title: e.title })
      else if (e.phase === 'done') emit({ type: 'tool_done', tool: e.tool, title: e.title, detail: e.detail })
      else emit({ type: 'tool_fail', tool: e.tool, title: e.title, detail: e.detail })
    },
  }

  // CHAT → answer directly, never touch the mutation surface
  if (classification.intent === 'CHAT') {
    console.log(`[Brain] route=CHAT → answer_question (no mutation surface)`)
    return await singleToolTurn('answer_question', { question: input.message }, dispatchCtx, classification, emit, input)
  }

  // UNCLEAR → ask one clarifying question, never build anything.
  if (classification.intent === 'UNCLEAR') {
    // SAFETY NET (the "describe your backend" contract): the classifier is an
    // LLM and occasionally hedges on a perfectly buildable app description. On
    // a brand-new project, if the message actually reads like a product/app
    // description, do NOT dead-end it in a canned clarification — hand it to
    // the architect, whose own vagueness gate asks a *contextual* question if
    // (and only if) the spec genuinely can't be designed. This is what keeps
    // "Users can post recipes and follow each other" from ever getting a
    // "could you tell me a bit more?" reply on a fresh project.
    if (isFreshProject && looksLikeBuildDescription(input.message)) {
      console.log(`[Brain] route=UNCLEAR→ARCHITECT (fresh project + build-shaped description) msg="${input.message.slice(0, 80)}"`)
      const resolved = await resolveBlueprintWithHeartbeat(input.message, input.projectId, emit)
      const buildClass: Classification = {
        intent: 'BUILD',
        confidence: classification.confidence,
        reasoning: 'fresh project + product description — routed to architect (classifier hedged UNCLEAR)',
      }
      if (resolved && 'vague' in resolved && resolved.vague) {
        return await singleToolTurn('ask_user', { question: resolved.askUser, options: [] }, dispatchCtx, buildClass, emit, input)
      }
      if (resolved && 'blueprint' in resolved) {
        return await blueprintProposeTurn(resolved.blueprint, resolved.match, resolved.architectTokens, dispatchCtx, buildClass, emit, input)
      }
      // Architect failed to resolve anything → fall through to a real clarification.
    }
    console.log(`[Brain] route=UNCLEAR → ask_user`)
    const q = await synthesiseClarification(input.message, recent, input.projectId)
    return await singleToolTurn('ask_user', { question: q.question, options: q.options }, dispatchCtx, classification, emit, input)
  }

  // ── BUILD on a fresh project → blueprint propose path ────────────────────
  // This is the structural fix for "the agent ships a toy backend": the LLM
  // is the *creative* layer, the blueprint is the *exhaustiveness* layer.
  //
  //   • Curated keyword hit (social-media, marketplace, saas, chat-app, blog,
  //     project-mgmt) → free, deterministic, hand-crafted.
  //   • Otherwise the LLM architect designs a comprehensive backend for the
  //     user's domain (music streaming, telehealth, ride-share, recipe app,
  //     crypto wallet, language learning, anything they describe). The spec
  //     is validated + enriched and stored as the executable artifact.
  //
  // Either way "go ahead" runs every step deterministically — no LLM
  // re-derivation, no partial coverage, no run_test → fix_backend loop.
  let architectFailedThisTurn = false
  if (classification.intent === 'BUILD' || classification.intent === 'APPLY_PROPOSAL') {
    if (isFreshProject) {
      const resolved = await resolveBlueprintWithHeartbeat(input.message, input.projectId, emit)
      if (!resolved) {
        architectFailedThisTurn = true
      }
      if (resolved && 'vague' in resolved && resolved.vague) {
        console.log(`[Brain] route=ARCHITECT_VAGUE — surfacing clarifying question`)
        return await singleToolTurn('ask_user', { question: resolved.askUser, options: [] }, dispatchCtx, classification, emit, input)
      }
      if (resolved && 'blueprint' in resolved) {
        console.log(
          `[Brain] route=BLUEPRINT_PROPOSE domain=${resolved.match.domain} conf=${resolved.match.confidence.toFixed(2)} ` +
          `matchedOn="${resolved.match.matchedOn}" steps=${resolved.blueprint.steps.length} architectTokens=${resolved.architectTokens}`,
        )
        return await blueprintProposeTurn(resolved.blueprint, resolved.match, resolved.architectTokens, dispatchCtx, classification, emit, input)
      }
    }
  }

  // ── CONFIRM with a pending blueprint plan → deterministic execution ──────
  // A CONFIRM here can only ever continue a BUILD plan. Destructive operations
  // are never confirmed by message (see the note at the top of runBrain), so
  // no "Confirm — drop …" turn can reach this branch carrying destructive
  // authority.
  if (classification.intent === 'CONFIRM') {
    const pending = await loadPendingPlan(input.projectId).catch(() => null)
    if (pending) {
      console.log(`[Brain] route=BLUEPRINT_EXECUTE domain=${pending.blueprintDomain} steps=${pending.steps.length} architectTokens=${pending.architectTokens}`)
      return await blueprintExecuteTurn(pending.steps, pending.architectTokens, dispatchCtx, classification, emit, input, pending.blueprintDomain, pending.ledger)
    }

    // No fresh proposal but a resume queue from a partial earlier run → keep
    // going deterministically on the remaining steps. "continue" / "finish it"
    // / "resume" all route here so the user never gets dropped into a
    // confused LLM loop after a partial build. No architect tokens to bill
    // — those were charged on the original proposal/execute pair.
    const resume = await loadResumeQueue(input.projectId).catch(() => null)
    if (resume) {
      console.log(`[Brain] route=BLUEPRINT_RESUME domain=${resume.domain} steps=${resume.steps.length}`)
      return await blueprintExecuteTurn(resume.steps, 0, dispatchCtx, classification, emit, input, resume.domain)
    }

    // A loop turn that stopped unfinished saved where it was. Resume the agent
    // loop on that request with what already landed, rather than searching the
    // history for a prompt that looks like one.


    if (loopResume) {
      if (loopResume.architectFailed && loopResume.request) {
        const resolved = await resolveBlueprintWithHeartbeat(
          loopResume.request,
          input.projectId,
          emit,
        )

        if (resolved && 'blueprint' in resolved) {
          console.log('[Brain] route=LOOP_RESUME_REARCHITECT')

          return await blueprintExecuteTurn(
            resolved.blueprint.steps,
            resolved.architectTokens,
            dispatchCtx,
            classification,
            emit,
            input,
            resolved.blueprint.domain,
            extractRequirements(loopResume.request),
          )
        }

        console.log('[Brain] Architect retry failed; falling back to loop resume')
      }

      console.log(
        `[Brain] route=LOOP_RESUME applied=${loopResume.applied.length} reason="${loopResume.reason}"`,
      )

      return await runAgentLoop(
        input,
        classification,
        memory.summary,
        understandingBlock,
        recent,
        dispatchCtx,
        emit,
        toolsRun,
        loopResume,
      )
    }


    // No stored plan at all — but the user is confirming/continuing a build.
    // This is the state that produced the endless "continue" loop: the
    // architect had failed on the original turn (e.g. the time limit cut it
    // off, or a transient model error), so no pending plan was ever saved, and
    // the build fell into the agent loop — which cannot finish a 40-operation
    // spec in 12 iterations and just re-derives partial work on every retry.
    //
    // Instead of re-entering that loop, re-run the DETERMINISTIC architect on
    // the ORIGINAL build prompt and execute it end-to-end. create_table /
    // generate_api / add_rls / enable_realtime are all idempotent
    // ("CREATE TABLE IF NOT EXISTS", "already exists → success"), so any steps
    // that already landed in a partial run succeed as no-ops, the remaining
    // work is done in one deterministic pass, and the coverage report
    // reconciles against live state. This is what breaks the loop.
    // Guard against re-architecting a MODIFY confirmation ("add reviews to my
    // marketplace" → "go ahead"): those run on a NON-fresh project and are not
    // full-schema specs. We only re-architect when the user gave their own
    // table spec (isExplicitSpec — unambiguously a from-scratch build) or when
    // the project is still empty and the original ask was a substantial build.


  }

  // APPLY_PROPOSAL (with no blueprint match) is NOT a dead-end. It enters the
  // agent loop like every other actionable intent. The loop has the
  // conversation history, the apply_proposal tool (for a formal Proposal),
  // AND every build tool — so when no formal Proposal exists it re-derives
  // the items the user is referring to from the recent conversation and
  // builds them directly.
  console.log(`[Brain] route=AGENT_LOOP intent=${classification.intent}`)

  // BUILD / MODIFY / FIX / QUESTION / DESTRUCTIVE / CONFIRM / APPLY_PROPOSAL → agent loop

  return await runAgentLoop(
    input,
    classification,
    memory.summary,
    understandingBlock,
    recent,
    dispatchCtx,
    emit,
    toolsRun,
    null,
    architectFailedThisTurn,
  )
}

/**
 * BLUEPRINT PROPOSE — render the full blueprint as a proposal card AND
 * persist it as the executable pending plan. The next "go ahead" message
 * routes to blueprintExecuteTurn and runs every step deterministically.
 *
 * No LLM round-trip in this path: the blueprint is the source of truth.
 */
async function blueprintProposeTurn(
  blueprint: Blueprint,
  match: BlueprintMatch,
  architectTokens: number,
  ctx: ToolDispatchContext,
  classification: Classification,
  emit: (e: BrainEvent) => void,
  input: BrainInput,
): Promise<BrainResult> {
  // Requirements ledger — extracted from the ORIGINAL prompt now, because the
  // execute turn's message is just "go ahead". Persisted with the plan.
  const ledger = extractRequirements(input.message)

  // Stash the architect token spend on the pending plan so the eventual
  // execute turn — the moment the user actually accepts the build — bills
  // those tokens. Proposing alone is free: the user can still reject it.
  await savePendingPlan(input.projectId, blueprint, match, architectTokens, ledger).catch((err) => {
    console.error('[Brain] savePendingPlan failed (non-fatal):', err)
  })

  // Pre-approval honesty: diff the user's requirements against THIS PLAN so
  // gaps are visible before they type "go ahead" — not discovered after 59
  // steps have already run.
  let coverageBlock = ''
  if (ledgerHasContent(ledger)) {
    const planCoverage = reconcileLedger(ledger, appliedStateFromSteps(blueprint.steps))
    coverageBlock = renderLedgerReport(planCoverage, 'plan')
  }

  // Group steps for a readable proposal card. The blueprint's `steps` are
  // tool-level; the user wants a feature-level summary.
  const groups = groupStepsForProposal(blueprint.steps)
  const lines = [
    `**${blueprint.title}**`,
    '',
    blueprint.summary,
    '',
    ...groups.map((g, i) => `${i + 1}. ${g.label}`),
    ...(coverageBlock ? ['', coverageBlock] : []),
    ...(blueprint.warnings && blueprint.warnings.length
      ? ['', '**Notes**', ...blueprint.warnings]
      : []),
    '',
    'Reply "go ahead" to run this, or tell me what to add or remove.',
  ]

  const summary = lines.join('\n')
  emit({ type: 'final', summary, needsUser: true, data: { kind: 'blueprint_proposal', domain: blueprint.domain, stepCount: blueprint.steps.length } })
  await saveTurn(input.projectId, input.message, summary, input.requestId ?? null)

  return {
    success: true,
    summary,
    needsUser: true,
    iterations: 0,
    toolsRun: ['propose_plan'],
    classification,
    tokensUsed: 0,
  }
}

/** Compress per-tool steps into feature-level bullets for the proposal card. */
function groupStepsForProposal(steps: BlueprintStep[]): Array<{ label: string }> {
  const tables: string[] = []
  const apis: string[] = []
  const rls: string[] = []
  const realtime: string[] = []
  const triggers: string[] = []
  const buckets: string[] = []
  const functions: string[] = []
  const crons: string[] = []
  const seeds: string[] = []
  const other: string[] = []

  for (const s of steps) {
    const t = s.tool
    const tn = (s.args as { tableName?: string }).tableName
    if (t === 'create_table' && tn) tables.push(tn)
    else if (t === 'generate_api' && tn) apis.push(tn)
    else if ((t === 'add_rls' || t === 'set_rls') && tn) rls.push(tn)
    else if (t === 'enable_realtime' && tn) realtime.push(tn)
    else if (t === 'create_trigger' && tn) triggers.push(tn)
    else if (t === 'create_bucket') buckets.push(String((s.args as { bucketName?: string }).bucketName ?? 'media'))
    else if (t === 'generate_function') functions.push(String((s.args as { name?: string }).name ?? 'function'))
    else if (t === 'create_cron_job') crons.push(String((s.args as { schedule?: string }).schedule ?? ''))
    else if (t === 'seed_rows' && tn) seeds.push(tn)
    else if (t === 'enable_auth') other.push('Enable end-user authentication (email + password)')
    else if (t === 'enable_teams') other.push('Wire up team multi-tenancy (orgs + members + invitations)')
    else if (t === 'generate_aggregate_api') other.push(`Aggregate stats endpoint /stats/${String((s.args as { name?: string }).name ?? 'summary')}`)
    else other.push(s.label)
  }

  const groups: Array<{ label: string }> = []
  for (const o of other) groups.push({ label: o })
  if (tables.length) groups.push({ label: `Create ${tables.length} tables: ${tables.join(', ')}` })
  if (apis.length) groups.push({ label: `Generate REST APIs for ${apis.length} tables` })
  if (rls.length) groups.push({ label: `Apply Row-Level Security to ${rls.length} tables (owner + public-read templates)` })
  if (realtime.length) groups.push({ label: `Enable realtime change streaming on ${realtime.length} tables` })
  if (triggers.length) groups.push({ label: `Add notify triggers on ${triggers.length} write-paths` })
  if (functions.length) groups.push({ label: `Create ${functions.length} backend function${functions.length === 1 ? '' : 's'} (automations): ${functions.join(', ')}` })
  if (crons.length) groups.push({ label: `Schedule ${crons.length} recurring job${crons.length === 1 ? '' : 's'} (${crons.join(' · ')})` })
  if (buckets.length) groups.push({ label: `Create storage bucket(s): ${buckets.join(', ')}` })
  if (seeds.length) groups.push({ label: `Seed demo data into ${seeds.length} table${seeds.length === 1 ? '' : 's'}: ${seeds.join(', ')}` })
  return groups
}

/**
 * BLUEPRINT EXECUTE — run every step of a persisted plan deterministically.
 *
 *   • No LLM in the loop — every step's tool + args are already concrete.
 *   • Steps run in order so dependencies (tables → APIs → RLS → realtime →
 *     triggers) resolve cleanly.
 *   • A failure on one step does NOT abort the rest — we keep going and
 *     surface a truthful per-step summary at the end. A funded platform
 *     does not stop at the first hiccup; it reports what landed.
 *   • The pending plan is cleared once execution finishes (success or fail).
 */
async function blueprintExecuteTurn(
  steps: BlueprintStep[],
  architectTokens: number,
  ctx: ToolDispatchContext,
  classification: Classification,
  emit: (e: BrainEvent) => void,
  input: BrainInput,
  domain?: string,
  ledger?: RequirementsLedger,
): Promise<BrainResult> {
  emit({ type: 'phase', phase: 'execute' })

  const succeeded: string[] = []
  const succeededSteps: BlueprintStep[] = []
  const failed: Array<{ label: string; detail: string; step: BlueprintStep }> = []
  const toolsRun: string[] = []
  /** Per-tool outcome aligned by index to `toolsRun` — see the note in the
   *  agent loop: a step that landed is 'applied' even if a sibling step failed,
   *  so Memory never labels applied work with the batch's worst outcome. */
  const toolStatuses: BackendEventStatus[] = []
  /** Tools we actually attempted — both successes and failures count toward billed work. */
  const attemptedTools: string[] = []
  /** Per-table outcomes from the deterministic seed runner. */
  const seedResults: SeedTableResult[] = []
  const seedCtx = createSeedContext(input.projectId)

  for (const step of steps) {
    attemptedTools.push(step.tool)

    // `seed_rows` is a blueprint-executor step, not an LLM tool — route it to
    // the deterministic seed runner (FK + demo-user resolution at insert time).
    if (step.tool === 'seed_rows') {
      const tn = String((step.args as { tableName?: string }).tableName ?? '')
      const rows = Array.isArray((step.args as { rows?: unknown }).rows)
        ? ((step.args as { rows: Array<Record<string, unknown>> }).rows)
        : []
      emit({ type: 'tool_start', tool: 'seed_rows', title: `Seeding demo rows into ${tn}` })
      const r = await runSeedStep(seedCtx, tn, rows)
      seedResults.push(r)
      toolsRun.push(step.tool)
      if (r.inserted === r.requested && r.requested > 0) {
        succeeded.push(step.label)
        succeededSteps.push(step)
        toolStatuses.push('applied')
        emit({ type: 'tool_done', tool: 'seed_rows', title: `Seeded ${r.inserted} rows into ${tn}` })
      } else if (r.inserted > 0) {
        // Partial seeds still count as applied work, but the summary reports
        // the true count — never round a 7/10 up to "done".
        succeeded.push(`${step.label} (${r.inserted}/${r.requested} rows)`)
        succeededSteps.push({ ...step, args: { ...step.args, rows: rows.slice(0, r.inserted) } })
        toolStatuses.push('applied')
        emit({ type: 'tool_done', tool: 'seed_rows', title: `Seeded ${r.inserted}/${r.requested} rows into ${tn}`, detail: r.error })
      } else {
        failed.push({ label: step.label, detail: (r.error ?? 'no rows inserted').slice(0, 200), step })
        toolStatuses.push('failed')
        emit({ type: 'tool_fail', tool: 'seed_rows', title: `Seeding ${tn} failed`, detail: r.error })
      }
      continue
    }

    // Same approval rule as the agent loop. Plans are built from a fixed build
    // vocabulary today, so this never fires; it exists so a future plan source
    // cannot become a way to run an approval-gated call unreviewed.
    if (needsApproval(step.tool)) {
      failed.push({ label: step.label, detail: `${step.tool} needs a human's approval and was not run`, step })
      toolStatuses.push('failed')
      emit({ type: 'tool_fail', tool: step.tool, title: `${step.label} needs approval`, detail: 'not run' })
      continue
    }

    try {
      const result = await dispatchTool(step.tool as ToolName, step.args, ctx)
      toolsRun.push(step.tool)
      toolStatuses.push(result.ok ? 'applied' : 'failed')
      if (result.ok) {
        succeeded.push(step.label)
        succeededSteps.push(step)
      } else {
        failed.push({ label: step.label, detail: result.summary.slice(0, 200), step })
      }
    } catch (err) {
      failed.push({
        label: step.label,
        detail: err instanceof Error ? err.message.slice(0, 200) : 'unexpected error',
        step,
      })
    }
  }

  // Done — clear the pending plan so a stray future "go ahead" cannot re-fire.
  await clearPendingPlan(input.projectId).catch(() => {})

  // If anything failed, save the failed steps as a resume queue so the user's
  // next "continue" / "finish it" message picks up the remaining work with
  // the same deterministic executor — not a confused LLM loop.
  if (failed.length > 0) {
    await saveResumeQueue(
      input.projectId,
      domain ?? 'custom',
      failed.map(f => f.step),
      `${failed.length} step(s) need a second pass after the first run.`,
    ).catch(() => {})
  } else {
    await clearResumeQueue(input.projectId).catch(() => {})
  }

  emit({ type: 'phase', phase: 'verify' })

  // ── Post-apply verification — run what we built, don't hope ─────────────
  // The behavioral verifier signs up throwaway end-users and exercises the
  // real runtime: auth flow, CRUD lifecycle, RLS cross-user isolation,
  // trigger execution, live HTTP endpoints. The agentic fix loop repairs
  // what it can and re-verifies. Bounded at 2 rounds; failures that survive
  // are reported honestly, never swallowed.
  let verificationBlock = ''
  if (succeededSteps.length > 0) {
    try {
      const { runAgenticFixLoop } = await import('../agentic-fix-loop')
      const fixResult = await runAgenticFixLoop(input.projectId, input.userId, {
        maxRounds: 2,
        emit: (e) => {
          if (e.type === 'fix_loop_verify_start') {
            emit({ type: 'tool_start', tool: 'run_test', title: e.round === 0 ? 'Verifying the live backend' : `Re-verifying (round ${e.round})` })
          } else if (e.type === 'fix_loop_verify_done') {
            emit({
              type: 'tool_done', tool: 'run_test',
              title: e.passed ? 'All runtime checks passed' : `${e.failedChecks.length} runtime check${e.failedChecks.length === 1 ? '' : 's'} failing`,
              detail: e.passed ? undefined : e.failedChecks.map(c => c.name).join(', '),
            })
          } else if (e.type === 'fix_loop_fix_start') {
            emit({ type: 'tool_start', tool: 'fix_backend', title: `Repairing: ${e.fix.reason.slice(0, 80)}` })
          } else if (e.type === 'fix_loop_fix_done') {
            emit({ type: e.success ? 'tool_done' : 'tool_fail', tool: 'fix_backend', title: e.message.slice(0, 100) })
          }
        },
      })
      // Prose summary + the structured evidence fence. The fence rides inside
      // the summary, so backend_chat's caller and the saved conversation both
      // get each check's evidence (what was exercised, what came back).
      const { buildVerificationFence } = await import('../verification-evidence')
      const fence = buildVerificationFence(fixResult)
      verificationBlock = [renderVerificationBlock(fixResult), fence].filter(Boolean).join('\n\n')
    } catch (err) {
      console.error('[Brain] post-build verification failed to run:', err)
      verificationBlock = '**Verification** · could not run this time — say "verify my backend" to run it on demand.'
    }
  }

  const finalProof = await collectProof(input.projectId).catch(() => null)
  const stateBlock = finalProof && !finalProof.nothingBuilt ? formatProof(finalProof) : ''

  // ── Request coverage — reconcile what was ASKED against what EXISTS ─────
  // Ground truth: live proof for tables/auth/realtime/buckets, succeeded plan
  // steps for columns/functions/crons/seeds. Deterministic — no self-grading.
  let coverageBlock = ''
  if (ledger && ledgerHasContent(ledger)) {
    const applied = appliedStateFromSteps(succeededSteps)
    if (finalProof) {
      applied.tables = Array.from(new Set([...applied.tables, ...finalProof.tables]))
      applied.authEnabled = applied.authEnabled || finalProof.authEnabled
      applied.realtimeTables = Array.from(new Set([...applied.realtimeTables, ...finalProof.realtimeTables]))
      applied.buckets = Array.from(new Set([...applied.buckets, ...finalProof.buckets]))
    }
    for (const r of seedResults) {
      if (r.inserted > 0) applied.seededTables.set(r.tableName, r.inserted)
      else applied.seededTables.delete(r.tableName)
    }
    coverageBlock = renderLedgerReport(reconcileLedger(ledger, applied), 'result')
  }

  const summary = [
    failed.length === 0
      ? `**Backend built.** ${succeeded.length} steps applied.`
      : `**${succeeded.length} steps applied.** ${failed.length} item${failed.length === 1 ? '' : 's'} need a follow-up.`,
    ...(coverageBlock ? ['', coverageBlock] : []),
    ...(verificationBlock ? ['', verificationBlock] : []),
    '',
    stateBlock,
    ...(failed.length
      ? ['', `**Follow-ups pending** · ${failed.length}`, ...failed.slice(0, 8).map((f, i) => `${i + 1}. ${f.label}: ${f.detail}`)]
      : []),
    '',
    failed.length === 0
      ? 'Open the dashboard tabs to explore: Database, APIs, Storage, Realtime, Auth & Users. Reply with what you want to change next.'
      : 'Reply "continue" and I\'ll work the follow-ups one by one.',
  ].filter(Boolean).join('\n')

  emit({ type: 'final', summary, needsUser: false })
  await saveTurn(input.projectId, input.message, summary, input.requestId ?? null)
  await recordBrainOperationalMemory(input, toolsRun, summary, failed.length === 0 ? 'applied' : 'failed', toolStatuses)

  // Bill = architect spend (real, from the propose turn) + per-step proxy
  // for every tool we actually dispatched. We bill attempts (not just
  // successes) because each one ran SQL / codegen / OAuth — the work
  // happened even when the final tool result was `ok=false`. Charging only
  // the green path would let pathological inputs build for free.
  const tokensUsed = architectTokens + proxyTokensForSteps(attemptedTools)

  return {
    success: failed.length === 0,
    summary,
    needsUser: false,
    iterations: steps.length,
    toolsRun,
    classification,
    tokensUsed,
    verifiedInline: succeededSteps.length > 0,
  }
}

/**
 * Render the post-build verification outcome. Truthful by construction: the
 * numbers come from the behavioral verifier's final snapshot, and surviving
 * failures are listed by name — never summarized away.
 */
function renderVerificationBlock(result: FixLoopResult): string {
  const checks = result.finalCheckSnapshot?.checks ?? []
  const ran = checks.filter(c => !c.skipped)
  const passed = ran.filter(c => c.passed)
  const failedChecks = ran.filter(c => !c.passed)

  if (ran.length === 0) {
    return '**Verification** · no runtime checks were applicable yet.'
  }

  const repairNote = result.appliedFixes > 0
    ? ` · ${result.appliedFixes} issue${result.appliedFixes === 1 ? '' : 's'} repaired automatically`
    : ''

  if (failedChecks.length === 0) {
    return (
      `**Verified against the live runtime** · ${passed.length}/${ran.length} checks passed${repairNote}\n` +
      `Auth flow, CRUD lifecycle, RLS cross-user isolation, triggers, and live HTTP endpoints were exercised with real requests.`
    )
  }

  return [
    `**Verification** · ${passed.length}/${ran.length} runtime checks passed${repairNote} — ${failedChecks.length} still failing:`,
    ...failedChecks.slice(0, 5).map(c => `• ${c.name}${c.error ? ` — ${c.error.slice(0, 120)}` : ''}`),
    // Held for an incident, asking for the fixes again would be held again.
    result.reason === 'held_for_incident'
      ? result.summary
      : `These are tracked as open findings — say "fix the failing checks" or review them on the dashboard.`,
  ].join('\n')
}

/**
 * Describe a call the approval gate stopped, for the Review Queue request the
 * caller files from it (BlockedCall). Best-effort row count via the
 * workspace-table-stats kernel (cached COUNT — cheap).
 * Honesty rules baked in:
 *   • A dropped table or column is reversible because its data is not
 *     destroyed: inside a recorded change it moves into the change's vault and
 *     rolling the change back restores it (lib/changes/preserve.ts). Only while
 *     the ledger is on; without it the old answer, irreversible, is the true one.
 *   • Truncation deletes rows, which are data rather than schema, and nothing
 *     keeps them, so it stays irreversible.
 */
async function describeDanger(
  projectId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ tool: string; target: string; rowCount: number | null; reversible: boolean; confirmPhrase: string }> {
  const str = (k: string): string | null => {
    const v = args[k]
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  const tableName = str('tableName') ?? str('table')
  const columnName = str('columnName') ?? str('column')
  const namedThing =
    str('bucketName') ?? str('fileName') ?? str('path') ?? str('name') ??
    str('provider') ?? str('email') ?? str('keyId') ?? str('id')

  // Live row count for table-shaped destruction — cached COUNT, never blocks long.
  let rowCount: number | null = null
  if (tableName && (tool === 'drop_table' || tool === 'truncate_table' || tool === 'drop_column')) {
    try {
      const { getTableStat } = await import('@/lib/services/workspace-table-stats')
      const stat = await getTableStat(projectId, tableName)
      rowCount = stat.rows
    } catch { rowCount = null }
  }

  const { ledgerEnabled } = await import('@/lib/changes/ledger')
  const kept = ledgerEnabled(projectId)

  switch (tool) {
    case 'drop_table':
      return {
        tool,
        target: `the \`${tableName ?? 'unknown'}\` table`,
        rowCount,
        reversible: kept, // its rows move into the change's vault
        confirmPhrase: `Confirm — drop the ${tableName ?? ''} table`.trim(),
      }
    case 'truncate_table':
      return {
        tool,
        target: `all rows in \`${tableName ?? 'unknown'}\``,
        rowCount,
        reversible: false,
        confirmPhrase: `Confirm — delete all rows in ${tableName ?? 'the table'}`,
      }
    case 'drop_column':
      return {
        tool,
        target: `column \`${columnName ?? 'unknown'}\` on \`${tableName ?? 'unknown'}\``,
        rowCount,
        reversible: kept, // its values are copied into the change's vault first
        confirmPhrase: `Confirm — drop the ${columnName ?? ''} column`.trim(),
      }
    case 'revert_schema_change': {
      const change = await import('@/lib/db/prisma')
        .then(({ prisma }) => prisma.backendChange.findFirst({
          where: { id: String(args.changeId ?? ''), projectId },
          select: { seq: true, summary: true, title: true },
        }))
        .catch(() => null)
      return {
        tool,
        target: change ? `the state before change #${change.seq} (${change.summary ?? change.title})` : 'the state before a change',
        rowCount: null,
        // A restore keeps what it removes and is itself recorded: it can be reapplied.
        reversible: true,
        confirmPhrase: `Confirm — restore the state before change #${change?.seq ?? ''}`.trim(),
      }
    }
    case 'delete_bucket':
      return { tool, target: `the \`${namedThing ?? 'unknown'}\` bucket and every file in it`, rowCount: null, reversible: false, confirmPhrase: `Confirm — delete the ${namedThing ?? ''} bucket`.trim() }
    case 'delete_file':
      return { tool, target: `the file \`${namedThing ?? 'unknown'}\``, rowCount: null, reversible: false, confirmPhrase: 'Confirm — delete the file' }
    case 'disable_realtime': {
      if (tableName) {
        return { tool, target: `realtime on \`${tableName}\` (live subscribers disconnect)`, rowCount: null, reversible: true, confirmPhrase: 'Confirm — disable realtime' }
      }
      // Project-wide: the card must name the blast radius, not a bare word.
      let scope = 'every streaming table (live subscribers disconnect)'
      try {
        const { listTablesWithRealtimeTriggers } = await import('@/lib/services/realtimeTriggers')
        const streaming = await listTablesWithRealtimeTriggers(projectId)
        scope = streaming.length === 0
          ? 'realtime project-wide — no table is currently streaming, so nothing disconnects'
          : `realtime on EVERY streaming table (${streaming.length}: ${streaming.join(', ')}) — their live subscribers disconnect`
      } catch { /* keep the generic scope */ }
      return { tool, target: scope, rowCount: null, reversible: true, confirmPhrase: 'Confirm — disable realtime on every table' }
    }
    case 'trigger_deploy':
      return { tool, target: 'a production deploy', rowCount: null, reversible: true, confirmPhrase: 'Confirm — deploy to production' }
    case 'rollback_deploy': {
      const version = Number.isInteger(args.version) ? String(args.version) : str('version')
      return {
        tool,
        target: version ? `the backend as it was when v${version} was published (every change since undone)` : 'the backend as it was at an earlier published version',
        rowCount: null,
        // Each step is a restore, which keeps what it removes and can be reapplied.
        reversible: true,
        confirmPhrase: `Confirm — restore the backend to ${version ? `v${version}` : 'that version'}`,
      }
    }
    case 'revoke_api_key':
      return { tool, target: 'an API key (every client using it stops working immediately)', rowCount: null, reversible: false, confirmPhrase: 'Confirm — revoke the API key' }
    case 'rotate_api_key':
      return { tool, target: 'an API key rotation (the old key stops working immediately)', rowCount: null, reversible: false, confirmPhrase: 'Confirm — rotate the API key' }
    case 'delete_env_var':
      return { tool, target: `the env var \`${namedThing ?? 'unknown'}\` (functions reading it will fail)`, rowCount: null, reversible: false, confirmPhrase: `Confirm — delete the ${namedThing ?? ''} env var`.trim() }
    case 'delete_trigger': {
      // The card names the trigger the person is approving. A call by id alone
      // read as `unknown`, so the deletion was approved unseen (WH-F15).
      const triggerId = str('triggerId')
      let label = triggerId ? `\`${triggerId}\`` : namedThing ? `\`${namedThing}\`` : null
      if (triggerId) {
        try {
          const { prisma } = await import('@/lib/db')
          const found = await prisma.appTrigger.findFirst({ where: { id: triggerId, projectId }, select: { name: true } })
          label = found ? `\`${found.name}\`` : `\`${triggerId}\` (no such trigger in this project)`
        } catch { /* keep the id */ }
      }
      return {
        tool,
        target: label ? `the trigger ${label}` : 'no trigger (the call names none)',
        rowCount: null,
        reversible: false,
        confirmPhrase: 'Confirm — delete the trigger',
      }
    }
    case 'delete_ai_function':
      return { tool, target: `the function \`${namedThing ?? 'unknown'}\``, rowCount: null, reversible: false, confirmPhrase: 'Confirm — delete the function' }
    case 'delete_cron_job':
      return { tool, target: `the scheduled job \`${namedThing ?? 'unknown'}\``, rowCount: null, reversible: false, confirmPhrase: 'Confirm — delete the scheduled job' }
    case 'remove_integration_key':
      return { tool, target: `the ${namedThing ?? ''} integration (functions calling it will fail)`.trim(), rowCount: null, reversible: false, confirmPhrase: 'Confirm — disconnect the integration' }
    case 'delete_webhook': {
      // The card names the endpoint the person is approving. The call carries
      // only an id, and a bare `delete_webhook` did not say which receiver
      // stops getting events.
      const webhookId = str('webhookId')
      let target = webhookId ? `the webhook \`${webhookId}\` and its delivery history` : 'no webhook (the call names none)'
      if (webhookId) {
        try {
          const { prisma } = await import('@/lib/db')
          const found = await prisma.webhook.findFirst({ where: { id: webhookId, projectId }, select: { eventType: true, targetUrl: true } })
          target = found
            ? `the webhook \`${webhookId}\` (${found.eventType} → ${found.targetUrl}) and its delivery history`
            : `the webhook \`${webhookId}\` (no such webhook in this project)`
        } catch { /* keep the id */ }
      }
      return {
        tool,
        target,
        rowCount: null,
        // Its signing secret goes with it: an endpoint created again signs with
        // a new one, which the receiver does not have.
        reversible: false,
        confirmPhrase: 'Confirm — delete the webhook',
      }
    }
    case 'block_end_user':
      return { tool, target: `the end-user ${namedThing ?? ''} (they lose access immediately)`.trim(), rowCount: null, reversible: true, confirmPhrase: 'Confirm — block the user' }
    case 'remove_permission':
      return { tool, target: 'a row-level security policy (data exposure may widen)', rowCount: null, reversible: true, confirmPhrase: 'Confirm — remove the permission' }
    case 'disable_oauth_provider':
      return { tool, target: `${namedThing ?? 'an OAuth'} sign-in (end-users on this provider cannot log in)`, rowCount: null, reversible: true, confirmPhrase: 'Confirm — disable the provider' }
    case 'remove_auth_smtp': {
      // The card says where auth email goes once the settings are gone: through
      // the deployment's SMTP when its environment has one, and otherwise
      // nowhere (resolveProjectSmtp, lib/email/project-smtp.ts).
      const { readEnvSmtpCredentials } = await import('@/lib/email/smtp-transport')
      const after = readEnvSmtpCredentials()
        ? "go out through the deployment's SMTP instead"
        : 'stop: this deployment has no SMTP to fall back to'
      return {
        tool,
        target: `this project's SMTP settings (verification, password-reset and magic-link emails then ${after})`,
        rowCount: null,
        // The stored password is deleted with them, so putting them back means
        // entering it again.
        reversible: false,
        confirmPhrase: 'Confirm — remove the SMTP settings',
      }
    }
    case 'merge_branch':
    case 'discard_branch': {
      // The approval card is the only thing the human reads before a branch
      // reaches (or loses) production — a bare `merge_branch` target made them
      // approve blind. Resolve the branch name and statement count; if the
      // lookup fails the generic shape below still names the id.
      const branchId = str('branchId') ?? str('branch')
      let branchName: string | null = null
      let statementCount: number | null = null
      if (branchId) {
        try {
          const { diffBranch } = await import('@/lib/branches/engine')
          const diff = await diffBranch(projectId, branchId)
          if (diff.ok) {
            branchName = diff.branch
            statementCount = diff.migrations.length
          }
        } catch { /* keep the id-based target */ }
      }
      const label = branchName ? `\`${branchName}\`` : `\`${branchId ?? 'unknown'}\``
      if (tool === 'merge_branch') {
        const count = statementCount === null ? '' : ` (${statementCount} statement${statementCount === 1 ? '' : 's'} reach production)`
        return { tool, target: `merge of preview branch ${label} into production${count}`, rowCount: null, reversible: false, confirmPhrase: `Confirm — merge ${branchName ?? branchId ?? 'the branch'} into production`.trim() }
      }
      return { tool, target: `the preview branch ${label} and every unmerged change on it`, rowCount: null, reversible: false, confirmPhrase: `Confirm — discard ${branchName ?? branchId ?? 'the branch'}`.trim() }
    }
    default:
      return { tool, target: `\`${tool}\``, rowCount: null, reversible: false, confirmPhrase: `Confirm — run ${tool}` }
  }
}

/** What a call that waits for a person affects, as its card and the model are told. */
type Danger = Awaited<ReturnType<typeof describeDanger>>

/**
 * A real data migration the executor stopped at its own gate (RUN_DATA_MIGRATION
 * in lib/ai/minimal-executor.ts), described by the rows that gate counted, so
 * what each operation would change is what a person approves. Null for any
 * other result, operations the executor refused as invalid included.
 */
function migrationAwaitingApproval(tool: string, result: ToolResult): Danger | null {
  if (tool !== 'run_data_migration' || result.ok) return null
  const data = result.data as { requiresApproval?: boolean; estimates?: DataMigrationEstimate[] } | undefined
  if (data?.requiresApproval !== true || !Array.isArray(data.estimates)) return null
  const tables = [...new Set(data.estimates.map((e) => `\`${e.table}\``))]
  const counted = data.estimates.map((e) => `${e.detail}: ${e.affectedRows} of ${e.totalRows} rows`)
  return {
    tool,
    target: `rows in ${tables.join(', ')} (${counted.join('; ')})`,
    // Summed over the operations: a row two of them rewrite counts twice.
    rowCount: data.estimates.reduce((sum, e) => sum + e.affectedRows, 0),
    // The executor copies each table it rewrites before it changes a row.
    reversible: true,
    confirmPhrase: 'Confirm — run the data migration',
  }
}

/** Dispatch one tool and treat its result as the terminal answer. */
async function singleToolTurn(
  tool: ToolName,
  args: Record<string, unknown>,
  ctx: ToolDispatchContext,
  classification: Classification,
  emit: (e: BrainEvent) => void,
  input: BrainInput,
): Promise<BrainResult> {
  const result = await dispatchTool(tool, args, ctx)
  emit({
    type: 'final',
    summary: result.summary,
    needsUser: !!result.needsUser,
    data: result.data,
  })
  // Persist conversation so future turns have context
  await saveTurn(input.projectId, input.message, result.summary, input.requestId ?? null)
  await recordBrainOperationalMemory(input, [tool], result.summary, result.ok ? 'applied' : 'failed')
  // `singleToolTurn` covers two very different shapes:
  //   • Read / chat / clarification tools (answer_question, ask_user,
  //     read_*, get_*, list_*) — no model spend worth billing → 0.
  //   • Direct dispatch of a mutation tool (apply_proposal, generate_function,
  //     fix_backend, etc.; runBrain sends none here today) — these do real
  //     internal LLM + DB work, so bill the proxy. Without this, the same
  //     operation through the deterministic shortcut would be free; through
  //     the agent loop it would cost — a meter the user can game by phrasing
  //     differently.
  const tokensUsed = isReadOnlyTool(tool) || CONTROL_TOOLS.has(tool)
    ? 0
    : proxyTokensForSteps([tool])
  return {
    success: result.ok,
    summary: result.summary,
    needsUser: !!result.needsUser,
    iterations: 1,
    toolsRun: [tool],
    classification,
    tokensUsed,
  }
}

/** Full tool-use loop for build/modify/fix/destructive/question/confirm intents. */
async function runAgentLoop(
  input: BrainInput,
  classification: Classification,
  rolledSummary: string,
  understandingBlock: string,
  recent: Array<{ role: 'user' | 'assistant'; content: string }>,
  ctx: ToolDispatchContext,
  emit: (e: BrainEvent) => void,
  toolsRun: string[],
  resume: LoopResume | null = null,
  architectFailedThisTurn = false,
): Promise<BrainResult> {
  const turnTools = toolsForIntent(classification.intent)

  // ── What the model is sent ────────────────────────────────────────────────
  //
  // Render order is tools → system → messages, and caching is a prefix match.
  // The tool catalog (~15.7k tokens) and the agent prompt are identical on
  // every call, across turns and projects, so they come first and are cached.
  // This turn's own context (project state, classification) follows them as a
  // second, uncached system block: in the prompt itself it would make the
  // cached prefix unique to every turn. The conversation is cached too, so each
  // step of a multi-step build reads the previous steps from the cache.
  const system = agentSystemPrompt()
  const intentHint = buildIntentHint(classification.intent)
  const context =
    `${understandingBlock}\n\n` +
    (rolledSummary ? `EARLIER CONTEXT:\n${rolledSummary}\n\n` : '') +
    `INTENT CLASSIFICATION (advisory): ${classification.intent} (${classification.confidence.toFixed(2)}) — ${classification.reasoning}\n` +
    `${intentHint}\n` +
    currentPageContext(input.surface)
  // On a resumed turn the model is sent the saved request and the applied list
  // instead of the bare "continue"; the conversation keeps the person's words.
  const messages = conversationFor(recent, resume ? resumePrompt(resume, input.message) : input.message)
  const resumeRequest = resume ? resume.request : input.message
  /** Set where the summary tells the caller to say "continue", so the promise has something behind it. */
  let stoppedUnfinished: LoopStop | null = null

  let mutated = false
  let verifiedAfterMutation = false
  // The model gets one chance to verify a mutation before the loop returns an
  // applied-but-unverified outcome. This is a phase, not a prompt alone: while
  // it is pending, another mutation must not be dispatched accidentally.
  let verificationSteered = false
  // This is deliberately distinct from `verifiedAfterMutation`: a failed
  // catalog read consumes the one bounded verification attempt, but does not
  // establish that the mutation's postcondition holds.
  let verificationReadAttempted = false
  let finalSummary = ''
  let success = false
  let needsUser = false
  let terminalData: unknown = null
  /** Set when a model call failed, classified once for both the prose and the caller's code. */
  let modelFailure: ModelFailure | null = null
  /** Mutations that landed this turn — reported even if the turn later fails. */
  const appliedMutationTitles: string[] = []
  /**
   * Mutations that were ATTEMPTED and refused, with the reason.
   *
   * Successes were reported and failures were not, so a six-item request where
   * two items were refused came back describing the four that worked — "no
   * error, no warning, no mention". For an additive request that reads as
   * complete, and the caller only discovers the gap when the feature depending
   * on it does not work.
   *
   * A refusal is an OUTCOME of the turn and belongs in its report next to the
   * successes. Kept separate from `applied` rather than merged, because the two
   * answer different questions: what is now true, and what still is not.
   */
  const refusedMutations: Array<{ title: string; reason: string }> = []
  let tokensUsed = 0
  // ── Meter what the turn COST, not how many tokens crossed the wire ──────────
  //
  // Weighted at the model's own cache prices: from the second step on, the
  // catalog and the earlier steps are cache reads at a tenth of the input price
  // on Claude. Charging raw totals billed a user the full catalog on every step
  // of a multi-step build, penalising the deep, useful builds hardest for
  // context they never asked for and we were not re-paying for. Reported as
  // spent, not as returned — see BrainInput.onTokens: a caller racing a wall
  // clock only ever sees this.
  const spend = (tokens: number) => {
    if (!(tokens > 0)) return
    tokensUsed += tokens
    try { input.onTokens?.(tokens) } catch { /* billing must never break the loop */ }
  }
  // Per-tool outcome, aligned by index to `toolsRun`. Recorded to Memory so an
  // action that landed reads 'applied' even when a later model call in this
  // same loop times out — the turn-level `success` flag must never smear
  // "failed" across work that actually applied.
  const toolStatuses: BackendEventStatus[] = []
  // Calls the approval gate stopped this turn, exactly as issued. Returned in
  // BrainResult.blockedCalls so the caller can queue each one for a human;
  // nothing here is ever executed by the brain itself.
  const blockedCalls: BlockedCall[] = []
  /**
   * Hold one call for a person: return it exactly as issued, once however often
   * the model repeats it, and tell the model it waits. Every call that needs
   * approval gets this one answer, whichever gate stopped it.
   */
  const holdForApproval = (toolUseId: string, tool: string, args: Record<string, unknown>, danger: Danger) => {
    emit({ type: 'danger', ...danger })
    const dup = blockedCalls.some(
      (b) => b.tool === tool && JSON.stringify(b.args) === JSON.stringify(args),
    )
    if (!dup) {
      blockedCalls.push({
        tool,
        args,
        target: danger.target,
        rowCount: danger.rowCount,
        reversible: danger.reversible,
      })
    }
    return toolResultBlock(
      toolUseId,
      {
        ok: false,
        blocked: 'needs_human_approval',
        summary:
          `\`${tool}\` on ${danger.target} needs a human's approval and was NOT run` +
          (danger.rowCount !== null ? ` — ${danger.rowCount} live row${danger.rowCount === 1 ? '' : 's'} affected` : '') +
          `. It has been queued, exactly as you issued it, for the project owner to approve or reject in ` +
          `the Backenly dashboard. Call finish and briefly state what will happen if it is approved. ` +
          `Do not ask for a confirmation phrase: no message can approve it.`,
      },
      true,
    )
  }
  let verificationToolRejected = false

  const unverifiedMutationSummary = async () => {
    const proof = await collectProof(input.projectId).catch(() => null)
    const state = proof && !proof.nothingBuilt ? formatProof(proof) : ''
    return (
      'I applied changes, but could not verify the resulting state. The changes may have succeeded, so I did not retry them.' +
      (state
        ? `\n\nBest-effort current backend state:\n\n${state}`
        : '\n\nCould not re-read the backend state. Open the dashboard to confirm before making another change.')
    )
  }

  /** Set when the loop stopped to protect its verification reserve. */
  let budgetStopped = false

  // Model calls that came back with an answer, which BrainResult.iterations
  // reports. Not `iter`: every exit but running out of steps is a break, which
  // skips `iter++`, so a turn the model answered at once reported 0.
  let modelCalls = 0
  let iter = 0
  agentLoop: for (; iter < MAX_ITERATIONS; iter++) {
    // ── Spend the verification reserve BEFORE it can be taken ────────────────
    //
    // Checked at the iteration boundary rather than mid-tool: a model round trip
    // plus a tool can easily be 10-20s, so starting one with less than the
    // reserve left is what guaranteed the run died during verification instead
    // of before it.
    if (input.deadlineAt && Date.now() > input.deadlineAt - VERIFY_RESERVE_MS) {
      budgetStopped = true
      break
    }

    // ── The model call never eats the verification reserve ───────────────────
    //
    // The check above only runs between steps, and one model step can take tens
    // of seconds. A call still running when the reserve begins is cancelled and
    // the loop stops exactly as if the check had fired, so the reserve is spent
    // on verifying what landed instead of on a step the caller will never see.
    const call = new AbortController()
    let reserveReached = false
    const reserveTimer = input.deadlineAt
      ? setTimeout(() => {
          reserveReached = true
          call.abort()
        }, Math.max(0, input.deadlineAt - VERIFY_RESERVE_MS - Date.now()))
      : undefined

    // Retries live in the gateway, which repeats only a request the provider
    // refused before running it. A timeout is never repeated here: the request
    // may already have run, and repeating it could run (and bill) it twice.
    let reply: GenerateResult
    try {
      reply = await generate({
        purpose: 'brain.agent',
        system,
        context,
        messages,
        tools: turnTools,
        cacheConversation: true,
        signal: call.signal,
        billing: { projectId: input.projectId },
        label: 'brain-agent',
      })
    } catch (err) {
      if (reserveReached) {
        budgetStopped = true
        break
      }
      // A model that ran and was then refused or cut off still consumed what
      // it says it did, and that is billed like any other step.
      if (err instanceof AiError && err.consumption === 'ran' && err.usage) {
        spend(effectiveTokensOf(err.model ?? '', err.usage))
      }
      console.error('[Brain] model call failed mid-loop:', {
        kind: err instanceof AiError ? err.kind : undefined,
        status: err instanceof AiError ? err.status : undefined,
        consumption: err instanceof AiError ? err.consumption : undefined,
        attempts: err instanceof AiError ? err.attempts : undefined,
        message: err instanceof Error ? err.message : String(err),
        iter,
        mutated,
      })
      // Classified ONCE, into prose for the human and a code for the caller.
      // Deriving them separately is how the prose came to say "rate-limited" while
      // the transport reported an unclassified `Brain run failed.`
      modelFailure = modelFailureOf(err)
      break
    } finally {
      clearTimeout(reserveTimer)
    }

    modelCalls++
    spend(effectiveTokensOf(reply.model, reply.usage))

    const text = textOf(reply.message)
    if (text) emit({ type: 'thinking', text: text.slice(0, 320) })

    const toolCalls = toolUsesOf(reply.message)

    // Cut off at the output ceiling: the last block may be a half-written tool
    // call, so nothing in this answer is run. What its stream had parsed can
    // mean far more than was asked: disable_realtime with no tableName is every
    // table. Each call is answered as cut off and the turn goes on, so the
    // model can send it again shorter. Ending the turn here told it nothing,
    // and a retry could write the same call again.
    if (reply.message.stop_reason === 'max_tokens') {
      if (toolCalls.length === 0) {
        modelFailure = { code: 'MODEL_ERROR', reason: "the AI model's answer was cut off at its output limit", retryable: true }
        break
      }
      console.log(`[Brain] answer cut off at the output limit, not run: ${toolCalls.map((c) => c.name).join(', ')}`)
      messages.push({ role: 'assistant', content: reply.message.content })
      messages.push({
        role: 'user',
        content: toolCalls.map((c) =>
          toolResultBlock(
            c.id,
            {
              ok: false,
              summary:
                `\`${c.name}\` was NOT run: your answer was cut off at the output limit, so this call may be ` +
                `incomplete. Send it again with shorter arguments, or split the work into smaller calls.`,
            },
            true,
          ),
        ),
      })
      continue
    }

    // Cut off because this turn filled the model's context window: the last
    // call may be half-written here too, but answering it would only add to a
    // context that is already full. Nothing in this answer is run and the turn
    // ends; a new turn starts from a fresh context, so it can be retried.
    if (reply.message.stop_reason === 'model_context_window_exceeded') {
      modelFailure = { code: 'MODEL_ERROR', reason: "the AI model's answer was cut off when this turn filled its context window", retryable: true }
      break
    }

    if (toolCalls.length === 0) {
      // Preserve a no-tool reply too. When it follows a mutation, the next
      // model call must see the answer it is being asked to substantiate.
      messages.push({ role: 'assistant', content: reply.message.content })
      if (mutated && !verifiedAfterMutation) {
        if (verificationSteered) {
          finalSummary = await unverifiedMutationSummary()
          success = false
          break
        }
        verificationSteered = true
        emit({ type: 'phase', phase: 'verify' })
        messages.push({
          role: 'user',
          content: [{
            type: 'text',
            text: 'You mutated state but answered without verifying it. Run ONE read_backend_state pass now, then give a truthful final summary. Do not run any mutation.',
          }],
        })
        continue
      }
      // Model answered without tools and there is no outstanding mutation to
      // verify — accept its text as the final summary.
      finalSummary = text || 'Done.'
      success = true
      break
    }

    // The assistant turn goes back exactly as it came, thinking blocks
    // included: with thinking on, a tool result sent without the thinking that
    // led to its call is rejected.
    messages.push({ role: 'assistant', content: reply.message.content })

    // Every call of this step is answered, in order, in ONE user turn.
    // Splitting results across turns teaches the model to stop calling tools in
    // parallel, and a call left unanswered is rejected outright.
    const results: Anthropic.ToolResultBlockParam[] = []
    let finished = false
    const verificationTurn = verificationSteered && mutated && !verifiedAfterMutation
    for (const toolCall of toolCalls) {
      const toolName = toolCall.name as ToolName

      // The verifier has one bounded turn. Never let a model response in that
      // turn replay or extend a mutation before the requested catalog read has
      // completed. We return an honest outcome instead of asking it again.
      if (verificationTurn && (toolName !== 'read_backend_state' || verificationReadAttempted)) {
        verificationToolRejected = true
        finalSummary = verifiedAfterMutation
          ? 'I verified the changes already applied, but did not run another mutation while verification was pending. Ask for that change in a new turn.'
          : await unverifiedMutationSummary()
        success = false
        break agentLoop
      }

      // Arguments that are not an object (a string, when a model encodes them
      // twice and the OpenAI adapter parses them once) are nothing this tool
      // can take, and running it with `{}` instead can mean far more than was
      // asked. The call is answered, not run, so the model can send it again.
      if (!toolCall.input || typeof toolCall.input !== 'object' || Array.isArray(toolCall.input)) {
        console.log(`[Brain] tool=${toolName} not run: its arguments were not an object`)
        results.push(
          toolResultBlock(
            toolCall.id,
            {
              ok: false,
              summary:
                `\`${toolName}\` was NOT run: its arguments were not a JSON object. ` +
                `Send the call again with its arguments as one JSON object.`,
            },
            true,
          ),
        )
        continue
      }
      const args = toolCall.input as Record<string, unknown>

      // Set this before dispatch. If the catalog read throws or returns an
      // unsuccessful ToolResult, a later model iteration must not reopen the
      // bounded verification attempt.
      if (verificationTurn) verificationReadAttempted = true

      // A question only reads. Its list offers nothing else, but a model can
      // send a tool it was not offered or ask a read to write (get_readiness
      // with autoFix), so a call that is neither a read nor one of the tools
      // that end the turn is answered here: not run, counted or queued. That
      // is wider than isMutationCall, which counts no control tool, because
      // apply_proposal and run_test write too.
      if (classification.intent === 'QUESTION' && !isReadOnlyCall(toolName, args) && !QUESTION_CONTROL_TOOLS.has(toolName)) {
        results.push(toolResultBlock(toolCall.id, {
          ok: false,
          blocked: 'read_only_turn',
          summary: `\`${toolName}\` was NOT run: this turn answers a question and only reads. Finish with the answer, and say in it what would need to change.`,
        }, true))
        continue
      }

      // Approval gate — one rule for every door. `needsApproval` is the same
      // judgement the MCP tool route uses: the brain's destructive set OR an
      // executor rated high-risk, so the two doors can never disagree about
      // what needs a person. A gated call never runs here; it is returned
      // exactly as issued so the caller can queue it for a human.
      if (needsApproval(toolName)) {
        results.push(holdForApproval(toolCall.id, toolName, args, await describeDanger(input.projectId, toolName, args)))
        continue
      }

      // Redacted for the log only; the call itself receives the real arguments.
      console.log(`[Brain] tool=${toolName} args=${JSON.stringify(redactArgs(args)).slice(0, 200)}`)
      const result = await dispatchTool(toolName, args, ctx)
      // A real data migration is stopped by the executor's own gate, which
      // counts the rows it would change. That answer used to reach the model as
      // a failure asking for a "confirm" no message could deliver, so from here
      // only a dry run ever happened. It waits for a person like a gated call
      // instead, with those counts as what they approve. Nothing ran: it is not
      // a mutation, a refusal or a tool run of this turn.
      const migration = migrationAwaitingApproval(toolName, result)
      if (migration) {
        results.push(holdForApproval(toolCall.id, toolName, args, migration))
        continue
      }
      toolsRun.push(toolName)
      toolStatuses.push(result.ok ? 'applied' : 'failed')
      console.log(`[Brain] tool=${toolName} ok=${result.ok} terminal=${!!result.terminal} summary="${result.summary.slice(0, 120)}"`)

      // Track verification cadence. A read that failed is not verification.
      if (toolName === 'read_backend_state' && mutated) verifiedAfterMutation = result.ok
      if (toolName === 'run_test' && mutated) verifiedAfterMutation = true
      // Allowlist-driven: a mutation is anything that is NOT a control tool and
      // NOT a read. Adding a new read tool to tools.READ_ONLY_TOOLS (or a
      // control tool to CONTROL_TOOLS above) keeps this honest without editing
      // this branch every time; a tool whose arguments decide, like a dry-run
      // migration, has its rule in tools.READ_ONLY_WHEN.
      const isMutation = isMutationCall(toolName, args)
      if (isMutation) {
        mutated = true
        verificationSteered = false
        // ── A self-verifying tool does not need a verification pass ───────────
        //
        // Verification was a single step at the END of the run, so it was always
        // the step a wall clock cut: four RLS calls in one session all landed and
        // all reported UNVERIFIED. The operation whose correctness matters most
        // was the one that never got confirmed.
        //
        // SELF_VERIFYING tools re-read the catalog INSIDE the executor and refuse
        // to return ok:true if what they read back does not match what they
        // asked for — set_rls compares pg_policies per command and restores the
        // table rather than report a change that is not there. That is a
        // stronger check than the final read_backend_state would have been, and
        // it has already happened by the time we get here. Demanding a second
        // pass afterwards is what pushed the run into the time budget in the
        // first place.
        verifiedAfterMutation = result.ok && SELF_VERIFYING_TOOLS.has(toolName)
        // Recorded even when the turn later fails, so the caller can tell "the
        // run stopped" from "nothing changed" — the distinction that decides
        // whether retrying is safe or duplicates work.
        if (result.ok) appliedMutationTitles.push(humanTitle(toolName, args))
        else refusedMutations.push({
          title: humanTitle(toolName, args),
          reason: (result.summary || 'no reason given').slice(0, 300),
        })
      }

      // Clip hard before feeding back into the loop. Executor summaries can be
      // huge markdown ("## Your Backend Architecture…"); echoing them verbatim
      // every iteration bloats context until the model call times out.
      const clippedSummary =
        result.summary && result.summary.length > 500
          ? result.summary.slice(0, 500) + '…'
          : result.summary
      results.push(toolResultBlock(toolCall.id, { ok: result.ok, summary: clippedSummary }, !result.ok))

      if (result.terminal) {
        finalSummary = result.summary || 'Done.'
        needsUser = !!result.needsUser
        terminalData = result.data ?? null
        success = !needsUser && result.ok
        finished = true
      }
    }

    if (finished) {
      // Steer the model to verify if it tried to finish after mutating. The
      // steer rides in the same user turn as the results: the routed models
      // take no system message mid-conversation.
      if (mutated && !verifiedAfterMutation && !needsUser) {
        if (verificationSteered) {
          finalSummary = await unverifiedMutationSummary()
          success = false
          break
        }
        verificationSteered = true
        emit({ type: 'phase', phase: 'verify' })
        messages.push({
          role: 'user',
          content: [
            ...results,
            {
              type: 'text',
              text: 'You called finish after mutating state but did not verify. Run ONE read_backend_state verification pass, then finish again with a truthful summary. Do not run any mutation.',
            },
          ],
        })
        success = false
        continue
      }
      break
    }

    messages.push({ role: 'user', content: results })
    emit({ type: 'phase', phase: mutated ? 'execute' : 'route' })
  }

  // Truthful failure handling. NEVER claim total failure when work landed —
  // and never call a failure "transient" when we don't know that: name the
  // actual reason so a repeated failure reads as what it is.
  if (modelFailure) {
    const { reason, retryable, code } = modelFailure
    if (mutated) {
      if (retryable || code === 'AI_UNAVAILABLE') stoppedUnfinished = 'model_failure'
      const proof = await collectProof(input.projectId).catch(() => null)
      const state = proof && !proof.nothingBuilt ? formatProof(proof) : ''
      finalSummary =
        `I applied changes, then ${reason} before I could finish verifying. ` +
        'This is the real current state of your backend:\n\n' +
        (state || 'Could not re-read the state. Open the dashboard to confirm.') +
        (retryable
          ? '\n\nSay "continue" and I\'ll finish and verify the rest. If this keeps happening, wait a minute before retrying.'
          : code === 'AI_UNAVAILABLE'
            ? '\n\nThe changes above are in place. Say "continue" once AI is available again and I\'ll finish and verify the rest.'
            : '\n\nThe changes above are in place. Rephrase what is left and I\'ll pick it up from here.')
      // success stays false (we did not cleanly finish) but the message is honest.
    } else {
      finalSummary = nothingChangedBecause(modelFailure)
    }
    emit({ type: 'error', message: `Recovered from a mid-loop model failure (${reason}) — reported the true state.` })
  }

  // ── The reserved verification pass ─────────────────────────────────────────
  //
  // Deterministic, not model-driven, and that is the point: the step that proves
  // what landed cannot itself be skipped because the model chose a different
  // tool or because a round trip ran long. It reads the live catalog directly.
  let verified = false
  if (budgetStopped) {
    stoppedUnfinished = 'time_budget'
    emit({ type: 'phase', phase: 'verify' })
    const proof = await collectProof(input.projectId).catch(() => null)
    verified = !!proof
    const state = proof && !proof.nothingBuilt ? formatProof(proof) : ''
    finalSummary = appliedMutationTitles.length
      ? `I ran out of time budget with work still queued, so I stopped taking new steps and spent the ` +
        `remaining budget VERIFYING what had already landed.\n\n` +
        `Applied and verified (${appliedMutationTitles.length}): ${appliedMutationTitles.join('; ')}.\n\n` +
        (state
          ? `Live state read back from the catalog:\n\n${state}\n\n`
          : `The state read-back itself failed, so treat the list above as applied-but-unconfirmed.\n\n`) +
        (refusedMutations.length
          ? `Attempted and REFUSED (${refusedMutations.length}) — these did NOT take effect:\n` +
            refusedMutations.map((r) => `  • ${r.title} — ${r.reason}`).join('\n') + '\n\n'
          : '') +
        `Nothing else was attempted. Say "continue" for the rest — do NOT replay the whole request, ` +
        `the changes above are already in place.`
      : `I ran out of time budget before changing anything. Nothing was applied. ` +
        `Say "continue" to retry with a fresh budget.` +
        (state ? `\n\nCurrent state, unchanged:\n\n${state}` : '')
    emit({
      type: 'error',
      message:
        `Stopped ${VERIFY_RESERVE_MS / 1000}s before the deadline to guarantee a verification pass — ` +
        `verification is budgeted, never dropped.`,
    })
  }

  if (!finalSummary && iter >= MAX_ITERATIONS) stoppedUnfinished = 'step_budget'
  if (!finalSummary) {
    finalSummary =
      iter >= MAX_ITERATIONS
        ? "I made progress but ran out of steps before fully finishing. Tell me to continue and I'll pick up where I left off."
        : 'Done.'
  }

  // The summary above invites "continue" only on these stops, so exactly these
  // save something for it to resume. A turn that finishes the resumed work, or
  // changes the backend for a new request, clears the marker so a later "yes"
  // cannot revive work that is done or replaced. A read-only turn in between
  // ("what tables do I have?") leaves it, so "continue" still works after it.
  if (stoppedUnfinished) {
    await saveLoopResume(
      input.projectId,
      resumeRequest,
      [...(resume?.applied ?? []), ...appliedMutationTitles],
      stoppedUnfinished,
      architectFailedThisTurn,
    ).catch((err) => console.error('[Brain] could not save the resume point:', err))
  } else if (resume || mutated) {
    await clearLoopResume(input.projectId)
  }

  emit({ type: 'final', summary: finalSummary, needsUser, data: terminalData })
  await saveTurn(input.projectId, input.message, finalSummary, input.requestId ?? null)
  await recordBrainOperationalMemory(input, toolsRun, finalSummary, success ? 'applied' : 'failed', toolStatuses)

  // ── The failure classification the caller gets ──────────────────────────────
  //
  // Derived from the same facts the summary prose is derived from, so the two can
  // never disagree. `applied` is populated regardless of outcome: a caller must be
  // able to distinguish "the run stopped" from "nothing changed".
  const mutationUnverified = mutated && !verifiedAfterMutation && verificationSteered
  const failureCode: BrainFailureCode | undefined = success
    ? undefined
    : needsUser
        ? 'NEEDS_USER'
        : mutationUnverified
          ? 'UNVERIFIED'
          : verificationToolRejected
            ? 'TOOL_REFUSED'
          : modelFailure
            ? modelFailure.code
            : iter >= MAX_ITERATIONS
              ? 'STEP_BUDGET_EXHAUSTED'
              : toolStatuses.includes('failed')
                ? 'TOOL_REFUSED'
                : undefined

  return {
    success,
    summary: finalSummary,
    needsUser,
    iterations: modelCalls,
    toolsRun,
    classification,
    tokensUsed,
    // Only a model failure can be worth retrying as-is: out of steps means
    // "continue", and a tool that refused on the merits refuses again.
    ...(failureCode ? {
      failureCode,
      retryable: failureCode === 'UNVERIFIED' ? false : modelFailure?.retryable ?? false,
    } : {}),
    applied: appliedMutationTitles,
    // Reported on EVERY path, including a turn that otherwise succeeded. A
    // request whose six items produced four changes and two refusals is not a
    // success with a footnote; the caller has to be told which two.
    ...(refusedMutations.length ? { refused: refusedMutations } : {}),
    ...(budgetStopped ? { budgetStopped: true, verified } : {}),
    ...(blockedCalls.length ? { blockedCalls } : {}),
  }
}

/** ──────────────────────────────────────────────────────────────────────── */

/**
 * Tools removed from the surface when the user is CONFIRMING a plan. Once the
 * user has said "go ahead", offering propose_plan to the model again is the
 * exact bug that made "go ahead" re-emit the same plan instead of running it:
 * the model pattern-matches the previous assistant turn and just re-proposes.
 * Removing the tool makes the bug physically impossible.
 *
 * ask_user is kept (execution can still discover a missing credential).
 */
const CONFIRM_TOOL_BLOCKLIST = new Set<string>(['propose_plan'])

/**
 * What a QUESTION turn is offered besides the reads (tools.READ_ONLY_TOOLS):
 * the tools that end it with an answer or a question back. The hint's "Do NOT
 * mutate anything" was all that stood between a question and create_table or
 * drop_table. As with CONFIRM_TOOL_BLOCKLIST, the model picks from what it is
 * offered, and the loop refuses any call it sends anyway that is neither a
 * read nor one of these. The shorter list is also cheaper and faster on every
 * question.
 */
const QUESTION_CONTROL_TOOLS = new Set<string>(['finish', 'ask_user', 'answer_question'])

/**
 * The catalog as the brain's model is offered it, translated once at load so
 * every call sends byte-identical tools and the cached prefix holds across
 * turns. BRAIN_MODEL_TOOLS, not BRAIN_TOOLS: tools only an MCP agent calls are
 * not offered to the model.
 */
const MODEL_TOOLS: Anthropic.Tool[] = BRAIN_MODEL_TOOLS.map(toModelTool)
const CONFIRM_MODEL_TOOLS: Anthropic.Tool[] = MODEL_TOOLS.filter((t) => !CONFIRM_TOOL_BLOCKLIST.has(t.name))
const QUESTION_MODEL_TOOLS: Anthropic.Tool[] = MODEL_TOOLS.filter(
  (t) => isReadOnlyTool(t.name) || QUESTION_CONTROL_TOOLS.has(t.name),
)

function toolsForIntent(intent: BrainIntent): Anthropic.Tool[] {
  if (intent === 'CONFIRM') return CONFIRM_MODEL_TOOLS
  if (intent === 'QUESTION') return QUESTION_MODEL_TOOLS
  return MODEL_TOOLS
}

/** "I stopped before changing anything because …", ending with what can be done next. */
function nothingChangedBecause(failure: ModelFailure): string {
  return (
    `I stopped before changing anything because ${failure.reason}. Nothing was modified.` +
    (failure.code === 'AI_UNAVAILABLE'
      ? ' The typed tools do not need AI and still work.'
      : failure.retryable
        ? ' Please try again in a moment.'
        : '')
  )
}

/**
 * A turn that could not get a model to answer at all. Nothing was changed, so
 * it says exactly that and why, instead of carrying on into a step that would
 * fail somewhere less explicable. `detail` is the deployment's own account of
 * the problem (which setting is missing), shown after the summary.
 */
function stoppedBeforeStarting(
  failure: ModelFailure,
  emit: (e: BrainEvent) => void,
  toolsRun: string[],
  detail?: string,
): BrainResult {
  const summary = nothingChangedBecause(failure) + (detail ? `\n\n${detail}` : '')
  emit({ type: 'error', message: `No model call could be made: ${failure.reason}.` })
  emit({ type: 'final', summary, needsUser: false })
  return {
    success: false,
    summary,
    needsUser: false,
    iterations: 0,
    toolsRun,
    classification: { intent: 'UNCLEAR', confidence: 0, reasoning: `not classified: ${failure.reason}` },
    tokensUsed: 0,
    failureCode: failure.code,
    retryable: failure.retryable,
    applied: [],
  }
}

function buildIntentHint(intent: BrainIntent): string {
  switch (intent) {
    case 'BUILD':
      return 'Hint: this is a BUILD request. If it touches 2+ resources or changes >1 subsystem, call propose_plan first. For a single small add, proceed directly.'
    case 'MODIFY':
      return 'Hint: this is a MODIFY request on an existing resource. Use add_column / generate_api / add_rls etc. Do NOT recreate the table.'
    case 'FIX':
      return 'Hint: this is a FIX request. Use read_backend_state to identify what is broken, then fix_backend or a specific mutation. A destructive fix waits for a person\'s approval.'
    case 'DESTRUCTIVE':
      return [
        'Hint: this is a DESTRUCTIVE request. Identify the exact target and CALL the destructive tool now — do NOT ask for confirmation in prose.',
        'The approval gate stops the call before it runs and queues it, exactly as issued, for the project owner to approve or reject in the dashboard, with the live row count.',
        'No message approves it, including a "yes" or "confirm" in this turn or the next. Describing the operation without calling the tool queues nothing, so the owner has nothing to approve.',
      ].join(' ')
    case 'QUESTION':
      return 'Hint: this is a QUESTION about the project state. Call read_backend_state and then finish with the answer. Do NOT mutate anything: this turn is offered only the read tools, so if something should change, say what in your answer.'
    case 'CONFIRM':
      return [
        'Hint: the user has CONFIRMED the plan you proposed in the previous assistant turn (e.g. "go ahead", "yes", "do it").',
        'EXECUTE that plan now — call the actual mutation tools (create_table / generate_api / enable_auth / add_rls / etc.) one by one, then read_backend_state to verify, then finish.',
        'The propose_plan tool is intentionally unavailable on this turn — re-proposing what they just confirmed would loop them forever, so it has been removed from your tool surface.',
        'Do NOT ask the user to confirm again. Do NOT restate the plan as prose. Do the work.',
      ].join(' ')
    case 'APPLY_PROPOSAL':
      return [
        'Hint: the user is telling you to act on a list / set of recommendations / features that came up EARLIER IN THIS CONVERSATION',
        '(e.g. "implement these 3 features", "yes add those", "do all that", "apply all those updates").',
        'Step 1: optionally call apply_proposal once in case a formal Proposal is stored.',
        'Step 2: if apply_proposal returns "No active proposal" (or you did not call it), DO NOT STOP. Read the recent',
        'conversation above, identify the EXACT concrete items the user is referring to (e.g. the features/tables/APIs',
        'you just listed), and BUILD them now with the appropriate tools. Treat it as a BUILD of those items.',
        'Never end the turn with "No active proposal to apply" — that is a failure. The user wants the work done.',
      ].join(' ')
    default:
      return ''
  }
}

/**
 * Produce a contextual clarifying question for a genuinely unclear message.
 *
 * Uses the LLM `clarifyPrompt` (previously written but never wired) so the
 * question adapts to what the user actually said, with 2–3 tappable options.
 * The old implementation string-truncated the message to 80 chars — which is
 * exactly why a clear recipe-app description surfaced as
 * `…and save "?` mid-word. Falls back to a non-truncating generic question
 * only if the model call fails.
 */
/** The clarification's shape, as structured output: every object closed, every field required. */
const CLARIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'options'],
  properties: {
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
  },
}

async function synthesiseClarification(
  message: string,
  recentHistory: ConversationTurn[],
  projectId: string,
): Promise<{ question: string; options: string[] }> {
  const fallback = {
    question: 'Just so I get this right — do you want me to build this backend for you, change something that already exists, or answer a question about how Backenly works?',
    options: ['Build it for me', 'Change something existing', 'Answer a question'],
  }
  try {
    const recent = recentHistory.slice(-4).map((turn) => ({
      role: turn.role,
      content: turn.content.length > 600 ? turn.content.slice(0, 600) + '…' : turn.content,
    }))
    const reply = await generate({
      purpose: 'brain.classify',
      system: clarifyPrompt(),
      messages: conversationFor(recent, message),
      jsonSchema: CLARIFICATION_SCHEMA,
      maxTokens: 400,
      billing: { projectId },
      label: 'brain-clarify',
    })
    const parsed = (reply.json ?? {}) as { question?: unknown; options?: unknown }
    const question = typeof parsed.question === 'string' && parsed.question.trim() ? parsed.question.trim() : fallback.question
    const options = Array.isArray(parsed.options)
      ? parsed.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).slice(0, 3)
      : []
    return { question, options }
  } catch (err) {
    console.error('[Brain] synthesiseClarification LLM call failed — using fallback:', err)
    return fallback
  }
}

async function recordBrainOperationalMemory(
  input: BrainInput,
  tools: string[],
  summary: string,
  status: BackendEventStatus,
  toolStatuses?: BackendEventStatus[],
): Promise<void> {
  if (tools.length === 0) return

  await recordToolExecutionMemory({
    projectId: input.projectId,
    actorId: input.userId,
    userMessage: input.message,
    tools,
    summary,
    status,
    toolStatuses,
  }).catch((error) => {
    console.error('[Operational Memory] Failed to record brain receipt:', error)
  })
}

function detectPendingPlan(history: Array<{ role: 'user' | 'assistant'; content: string }>): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]
    if (t.role === 'assistant') {
      return /Reply\s+\*?["']?go ahead["']?\*?\s+to run this/i.test(t.content)
    }
  }
  return false
}

async function hasActiveProposal(projectId: string): Promise<boolean> {
  try {
    const { getActiveProposal } = await import('../proposals/store')
    const p = await getActiveProposal(projectId)
    return p !== null
  } catch {
    return false
  }
}
