/**
 * How values read in the console: moments, durations, and text written for
 * agents.
 *
 * ONE MODULE FOR TIME (project decision 13, 2026-11-16). The sections had a
 * dozen copies (ago, timeAgo, formatRelative, formatTimeAgo, lastCallAgo,
 * formatDate…) that said the same moment as "12m ago", "12 minutes ago" and
 * "10/20/2026, 8:00:48 AM" on neighbouring pages. Every page now says it one
 * way, through formatTime() or <Time> (components/console/Time.tsx):
 *
 *   'ago'          just now · 40 s ago · 12 min ago · 3 h ago · 2 d ago (up to
 *                  6 days) · then Nov 14 · Nov 14, 2025 in another year.
 *                  For freshness and "last used".
 *   'clock'        2:09 AM            inside day groups
 *   'clockSeconds' 2:18:41 AM         runs, requests and log lines
 *   'date'         Nov 14 · Nov 14, 2025
 *   'dateTime'     Nov 14, 6:02 AM · Nov 14, 2025, 6:02 AM    everywhere else
 *   'day'          Today · Yesterday · Sat, Nov 14 · Sat, Nov 14, 2025
 *                  a day group's heading
 *
 * Schedules are said in UTC ({ utc: true } adds " UTC"). Durations read
 * "60 ms", "3.2 s" (duration()). Database grid cells stay raw: they are data.
 *
 * The strings are built here rather than by toLocaleString(), so they are the
 * same in every browser and in Node: recent ICU versions put a narrow
 * no-break space before "AM", which made the same time two different strings
 * in a test and in Chrome. The console is written in English; only the time
 * zone is the viewer's own.
 */

export type TimeMode = 'ago' | 'clock' | 'clockSeconds' | 'date' | 'dateTime' | 'day'

/** Anything a timestamp arrives as: an ISO string from the API, epoch ms, a Date. */
export type Moment = string | number | Date

