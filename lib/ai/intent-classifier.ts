/**
 * INTENT CLASSIFIER  *(legacy — superseded by lib/ai/intent-router.ts)*
 * =====================================================================
 * LLM-based intent gate that runs BEFORE the task planner.
 * Prevents capability questions, general chat, and clarifications
 * from being misrouted into the build pipeline.
 *
 * Intent types:
 *  - build        → user wants to create/generate backend resources
 *  - evaluate     → user asking whether the current project state is sufficient for a purpose
 *  - question     → user asking about platform capabilities, features, or how something works
 *  - clarification → refining or following up on a previous request
 *  - chat         → general conversation, greetings, thanks
 *
 * MIGRATION NOTE (Move 5):
 *   New chat-pipeline code should call `classifyIntent` from
 *   `lib/ai/intent-router.ts`, which uses a finer-grained typed taxonomy
 *   and is the single canonical signal populated on `ctx.intent`.
 *   This module is preserved because:
 *     - `app/api/projects/[id]/execute/route.ts` still calls it directly.
 *     - `mode-classifier-stage.ts` uses its `handleNonBuildIntent` helper.
 *   Migrate one call site at a time, then remove this file.
 */

import { getOpenAIClient } from './openai-service'
import { getModel } from './model-router'

export type IntentType = 'build' | 'evaluate' | 'question' | 'clarification' | 'chat'

export interface ClassifiedIntent {
  intent: IntentType
  confidence: number
  reasoning: string
}

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'ai'
  content: string
}

