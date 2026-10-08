/**
 * The metered usage axes, and exactly what each one counts.
 *
 * This file is the definition. The ledger (./ledger.ts) records against these
 * names, the monthly close (./close.ts) totals them, and anything that prices
 * them later reads the same definitions. Change a definition here, not at a
 * call site.
 *
 * Two kinds:
 *   counter  quantities add up within a day (bytes sent, users first seen, runs)
 *   gauge    the day keeps its MAXIMUM sample (bytes stored)
 *
 * Nothing here is a price, and nothing here is Cloud-only: a self-hosted
 * install meters itself the same way, and simply never charges for it.
 */

export type UsageKind = 'counter' | 'gauge'

export interface UsageAxis {
  kind: UsageKind
  /** Unit of UsageDaily.quantity for this axis. */
  unit: 'bytes' | 'users' | 'runs'
  /** Unit of the closed monthly quantity (UsagePeriodClose.quantity). */
  closedUnit: 'bytes' | 'byte_month' | 'users' | 'runs' | 'tokens'
  definition: string
}

export const USAGE_AXES = {
  egress_bytes: {
    kind: 'counter',
    unit: 'bytes',
    closedUnit: 'bytes',
    definition:
      'Bytes a project sends to clients: responses under /api/v1 and /api/v2 (including ' +
      'responses the runtime serves and realtime streams), file downloads served by the ' +
      'app, and file downloads served directly from object storage or the CDN (from ' +
      'their access logs). Backenly\'s own synthetic traffic is never counted.',
  },
  mau: {
    kind: 'counter',
    unit: 'users',
    closedUnit: 'users',
    definition:
      'Distinct end users of a project (rows of that project\'s workspace users table) ' +
      'who authenticated, refreshed a session, or made an authenticated data request ' +
      'during the UTC calendar month. Counted once, the first time in the month. ' +
      'Platform accounts (dashboard and team members) and reserved verifier accounts ' +
      'are never end users.',
  },
  db_bytes: {
    kind: 'gauge',
    unit: 'bytes',
    closedUnit: 'byte_month',
    definition:
      'Total on-disk size (tables, indexes, TOAST) of a project\'s workspace schema and ' +
      'every branch schema of the same project. The day keeps its largest sample; the ' +
      'month is the average of daily maxima over the days of the month.',
  },
  file_bytes: {
    kind: 'gauge',
    unit: 'bytes',
    closedUnit: 'byte_month',
    definition:
      'Sum of the sizes of a project\'s stored files that are not deleted, from the ' +
      'storage metadata (storage_files). The day keeps its largest sample; the month is ' +
      'the average of daily maxima over the days of the month.',
  },
  fn_runs: {
    kind: 'counter',
    unit: 'runs',
    closedUnit: 'runs',
    definition:
      'Function invocations that passed the plan check and started executing the ' +
      'function, whatever the outcome (success, error or timeout), from any trigger ' +
      '(API, SDK, cron, database event, sign-up, dashboard test run). Invocations ' +
      'refused by the plan check and calls to a function that does not exist are not ' +
      'runs.',
  },
} as const satisfies Record<string, UsageAxis>

export type UsageAxisName = keyof typeof USAGE_AXES

/**
 * AI usage is not a daily per-project axis: it is already metered per account
 * in AccountAiUsage.tokenCount (lib/entitlements/policy.ts, charged at the model
 * client boundary). The close reads it from there rather than keeping a second
 * count that could disagree.
 */
export const AI_TOKENS_AXIS = 'ai_tokens' as const

/** Where a UsageDaily row's quantity was measured. */
export const USAGE_SOURCES = [
  'app', //        in-process: bytes a Backenly server wrote to a response body
  'alb', //        load balancer access logs: bytes on the wire
  's3', //         object-storage server access logs: direct (presigned) downloads
  'cloudfront', // CDN standard logs
  'pg', //         PostgreSQL catalog size functions
  'metadata', //   storage_files metadata
  'executor', //   the function executor
  'auth', //       end-user authentication and authenticated requests
] as const

export type UsageSource = (typeof USAGE_SOURCES)[number]

export function isUsageAxis(axis: string): axis is UsageAxisName {
  return Object.prototype.hasOwnProperty.call(USAGE_AXES, axis)
}

export function isUsageSource(source: string): source is UsageSource {
  return (USAGE_SOURCES as readonly string[]).includes(source)
}

/** UTC calendar day, as the Date the DATE column stores (midnight UTC). */
export function utcDay(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
}

/** UTC calendar month key, YYYY-MM. */
export function utcPeriod(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7)
}

/** [first day, first day of next month) for a YYYY-MM period, in UTC. */
export function periodBounds(period: string): { start: Date; end: Date; days: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(period)
  if (!m) throw new Error(`Invalid usage period "${period}" (expected YYYY-MM)`)
  const year = Number(m[1])
  const month = Number(m[2]) - 1
  if (month < 0 || month > 11) throw new Error(`Invalid usage period "${period}"`)
  const start = new Date(Date.UTC(year, month, 1))
  const end = new Date(Date.UTC(year, month + 1, 1))
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000)
  return { start, end, days }
}

/** The period before `period`, e.g. 2026-01 -> 2025-12. */
export function previousPeriod(period: string): string {
  const { start } = periodBounds(period)
  return utcPeriod(new Date(start.getTime() - 86_400_000))
}
