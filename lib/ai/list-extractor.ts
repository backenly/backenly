/**
 * LIST EXTRACTOR
 * ==============
 * Pulls actionable bullet / numbered items out of an AI-generated response so
 * cross-turn references ("implement those", "start with all these updates")
 * can bind to concrete work instead of running the build runtime on the bare
 * reference phrase.
 *
 * Inputs are markdown-flavoured assistant messages (the same shape the chat
 * UI renders). Outputs are short item strings — section headers and prose
 * paragraphs are dropped.
 */

const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/
const HEADER_RE = /^\s*#{1,6}\s+/
const BOLD_HEADER_RE = /^\s*\*\*[^*]+\*\*\s*:?\s*$/

/** Strip markdown emphasis (*, **, _, `) and trailing punctuation noise. */
function cleanItem(raw: string): string {
  return raw
    .replace(/^[*_`]+|[*_`]+$/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract bullet / numbered list items from an assistant message. Items are
 * deduped (case-insensitive) and capped at a sensible length so the sticky
 * store stays compact.
 *
 * Returns [] when the message doesn't look like a list response — callers
 * should only persist when the result has at least 2 items.
 */
export function extractListItems(message: string, options: { maxItems?: number; minLength?: number; maxLength?: number } = {}): string[] {
  const maxItems = options.maxItems ?? 20
  const minLength = options.minLength ?? 4
  const maxLength = options.maxLength ?? 240

  if (!message || message.length < 20) return []

  const lines = message.split(/\r?\n/)
  const seen = new Set<string>()
  const items: string[] = []
  let lastHeader = ''

  for (const rawLine of lines) {
    if (items.length >= maxItems) break
    if (!rawLine.trim()) continue

    // Track recent header so a sub-bullet can inherit its context if it would
    // otherwise be too short to be actionable.
    if (HEADER_RE.test(rawLine) || BOLD_HEADER_RE.test(rawLine)) {
      lastHeader = cleanItem(rawLine.replace(HEADER_RE, ''))
      continue
    }

    const match = rawLine.match(BULLET_RE)
    if (!match) continue

    let item = cleanItem(match[1])
    if (item.length < minLength) continue

    // If a bullet is just a short phrase and we have a header, prefix it so
    // the persisted item still makes sense out of context (e.g., header
    // "Auth Flow Failing" + bullet "Debug and fix the user creation logic").
    if (item.length < 60 && lastHeader && !item.toLowerCase().includes(lastHeader.toLowerCase().slice(0, 16))) {
      item = `${lastHeader}: ${item}`
    }

    if (item.length > maxLength) item = `${item.slice(0, maxLength - 1)}…`

    const dedupeKey = item.toLowerCase()
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    items.push(item)
  }

  return items
}
