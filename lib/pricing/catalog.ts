/**
 * What each plan includes beyond its Plan row, and what usage past it costs.
 *
 * One place for the numbers usage-based pricing is built from: the quota
 * kernel's spend-limit headroom (lib/usage/overage.ts), the usage alerts, the
 * monthly overage charge and, later, the pricing page all read them from here.
 * The per-plan quotas that already existed (MAU, database, files, function
 * runs, AI credits) stay on the Plan row and reach the product through
 * entitlements; this file adds only what the Plan row has never carried.
 *
 * Plans are named by their internal codes (SANDBOX = Free, BUILDER = Pro,
 * SCALE = Enterprise). A code that is not listed has no overage and no egress
 * quota, which is also what a self-hosted install answers.
 *
 * Rates are cents per unit and are PROVISIONAL until measured cost confirms
 * each one sits above its cost floor. Nothing here is advertised until then.
 */

import type { UsageAxisName } from '@/lib/usage/axes'

export const GIB = 1024 * 1024 * 1024

/** Axes that can be billed past the included quota. */
export type OverageAxis = Extract<UsageAxisName, 'mau' | 'db_bytes' | 'file_bytes' | 'fn_runs' | 'egress_bytes'>

export const OVERAGE_AXES: readonly OverageAxis[] = ['mau', 'db_bytes', 'file_bytes', 'fn_runs', 'egress_bytes']

/**
 * How file and API bytes leave AWS decides what egress costs Backenly, and so
 * what can be included and charged. `direct` is the load balancer and presigned
 * S3 (about $0.109/GB after the account's free 100 GB). `cdn` is a flat-rate
 * CloudFront distribution serving files, which only applies once it is live and
 * its real cost has been verified.
 */
export type EgressTerms = 'direct' | 'cdn'

export function egressTerms(env: NodeJS.ProcessEnv = process.env): EgressTerms {
  return env.BACKENLY_EGRESS_TERMS === 'cdn' ? 'cdn' : 'direct'
}

export interface UnitPrice {
  /** Cents per `per` units of the axis's own unit. */
  cents: number
  per: number
  /** How a price line reads: "per GB-month", "per 1M runs". */
  label: string
}

interface PlanUsageTerms {
  /** Included egress per month, in GiB, by egress terms. null = unmetered. */
  includedEgressGib: Record<EgressTerms, number> | null
  /** Whether usage past the included quota can be billed at all. */
  overage: boolean
}

const PLAN_USAGE_TERMS: Record<string, PlanUsageTerms> = {
  // Free: hard caps only. The egress quota exists to stop one free project
  // from sending unbounded bytes at Backenly's cost.
  SANDBOX: { includedEgressGib: { direct: 5, cdn: 5 }, overage: false },
  // Pro: pooled quotas across every project, then overage within the owner's
  // spend limit.
  BUILDER: { includedEgressGib: { direct: 100, cdn: 250 }, overage: true },
  // Enterprise: quotas and pricing are per contract.
  SCALE: { includedEgressGib: null, overage: false },
}

/** Included egress in MB for a plan code, or null (unmetered). */
export function includedEgressMb(planName: string, terms: EgressTerms = egressTerms()): number | null {
  const gib = PLAN_USAGE_TERMS[planName]?.includedEgressGib?.[terms]
  return gib === undefined || gib === null ? null : gib * 1024
}

/** Whether a plan can be billed for usage past its included quota. */
export function planAllowsOverage(planName: string): boolean {
  return PLAN_USAGE_TERMS[planName]?.overage === true
}

/**
 * Overage unit prices. Bytes are priced per GiB (the same 1024-based unit as
 * the Plan row's MB quotas). Storage axes are priced per GiB-month and billed on
 * the month's average of daily maxima (lib/usage/close.ts).
 */
