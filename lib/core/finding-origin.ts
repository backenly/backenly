/**
 * WHO RAISED A FINDING
 * ====================
 *
 * A finding's `details.source` is written by two different kinds of code, and
 * means a different thing for each:
 *
 *   - the backend build's reports (lib/core/ai-report-to-health-findings.ts)
 *     and the held-action ledger (lib/operational-memory/ledger.ts) write
 *     WHO raised it: a build step, an agent's risky call, an import;
 *   - Backenly's own detectors write WHAT they read: `pg_stat_statements`
 *     (lib/autonomy/slow-query-index.ts), `infra_intelligence`.
 *
 * The Review Queue read every source but `autonomy` as the build's, so a slow
 * query Backenly measured itself was labelled "From the backend build"
 * (production QA, 2026-11-16). Only the sources that name a raiser get a label;
 * everything else is Backenly's own checks, which need none.
 *
 * Pure and client-safe.
 */

import type { HealthFindingPreviewSource } from './ai-report-to-health-findings'

/** The backend build's report steps, which file findings while a backend is built. */
const BUILD_REPORT_SOURCES = [
  'product_understanding',
  'workflow_extractor',
  'business_rules',
  'state_machines',
  'plan_validator',
  'domain_api_generator',
  'behavior_verification',
] as const satisfies readonly HealthFindingPreviewSource[]

// Every report source is listed: a new one fails to compile until it is.
type Unlisted = Exclude<HealthFindingPreviewSource, (typeof BUILD_REPORT_SOURCES)[number]>
const everyReportSourceListed: [Unlisted] extends [never] ? true : never = true
void everyReportSourceListed

export type FindingOrigin = 'backenly' | 'build' | 'agent' | 'import'

/** Who raised a finding, from its `details.source`. */
export function findingOrigin(source: unknown): FindingOrigin {
  if (source === 'brain-risk') return 'agent'
  if (source === 'import') return 'import'
  // A risky step of a build the orchestrator ran, held for a person.
  if (source === 'orchestration-risk') return 'build'
  if (typeof source === 'string' && (BUILD_REPORT_SOURCES as readonly string[]).includes(source)) return 'build'
  return 'backenly'
}

/** The words a card shows for who raised it, or null for Backenly's own checks. */
export function findingOriginLabel(source: unknown): string | null {
  switch (findingOrigin(source)) {
    case 'agent':
      return 'Raised by an AI agent'
    case 'build':
      return 'From the backend build'
    case 'import':
      return 'From the import'
    default:
      return null
  }
}
