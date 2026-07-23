/**
 * MULTI-MODEL LLM ROUTER (#11)
 * ==============================
 * Routes each AI task to the cheapest model that can handle it reliably.
 *
 * Fast model (gpt-4o-mini):   classify, summarize, self-correct, simple Q&A
 * Smart model (gpt-4o):       intent graph planning, conversational responses
 *
 * Set OPENAI_MODEL_FAST and OPENAI_MODEL in your .env to override defaults.
 * Typical cost savings: 5-10x cheaper for fast tasks, no quality loss.
 */

export type ModelTask =
  | 'classify'    // Intent classification — runs on every message, must be cheap
  | 'summarize'   // Conversation summarization — bulk text, cheap model fine
  | 'correct'     // Error self-correction — short reasoning, cheap model fine
  | 'conflict'    // Conflict detection — structured check, cheap model fine
  | 'plan'        // Intent graph building — complex multi-entity reasoning, needs smart model
  | 'respond'     // Conversational response — needs coherent context, smart model

const FAST_DEFAULT = 'gpt-4o-mini'
const SMART_DEFAULT = 'gpt-4.1'

/**
 * Return the model name for a given task type.
 * Respects OPENAI_MODEL_FAST and OPENAI_MODEL env vars.
 */
export function getModel(task: ModelTask): string {
  const fast = process.env.OPENAI_MODEL_FAST || FAST_DEFAULT
  const smart = process.env.OPENAI_MODEL || SMART_DEFAULT

  switch (task) {
    case 'classify':
    case 'summarize':
    case 'correct':
    case 'conflict':
      return fast
    case 'plan':
    case 'respond':
      return smart
    default:
      return smart
  }
}

/**
 * Estimate rough complexity of a user request to assist routing.
 * Returns 'simple' for single-entity requests, 'complex' for multi-entity.
 */
export function estimateComplexity(message: string): 'simple' | 'complex' {
  const lower = message.toLowerCase()

  // Indicators of complex multi-entity requests
  const complexPatterns = [
    /\band\b.*\band\b/,           // "X and Y and Z"
    /\bwith\b.*\band\b/,          // "X with Y and Z"
    /saas|multi.?tenant|organiz/,  // SaaS patterns always complex
    /dashboard|platform|marketplace/, // Platform apps complex
  ]

  if (complexPatterns.some(p => p.test(lower))) return 'complex'

  // Count entity-like nouns (rough heuristic: words not in common stop-list)
  const entityHints = lower.match(/\b(table|entity|model|users?|orders?|products?|posts?|comments?|tasks?|projects?|teams?|orgs?|channels?|messages?|reviews?|payments?)\b/g)
  if (entityHints && entityHints.length >= 3) return 'complex'

  return 'simple'
}
