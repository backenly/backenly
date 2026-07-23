/**
 * PHASE 10.2 — CORRECTION PATTERN MINER
 * ========================================
 * Aggregates CorrectionEvents into CorrectionPatterns for human review.
 *
 * Design constraints:
 *  - Patterns are NEVER injected automatically into the AI planner.
 *  - Patterns are created with status PENDING_REVIEW and must be explicitly
 *    approved by an operator before they influence anything.
 *  - Existing REJECTED or ARCHIVED patterns are not re-opened by mining.
 *  - Mining is idempotent: running it twice produces the same output.
 */

import { prisma } from '@/lib/db/prisma'

// ── Config ────────────────────────────────────────────────────────────────────

/** Minimum occurrences before a group becomes a CorrectionPattern candidate. */
const MIN_OCCURRENCES = 3

/** Maximum CorrectionEvent IDs to store as evidence per pattern. */
const MAX_EXAMPLE_IDS = 5

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MiningResult {
  patternsCreated: number
  patternsUpdated: number
  patternsSkipped: number
  totalGroups:     number
}

interface EventGroup {
  domain:               string | null
  originalActionType:   string
  errorClassification:  string | null
  count:                bigint
  ids:                  string[]
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan all CorrectionEvents and produce or update CorrectionPattern rows.
 *
 * Safe to run on a cron schedule or on-demand from the review API.
 * Never raises unless the DB is completely unavailable.
 */
export async function minePatterns(): Promise<MiningResult> {
  const result: MiningResult = {
    patternsCreated: 0,
    patternsUpdated: 0,
    patternsSkipped: 0,
    totalGroups:     0,
  }

  // Aggregate events grouped by the three pattern dimensions.
  // We use a raw query so we can HAVING COUNT(*) >= N in one pass.
  const groups = await prisma.$queryRaw<EventGroup[]>`
    SELECT
      domain,
      "originalActionType",
      "errorClassification",
      COUNT(*)              AS count,
      array_agg(id ORDER BY "createdAt" DESC) AS ids
    FROM "correction_events"
    GROUP BY domain, "originalActionType", "errorClassification"
    HAVING COUNT(*) >= ${MIN_OCCURRENCES}
  `

  result.totalGroups = groups.length

  for (const group of groups) {
    const occurrenceCount = Number(group.count)
    const exampleIds      = (group.ids ?? []).slice(0, MAX_EXAMPLE_IDS)
    const patternSummary  = buildPatternSummary(
      group.domain,
      group.originalActionType,
      group.errorClassification,
      occurrenceCount,
    )

    const whereClause = {
      domain:              group.domain              ?? null,
      actionType:          group.originalActionType,
      errorClassification: group.errorClassification ?? null,
    }

    // Check for an existing pattern with the same unique key.
    const existing = await prisma.correctionPattern.findFirst({ where: whereClause })

    if (existing) {
      if (existing.status === 'PENDING_REVIEW' || existing.status === 'APPROVED') {
        // Refresh the evidence count and summary; preserve review state.
        await prisma.correctionPattern.update({
          where: { id: existing.id },
          data:  { occurrenceCount, exampleIds, patternSummary },
        })
        result.patternsUpdated++
      } else {
        // REJECTED or ARCHIVED — do not re-open automatically.
        result.patternsSkipped++
      }
    } else {
      await prisma.correctionPattern.create({
        data: {
          ...whereClause,
          patternSummary,
          occurrenceCount,
          exampleIds,
          status: 'PENDING_REVIEW',
        },
      })
      result.patternsCreated++
    }
  }

  return result
}

/**
 * Return counts of CorrectionPatterns grouped by status.
 * Used by the review API to surface dashboard numbers.
 */
export async function getPatternStatusCounts(): Promise<Record<string, number>> {
  const rows = await prisma.correctionPattern.groupBy({
    by:      ['status'],
    _count:  { id: true },
  })
  return Object.fromEntries(rows.map(r => [r.status, r._count.id]))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPatternSummary(
  domain:              string | null,
  actionType:          string,
  errorClassification: string | null,
  count:               number,
): string {
  const domainStr = domain ? `in ${domain} projects` : 'across all project types'
  const errorStr  = errorClassification
    ? ` with error ${errorClassification}`
    : ''
  return (
    `${actionType}${errorStr} required correction ${count} times ${domainStr}. ` +
    `Review to determine whether a planning hint would prevent recurrence.`
  )
}
