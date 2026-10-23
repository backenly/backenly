/**
 * How values read in the console: moments, and text written for agents.
 *
 * Moments, so the same timestamp is not written three ways on three pages.
 * Detail panes printed toLocaleString() ("10/20/2026, 8:00:48 AM": numeric
 * month, seconds, the viewer's locale order) beside lists that wrote "Oct 20,
 * 2026", which made the console look assembled from parts. Relative time stays
 * with ago() in components/changes/present.ts; these name the exact moment.
 */

/** "Oct 20, 8:00 AM" this year, "Oct 20, 2025, 8:00 AM" before it. */
export function formatStamp(iso: string | number | Date): string {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' as const }),
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** "Oct 20, 2026": a date with no time of day. */
export function formatDay(iso: string | number | Date): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Agent-facing text (MCP result summaries, system event messages) is written
 * as markdown: bold, backticks, emoji bullets. The console prints it as plain
 * text, so the asterisks and backticks never reach the screen.
 */
export function plainText(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[\u2600-\u27BF\u2B00-\u2BFF\uFE0F]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDEFF]/g, '')
    .replace(/\s*[•·]\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim()
}