// Fast keyword-based pre-check — catches obvious non-build phrases
// without spending an LLM call
function fastNonBuildCheck(lower: string): IntentType | null {
  // Evaluation questions about current project state: "is this enough?", "is this ready?"
  // These MUST be caught before fastBuildCheck sees words like "production", "backend", "saas"
  if (/\b(is this enough|is this ready|is this sufficient|does this cover|will this work|what('s| is) missing|is there anything|am i missing|do i need anything|what else (do i|should i)|anything else (i|to)|is this production.ready)\b/i.test(lower)) {
    return 'evaluate'
  }

  // "this" + question mark + assessment word = evaluating current state
  if (
    /\bthis\b/.test(lower) &&
    /\?/.test(lower) &&
    /\b(enough|ready|sufficient|complete|good|fine|ok|okay|missing|lacking|need|production|scalable|work for|handle)\b/i.test(lower)
  ) {
    return 'evaluate'
  }

  // Capability questions: "can you X", "are you able to", "do you support", "is it possible"
  // Guard: if the prompt also contains a clear action verb + backend resource type, it's a
  // BUILD request phrased as a question ("can you delete the uploads bucket?"), not a
  // capability inquiry. Only classify as question when no actionable target is present.
  if (
    /\b(can you|are you able|do you support|is it possible|do you have|does backenly|will you|you able to)\b/.test(lower) &&
    /\?/.test(lower) &&
    !/\b(delete|remove|drop|add|create|build|generate|enable|disable|rotate|revoke|rename|alter|make|set up|connect|integrate)\b.{0,60}\b(table|bucket|storage|api|endpoint|auth|function|trigger|column|field|key|role|permission)\b/i.test(lower)
  ) {
    return 'question'
  }

  // How-do-I questions: "how do I authenticate users?", "how do I structure this?"
  // These are information requests, NOT build requests — even though they mention backend concepts.
  if (
    /\bhow (do|can|should|would|does|did) (i|we|you|this|it|one)\b.{0,80}\?$/i.test(lower) ||
    /\bhow (to|do you) (add|use|implement|set up|configure|connect|enable|disable|handle|manage)\b/i.test(lower)
  ) {
    return 'question'
  }

  // What-is / what-are concept questions
  if (
    /\bwhat (is|are) (a |an |the )?(difference|benefit|advantage|downside|tradeoff|best practice|common|typical|standard)\b/i.test(lower) &&
    /\?/.test(lower)
  ) {
    return 'question'
  }

  // Pure greetings/thanks
  if (/^(hi|hello|hey|thanks|thank you|cheers|great|awesome|cool|nice|ok|okay|sure|got it)[.!?\s]*$/.test(lower.trim())) {
    return 'chat'
  }

  return null // needs LLM classification
}

// Fast build detection — catches obvious build requests before LLM call
// Prevents "add auth", "add google auth", "implement Resend" from being misclassified
function fastBuildCheck(lower: string): boolean {
  // "add/implement/enable/... X" where X is a backend concept or known integration
  // Note: no ^ anchor so it works mid-sentence ("also implement Resend", "now add stripe")
  if (/\b(add|enable|setup|set up|activate|create|build|generate|implement|use|connect|integrate)\s+(auth|authentication|google\s*auth|github\s*auth|oauth|oauth2|jwt|login|signup|sign.?up|sign.?in|storage|bucket|file.?upload|realtime|real.?time|websocket|webhook|cron|trigger|payment|stripe|email|resend|sendgrid|twilio|cloudinary|pusher|openai|anthropic)\b/i.test(lower)) {
    return true
  }
  // "add X table", "create X table", "build X"
  if (/^(add|create|build|make|generate|implement)\s+(a\s+|an\s+)?\w+(\s+(table|api|endpoint|bucket|function))?\s*$/i.test(lower) && lower.split(' ').length <= 6) {
    return true
  }
  // Destructive mutations — "remove/delete/drop [the] X [table/api]", "confirm delete X"
  if (/\b(remove|delete|drop)\s+(?:the\s+)?\w+(?:\s+(?:table|collection|api[s]?|endpoint[s]?))?/i.test(lower)) {
    return true
  }
  // Two-step confirmation: "confirm delete X", "confirm drop X"
  if (/^(?:confirm|yes,?\s+delete|yes,?\s+drop)\s+\w+/i.test(lower)) {
    return true
  }
  // API key management — "rotate/revoke/regenerate [my/the] [api] key"
  if (/\b(rotate|revoke|regenerate|invalidate)\s+(?:my\s+|the\s+|an?\s+)?(?:api\s+)?key[s]?\b/i.test(lower)) {
    return true
  }
  // Schema mutations — "rename column X to Y", "change/alter column type", "add constraint"
  if (/\b(rename|alter|change)\s+(?:the\s+)?\w+\s+(?:column|field|type)\b/i.test(lower)) {
    return true
  }
  if (/\b(add|create)\s+(?:a\s+)?(?:unique\s+|foreign\s+key\s+|check\s+|not.null\s+)?constraint\b/i.test(lower)) {
    return true
  }
  if (/\bchange\s+(?:the\s+)?(?:type|column\s+type)\s+of\b/i.test(lower)) {
    return true
  }
  // Trigger / function / cron / permission deletion
  if (/\b(delete|remove|drop)\s+(?:the\s+)?(?:trigger|function|cron\s*job|scheduled\s+job|permission\s+rule|rls\s+rule|integration\s+key)\b/i.test(lower)) {
    return true
  }
  // User management — "block user X", "reset password for X"
  if (/\b(block|suspend|ban|disable)\s+(?:user|account)\b/i.test(lower)) {
    return true
  }
  if (/\breset\s+(?:the\s+)?password\b/i.test(lower)) {
    return true
  }
  // Key permissions, rate limits, alerts
  if (/\bset\s+(?:key\s+)?permissions?\b|\bset\s+rate\s+limit\b|\bset\s+(?:an?\s+)?alert\b/i.test(lower)) {
    return true
  }
  // "integrate/connect/link google|github|stripe|resend|..."
  if (/\b(integrate|connect|link|implement)\s+(google|github|stripe|resend|sendgrid|twilio|firebase|supabase|cloudinary|pusher|openai|anthropic)\b/i.test(lower)) {
    return true
  }
  // Storage bucket operations — "delete/remove/drop [the/a/one] [NAME] bucket"
  if (/\b(delete|remove|drop)\s+(?:the\s+|a\s+|one\s+|my\s+|an?\s+)?(?:[a-zA-Z0-9_-]+\s+)?bucket\b/i.test(lower)) {
    return true
  }
  if (/\b(create|add|set\s+up)\s+(?:a\s+|an?\s+)?(?:[a-zA-Z0-9_-]+\s+)?bucket\b/i.test(lower)) {
    return true
  }
  if (/\b(make|set)\s+(?:the\s+)?(?:[a-zA-Z0-9_-]+\s+)?bucket\s+(?:public|private)\b/i.test(lower)) {
    return true
  }
  // Function operations
  if (/\b(create|add|delete|remove|test)\s+(?:a\s+|an?\s+)?(?:serverless\s+|ai\s+)?function\b/i.test(lower)) {
    return true
  }
  // Realtime operations
  if (/\b(enable|disable|add|remove)\s+realtime\b|\benable\s+(?:live\s+)?updates?\b/i.test(lower)) {
    return true
  }
  // Role / permission operations
  if (/\b(add|create|remove|delete)\s+(?:a\s+|an?\s+)?(?:admin\s+|user\s+)?role\b/i.test(lower)) {
    return true
  }
  if (/\b(add|create|enforce|enable)\s+(?:row.?level\s+security|rls|permission[s]?|access\s+control)\b/i.test(lower)) {
    return true
  }
  return false
}

/**
 * Classify user intent via LLM.
 * Returns 'build' only when the user is genuinely requesting backend construction.
 * Pass recentHistory (last 2-3 turns) for context-aware classification of
 * follow-up messages like "is this enough?" that reference what was just built.
 */
export async function classifyIntent(
  prompt: string,
  recentHistory?: ConversationTurn[],
): Promise<ClassifiedIntent> {
  const lower = prompt.toLowerCase().trim()

  // Fast path — no LLM needed for obvious cases
  const fast = fastNonBuildCheck(lower)
  if (fast) {
    return { intent: fast, confidence: 0.95, reasoning: 'Matched fast keyword pattern' }
  }

  // Fast build path — obvious build commands bypass LLM to avoid misclassification
  if (fastBuildCheck(lower)) {
    return { intent: 'build', confidence: 0.95, reasoning: 'Matched fast build pattern' }
  }

  try {
    const openai = getOpenAIClient()

    // Build conversation context block so the LLM understands "this" references
    let contextBlock = ''
    if (recentHistory && recentHistory.length > 0) {
      const turns = recentHistory.slice(-3).map(t => {
        const role = t.role === 'ai' ? 'assistant' : t.role
        const snippet = t.content.substring(0, 300)
        return `[${role}]: ${snippet}`
      }).join('\n')
      contextBlock = `\n\nRecent conversation context:\n${turns}\n\nThe user's new message refers to the above. Use this context to classify correctly.`
    }

    const response = await openai.chat.completions.create({
      model: getModel('classify'),
      messages: [
        {
          role: 'system',
          content: `You are an intent classifier for Backenly, an AI Backend-as-a-Service platform.

Classify the user's message into EXACTLY ONE of these intents:

- "build"         → User is requesting ANY backend change: create, modify, delete, rename, rotate, revoke, block, alter, configure, or manage backend resources (tables, APIs, auth, storage, keys, triggers, functions, permissions, etc.)
- "evaluate"      → User is asking whether the CURRENT project state is sufficient, ready, or missing anything for a specific purpose (e.g. "is this enough for a video SaaS?", "what's missing for production?", "will this handle 10k users?")
- "question"      → User is asking about platform capabilities, features, or how something works — NOT requesting a change and NOT evaluating current state
- "clarification" → User is refining, adjusting, or following up on a PREVIOUS build request in the conversation
- "chat"          → General conversation, greetings, compliments, acknowledgements

CRITICAL RULES:
1. "Is this [enough/ready/sufficient] for X?" = EVALUATE — never build. The user is assessing what exists.
2. "What's missing for X?", "am I missing anything?", "what else do I need?" = EVALUATE
3. "Is this production-ready?", "will this scale?", "does this cover all cases?" = EVALUATE
4. A message with "?" that contains action words like "build", "create", "generate" is almost always a QUESTION about capability, NOT a build request — unless it also has a clear subject to build
5. "so you can build X?" = QUESTION (capability inquiry)
6. "build me X" or "create X" or "I want X" = BUILD
7. "add auth", "add google auth", "add github auth", "add storage", "add realtime", "enable auth" = BUILD
8. "auth added?", "did you add auth?", "is auth enabled?" = QUESTION (status check)
9. NEVER classify "add X" or "enable X" where X is a feature as CLARIFICATION — it is always BUILD
10. "implement Resend", "implement Stripe", "implement SendGrid" = BUILD
11. "implement X also", "also add X", "now set up X" = BUILD — continuation build requests are always BUILD
12. If conversation context shows the AI just built something and the user asks "is this enough?" → EVALUATE
13. "rotate/revoke/regenerate API key" = BUILD — it's a key management action
14. "rename column X to Y", "change column type", "alter column", "add constraint" = BUILD — schema mutations
15. "delete trigger X", "remove function X", "delete cron job" = BUILD — resource deletion
16. "block user X", "reset password for X" = BUILD — user management
17. "set permissions on key", "set rate limit", "set alert" = BUILD — configuration change
18. "remove X", "delete X", "drop X" where X is any backend resource = BUILD
19. "delete [a/one/the] bucket", "can you delete a bucket?" = BUILD — storage deletion even when target is vague
20. "create [NAME] bucket", "make bucket public/private" = BUILD
21. "add a role", "create admin role", "enable RLS" = BUILD
22. "can you delete/remove/add/create/enable [resource]?" = BUILD — capability-phrased action requests are always BUILD, not questions${contextBlock}

Respond ONLY with valid JSON:
{
  "intent": "build" | "evaluate" | "question" | "clarification" | "chat",
  "confidence": 0.0–1.0,
  "reasoning": "One sentence explanation"
}`,
        },
        {
          role: 'user',
          content: `Classify this message: "${prompt}"`,
        },
      ],
      temperature: 0.1,
      max_tokens: 150,
      response_format: { type: 'json_object' },
    })

    const raw = response.choices[0].message.content || '{}'
    const parsed = JSON.parse(raw)

    const intent = (['build', 'evaluate', 'question', 'clarification', 'chat'].includes(parsed.intent)
      ? parsed.intent
      : 'question') as IntentType

    return {
      intent,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
      reasoning: String(parsed.reasoning || ''),
    }
  } catch (err) {
    console.error('[Intent Classifier] LLM failed, defaulting to safe question mode:', err)
    // Safe default: question mode asks for clarification rather than blindly building
    return { intent: 'question', confidence: 0.3, reasoning: 'Classifier failed — defaulting to safe question mode' }
  }
}

/**
 * Generate a conversational response for non-build intents via LLM.
 * Falls back to minimal canned copy only when the LLM call fails.
 * Never says "describe your requirements" — always answers specifically.
 */
export async function handleNonBuildIntent(
  prompt: string,
  intent: IntentType,
  recentHistory?: ConversationTurn[],
  summaryContext?: string,
): Promise<string> {
  try {
    const openai = getOpenAIClient()

    // Build conversation context — summary of older turns first, then recent raw turns.
    // This preserves continuity across long conversations (20+ messages).
    const summaryBlock = summaryContext
      ? `\n\nConversation summary (earlier turns):\n${summaryContext.slice(0, 600)}`
      : ''
    const historyBlock = recentHistory && recentHistory.length > 0
      ? '\n\nRecent conversation:\n' + recentHistory.slice(-4).map(t => {
          const role = t.role === 'ai' ? 'Backenly AI' : 'Developer'
          return `${role}: ${t.content.substring(0, 400)}`
        }).join('\n')
      : ''

    const intentInstruction =
      intent === 'clarification'
        ? 'The developer is refining a previous request. Confirm what you understood and ask the one specific thing needed to proceed.'
        : intent === 'chat'
          ? 'The developer sent a greeting or acknowledgement. Respond warmly in one sentence and invite them to describe what they want to build.'
          : intent === 'evaluate'
            ? 'The developer is asking whether their current backend is ready or sufficient for a specific purpose. Give a direct gap analysis: list what they likely have (✓) and what is typically missing (✗) for that use case. End with one concrete next step (e.g. "Say \'add stripe\' to implement payments"). Be specific — reference real Backenly features, not generic advice. Note: you do not have live schema access here, so focus on what is commonly needed for the stated purpose.'
            : 'The developer asked a capability or how-it-works question. Answer it directly and specifically. End with one concrete next step they can take.'

    const response = await openai.chat.completions.create({
      model: getModel('classify'),
      messages: [
        {
          role: 'system',
          content: `You are Backenly AI — a confident, direct backend architect AI.

Your capabilities: database tables with smart schemas, full CRUD REST APIs, JWT authentication (email + Google + GitHub OAuth), file storage with signed URLs, row-level security, event triggers (insert/update/delete/webhook), serverless AI functions, realtime subscriptions, and deployment.

Rules:
- Never say "describe your requirements" or "let me know how I can help"
- Never use marketing language or vague promises
- Answer specifically — reference actual features, not abstractions
- End every response with one concrete next step (e.g. "Say 'add stripe' to connect payments")
- Maximum 5 sentences. Be direct like a senior engineer talking to a colleague.${summaryBlock}${historyBlock}

${intentInstruction}`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.3,
      max_tokens: 250,
    })

    return response.choices[0].message.content?.trim() || fallbackNonBuildResponse(prompt, intent)
  } catch {
    return fallbackNonBuildResponse(prompt, intent)
  }
}

function fallbackNonBuildResponse(prompt: string, intent: IntentType): string {
  const lower = prompt.toLowerCase()

  if (intent === 'question') {
    if (lower.includes('production') || lower.includes('prod')) {
      return `Yes — every backend includes proper relational schema design, indexed foreign keys, full CRUD REST APIs, JWT authentication, row-level security, and scalable connection pooling out of the box.`
    }
    return `Supported: database tables, CRUD REST APIs, JWT auth (email + OAuth), file storage, row-level security, event triggers, serverless AI functions, and realtime subscriptions. Say what you want to build and I'll start immediately.`
  }

  if (intent === 'clarification') {
    return `Got it — what specifically would you like to change or add?`
  }

  return `What do you need? Describe your tables, auth flow, or any feature and I'll build it.`
}
