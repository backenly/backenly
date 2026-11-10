/**
 * RESUME ROUTING (pure)
 * =====================
 * Dependency-free helpers the brain uses to recognise a CONFIRM/"continue"
 * turn that is telling us to run a build whose executable plan we no longer
 * hold — so we can re-run the deterministic architect on the ORIGINAL prompt
 * instead of dropping into the fragile agent loop and looping forever.
 *
 * Kept in its own module (no LLM / DB imports) so it is cheap to unit-test.
 */

export interface ConversationTurnLite {
  role: 'user' | 'assistant'
  content: string
}

/**
 * A bare confirmation / resume message — "go ahead", "continue", "finish it",
 * "yes", etc. When a CONFIRM turn matches this AND we hold no executable plan,
 * the user is telling us to run/continue a build we designed conversationally.
 */
export const CONFIRM_OR_RESUME_RE =
  /^\s*(go\s*ahead|continue|resume|finish(\s*it)?|keep\s*going|carry\s*on|proceed|ye(s|p|ah)|ok(ay)?|do\s*it|sure|please\s*(do|continue))[\s.!]*$/i

/**
 * Walk back to the ORIGINAL build request in a conversation whose latest turns
 * are bare confirmations. Returns the most recent substantial, non-confirmation
 * USER message — the spec the user is telling us to run — or null when there is
 * no real build prompt to resume (caller falls through to the agent loop).
 */
export function findOriginalBuildPrompt(
  history: ConversationTurnLite[],
): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const t = history[i]
    if (t.role !== 'user') continue
    const c = (t.content ?? '').trim()
    if (c.length < 40) continue
    if (CONFIRM_OR_RESUME_RE.test(c)) continue
    return c
  }
  return null
}
