/**
 * How the projects list words its times and places. Pure, so the rules are
 * pinned by a test (__tests__/projects/live-status.test.ts) rather than by
 * whoever last edited a row.
 */

import { findRegion, HOME_REGION, type CloudRegion } from '@/lib/regions'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const parse = (at: string | Date | null | undefined): number | null => {
  if (!at) return null
  const t = new Date(at).getTime()
  return Number.isFinite(t) ? t : null
}

function shortDate(t: number, now: number): string {
  const d = new Date(t)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

export interface LastUsed {
  /** Under a "Last used" column heading: "Within the last hour", "3 h ago", "Oct 6". */
  column: string
  /** Standing alone, where there is no heading: "Used 3 h ago". */
  fact: string
  /** The exact time, for a tooltip. */
  exact: string | null
}

/**
 * "Last used", from Project.lastActivityAt. The clock is stamped at most once
 * an hour (lib/projects/activity.ts), so anything inside the hour is "within
 * the last hour" and nothing finer is ever claimed: a stamp 12 minutes old
 * means the project was used at some point in the last 12 minutes or more.
 */
export function lastUsed(at: string | Date | null | undefined, now: number = Date.now()): LastUsed {
  const t = parse(at)
  if (t === null) return { column: 'Not yet', fact: 'Not used yet', exact: null }
  const exact = new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
  const age = Math.max(0, now - t)
  if (age < HOUR) return { column: 'Within the last hour', fact: 'Used within the last hour', exact }
  if (age < DAY) {
    const h = Math.floor(age / HOUR)
    return { column: `${h} h ago`, fact: `Used ${h} h ago`, exact }
  }
  if (age < 30 * DAY) {
    const d = Math.floor(age / DAY)
    return { column: `${d} d ago`, fact: `Used ${d} d ago`, exact }
  }
  const date = shortDate(t, now)
  return { column: date, fact: `Used ${date}`, exact }
}

/**
 * The self-healing loop's last pass: "Checked 40 s ago". Seconds are rounded
 * down to tens, so a list re-rendered every few seconds does not flicker.
 * Null when there is no pass to report, and then the list says nothing at all:
 * the loop does not visit every project, and silence is the true answer.
 */
export function checkedAgo(at: string | Date | null | undefined, now: number = Date.now()): string | null {
  const t = parse(at)
  if (t === null) return null
  const age = Math.max(0, now - t)
  if (age < 10_000) return 'Checked just now'
  if (age < MINUTE) return `Checked ${Math.floor(age / 10_000) * 10} s ago`
  if (age < HOUR) return `Checked ${Math.floor(age / MINUTE)} min ago`
  if (age < DAY) return `Checked ${Math.floor(age / HOUR)} h ago`
  return null
}

/** Where a project runs. A missing or unknown id is the home region, as everywhere else (lib/regions.ts). */
export function regionOf(id: string | null | undefined): CloudRegion {
  return findRegion(id) ?? findRegion(HOME_REGION)!
}

/** "1 table", "14 tables". */
export function tables(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'table' : 'tables'}`
}
