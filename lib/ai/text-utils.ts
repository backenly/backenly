/**
 * TEXT UTILITIES
 * ==============
 * Pure string helpers shared across the AI pipeline.
 * No LLM calls. No DB access. No side effects.
 */

const BUILD_MODE_FORBIDDEN_PATTERNS = [
  /let me know( if| what| how)?/i,
  /if you('d| would) like/i,
  /would you like/i,
  /feel free to/i,
  /don't hesitate/i,
  /i recommend/i,
  /you can always/i,
  /i suggest/i,
  /as a next step/i,
  /you might (also |want to )?consider/i,
  /additionally,? you (may|might|can|could)/i,
  /it('s| is) worth (noting|mentioning)/i,
  /i (should|would) (also )?mention/i,
  /just (a )?(thought|heads? up|note|reminder)/i,
  /please (note|be aware|keep in mind)/i,
  /one (thing|more thing) to (note|mention|consider)/i,
  /for your reference/i,
  /this is (just |only )?a (starting point|suggestion|recommendation)/i,
]

/** Returns true if text contains ChatGPT-style advisory phrasing. */
export function hasForbiddenPhrases(text: string): boolean {
  return BUILD_MODE_FORBIDDEN_PATTERNS.some(pattern => pattern.test(text))
}

/**
 * Strips trailing advisory sentences from a Build mode response.
 * Sentences ending with forbidden patterns are removed entirely.
 * Used as a last-pass filter on all Build mode messages.
 */
export function stripAdvisoryPhrases(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/)
  const filtered = sentences.filter(sentence => {
    const lower = sentence.toLowerCase()
    return !(
      /\blet me know\b/.test(lower) ||
      /\bif you('d| would) like\b/.test(lower) ||
      /\bwould you like\b/.test(lower) ||
      /\bfeel free\b/.test(lower) ||
      /\bdon't hesitate\b/.test(lower) ||
      /\bi recommend\b/.test(lower) ||
      /\byou can always\b/.test(lower) ||
      /\bi suggest\b/.test(lower) ||
      /\bas a next step\b/.test(lower) ||
      /\byou might (also )?consider\b/.test(lower) ||
      /\bthis is (just |only )?a (starting point|suggestion|recommendation)\b/.test(lower) ||
      /\bplease (note|be aware|keep in mind)\b/.test(lower) ||
      /\bjust (a )?(thought|heads? up|note|reminder)\b/.test(lower) ||
      /\bone (thing|more thing) to (note|mention|consider)\b/.test(lower)
    )
  })
  return filtered.join(' ').trim()
}