export function overagePrice(axis: OverageAxis, terms: EgressTerms = egressTerms()): UnitPrice {
  switch (axis) {
    case 'mau':
      return { cents: 0.3, per: 1, label: 'per MAU' }
    case 'db_bytes':
      return { cents: 15, per: GIB, label: 'per GB-month' }
    case 'file_bytes':
      return { cents: 3, per: GIB, label: 'per GB-month' }
    case 'fn_runs':
      return { cents: 200, per: 1_000_000, label: 'per 1M runs' }
    case 'egress_bytes':
      return terms === 'cdn'
        ? { cents: 9, per: GIB, label: 'per GB' }
        : { cents: 12, per: GIB, label: 'per GB' }
  }
}

/** Cents for `units` of an axis past its quota (fractional; round at the invoice). */
export function overageCents(axis: OverageAxis, units: number, terms: EgressTerms = egressTerms()): number {
  if (units <= 0) return 0
  const price = overagePrice(axis, terms)
  return (units / price.per) * price.cents
}

/** Units of an axis that `cents` buys (floored, never negative). */
export function unitsForCents(axis: OverageAxis, cents: number, terms: EgressTerms = egressTerms()): number {
  if (cents <= 0) return 0
  const price = overagePrice(axis, terms)
  return Math.floor((cents / price.cents) * price.per)
}

/** Spend-limit presets offered in the dashboard; a custom amount is also allowed. */
export const SPEND_LIMIT_PRESETS_CENTS = [0, 5_000, 10_000, 25_000] as const

/** The largest spend limit an owner can set without talking to Backenly. */
export const SPEND_LIMIT_MAX_CENTS = 1_000_000

// ─── What the pricing page states ────────────────────────────────────────────
//
// The Pro plan's included quantities as advertised. The Plan row (seeded by
// the Cloud overlay) is what the quota kernel enforces; an overlay test holds
// the two equal, so the page cannot promise a quota the product does not give.

export const PRO_INCLUDED = {
  mau: 200_000,
  fnRuns: 2_000_000,
  dbGib: 10,
  fileGib: 100,
} as const

/**
 * Whether usage-based pricing is shown on the public pricing page. A build-time
 * switch (NEXT_PUBLIC_*), off unless the release that runs production in
 * shadow mode or later turns it on: no rate is advertised before it can be
 * measured.
 */
export function usagePricingPublished(value: string | undefined = process.env.NEXT_PUBLIC_USAGE_PRICING): boolean {
  // Read as a literal process.env.NEXT_PUBLIC_* reference: that is the only
  // form Next inlines into the client bundle the pricing page ships in.
  return value === 'published'
}

/**
 * Whether the egress rate may be advertised. Only once files are served by the
 * CDN whose cost has been verified; until then egress is metered and capped but
 * its price is not stated.
 */
export function egressPricePublished(value: string | undefined = process.env.NEXT_PUBLIC_EGRESS_TERMS): boolean {
  return value === 'cdn'
}

export interface UsagePriceRow {
  axis: OverageAxis
  label: string
  included: string
  rate: string
}

/** The Pro usage table: included, then the rate past it. Egress only when publishable. */
export function proUsagePriceRows(opts: { includeEgress: boolean }): UsagePriceRow[] {
  const rate = (axis: OverageAxis, terms: EgressTerms = 'direct') => {
    const p = overagePrice(axis, terms)
    return `$${(p.cents / 100).toFixed(p.cents < 1 ? 3 : 2)} ${p.label}`
  }
  const rows: UsagePriceRow[] = [
    { axis: 'mau', label: 'Monthly active users', included: PRO_INCLUDED.mau.toLocaleString('en-US'), rate: rate('mau') },
    { axis: 'db_bytes', label: 'Database', included: `${PRO_INCLUDED.dbGib} GB`, rate: rate('db_bytes') },
    { axis: 'file_bytes', label: 'File storage', included: `${PRO_INCLUDED.fileGib} GB`, rate: rate('file_bytes') },
    { axis: 'fn_runs', label: 'Function runs', included: `${PRO_INCLUDED.fnRuns / 1_000_000}M`, rate: rate('fn_runs') },
  ]
  if (opts.includeEgress) {
    const gib = (includedEgressMb('BUILDER', 'cdn') ?? 0) / 1024
    rows.push({ axis: 'egress_bytes', label: 'Egress', included: `${gib} GB`, rate: rate('egress_bytes', 'cdn') })
  }
  return rows
}
