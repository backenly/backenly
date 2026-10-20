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

import { AiError, generate } from '../llm'
import { conversationFor } from './model'
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
  /** The project the turn is for: its usage log records the call. */
  projectId?: string
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

/**
 * The classification's shape, as structured output: where the provider
 * enforces it, the intent is one of the known values and every field is
 * present, so a reply can only fail to parse by being cut off.
 */
const CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'confidence', 'reasoning'],
  properties: {
    intent: { type: 'string', enum: [...VALID_INTENTS] },
    confidence: { type: 'number' },
    reasoning: { type: 'string' },
  },
}

/**
 * Classify one message.
 *
 * Throws the gateway's AiError when the provider could not answer: no model is
 * configured, it is out of quota, rate-limited, or timed out. Every later step
 * of the turn needs the same provider, so the caller stops and says why. This
 * used to come back as UNCLEAR, which made the turn ask the user a clarifying
 * question about a perfectly clear message. Only an answer that arrived but
 * cannot be read falls back to UNCLEAR.
 */
export async function classify(ctx: ClassifierContext): Promise<Classification> {
  const contextLines: string[] = []
  if (ctx.hasPendingPlan) contextLines.push('CONTEXT: a plan was proposed in the previous AI turn and is awaiting user confirmation.')
  if (ctx.hasPendingProposal) contextLines.push('CONTEXT: a Proposal (recommendation list) is active and may be applied.')
  if (ctx.isFreshProject) contextLines.push('CONTEXT: this project is brand new — nothing has been built yet, and the user most likely just arrived from the "describe your backend" box. If this message describes an app, a product, or what its users can do, it is a BUILD request — not a QUESTION and not UNCLEAR.')

  const recent = (ctx.recentHistory ?? []).slice(-4).map((turn) => ({
    role: turn.role,
    content: turn.content.length > 600 ? turn.content.slice(0, 600) + '…' : turn.content,
  }))

  let parsed: { intent?: unknown; confidence?: unknown; reasoning?: unknown } | null
  try {
    const reply = await generate({
      purpose: 'brain.classify',
      system: classifierPrompt(),
      ...(contextLines.length ? { context: contextLines.join('\n') } : {}),
      messages: conversationFor(recent, ctx.message),
      jsonSchema: CLASSIFICATION_SCHEMA,
      maxTokens: 400,
      billing: { projectId: ctx.projectId },
      label: 'brain-classify',
    })
    parsed = reply.json && typeof reply.json === 'object' ? (reply.json as typeof parsed) : null
  } catch (err) {
    if (err instanceof AiError && err.kind !== 'output_invalid') throw err
    console.error('[BrainClassifier] classification could not be read:', err)
    parsed = null
  }

  if (!parsed) {
    return {
      intent: 'UNCLEAR',
      confidence: 0,
      reasoning: 'classifier answer could not be read — defaulting to UNCLEAR',
    }
  }

  // OpenAI is sent the schema with strict: false, so it does not enforce it:
  // "build" or a confidence of "0.92" can still arrive, and read strictly,
  // either one turned a clear request into a clarifying question.
  const named = String(parsed.intent ?? '').trim().toUpperCase()
  let intent: BrainIntent = (VALID_INTENTS as readonly string[]).includes(named)
    ? (named as BrainIntent)
    : 'UNCLEAR'

  const stated = Number(parsed.confidence)
  const confidence = Number.isFinite(stated) ? Math.max(0, Math.min(1, stated)) : 0
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

/** Convenience: should this intent go to the answerer path (no tools)? */
export function isAnswererIntent(intent: BrainIntent): boolean {
  return intent === 'CHAT'
}

/** Convenience: should the brain immediately ask a clarifying question? */
export function isClarifyIntent(intent: BrainIntent): boolean {
  return intent === 'UNCLEAR'
}
