/**
 * MODE CLASSIFIER
 * ===============
 * Determines whether a project chat message should enter
 * Plan Mode (think/design) or Build Mode (execute/inspect).
 *
 * Plan Mode  → request is unclear, user wants architecture/schema advice,
 *              or the system needs clarification before acting.
 *
 * Build Mode → user wants to create/build/add/implement/check/verify/list
 *              or continue/modify an existing resource.
 *
 * Every message resolves to exactly one mode — no mixed responses.
 */

import { getOpenAIClient } from './openai-service'
import { getModel } from './model-router'

export type ChatMode = 'plan' | 'build' | 'conversation'

export interface ModeClassification {
  mode: ChatMode
  reason: string
}

// ── Conversation Mode fast-path signals ──────────────────────────────────────
// These match advisory/discussion requests that need a conversational response,
// not a structured plan card or a build execution.

const CONVERSATION_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(explain|walk me through|tell me (about|how|why))\b.{0,60}\?/i,                 reason: 'Explanation request — needs conversational answer' },
  { re: /\b(what do you think|what'?s your (opinion|take|recommendation|view))\b/i,         reason: 'Opinion/advisory request — conversation mode' },
  { re: /\b(should (i|we) use|which (is|would be) better|pros and cons|trade.?offs?)\b/i,  reason: 'Comparison/tradeoff question — conversation mode' },
  { re: /\b(jwt|oauth|session|cookie|token).{0,40}(vs\.?|versus|or|compared to).{0,40}(jwt|oauth|session|cookie|token)\b/i, reason: 'Auth mechanism comparison — conversation mode' },
  { re: /\bhow (do|does|would|can|should) (i|we|you|it|this) .{0,60}\b(work|flow|function|behave|handle)\b.{0,20}\?/i, reason: 'How-does-X-work question — conversation mode' },
  { re: /\b(advise|consult|your thoughts|thoughts on|opinion on|guidance on)\b/i,           reason: 'Explicit advisory request — conversation mode' },
  { re: /\b(explain (how|why|what|the|my))\b/i,                                             reason: 'Explain directive — conversation mode' },
  { re: /\bwhat (is|are) (the )?(difference|benefit|advantage|disadvantage|downside|tradeoff)/i, reason: 'Concept comparison — conversation mode' },
]

// ── Plan Mode fast-path signals ───────────────────────────────────────────────

const PLAN_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /what (should|would|could) (i|we) (build|make|create|start with)/i,           reason: 'User asking for build recommendations' },
  { re: /\b(help me (plan|design|architect|decide|think|figure out))\b/i,              reason: 'User requesting planning guidance' },
  { re: /\b(how (should|do|would) (i|we|you) (structure|design|architect|model))\b/i,  reason: 'User asking how to design their backend' },
  { re: /\b(what (tables?|schema|architecture|structure|design|approach) (should|would|do))\b/i, reason: 'Schema/architecture design question' },
  { re: /\b(recommend|advice|suggest|best practice|best way|best approach)\b.*\?/i,   reason: 'User asking for recommendations' },
  { re: /\b(not sure|unsure|don'?t know|confused|unclear)\b/i,                        reason: 'User expressing uncertainty — needs clarification' },
  { re: /\b(thinking (of|about)|considering|planning (to|on))\b/i,                    reason: 'User in planning/thinking phase' },
  // Open-ended question starters — broadened to match how users actually phrase questions.
  // Previously this only caught what/how/which/where/why/should/could/would/can.
  // "does any other integration needed?" / "is auth required?" / "do I need X?" were
  // missed and fell through to build-mode default, causing the AI to build unrequested
  // resources. Now also catches: is/are/do/does/did/will/have/has/had/any/am/were/may/might.
  { re: /^(what|how|which|where|why|should|could|would|can|is|are|do|does|did|will|have|has|had|any|am|were|may|might)\b[\s\S]{0,120}\?$/i, reason: 'Open-ended question without a build action' },
  // Production-readiness / needs-assessment questions — these are CONSULTATIVE,
  // never build commands. "is X needed for production?", "what do I need for prod?",
  // "any other X needed?", "anything else needed?" — all map to plan mode.
  { re: /\b(is|are|does|do)\s+(it|this|that|there|any|anything|something|enough)?\s*(other\s+|more\s+|else\s+)?\w*\s*(needed|required|necessary|missing|recommended)\b.*\??/i, reason: 'Needs/requirements question — needs assessment, not build' },
  { re: /\b(production[- ]grade|production[- ]ready|prod[- ]ready|launch[- ]ready)\b.{0,80}\?/i, reason: 'Production-readiness question — consultative, not build' },
  { re: /\b(what\s+(else|other|all|more)\s+(do|should|would|could)\s+(i|we)\s+(need|require|add|include))/i, reason: 'What-else-do-I-need question — consultative' },
  { re: /\b(do|does)\s+(i|we|the (app|backend|platform|project))\s+(need|require)\b/i, reason: 'Do I need question — needs assessment' },
  { re: /\b(needed|required|necessary|missing)\s+(for|to)\s+\w+\??$/i,                reason: 'X-needed-for-Y question — consultative' },
  // Phase 11 — Research-aware Plan mode
  { re: /\bcheck how\s+\w+\s+(works?|is built|handles|manages)\b/i,                   reason: 'Competitor research request — force Plan mode' },
  { re: /\b(like|similar to|inspired by|based on)\s+(amazon|coupang|shopify|uber|airbnb|twitter|instagram|stripe|alibaba|ebay|etsy|doordash|lyft|booking\.com)\b/i, reason: 'Named platform reference — force Plan mode for clarification' },
  { re: /\bbuild (it |this )?(like|based on|according to|similar to|inspired by)\b/i,  reason: 'Build-like-platform — clarification needed before build' },
  { re: /\b(industry[- ]standard|standard ecommerce|typical ecommerce|standard marketplace)\b/i, reason: 'Vague industry-standard request — needs domain confirmation' },
  { re: /\bhow (amazon|coupang|shopify|uber|airbnb|twitter|instagram|stripe) (works?|is built|handles)\b/i, reason: 'How-platform-works — research intent, force Plan mode' },
  { re: /\b(check|look at|research|follow)\s+how\s+\w+\s+(does|handles|works?|builds?|manages?)\b/i, reason: 'Research instruction — force Plan mode' },
  { re: /\baccording to (those|these|similar|competitor|that) (platform|app|site|company)\b/i, reason: 'Build-according-to-competitor — clarification needed' },
]

// ── Build Mode fast-path signals ──────────────────────────────────────────────

const BUILD_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /^(add|create|build|make|generate|implement|setup|set up|enable|configure|scaffold)\b/i, reason: 'Direct create/build command' },
  { re: /^(list|show|check|verify|view|display|get|fetch|describe)\b/i,               reason: 'Inspect/read operation' },
  { re: /^(continue|modify|update|change|edit|delete|remove|drop|fix|repair|alter)\b/i, reason: 'Modify/continue operation' },
  { re: /\b(i want|i need|i'?d like|give me|please (add|create|build|make|generate))\b/i, reason: 'User-initiated build request' },
  { re: /\b(add|create|build|make|generate)\b.{0,60}\b(table|api|endpoint|auth|storage|bucket|function|trigger|webhook|cron)\b/i, reason: 'Build request targeting a backend resource' },
]

// ── Fast classifier (no LLM) ──────────────────────────────────────────────────

function fastClassify(message: string): ModeClassification | null {
  const trimmed = message.trim()

  // Phase 5 continuation triggers — always route to build even if very short
  if (/^(implement|proceed|continue|do it|build it|apply|run it|execute)[\s!.,]*$/i.test(trimmed)) {
    return { mode: 'build', reason: 'Phase 5 continuation trigger — sticky context binding' }
  }

  // Conversation patterns checked FIRST — advisory/discussion signals override the broad
  // "^should/would/can" plan catch-all. "Should I use microservices?" is conversation,
  // not a schema planning question. Named-platform PLAN patterns are still checked before
  // the bare ^create BUILD pattern fires, so "create an ecommerce backend similar to Amazon"
  // still correctly hits PLAN mode.
  for (const { re, reason } of CONVERSATION_PATTERNS) {
    if (re.test(trimmed)) return { mode: 'conversation', reason }
  }

  // Plan patterns — architectural guidance, named platforms, open-ended "what should I build"
  for (const { re, reason } of PLAN_PATTERNS) {
    if (re.test(trimmed)) return { mode: 'plan', reason }
  }

  // Build patterns — direct action commands targeting backend resources
  for (const { re, reason } of BUILD_PATTERNS) {
    if (re.test(trimmed)) return { mode: 'build', reason }
  }

  // Very short message with no recognisable action → ask to clarify
  if (trimmed.length < 15) {
    return { mode: 'plan', reason: 'Request is too brief to act on — needs clarification' }
  }

  return null // hand off to LLM
}

// ── LLM classifier ────────────────────────────────────────────────────────────

async function llmClassify(message: string): Promise<ModeClassification> {
  try {
    const openai = getOpenAIClient()
    const response = await openai.chat.completions.create({
      model: getModel('classify'),
      messages: [
        {
          role: 'system',
          content: `You are a mode classifier for Backenly, an AI Backend-as-a-Service platform.

Classify the user's message into EXACTLY ONE mode:

- "plan"         → The request is unclear, user wants architecture/schema advice, wants to think before building, or needs clarification.
- "build"        → User wants to create, add, implement, check, list, verify, continue, or modify a backend resource RIGHT NOW.
- "conversation" → User wants a discussion or explanation: "should I use JWT or OAuth?", "explain how X works", "what do you think about my schema?", "what are the tradeoffs?", "tell me about X", advisory/opinion requests.

RULES (apply in order):
1. **Build mode requires an IMPERATIVE CONSTRUCTION VERB** as the leading clause. Only these qualify: add, create, build, make, generate, implement, set up, setup, configure, scaffold, enable, install, deploy, modify, update, change, edit, delete, remove, drop, fix, repair, alter, list, show, check, verify, view, display, get, fetch, describe, continue, proceed, apply, run, execute.
2. **Questions are NEVER build mode** — even if they mention backend resources by name. Specifically: any message that ends in "?" and begins with is/are/do/does/did/will/would/can/could/should/what/how/which/where/why/have/has/had/any/am/were is plan or conversation.
3. **"Is X needed?" / "do I need X?" / "production grade?" / "production ready?" / "what else do I need?" → ALWAYS plan mode.** These are consultative needs-assessments, not build commands. Even if the message lists integrations like "Payments / Stripe / PostHog", classify as plan when the surrounding context is a question about whether they are required.
4. **Comparative/opinion questions** ("should I use JWT vs OAuth", "tradeoffs", "pros and cons", "what's your opinion", "tell me how X works") → conversation mode.
5. **Imperative commands** ("add a users table", "create posts endpoint", "remove the email column", "show my tables") → build mode.
6. **When ambiguous, default to plan**. Accidentally building an unrequested resource is a worse failure than asking the user to clarify.

CRITICAL EXAMPLES (use these to calibrate):
- "does any other integration features needed for making the social media backend production grade??" → plan (needs assessment, not build)
- "is auth required for my app?" → plan
- "do I need to add stripe?" → plan
- "what else should I add for production?" → plan
- "add stripe payments" → build
- "i want to add subscriptions" → build
- "should I use JWT or sessions?" → conversation
- "tell me about RLS" → conversation

Respond ONLY with valid JSON:
{"mode": "plan" | "build" | "conversation", "reason": "One sentence explanation"}`,
        },
        { role: 'user', content: `Classify: "${message}"` },
      ],
      temperature: 0.1,
      max_tokens: 80,
      response_format: { type: 'json_object' },
    })

    const raw = response.choices[0].message.content || '{}'
    const parsed = JSON.parse(raw)
    const mode: ChatMode = parsed.mode === 'build' ? 'build'
      : parsed.mode === 'conversation' ? 'conversation'
      : 'plan'
    return { mode, reason: String(parsed.reason || '') }
  } catch {
    // Safe default — prefer plan (clarification) over accidentally executing
    return { mode: 'plan', reason: 'Classifier unavailable — defaulting to plan mode' }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify a message as Plan or Build mode.
 * Uses fast keyword matching, falls back to LLM only when ambiguous.
 */
export async function classifyMode(message: string): Promise<ModeClassification> {
  const fast = fastClassify(message)
  if (fast) {
    console.log(`[ModeClassifier] fast=${fast.mode} reason="${fast.reason}"`)
    return fast
  }
  const llm = await llmClassify(message)
  console.log(`[ModeClassifier] llm=${llm.mode} reason="${llm.reason}"`)
  return llm
}

/**
 * Detect consultative/advisory requests that should be forced to Plan or
 * Conversation mode even when the client sends mode='build'.
 *
 * These are messages where the user wants explanation, opinion, or guidance —
 * not immediate execution. Executing them as build actions produces wrong
 * output (e.g. hallucinating "products table" on a social-media backend
 * because the user asked "is anything needed for production?").
 *
 * The check is BROAD by design — false positives just route to a clarifying
 * conversation, which is recoverable. False negatives produce destructive
 * builds the user did not ask for, which are NOT recoverable in chat.
 */
export function detectConsultMode(message: string): boolean {
  const trimmed = message.trim()

  // Pattern 1 — explicit consultative language
  if (
    /\b(explain|walk me through|tell me (about|how|why)|help me understand)\b/i.test(trimmed) ||
    /\b(what do you think|what'?s your (opinion|take|recommendation|view))\b/i.test(trimmed) ||
    /\b(should i|would you (recommend|suggest|use)|which is better|pros and cons|trade.?offs?)\b/i.test(trimmed) ||
    /\b(how would you approach|best practices for|guidance on|thoughts on|opinion on)\b/i.test(trimmed) ||
    /\b(compare|vs\.?|versus|difference between)\b.{0,50}\b(approach|option|solution|way|method)\b/i.test(trimmed) ||
    /\b(advise me|consult|consultation)\b/i.test(trimmed)
  ) return true

  // Pattern 2 — needs-assessment questions
  // "is X needed?", "do I need X?", "is X required?", "what do I need for prod?",
  // "any other X needed?", "anything missing?", "is this production ready?"
  if (
    /\b(is|are|does|do)\s+(it|this|that|there|any|anything|something|enough)?\s*(other\s+|more\s+|else\s+)?\w*\s*(needed|required|necessary|missing|recommended|sufficient)\b/i.test(trimmed) ||
    /\b(production[- ]grade|production[- ]ready|prod[- ]ready|launch[- ]ready|launch[- ]grade)\b/i.test(trimmed) ||
    /\b(what\s+(else|other|all|more)\s+(do|should|would|could)\s+(i|we)\s+(need|require|add|include))/i.test(trimmed) ||
    /\b(do|does)\s+(i|we|the (app|backend|platform|project))\s+(need|require)\b/i.test(trimmed) ||
    /\b(needed|required|necessary|missing)\s+(for|to)\s+\w+\??$/i.test(trimmed)
  ) return true

  // Pattern 3 — bare question form. Any message that ENDS WITH `?` and
  // starts with a question word is consultative by default. We exclude
  // direct imperatives like "create X?" by requiring the opening word to be
  // a true question starter, not a construction verb.
  if (
    /\?$/.test(trimmed) &&
    /^(is|are|do|does|did|will|would|can|could|should|what|how|which|where|why|have|has|had|any|am|were|may|might)\b/i.test(trimmed)
  ) return true

  return false
}

// ── Plan Response types ───────────────────────────────────────────────────────

export interface PlanResponse {
  /** Full formatted message for display */
  message: string
  /** High-level architecture description (tables, relationships, APIs) */
  proposed_architecture: string | null
  /** Ordered list of steps to implement the plan */
  required_steps: string[] | null
  /** Inputs the user must provide before building can start */
  missing_inputs: string[] | null
}

// ── Fallback plan response ────────────────────────────────────────────────────

const FALLBACK_PLAN: PlanResponse = {
  message: "Describe your backend requirements (tables, auth, APIs, integrations) and I'll design the architecture.",
  proposed_architecture: null,
  required_steps: null,
  missing_inputs: ['Backend requirements not specified'],
}

// ── Plan response parser ──────────────────────────────────────────────────────

function parsePlanResponse(raw: string): PlanResponse {
  try {
    const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1])
      const architecture: string | null = parsed.proposed_architecture || null
      const steps: string[] | null = Array.isArray(parsed.required_steps) ? parsed.required_steps : null
      const missing: string[] | null = Array.isArray(parsed.missing_inputs) && parsed.missing_inputs.length > 0
        ? parsed.missing_inputs
        : null

      // Build human-readable message from the structured parts
      const parts: string[] = []
      if (architecture) parts.push(`**Architecture:** ${architecture}`)
      if (steps?.length) parts.push(`**Steps:**\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
      if (missing?.length) parts.push(`**To start building:**\n${missing.map(m => `— ${m}`).join('\n')}`)

      const hasContent = parts.length > 0
      if (!hasContent) return FALLBACK_PLAN

      const suffix = missing?.length
        ? `\nProvide the above, then say **"build it"**.`
        : `\nSay **"build it"** to start.`

      return {
        message: parts.join('\n\n') + suffix,
        proposed_architecture: architecture,
        required_steps: steps,
        missing_inputs: missing,
      }
    }
  } catch {
    // Fall through to text-based response
  }

  // No JSON found — wrap raw text and return with no structured fields
  return {
    message: raw,
    proposed_architecture: null,
    required_steps: null,
    missing_inputs: null,
  }
}

// Advisory questions that need prose, not a schema planning card
const ADVISORY_RE = /\b(should (i|we) use|should (i|we) (build|make|go with|choose)|which (is|would be) better|pros and cons|trade.?offs?|microservices|monolith|what do you (think|recommend)|what'?s your (opinion|take|recommendation)|is it worth|do i need|do i really need|difference between)\b/i

/**
 * Generate a Plan Mode response — architecture advice, clarifying questions,
 * or a proposed schema outline. Never executes any backend operations.
 *
 * For advisory/opinion questions ("should I use microservices?") responds with
 * direct conversational prose. For schema/build planning questions responds with
 * the structured JSON card (architecture, steps, missing inputs).
 */
export async function generatePlanResponse(
  message: string,
  schemaContext: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<PlanResponse> {
  try {
    const openai = getOpenAIClient()
    const schemaBlock = schemaContext?.trim()
      ? `\n\nExisting schema:\n${schemaContext.slice(0, 1200)}`
      : ''

    const historyMessages = history.slice(-6).map(h => ({
      role: h.role as 'user' | 'assistant',
      content: h.content,
    }))

    const isAdvisory = ADVISORY_RE.test(message)

    if (isAdvisory) {
      // Conversational response — direct prose, no rigid JSON card
      const response = await openai.chat.completions.create({
        model: getModel('respond'),
        messages: [
          {
            role: 'system',
            content: `You are a senior backend architect advising a developer on their Backenly project.

Answer the question directly and specifically — like a senior engineer talking to a colleague.
NEVER start with filler like "Great!", "Sure!", "Absolutely!".
Maximum 5 sentences. Give your actual recommendation, not a list of options.
End with one concrete next step (e.g. "Say 'build it' to start" or "Say 'add stripe' to add payments").${schemaBlock}`,
          },
          ...historyMessages,
          { role: 'user', content: message },
        ],
        temperature: 0.4,
        max_tokens: 300,
      })
      const prose = response.choices[0].message.content?.trim() || ''
      return {
        message: prose || FALLBACK_PLAN.message,
        proposed_architecture: null,
        required_steps: null,
        missing_inputs: null,
      }
    }

    // Structured schema/build planning response
    const response = await openai.chat.completions.create({
      model: getModel('respond'),
      messages: [
        {
          role: 'system',
          content: `You are a senior backend architect helping a developer plan their Backenly project.

You are in PLAN MODE — your job is to THINK, not build. Never create tables, enable auth, generate APIs, or trigger deployments.

NEVER start with filler phrases like "Great!", "Absolutely!", "Sure!", "Of course!", "Certainly!" — answer directly.

Always respond with a JSON object in this exact format:
{
  "proposed_architecture": "Description of tables, relationships, and API structure. Null if the request is too vague to propose anything yet.",
  "required_steps": ["Step 1 description", "Step 2 description", ...],
  "missing_inputs": ["Question or input needed before building can start", ...]
}

Rules:
- proposed_architecture: Describe tables (with key columns), relationships, and API endpoints. Be concrete. Null only if you cannot propose anything without more info.
- required_steps: Ordered list of implementation steps (e.g. "Create users table with email/password", "Generate CRUD API for posts"). Empty array [] if missing inputs prevent planning.
- missing_inputs: Questions the user must answer before building. Empty array [] if you have enough info to propose a full plan.
- If the request is unclear, focus on missing_inputs with 1–3 targeted questions and leave required_steps empty.
- Do NOT wrap in markdown code fences — return raw JSON only.${schemaBlock}`,
        },
        ...historyMessages,
        { role: 'user', content: message },
      ],
      temperature: 0.3,
      max_tokens: 700,
      response_format: { type: 'json_object' },
    })

    const raw = response.choices[0].message.content?.trim() || ''
    return parsePlanResponse(raw)
  } catch {
    return FALLBACK_PLAN
  }
}