export interface TimeOptions {
  /** The moment "ago" and "Today" are measured from. Defaults to now. */
  now?: Moment
  /** Read the moment in UTC (schedules). Clock modes then end in " UTC". */
  utc?: boolean
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Below this many seconds a moment is "just now". */
const JUST_NOW_S = 10
/** Relative days stop here ("6 d ago"); a week back reads as a date. */
const MAX_RELATIVE_DAYS = 6

interface Parts {
  year: number
  month: number
  day: number
  weekday: number
  hour: number
  minute: number
  second: number
}

/** A Date, or null when the value is missing or not a time. */
export function toDate(m: Moment | null | undefined): Date | null {
  if (m === null || m === undefined || m === '') return null
  const d = m instanceof Date ? m : new Date(m)
  return Number.isNaN(d.getTime()) ? null : d
}

function partsOf(d: Date, utc: boolean): Parts {
  return utc
    ? {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth(),
        day: d.getUTCDate(),
        weekday: d.getUTCDay(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        second: d.getUTCSeconds(),
      }
    : {
        year: d.getFullYear(),
        month: d.getMonth(),
        day: d.getDate(),
        weekday: d.getDay(),
        hour: d.getHours(),
        minute: d.getMinutes(),
        second: d.getSeconds(),
      }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** "2:09 AM", "2:18:41 AM": twelve-hour, no leading zero. */
function clockOf(p: Parts, seconds: boolean): string {
  const h = p.hour % 12 || 12
  return `${h}:${pad(p.minute)}${seconds ? `:${pad(p.second)}` : ''} ${p.hour < 12 ? 'AM' : 'PM'}`
}

/** "Nov 14", or "Nov 14, 2025" when the year is not the current one. */
function dateOf(p: Parts, currentYear: number): string {
  return `${MONTHS[p.month]} ${p.day}${p.year === currentYear ? '' : `, ${p.year}`}`
}

/** Whole calendar days from `then` to `now`, in the zone the parts were read in. */
function daysBetween(then: Parts, now: Parts): number {
  // Date.UTC on the calendar parts counts days without daylight-saving drift.
  return Math.round(
    (Date.UTC(now.year, now.month, now.day) - Date.UTC(then.year, then.month, then.day)) / 86_400_000,
  )
}

/**
 * One moment, said the console's way. Returns '' for a missing or invalid
 * value, so a caller can fall back with `|| '—'` where a dash reads better.
 */
export function formatTime(iso: Moment | null | undefined, mode: TimeMode = 'ago', opts: TimeOptions = {}): string {
  const d = toDate(iso)
  if (!d) return ''
  const utc = !!opts.utc
  const now = toDate(opts.now ?? Date.now()) ?? new Date()
  const p = partsOf(d, utc)
  const n = partsOf(now, utc)
  const zone = utc ? ' UTC' : ''

  switch (mode) {
    case 'clock':
      return clockOf(p, false) + zone
    case 'clockSeconds':
      return clockOf(p, true) + zone
    case 'date':
      return dateOf(p, n.year)
    case 'dateTime':
      return `${dateOf(p, n.year)}, ${clockOf(p, false)}${zone}`
    case 'day': {
      const days = daysBetween(p, n)
      if (days === 0) return 'Today'
      if (days === 1) return 'Yesterday'
      return `${WEEKDAYS[p.weekday]}, ${dateOf(p, n.year)}`
    }
    case 'ago':
    default: {
      // A moment slightly ahead of this clock (server skew) is still "just now".
      const s = (now.getTime() - d.getTime()) / 1000
      if (s < JUST_NOW_S) return 'just now'
      if (s < 60) return `${Math.floor(s)} s ago`
      const min = Math.floor(s / 60)
      if (min < 60) return `${min} min ago`
      const h = Math.floor(min / 60)
      if (h < 24) return `${h} h ago`
      const days = Math.floor(h / 24)
      if (days <= MAX_RELATIVE_DAYS) return `${days} d ago`
      return dateOf(p, n.year)
    }
  }
}

/** A day group's heading: "Today", "Yesterday", "Sat, Nov 14". */
export function dayLabel(iso: Moment | null | undefined, opts: TimeOptions = {}): string {
  return formatTime(iso, 'day', opts)
}

/**
 * The exact moment, for a hover title and screen readers:
 * "Sat, Nov 14, 2026, 2:09:41 AM GMT+5:30".
 */
export function fullTime(iso: Moment | null | undefined, opts: Pick<TimeOptions, 'utc'> = {}): string {
  const d = toDate(iso)
  if (!d) return ''
  const utc = !!opts.utc
  const p = partsOf(d, utc)
  return `${WEEKDAYS[p.weekday]}, ${MONTHS[p.month]} ${p.day}, ${p.year}, ${clockOf(p, true)} ${utc ? 'UTC' : zoneName(d)}`.trim()
}

/** The viewer's zone as the browser abbreviates it ("GMT+5:30", "PST"). */
function zoneName(d: Date): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? ''
  } catch {
    return ''
  }
}

/**
 * How long something took: "<1 ms", "60 ms", "3.2 s", "42 s", "2 min 5 s",
 * "1 h 4 min". Returns '' for a missing or negative value.
 */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1) return '<1 ms'
  if (Math.round(ms) < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  // One decimal while it says something ("3.2 s"), none once it does not ("1 s", "42 s").
  if (Math.round(s * 10) < 100) return `${String(Math.round(s * 10) / 10)} s`
  if (Math.round(s) < 60) return `${Math.round(s)} s`
  const totalS = Math.round(s)
  const min = Math.floor(totalS / 60)
  if (min < 60) return totalS % 60 ? `${min} min ${totalS % 60} s` : `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
}

/**
 * Items under the day they happened, in the order given (newest first is the
 * console's order). Consecutive items share a group; each group carries its
 * heading.
 */
export function groupByDay<T>(
  items: readonly T[],
  at: (item: T) => Moment | null | undefined,
  opts: TimeOptions = {},
): Array<{ key: string; label: string; items: T[] }> {
  const groups: Array<{ key: string; label: string; items: T[] }> = []
  for (const item of items) {
    const d = toDate(at(item))
    const p = d ? partsOf(d, !!opts.utc) : null
    const key = p ? `${p.year}-${p.month + 1}-${p.day}` : 'unknown'
    const last = groups[groups.length - 1]
    if (last && last.key === key) last.items.push(item)
    else groups.push({ key, label: d ? dayLabel(d, opts) : 'Unknown day', items: [item] })
  }
  return groups
}

/** "Oct 20, 8:00 AM" this year, "Oct 20, 2025, 8:00 AM" before it. Same as formatTime(iso, 'dateTime'). */
export function formatStamp(iso: string | number | Date): string {
  return formatTime(iso, 'dateTime')
}

/** "Oct 20, 2026": a date with no time of day, always with its year. */
export function formatDay(iso: string | number | Date): string {
  const d = toDate(iso)
  if (!d) return ''
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
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
    .replace(/[☀-➿⬀-⯿️]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDEFF]/g, '')
    .replace(/\s*[•·]\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim()
}
