/**
 * CROSS-PROJECT PATTERN LEARNING (Phase 6 — data collection MVP)
 * ================================================================
 * A true recommendation flywheel ("social apps usually need a bookmarks
 * table") needs volume this product doesn't have yet. What we can build now
 * is the anonymized data collection system so that flywheel has something to
 * learn from later.
 *
 * Anonymization is structural, not a redaction step: `backend_patterns` rows
 * have no projectId/userId column at all. Many projects' events collapse
 * into one shared counter row per (project_type, pattern_type, resource_type)
 * — the aggregation itself is what makes this safe. Only structural naming
 * choices go in (table/column/API/auth-rule names) — never row data, never
 * free-text descriptions that might carry business context, never a tenant
 * identifier.
 */

import { prisma } from '@/lib/db'
import { detectDomain } from '@/lib/ai/blueprints'
import type { BackendRiskLevel } from '@/lib/operational-memory/ledger'

export type PatternType = 'schema' | 'auth' | 'api' | 'rollback' | 'health_failure'

/** Resolve a best-effort, anonymized project-type bucket from the user's request text. */
export function resolveProjectType(userMessage: string): string {
  return detectDomain(userMessage)?.domain ?? 'general'
}

/**
 * Map a lib/operational-memory/ledger.ts BackendEventType down to Phase 6's
 * narrower five-bucket taxonomy. Returns null for event types that don't fit
 * any bucket (storage/function/migration) — those are simply not collected
 * into cross-project patterns yet.
 */
export function patternTypeForEventType(eventType: string): PatternType | null {
  if (eventType === 'schema_created' || eventType === 'schema_changed') return 'schema'
  if (eventType === 'api_created' || eventType === 'api_changed') return 'api'
  if (eventType === 'auth_rule_created' || eventType === 'auth_changed') return 'auth'
  if (eventType === 'rollback_created') return 'rollback'
  if (eventType === 'health_check_failed') return 'health_failure'
  return null
}

export interface RecordPatternInput {
  projectType: string
  patternType: PatternType
  resourceType: string
  patternSummary: string
  outcome: 'success' | 'failure' | 'neutral'
  riskLevel?: BackendRiskLevel
}

/**
 * Upsert one anonymized pattern counter. Best-effort — a failure here must
 * never block the real backend mutation that triggered it.
 */
export async function recordPattern(input: RecordPatternInput): Promise<void> {
  try {
    // Atomic upsert on the compound unique key. A findUnique-then-create pair
    // would race under concurrent events: two callers both read null, both
    // create, and the second loses to the unique constraint (dropping its
    // increment). upsert collapses that into one atomic statement. On conflict
    // we do NOT overwrite patternSummary — the first-seen phrasing is kept.
    await prisma.backendPattern.upsert({
      where: {
        projectType_patternType_resourceType: {
          projectType: input.projectType,
          patternType: input.patternType,
          resourceType: input.resourceType,
        },
      },
      create: {
        projectType: input.projectType,
        patternType: input.patternType,
        resourceType: input.resourceType,
        patternSummary: input.patternSummary,
        frequency: 1,
        successCount: input.outcome === 'success' ? 1 : 0,
        failureCount: input.outcome === 'failure' ? 1 : 0,
        riskScore: input.riskLevel ?? 'low',
      },
      update: {
        frequency: { increment: 1 },
        successCount: input.outcome === 'success' ? { increment: 1 } : undefined,
        failureCount: input.outcome === 'failure' ? { increment: 1 } : undefined,
        // Only bump the stored risk when the caller actually classified this
        // event; otherwise leave the existing value untouched.
        riskScore: input.riskLevel ?? undefined,
        lastSeenAt: new Date(),
      },
    })
  } catch (error) {
    console.error('[CrossProjectLearning] Failed to record pattern:', error)
  }
}
