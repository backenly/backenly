/**
 * BUILD MODE ROUTER
 * =================
 * Unified sub-behavior classifier for Build mode.
 *
 * Every message that reaches Build mode is dispatched through here.
 * The router identifies EXACTLY ONE sub-behavior — no overlap, no fallbacks
 * to generic answers.
 *
 * Sub-behaviors:
 *   CONTINUATION  — "build it", "implement", "continue", "go ahead", "yes"
 *   VERIFICATION  — "is this ready?", "does X work?", "run readiness"
 *   INSPECTION    — "list tables", "what do I have", "check if X exists"
 *   MODIFICATION  — "add column", "rename field", "alter existing table"
 *   EXECUTION     — everything else: create, build, generate, enable, fix, trigger
 *
 * Priority: CONTINUATION > VERIFICATION > INSPECTION > MODIFICATION > EXECUTION
 *
 * Rule: every handler MUST use real project state. No generic answers.
 */

import { getOpenAIClient } from './openai-service'
import { getModel } from './model-router'

// ── Public types ──────────────────────────────────────────────────────────────

export type BuildSubBehavior =
  | 'EXECUTION'     // create tables, add auth, generate APIs, fix, triggers, functions
  | 'INSPECTION'    // list, show, check if X exists, what do I have
  | 'MODIFICATION'  // add column, rename field, alter existing resource
  | 'CONTINUATION'  // build it, implement it, continue, proceed, go ahead
  | 'VERIFICATION'  // is this ready?, does X work?, run readiness check

export interface BuildRouterResult {
  subBehavior: BuildSubBehavior
  reason: string
  confidence: number
}

// ── Fast-path patterns ────────────────────────────────────────────────────────

/** Matches user confirming/continuing a previous intent — must fire BEFORE execution patterns.
 *  Phase 5 triggers: implement, build it, continue, proceed, do it (and variants). */
