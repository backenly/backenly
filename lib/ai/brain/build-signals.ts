/**
 * BUILD SIGNALS
 * =============
 * Pure, dependency-free heuristics for recognising build intent from raw text.
 * Kept in a leaf module (no prisma / no openai) so it can be unit-tested in
 * isolation, exactly like blueprints/resume-routing.
 */

/** Question-opener words — a short message starting with one of these is a
 *  QUESTION/CHAT, not a description of an app to build. */
const QUESTION_OPENERS = new Set([
  'what', 'how', 'why', 'who', 'when', 'where',
  'can', 'does', 'do', 'is', 'are', 'should', 'could', 'would', 'will',
])

/**
 * Does this message read like a description of an app/product to build?
 *
 * Used ONLY as the fresh-project safety net inside the brain's UNCLEAR branch:
 * when the LLM classifier hedges on an empty project, a message that looks like
 * a real product description should reach the architect rather than a canned
 * clarification. Deliberately simple — the architect's own vagueness gate is
 * the real filter; this only screens out trivial non-descriptions ("hi",
 * "help", "make it better", a bare question) so we never hand the architect an
 * empty prompt.
 */
export function looksLikeBuildDescription(message: string): boolean {
  const text = (message ?? '').trim()
  if (text.length < 20) return false // "hi", "help", "yo" — not a description
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < 4) return false

  // A short message that is purely a question ("what can you do?", "how does
  // this work?") is a CHAT/QUESTION the classifier normally catches; if it
  // still landed here, it is not a build description.
  const firstWord = words[0].toLowerCase().replace(/[^a-z]/g, '')
  if (text.length < 60 && (text.endsWith('?') || QUESTION_OPENERS.has(firstWord))) return false

  // Anything else on a fresh project that is a real sentence is worth handing
  // to the architect — it decides buildable vs genuinely-vague, not us.
  return true
}
