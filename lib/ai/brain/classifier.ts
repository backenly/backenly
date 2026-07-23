/**
 * BRAIN CLASSIFIER
 * ================
 * A single LLM-based intent classifier that replaces the four regex
 * classifiers deleted in Phase 1. Runs ONCE per turn before the agent
 * loop and decides which path the brain takes:
 *
 *   BUILD            → agent loop, allowed to call mutation tools
 *   MODIFY           → agent loop, change-an-existing-resource bias
 *   FIX              → agent loop, repair bias
 *   DESTRUCTIVE      → agent loop, but flag for confirmation up front
 *   QUESTION         → agent loop with read-only bias (state-of-project)
 *   CHAT             → answerer path; never builds anything
 *   APPLY_PROPOSAL   → apply_proposal tool directly
 *   CONFIRM          → resume any pending plan
 *   UNCLEAR          → ask_user with a clarifying question
 *
 * The classifier defaults to UNCLEAR (NOT BUILD) on low confidence — the fix
 * for "give me competitors" being forced into BUILD. The ONE exception is a
 * brand-new project (isFreshProject): there, a low-confidence BUILD/MODIFY is
 * almost always a product description typed into "describe your backend", so
 * it is NOT demoted to UNCLEAR — the architect's own vagueness gate decides.
 * That exception is the fix for the opposite bug: a clear app description
 * ("Users can post recipes and follow each other") dead-ending in a canned
 * "could you tell me a bit more?" clarification.
 */

import { getOpenAIClient, trackCompletionCost } from '../openai-service'
import { getModel } from '../model-router'
import { classifierPrompt } from './prompts'
import type { ConversationTurn } from './memory'

export type BrainIntent =
  | 'BUILD'
  | 'MODIFY'
  | 'FIX'
  | 'DESTRUCTIVE'
  | 'QUESTION'
  | 'CHAT'
  | 'APPLY_PROPOSAL'
  | 'CONFIRM'
  | 'UNCLEAR'

export interface Classification {
  intent: BrainIntent
  confidence: number
  reasoning: string
}

export interface ClassifierContext {
  message: string
  recentHistory?: ConversationTurn[]
  /** True when there's an active Proposal waiting for "apply". */
  hasPendingProposal?: boolean
  /** True when the previous AI message proposed a plan awaiting CONFIRM. */
  hasPendingPlan?: boolean
  /**
   * True when the project is brand new — nothing has been built yet. This is
   * the single strongest disambiguator for the product's #1 input: a plain
   * description typed into the "describe your backend" box. On an empty
   * project a message that describes an app or what its users can do has
   * exactly one meaning — build it — so we must never dead-end it in a
   * clarification. Mirrors how `hasPendingPlan` disambiguates "continue".
   */
  isFreshProject?: boolean
}

/** Threshold below which we treat any classification as UNCLEAR. */
const MIN_CONFIDENCE = 0.55

const VALID_INTENTS: readonly BrainIntent[] = [
  'BUILD', 'MODIFY', 'FIX', 'DESTRUCTIVE', 'QUESTION', 'CHAT',
  'APPLY_PROPOSAL', 'CONFIRM', 'UNCLEAR',
]

export async function classify(ctx: ClassifierContext): Promise<Classification> {
  const openai = getOpenAIClient()

  const sys = classifierPrompt()
  const contextLines: string[] = []
  if (ctx.hasPendingPlan) contextLines.push('CONTEXT: a plan was proposed in the previous AI turn and is awaiting user confirmation.')
  if (ctx.hasPendingProposal) contextLines.push('CONTEXT: a Proposal (recommendation list) is active and may be applied.')
  if (ctx.isFreshProject) contextLines.push('CONTEXT: this project is brand new — nothing has been built yet, and the user most likely just arrived from the "describe your backend" box. If this message describes an app, a product, or what its users can do, it is a BUILD request — not a QUESTION and not UNCLEAR.')

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: sys },
  ]
  if (contextLines.length) messages.push({ role: 'system', content: contextLines.join('\n') })
  for (const turn of (ctx.recentHistory ?? []).slice(-4)) {
    messages.push({
      role: turn.role,
      content: turn.content.length > 600 ? turn.content.slice(0, 600) + '…' : turn.content,
    })
  }
  messages.push({ role: 'user', content: ctx.message })

  let raw: string
  try {
    const completion = await openai.chat.completions.create({
      model: getModel('classify'),
      messages,
      temperature: 0,
      max_tokens: 120,
      response_format: { type: 'json_object' },
    })
    raw = completion.choices[0]?.message?.content?.trim() ?? ''
  } catch (err) {
    console.error('[BrainClassifier] LLM call failed:', err)
    return {
      intent: 'UNCLEAR',
      confidence: 0,
      reasoning: 'classifier call failed — defaulting to UNCLEAR (asks user)',
    }
  }

  const parsed = safeParse(raw)
  if (!parsed) {
    return {
      intent: 'UNCLEAR',
      confidence: 0,
      reasoning: 'classifier returned unparseable JSON — defaulting to UNCLEAR',
    }
  }

  let intent: BrainIntent = (VALID_INTENTS as readonly string[]).includes(parsed.intent)
    ? (parsed.intent as BrainIntent)
    : 'UNCLEAR'

  const confidence = Number.isFinite(parsed.confidence) ? Math.max(0, Math.min(1, parsed.confidence)) : 0
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : ''

  // Hard floor: never trust BUILD/MODIFY/DESTRUCTIVE at low confidence — that
  // was the exact failure mode in the legacy regex classifier.
  if (confidence < MIN_CONFIDENCE && intent !== 'CHAT' && intent !== 'QUESTION') {
    // EXCEPTION: on a brand-new project, a low-confidence BUILD/MODIFY is almost
    // always a product description the user typed into "describe your backend".
    // Demoting it to UNCLEAR is the bug that made the agent reply "could you
    // tell me a bit more about…" to a perfectly clear app description. Keep the
    // build intent and let the architect's own vagueness gate ask a *contextual*
    // question if the spec genuinely can't be designed.
    const buildish = intent === 'BUILD' || intent === 'MODIFY' || intent === 'APPLY_PROPOSAL'
    if (!(ctx.isFreshProject && buildish)) {
      return {
        intent: 'UNCLEAR',
        confidence,
        reasoning: `low confidence (${confidence.toFixed(2)}) on ${intent} — promoting to UNCLEAR for safety`,
      }
    }
    return { intent, confidence, reasoning: `low confidence (${confidence.toFixed(2)}) on ${intent}, but fresh project — routing to architect instead of UNCLEAR` }
  }

  return { intent, confidence, reasoning }
}

function safeParse(raw: string): { intent?: string; confidence?: number; reasoning?: string } | null {
  if (!raw) return null
  try {
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object') return obj
  } catch {
    // Attempt to recover from prose-wrapped JSON
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) {
      try { return JSON.parse(m[0]) } catch { /* fall through */ }
    }
  }
  return null
}

/** Convenience: should this intent go to the answerer path (no tools)? */
export function isAnswererIntent(intent: BrainIntent): boolean {
  return intent === 'CHAT'
}

/** Convenience: should the brain immediately ask a clarifying question? */
export function isClarifyIntent(intent: BrainIntent): boolean {
  return intent === 'UNCLEAR'
}
