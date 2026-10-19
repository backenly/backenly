/**
 * HOW A FINDING LEFT THE QUEUE — the one place that says whether "fixed" is true
 * ==============================================================================
 *
 * A finding stops being actionable for several reasons, and only some of them
 * mean the problem was repaired:
 *
 *   autonomy_verified   Backenly repaired it on its own and a re-check of the
 *                       live database confirmed the problem is gone.
 *   approved_verified   A person approved the repair; it ran and the re-check
 *                       confirmed it.
 *   applied_unverified  A repair ran, but nothing could confirm it worked
 *                       (no probe covers the type, or the check errored).
 *   condition_cleared   The detector stopped seeing the problem without
 *                       Backenly repairing it (fixed by hand, table dropped,
 *                       project no longer watched). Not a Backenly fix.
 *   detector_retired    The check that filed it was retired.
 *   dismissed           A person dismissed it.
 *
 * Every surface that tells someone what happened reads this classification
 * rather than inferring it. Inferring it from a finding disappearing between
 * two polls is how dismissals, withdrawals and escalations came to be shown as
 * repairs.
 *
 * "Verified" is read only from the recorded verification outcome. Anything
 * else, including a missing value, is not verified.
 */

import { prisma } from '@/lib/db/prisma'

export type FixVerificationState = 'confirmed' | 'unverified' | 'verification_error'

export type ClosedBy =
  | 'autonomy_verified'
  | 'approved_verified'
  | 'applied_unverified'
  | 'condition_cleared'
  | 'detector_retired'
  | 'dismissed'

export interface ResolvedFinding {
  id: string
  type: string
  severity: string
  closedBy: ClosedBy
  /** When the closure happened (ISO). */
  at: string
}

type Details = Record<string, unknown> | null | undefined

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * The verification outcome a repair recorded. Repairs store it on
 * `details.rollbackData.verification` (the auto-fix kernel and the approve
 * route). `details.verification` is where the observer's inline repairs kept
 * it, read for the rows they left: the observer no longer repairs.
 */
export function fixVerificationOf(details: Details): FixVerificationState | null {
  const d = obj(details)
  if (!d) return null
  const raw = obj(d.rollbackData)?.verification ?? d.verification
  return raw === 'confirmed' || raw === 'unverified' || raw === 'verification_error' ? raw : null
}

/** How this finding left the actionable set, or null if it has not. */
export function closureOf(finding: { status: string; details: Details }): ClosedBy | null {
  const d = obj(finding.details)
  if (finding.status === 'auto_fixed' || finding.status === 'fixed') {
    if (fixVerificationOf(d) !== 'confirmed') return 'applied_unverified'
    return obj(d?.rollbackData)?.approvedBy ? 'approved_verified' : 'autonomy_verified'
  }
  if (finding.status === 'dismissed') {
    const by = d?.withdrawnBy
    if (by === 'detector_retired') return 'detector_retired'
    if (typeof by === 'string' && by) return 'condition_cleared'
    return 'dismissed'
  }
  return null
}

/** The moment the closure happened, when it was recorded. */
function closedAt(
  finding: { status: string; details: Details; fixAppliedAt: Date | null },
): Date | null {
  if (finding.status === 'auto_fixed' || finding.status === 'fixed') return finding.fixAppliedAt
  const d = obj(finding.details)
  const stamp = d?.withdrawnAt ?? d?.dismissedAt
  if (typeof stamp === 'string') {
    const t = Date.parse(stamp)
    return Number.isFinite(t) ? new Date(t) : null
  }
  return null
}

/**
 * Findings that left the queue since `since`, newest first, each with how it
 * left. A closure without a recorded time is omitted rather than guessed.
 */
export async function recentlyResolved(
  projectId: string,
  since: Date,
  limit = 20,
): Promise<ResolvedFinding[]> {
  const select = { id: true, type: true, severity: true, status: true, details: true, fixAppliedAt: true } as const
  // Two queries, so a burst of dismissals can never crowd a repair out of the
  // candidate set.
  const [repairs, dismissals] = await Promise.all([
    prisma.healthFinding.findMany({
      where: { projectId, status: { in: ['auto_fixed', 'fixed'] }, fixAppliedAt: { gte: since } },
      orderBy: { fixAppliedAt: 'desc' },
      take: limit,
      select,
    }),
    // Withdrawal and dismissal times live in `details`, so this candidate set
    // is bounded by recency of detection and filtered precisely below.
    prisma.healthFinding.findMany({
      where: { projectId, status: 'dismissed', detectedAt: { gte: new Date(since.getTime() - 30 * 24 * 60 * 60 * 1000) } },
      orderBy: { detectedAt: 'desc' },
      take: 200,
      select,
    }),
  ])

  const out: ResolvedFinding[] = []
  for (const row of [...repairs, ...dismissals]) {
    const closedBy = closureOf(row as { status: string; details: Details })
    const at = closedAt(row as { status: string; details: Details; fixAppliedAt: Date | null })
    if (!closedBy || !at || at < since) continue
    out.push({ id: row.id, type: row.type, severity: row.severity, closedBy, at: at.toISOString() })
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}

/** Repairs since `since`, split by whether a re-check confirmed them. */
export async function countRepairs(
  projectId: string,
  since: Date,
): Promise<{ verified: number; unverified: number }> {
  const rows = await prisma.healthFinding.findMany({
    where: { projectId, status: { in: ['auto_fixed', 'fixed'] }, fixAppliedAt: { gte: since } },
    select: { details: true },
  })
  let verified = 0
  for (const r of rows) if (fixVerificationOf(r.details as Details) === 'confirmed') verified++
  return { verified, unverified: rows.length - verified }
}