const CONTINUATION_RE =
  /^(yes|yeah|yep|ok|okay|sure|go ahead|proceed|do it|build it|implement it?|implement that|implement|make it|sounds good|looks good|let'?s go|let'?s do it|let'?s build|continue|keep going|carry on|go on|do that|run it|execute it?|make it so|approved|absolutely|definitely|perfect|great|exactly|correct|right|yes please|do this|apply it|apply that|apply the plan|apply changes|run the plan)[\s!.,]*$/i

/** Additional continuation phrases that can appear mid-sentence.
 *  Includes referential follow-ups like "implement the enhancements / those / all of them".
 *  Also covers: "build everything I said/above/mentioned" — these ALWAYS refer back to
 *  the prior detailed prompt, never to the short phrase itself.
 *
 *  Cross-turn referential covers both base and -ing/-ed forms ("implement",
 *  "implementing", "implemented") plus imperative starters ("start", "begin",
 *  "let's", "go ahead and"). The target nouns ("updates", "fixes",
 *  "recommendations", etc.) are the labels users naturally apply to an
 *  AI-generated list, so messages like "start implementing all these updates"
 *  bind to the prior list instead of being treated as a fresh build. */
const REFERENTIAL_OBJECT_NOUNS =
  '(?:updates|changes|fixes|improvements|enhancements|suggestions|recommendations|features|items|things|steps|points|tasks|todos|to-?dos|action\\s+items|gaps|issues|problems|production[- ]grade(?:\\s+updates)?|everything\\s+(?:above|listed|mentioned|suggested|recommended))'

const REFERENTIAL_QUANTIFIERS =
  '(?:all|these|those|them|every(?:thing)?|all\\s+of\\s+(?:it|them|these|those))'

const CONTINUATION_PHRASE_RE =
  /\b(build it|implement it|implement that|implement this|implement (the|those|these|all|them|everything)|implement all of (it|them)|add (those|these|all|them|everything)|apply the plan|apply this|execute the plan|continue from|carry on from|resume from|keep building|proceed with the plan|apply changes|run the plan|build everything|build all of (it|them|that|this)|build (what|everything) (i|we) (said|wrote|described|listed|mentioned|asked for|requested)|do everything (i|we) (said|asked|described|listed|mentioned)|implement (what|everything) (i|we) (said|wrote|described|listed|mentioned|asked for)|just build it|just do it|just implement it|now build|now implement|go build|start building)\b/i

/** Cross-turn referential phrasing: a verb (any tense) + a vague quantifier
 *  that points at prior assistant content. Covers "start implementing all
 *  these updates", "implement those", "apply everything you suggested", etc.
 *
 *  Two flavours combined into one alternation to keep false positives low:
 *    (a) Plural demonstrative quantifier ("these|those|them|everything") —
 *        already inherently referential, noun is optional.
 *    (b) "all" / "all of (it|them|these|those)" — only treated as referential
 *        when followed by one of the object nouns ("updates", "fixes", etc.)
 *        so we don't catch builder phrases like "add all the users". */
const CROSS_TURN_REFERENTIAL_RE = new RegExp(
  '\\b(?:start|begin|let\'?s|go\\s+ahead\\s+(?:and\\s+)?|please\\s+)?\\s*' +
    '(?:implement|build|create|add|do|execute|apply|patch|fix|finish|complete|set\\s*up|configure|enable|make|tackle|handle|knock\\s+out|push\\s+through|roll\\s+out|ship)' +
    '(?:s|ing|ed)?' +
    '\\s+(?:up\\s+)?(?:the\\s+|all\\s+(?:of\\s+)?)?' +
    '(?:' +
      // (a) Inherently referential demonstratives — noun optional.
      '(?:these|those|them|every(?:thing)?|all\\s+of\\s+(?:it|them|these|those))' +
      '(?:\\s+(?:of\\s+(?:the\\s+)?)?' + REFERENTIAL_OBJECT_NOUNS + ')?' +
    '|' +
      // (b) Bare "all" — only referential when an object noun follows.
      'all\\s+(?:of\\s+(?:the\\s+)?)?' + REFERENTIAL_OBJECT_NOUNS +
    ')\\b',
  'i',
)

/** "everything you suggested/recommended/mentioned/listed/said/proposed" */
const REFERENTIAL_YOU_SAID_RE =
  /\b(everything|all|the\s+(?:items|points|steps|fixes|updates|recommendations|suggestions|enhancements|improvements|features|things))\s+you\s+(?:just\s+)?(suggested|recommended|mentioned|listed|said|told\s+me|proposed|outlined|laid\s+out)\b/i

/** Returns true if the message refers back to a prior assistant list. */
export function isCrossTurnReferential(message: string): boolean {
  const trimmed = message.trim()
  if (!trimmed) return false
  if (CROSS_TURN_REFERENTIAL_RE.test(trimmed)) return true
  if (REFERENTIAL_YOU_SAID_RE.test(trimmed)) return true
  return false
}

/** Verification — checking if something is working / ready */
const VERIFICATION_RE =
  /\b(is (this|it|my|the) (ready|working|live|set[\s-]?up|complete|done|running|deployed|active|correct|set))\b|\b(does (this|it|the|my) \w+ work)\b|\b(is \w+ (enabled|configured|set up|working|active|running))\b|\b(run readiness|readiness check|health check|check health|check if (it'?s?|this is) (ready|working|set up|live))\b|\b(am i ready|are we ready|is the backend ready)\b|\b(verify (the )?(setup|integration|config|auth|tables|apis?))\b/i

/** Inspection — read-only queries about current state */
const INSPECTION_RE =
  /^(what|list|show|describe|get|tell me|explain|which|are there|is there|do i|do we|how many|count)\b/i

const INSPECTION_SUFFIX_RE = /\?$/

const INSPECTION_EXPLICIT_RE =
  /\b(list|show|describe|display|what tables|what apis?|what do i have|what('?s| is) in|check if .* (exist|table|column)|do i have|how many tables|show me my|get my tables|get my apis?|inspect|what'?s my)\b/i

/**
 * Big-goal autonomy — "build me a marketplace", "create a SaaS platform".
 * These always go to EXECUTION (full build runtime), never to LLM classifier.
 * Matched before MODIFICATION to prevent misrouting compound build requests.
 */
const AUTONOMY_GOAL_RE =
  /\b(build|create|make|generate|set up|spin up|give me|i need|i want).{0,50}(marketplace|platform|saas|b2b|b2c|startup|ecommerce|e-commerce|social (network|app|platform)|fintech|healthtech|edtech|app|backend|api|system|service|product)\b/i

/** Modification — mutating an EXISTING resource */
const MODIFICATION_RE =
  /\b(add (a |an |the )?(column|field|attribute|property)|remove (column|field|attribute)|rename (column|field|table)|change (column|field) type|alter (table|column|schema)|make .* (required|optional|unique|nullable|indexed)|drop (column|field)|add .+ to (the |a |an )?\w+ (table|entity)|update schema safely|add index|remove index|remove (integration|payment|feature|module|service|webhook|trigger|system)|disable (integration|payment|feature|module|service|webhook))\b/i

const M2M_MODIFY_RE =
  /\b(many.to.many|m2m|junction table|pivot table|relationship between)\b/i

// ── Fast classifier (no LLM) ──────────────────────────────────────────────────

function fastRoute(message: string, hasSchema: boolean): BuildRouterResult | null {
  const trimmed = message.trim()
  const lower = trimmed.toLowerCase()

  // 1. CONTINUATION — exact short phrases (highest priority)
  if (CONTINUATION_RE.test(trimmed)) {
    return { subBehavior: 'CONTINUATION', reason: 'continuation/confirm phrase', confidence: 0.97 }
  }
  if (CONTINUATION_PHRASE_RE.test(lower)) {
    return { subBehavior: 'CONTINUATION', reason: 'explicit continuation phrase', confidence: 0.92 }
  }
  // Cross-turn referential: "start implementing all these updates",
  // "apply those fixes", "do everything you suggested", etc. These ALWAYS
  // refer to the prior assistant turn — bind via extractContinuationContext.
  if (isCrossTurnReferential(trimmed)) {
    return { subBehavior: 'CONTINUATION', reason: 'cross-turn referential to prior list', confidence: 0.9 }
  }

  // 2. VERIFICATION — "is this ready?", "does X work?", readiness patterns
  if (VERIFICATION_RE.test(lower)) {
    return { subBehavior: 'VERIFICATION', reason: 'readiness/verification pattern', confidence: 0.93 }
  }

  // 3. INSPECTION — read-only questions about current state
  if (INSPECTION_EXPLICIT_RE.test(lower)) {
    return { subBehavior: 'INSPECTION', reason: 'explicit inspection pattern', confidence: 0.92 }
  }
  if ((INSPECTION_RE.test(lower) || INSPECTION_SUFFIX_RE.test(lower.trim())) && !hasSchema) {
    // Without schema, "what do I have?" is always inspection
    return { subBehavior: 'INSPECTION', reason: 'question pattern, no schema', confidence: 0.85 }
  }

  // 4a. AUTONOMY fast path — big-goal requests skip LLM and go straight to EXECUTION
  // These describe a whole product, not a targeted mutation — the build runtime
  // handles full autonomy internally (ProductBlueprint + domain classification).
  // Only trigger when the message is long enough to be a real goal (>5 words).
  if (AUTONOMY_GOAL_RE.test(lower) && lower.split(/\s+/).length > 5) {
    return { subBehavior: 'EXECUTION', reason: 'big-goal autonomy pattern', confidence: 0.96 }
  }

  // 4. MODIFICATION — must come before EXECUTION so "add column" doesn't become EXECUTION
  if (MODIFICATION_RE.test(lower) || M2M_MODIFY_RE.test(lower)) {
    return { subBehavior: 'MODIFICATION', reason: 'schema mutation pattern', confidence: 0.91 }
  }
  // "add X to existing TABLE table" when schema exists
  if (hasSchema && /\badd\s+\w+.*\bto\s+(the\s+)?\w+\s*(table|entity)?\b/i.test(lower)) {
    // Don't match "add a table" (that's EXECUTION)
    if (!/\badd\s+(a|an|the)\s+\w+\s+(table|entity)\b/i.test(lower)) {
      return { subBehavior: 'MODIFICATION', reason: 'add-to-table pattern with existing schema', confidence: 0.88 }
    }
  }

  // 5. EXECUTION — default
  return null // hand to LLM classifier
}

// ── LLM classifier ────────────────────────────────────────────────────────────

async function llmRoute(message: string, schemaContext: string): Promise<BuildRouterResult> {
  try {
    const openai = getOpenAIClient()
    const hasSchema = schemaContext.trim().length > 50

    const response = await openai.chat.completions.create({
      model: getModel('classify'),
      messages: [
        {
          role: 'system',
          content: `You classify a build-mode message into exactly one sub-behavior.

Sub-behaviors:
- "CONTINUATION" — user is confirming/continuing a prior plan ("build it", "implement that", "go ahead", "yes continue")
- "VERIFICATION" — user wants to know if something is working/ready/complete ("is this ready?", "does auth work?", "is my backend set up?")
- "INSPECTION"   — user wants to read/list current state ("what tables do I have?", "check if users table exists", "list my APIs")
- "MODIFICATION" — user wants to mutate an EXISTING resource ("add a column", "rename this field", "alter the users table")
- "EXECUTION"    — user wants to create/build/generate something new, fix something, add auth, configure integrations, run triggers/functions

Rules:
1. If the message is a short affirmation ("yes", "ok", "build it", "do it") → CONTINUATION
2. If the message asks whether something is working/ready/set up → VERIFICATION
3. If the message asks about current state (list, show, check if exists) → INSPECTION
4. If the message mutates an EXISTING table/column/field → MODIFICATION
5. Big-goal product descriptions ("build me a marketplace", "I need a SaaS backend") → EXECUTION (the build runtime handles full autonomy)
6. Everything else → EXECUTION (new creation, repair, integration, trigger, function)
7. Default to EXECUTION when uncertain.

${hasSchema ? `Project has existing schema.` : `Project has no schema yet.`}

Respond ONLY with JSON: {"subBehavior": "...", "reason": "one sentence"}`,
        },
        { role: 'user', content: `Classify: "${message}"` },
      ],
      temperature: 0.1,
      max_tokens: 80,
      response_format: { type: 'json_object' },
    })

    const raw = response.choices[0].message.content || '{}'
    const parsed = JSON.parse(raw)
    const valid: BuildSubBehavior[] = ['EXECUTION', 'INSPECTION', 'MODIFICATION', 'CONTINUATION', 'VERIFICATION']
    const subBehavior: BuildSubBehavior = valid.includes(parsed.subBehavior) ? parsed.subBehavior : 'EXECUTION'
    return { subBehavior, reason: String(parsed.reason || ''), confidence: 0.8 }
  } catch {
    return { subBehavior: 'EXECUTION', reason: 'classifier unavailable — defaulting to execution', confidence: 0.5 }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a build-mode message into one of 5 sub-behaviors.
 * Uses fast pattern matching first; falls back to LLM only when ambiguous.
 * Always uses real schema context for schema-dependent decisions.
 */
export async function classifyBuildSubBehavior(
  message: string,
  schemaContext: string,
): Promise<BuildRouterResult> {
  const hasSchema = schemaContext.trim().length > 50
  const fast = fastRoute(message, hasSchema)
  if (fast) {
    console.log(`[BuildRouter] fast=${fast.subBehavior} (${(fast.confidence * 100).toFixed(0)}%) reason="${fast.reason}"`)
    return fast
  }
  const llm = await llmRoute(message, schemaContext)
  console.log(`[BuildRouter] llm=${llm.subBehavior} (${(llm.confidence * 100).toFixed(0)}%) reason="${llm.reason}"`)
  return llm
}

// ── Verification handler ──────────────────────────────────────────────────────

export interface VerificationReport {
  message: string
  ready: boolean
  checks: Array<{ label: string; status: 'ok' | 'missing' | 'partial'; detail?: string }>
}

/**
 * Check project readiness against real DB state.
 * Never returns a generic "looks good" — every check reads actual project state.
 */
export async function verifyProjectReadiness(
  projectId: string,
  schemaContext: string,
  question: string,
): Promise<VerificationReport> {
  const checks: VerificationReport['checks'] = []

  // ── Check 1: Tables exist ──────────────────────────────────────────────────
  const tableMatches = schemaContext.match(/Table:\s*(\w+)/gi) ?? []
  const tableNames = tableMatches.map(m => m.replace(/Table:\s*/i, '').trim())
  if (tableNames.length > 0) {
    checks.push({ label: 'Database tables', status: 'ok', detail: tableNames.join(', ') })
  } else {
    checks.push({ label: 'Database tables', status: 'missing', detail: 'No tables found' })
  }

  // ── Check 2: APIs generated ────────────────────────────────────────────────
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const apiCount = await prisma.apiDefinition.count({ where: { projectId } })
    if (apiCount > 0) {
      checks.push({ label: 'REST APIs', status: 'ok', detail: `${apiCount} endpoint${apiCount !== 1 ? 's' : ''} generated` })
    } else {
      checks.push({ label: 'REST APIs', status: 'missing', detail: 'No APIs generated yet' })
    }
  } catch {
    checks.push({ label: 'REST APIs', status: 'partial', detail: 'Could not check API status' })
  }

  // ── Check 3: Auth enabled ──────────────────────────────────────────────────
  const authEnabled = /auth|users.*table|jwt|password|login|register/i.test(schemaContext)
  checks.push({
    label: 'Authentication',
    status: authEnabled ? 'ok' : 'missing',
    detail: authEnabled ? 'Auth configured' : 'Auth not enabled — say "enable auth" to add it',
  })

  // ── Check 4: Project deployed ──────────────────────────────────────────────
  try {
    const { prisma } = await import('@/lib/db/prisma')
    const deployment = await prisma.deployment.findFirst({
      where: { projectId, status: 'success' },
      orderBy: { createdAt: 'desc' },
    })
    if (deployment) {
      checks.push({ label: 'Deployment', status: 'ok', detail: `Last deployed ${deployment.createdAt.toLocaleDateString()}` })
    } else {
      checks.push({ label: 'Deployment', status: 'missing', detail: 'Not deployed yet — say "deploy" when ready' })
    }
  } catch {
    checks.push({ label: 'Deployment', status: 'partial', detail: 'Could not check deployment status' })
  }

  const allOk = checks.every(c => c.status === 'ok')
  const anyOk = checks.some(c => c.status === 'ok')
  const ready = allOk

  const statusLines = checks.map(c => {
    const icon = c.status === 'ok' ? '✓' : c.status === 'partial' ? '~' : '✗'
    return `${icon} **${c.label}**: ${c.detail ?? c.status}`
  })

  let summary: string
  if (allOk) {
    summary = 'Complete — backend is fully set up and ready.'
  } else if (anyOk) {
    const missing = checks.filter(c => c.status !== 'ok').map(c => c.label).join(', ')
    summary = `Partial — still missing: ${missing}.`
  } else {
    summary = 'Blocked — nothing built yet. Describe what you want to build to start.'
  }

  // If the user asked about something specific, answer that specifically
  const specificTarget = question.match(/\b(auth|login|table|api|deploy|payment|stripe|storage|bucket)\b/i)?.[1]
  if (specificTarget) {
    const match = checks.find(c => c.label.toLowerCase().includes(specificTarget.toLowerCase()))
    if (match) {
      summary = `${match.label}: ${match.detail ?? match.status}.\n\n${summary}`
    }
  }

  return {
    message: `**Readiness**\n\n${statusLines.join('\n')}\n\n${summary}`,
    ready,
    checks,
  }
}

// ── Continuation handler ──────────────────────────────────────────────────────

/**
 * Phase 5 — Sticky Context & Continuation Binding
 *
 * Resolve what to build when the user sends a bare continuation trigger
 * ("implement", "build it", "continue", "proceed", "do it", etc.).
 *
 * Binding order (strict — no fallback to generic scaffold):
 *   1. Sticky store: last unfinished build_request for this project
 *   2. Sticky store: last generated plan for this project
 *   3. In-memory history: last user build intent not followed by "Done:"
 *   4. null → caller MUST return "No unfinished build plan found."
 *
 * @param projectId  Required for sticky-store lookup
 * @param history    In-memory conversation history (fallback only)
 * @param triggerMessage  The raw continuation phrase the user sent
 */
export async function extractContinuationContext(
  projectId: string,
  history: Array<{ role: string; content: string }>,
  triggerMessage: string,
): Promise<string | null> {
  // ── 0: Active BuildJob binding (highest priority) ─────────────────────────
  // If a BuildJob is still pending/partial/blocked, ALWAYS bind to it.
  // This is the fix for "continue → recompiles fresh backend" — we look at
  // real pending state, not chat history, so the answer is always correct.
  try {
    const { loadActiveBuildJob } = await import('./build-runtime/continuation-store')
    const activeJob = await loadActiveBuildJob(projectId)
    if (activeJob && ['partial', 'blocked', 'running'].includes(activeJob.status)) {
      const allNodes = activeJob.phases.flatMap(p => p.nodes)
      const pendingNodes = allNodes.filter(n => n.status === 'pending' || n.status === 'partial')
      const blockedNodes = allNodes.filter(n => n.status === 'blocked')
      if (pendingNodes.length > 0 || blockedNodes.length > 0) {
        const goal = activeJob.goalSummary ?? activeJob.originalPrompt ?? 'previous build'
        const pendingLabels = pendingNodes.slice(0, 5).map(n => n.label).join(', ')
        const blockedLabels = blockedNodes.slice(0, 3).map(n => n.label).join(', ')
        const parts: string[] = [`Resume the build: ${goal}`]
        if (pendingLabels) parts.push(`Pending: ${pendingLabels}`)
        if (blockedLabels) parts.push(`Blocked (need credentials): ${blockedLabels}`)
        return `${parts.join('. ')}. [User confirmed: ${triggerMessage}]`
      }
    }
  } catch { /* non-fatal — fall through to history */ }

  // ── 1: AI suggestion / plan item reference — "implement the enhancements/suggestions/all" ──
  // Detect referential follow-ups that point to AI-generated lists, not a prior user intent.
  // Covers base + -ing/-ed verb forms, imperative starters ("start", "begin", "let's"),
  // and the broader noun set users naturally apply to an AI list
  // ("updates", "fixes", "recommendations", etc.). The shared
  // `isCrossTurnReferential` keeps detection consistent with the build-router.
  //
  // EXCLUSION: phrases that self-reference the user ("X I said / I wrote /
  // I described / I listed / I mentioned") must NOT bind to an AI list —
  // they point to the *user's* prior prompt and should fall through to the
  // sticky-store / user-history path below.
  const isUserSelfReference =
    /\b(i|we)\s+(said|wrote|described|listed|mentioned|asked\s+for|requested|told\s+you|gave\s+you|spelled\s+out)\b/i.test(triggerMessage)
  const refsAISuggestions =
    !isUserSelfReference && (
      isCrossTurnReferential(triggerMessage) ||
      /\b(implement|add|build|create|do|execute|apply|patch|fix|finish|complete|set\s*up|configure|enable|make|tackle|handle|knock\s+out|push\s+through|roll\s+out|ship)(s|ing|ed)?\s+(the\s+)?(potential\s+)?(enhancement|enhancements|improvement|improvements|suggestion|suggestions|recommendation|recommendations|feature|features|update|updates|fix|fixes|change|changes|item|items|step|steps|gap|gaps|todo|todos|to-?dos|all|those|these|them|everything|all of (it|them))\b/i.test(triggerMessage)
    )
  if (refsAISuggestions) {
    try {
      const { getAISuggestions, getAIPlanItems } = await import('./sticky-intent-store')
      const [suggestions, planItems] = await Promise.all([
        getAISuggestions(projectId),
        getAIPlanItems(projectId),
      ])
      const items = suggestions ?? planItems
      if (items && items.length > 0) {
        return `Implement these features/enhancements:\n${items.map(i => `- ${i}`).join('\n')}\n\n[User confirmed: ${triggerMessage}]`
      }
    } catch { /* non-fatal */ }
  }

  // ── 1 & 2: Sticky store (survives page reload, new sessions) ─────────────
  try {
    const { resolveStickyGoal } = await import('./sticky-intent-store')
    const stickyGoal = await resolveStickyGoal(projectId, triggerMessage)
    if (stickyGoal) return stickyGoal
  } catch { /* non-fatal — fall through to history */ }

  // ── 1b: Check AI suggestions in history as additional fallback ────────────
  // Walk recent assistant messages for an AI-generated list the user is now referencing.
  // If the message looked referential (refsAISuggestions matched) but the
  // sticky store was empty, also walk history — the AI may have emitted the
  // list inline without persisting it (e.g., the answer-engine path).
  //
  // Same self-reference exclusion as refsAISuggestions — "build everything
  // I said" must fall through to the user-history path so we recover the
  // user's prior detailed prompt, not the assistant's analysis of it.
  const mentionsList =
    !isUserSelfReference && (
      refsAISuggestions ||
      /\b(those|them|the (suggestions|enhancements|improvements|features|steps|plan|updates|fixes|recommendations|changes|items|points|tasks))\b/i.test(triggerMessage)
    )
  if (mentionsList) {
    // Find the last assistant message that contained a numbered or bulleted list
    const recentTurns = [...history].reverse().slice(0, 10)
    for (const turn of recentTurns) {
      if (turn.role !== 'assistant') continue
      const hasList = /\n\s*[-*•]\s+\S|\n\s*\d+\.\s+\S/.test(turn.content)
      if (hasList) {
        return `Implement the following based on previous AI suggestions:\n\n${turn.content.slice(0, 2000)}\n\n[User confirmed: ${triggerMessage}]`
      }
    }
  }

  // ── 3: In-memory history fallback ────────────────────────────────────────
  // Walk history in reverse — find the last user message that looks like a
  // build intent that wasn't already executed (no "Done:" after it).
  const turns = [...history].reverse()

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    if (turn.role !== 'user') continue

    const content = turn.content.toLowerCase()
    // Skip trivial continuation phrases themselves
    if (/^(yes|ok|build it|do it|continue|go ahead|proceed|implement)[\s!.]*$/.test(content)) continue

    // Check if this was already built (the turn BEFORE it in reversed order = AFTER it chronologically)
    const prevTurn = turns[i - 1]
    if (prevTurn?.role === 'assistant' && /\b(done:|built|created|enabled|configured|generated)\b/i.test(prevTurn.content)) {
      continue
    }

    // Has a build/plan intent → use as continuation context.
    // Preserve up to 2000 chars so multi-entity marketplace-style prompts
    // don't lose entities that appear past the first 400 characters.
    if (/\b(create|build|add|generate|implement|set up|enable|configure|scaffold|make|need|want)\b/i.test(content)) {
      return `${turn.content.slice(0, 2000)}\n\n[User confirmed: ${triggerMessage}]`
    }

    // Plan mode response → user said "build it" after seeing the plan
    if (prevTurn?.role === 'assistant' && /proposed_architecture|required_steps|say.*build it/i.test(prevTurn.content)) {
      return `${turn.content.slice(0, 2000)}\n\n[User confirmed: ${triggerMessage}]`
    }
  }

  // ── 4: Nothing found — hard rule: no generic scaffold ────────────────────
  return null
}
