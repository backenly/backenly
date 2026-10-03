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
 * Rates are cents per unit, and this file is the only place they are written:
 * the pricing page, the quota kernel's spend-limit headroom, the usage page and
 * alerts, and the monthly invoice lines all read them from here. A rate is
 * published only once measured cost confirms it sits above its floor
 * (OVERAGE_RATE_PUBLISHED), and an unpublished rate is never charged, capped or
 * estimated: axisBillable refuses it. So a rate cannot be billed before it is
 * advertised.
 */

import type { UsageAxisName } from '@/lib/usage/axes'

export const GIB = 1024 * 1024 * 1024

/** Axes that can be billed past the included quota. */
export type OverageAxis = Extract<UsageAxisName, 'mau' | 'db_bytes' | 'file_bytes' | 'fn_runs' | 'egress_bytes'>

export const OVERAGE_AXES: readonly OverageAxis[] = ['mau', 'db_bytes', 'file_bytes', 'fn_runs', 'egress_bytes']

/**
 * How file and API bytes leave AWS: `direct` is the load balancer and presigned
 * S3, `cdn` the CloudFront distribution serving files. Both cost about
 * $0.109/GB pay-as-you-go in Mumbai, so Pro has one set of terms on either path
 * (250 GB included, then $0.12/GB). The terms still decide whether egress can be
 * CHARGED at all: see egressBillable.
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
  // spend limit. 250 GB on either path: the included value customers compare
  // plans on. It is the rate past it that must clear cost, not the quota.
  BUILDER: { includedEgressGib: { direct: 250, cdn: 250 }, overage: true },
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
 * THE switch for charging egress. Egress is always metered and always has a
 * quota, but bytes past it are billable only when BOTH hold:
 *
 *   BACKENLY_EGRESS_BILLING=enabled   an explicit decision to charge egress,
 *                                     made once the CDN path is qualified and
 *                                     its rate is published; and
 *   BACKENLY_EGRESS_TERMS=cdn         the CDN terms (and CDN rate) are live.
 *
 * So the direct rate, which is never advertised, can never be charged. While
 * this is false, egress past its quota follows the no-overage path (grace, then
 * restricted downloads) whatever the owner's spend limit, no estimate or
 * invoice line includes it, and the spend limit buys no egress headroom.
 */
export function egressBillable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BACKENLY_EGRESS_BILLING === 'enabled' && egressTerms(env) === 'cdn'
}

/**
 * Whether usage of one axis past its quota can be charged on a plan: the plan
 * allows overage, the axis's rate is PUBLISHED, and, for egress, egressBillable()
 * holds. Every estimate, cap and charge decides per axis through this, so an
 * unpublished rate never becomes chargeable by being set in overagePrice.
 */
export function axisBillable(
  planName: string,
  axis: OverageAxis,
  egressCharged: boolean = egressBillable(),
  published: Readonly<Record<OverageAxis, boolean>> = OVERAGE_RATE_PUBLISHED,
): boolean {
  if (!planAllowsOverage(planName)) return false
  if (!published[axis]) return false
  return axis !== 'egress_bytes' || egressCharged
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
      // Measured 2026-09-30, after the daily snapshots moved to S3 (release
      // v11.5): a database GB-month costs $0.178-0.283 on Single-AZ RDS (gp3 at
      // $0.131 with headroom, seven compressed snapshots in S3, backup storage
      // past the free allowance), $0.207 in the central case, $0.371 on
      // Multi-AZ. $0.30 clears every Single-AZ case.
      return { cents: 30, per: GIB, label: 'per GB-month' }
    case 'file_bytes':
      return { cents: 3, per: GIB, label: 'per GB-month' }
    case 'fn_runs':
      return { cents: 200, per: 1_000_000, label: 'per 1M runs' }
    case 'egress_bytes':
      // One rate on either path (`terms` is kept for its callers), above the
      // $0.109/GB both cost pay-as-you-go. Matching the $0.09 some competitors
      // charge needs CloudFront's flat-rate economics first; until then it would
      // sell every extra GB at a loss.
      return { cents: 12, per: GIB, label: 'per GB' }
  }
}

/**
 * Which rates are PUBLISHED: stated on the pricing page and, only then,
 * chargeable (axisBillable). A rate is published once measured cost confirms it
 * sits above its floor: marginal usage is never sold below cost, and a rate that
 * may still move is never advertised as a commitment.
 *
 * Egress is UNPUBLISHED: CloudFront India PAYG is ~$0.109/GB, so $0.12 has
 * only ~9% margin before ancillary costs. Kept non-billable (BACKENLY_EGRESS_BILLING
 * unset) and hidden from the pricing page until a safer rate or improved
 * economics are approved.
 */
export const OVERAGE_RATE_PUBLISHED: Readonly<Record<OverageAxis, boolean>> = {
  mau: true,
  db_bytes: true,
  file_bytes: true,
  fn_runs: true,
  egress_bytes: false,
}

/** "$0.003 per MAU", "$2.00 per 1M runs": how a published rate reads on the page. */
export function formatRate(axis: OverageAxis): string {
  const p = overagePrice(axis, 'cdn')
  return `$${(p.cents / 100).toFixed(p.cents < 1 ? 3 : 2)} ${p.label}`
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
  mau: 100_000,
  fnRuns: 2_000_000,
  dbGib: 8,
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

export interface UsagePriceRow {
  axis: OverageAxis
  label: string
  included: string
  /** The published rate past the included amount, or null while it is not published. */
  rate: string | null
}

/** Pro's included amount of each billable axis, and its rate where that is published. */
export function proUsagePriceRows(): UsagePriceRow[] {
  const rate = (axis: OverageAxis) => (OVERAGE_RATE_PUBLISHED[axis] ? formatRate(axis) : null)
  const egressGib = (includedEgressMb('BUILDER', 'cdn') ?? 0) / 1024
  return [
    { axis: 'mau', label: 'Monthly active users', included: PRO_INCLUDED.mau.toLocaleString('en-US'), rate: rate('mau') },
    { axis: 'db_bytes', label: 'Database', included: `${PRO_INCLUDED.dbGib} GB`, rate: rate('db_bytes') },
    { axis: 'file_bytes', label: 'File storage', included: `${PRO_INCLUDED.fileGib} GB`, rate: rate('file_bytes') },
    { axis: 'fn_runs', label: 'Function runs', included: `${PRO_INCLUDED.fnRuns / 1_000_000}M`, rate: rate('fn_runs') },
    { axis: 'egress_bytes', label: 'Egress', included: `${egressGib} GB`, rate: rate('egress_bytes') },
  ]
}
