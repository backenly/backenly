/**
 * LOADING A PLAN THAT WAS NEVER STORED
 * ====================================
 *
 * A maintenance plan is a pure function of a finding, its subsystem, a
 * structural diagnosis and a catalog fingerprint. Nothing persists it, and
 * nothing should: a stored plan is a claim about a schema that may have moved
 * since, and the whole point of `isPlanStale` is that such a claim expires.
 *
 * So "load plan X" means "rebuild it and check you got X". The identifiers a
 * caller supplies are ASSERTIONS, not lookup keys:
 *
 *   --plan <id>            must equal the rebuilt planId
 *   --plan-version <hash>  must equal the rebuilt planVersion
 *
 * A mismatch is the useful outcome. `planVersion` covers the ladder, the catalog
 * fingerprint AND the executor capability table, so any of those moving makes
 * the rebuild disagree with what the operator typed — which is exactly when a
 * plan should not run.
 *
 * ── This does not discover anything ─────────────────────────────────────────
 *
 * One finding, named explicitly. There is no "find all eligible maintenance"
 * here and there must not be: that function is a scheduler, and a scheduler is
 * how this becomes autonomous for everyone before one plan has gone end to end.
 */

import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db'
import { readWorkspaceSchema } from '@/lib/typegen/schema-reader'
import { computeSubsystems, subsystemOf } from '../subsystem'
import { diagnoseStructuralCause } from '../hypothesis/structural'
import { buildMaintenancePlan, type MaintenancePlan } from './plan'

export interface ResolvedPlan {
  plan: MaintenancePlan
  subsystem: { fingerprint: string; membership: string[] }
  catalogFingerprint: string
  /** The table the finding is about, which anchored the subsystem lookup. */
  table: string
}

export interface ResolveRefusal {
  refusal: string
}

export type ResolveResult = ResolvedPlan | ResolveRefusal

export const isRefusal = (r: ResolveResult): r is ResolveRefusal =>
  (r as ResolveRefusal).refusal !== undefined

/**
 * A stable identity for the live schema.
 *
 * Tables and columns only, sorted, with `generatedAt` deliberately excluded —
 * including a timestamp would make every plan instantly stale against itself.
 * It does not cover indexes or policies: this identifies the shape a ladder's
 * preconditions were computed against, and those preconditions are about
 * columns.
 */
export async function computeCatalogFingerprint(projectId: string): Promise<string> {
  const schema = await readWorkspaceSchema(projectId)
  const shape = schema.tables
    .map(t => {
      // `udtName` rather than `dataType`: it distinguishes `uuid` from `text`
      // and an array from its element type, both of which change whether a
      // ladder's preconditions still hold.
      const cols = t.columns.map(c => `${c.columnName}:${c.udtName}:${c.isNullable ? 'null' : 'notnull'}`)
      return `${t.tableName}(${cols.sort().join(',')})`
    })
    .sort()
    .join(';')
  return createHash('sha256').update(shape).digest('hex').slice(0, 16)
}

/**
 * Rebuild the plan for one named finding.
 *
 * Every failure is a refusal with a reason rather than an exception, because
 * each one is a legitimate answer the report has to be able to print: the
 * finding is gone, its table is not in an eligible subsystem, the diagnosis is
 * inconclusive.
 */
export async function resolveMaintenancePlan(input: {
  projectId: string
  findingId: string
}): Promise<ResolveResult> {
  const { projectId, findingId } = input

  const finding = await prisma.healthFinding
    .findUnique({ where: { id: findingId }, select: { id: true, projectId: true, type: true, details: true } })
    .catch(() => null)
  if (!finding) return { refusal: `finding ${findingId} does not exist` }
  if (finding.projectId !== projectId) {
    return { refusal: `finding ${findingId} belongs to a different project` }
  }

  const details = (finding.details ?? {}) as Record<string, unknown>
  // Rows written before the detector named an anchor table still carry their
  // membership; any member resolves the same subsystem while it is unchanged,
  // and a changed membership is refused below as it should be.
  const membership = Array.isArray(details.membership)
    ? (details.membership as unknown[]).filter((t): t is string => typeof t === 'string').sort()
    : []
  const table = typeof details.table === 'string'
    ? details.table
    : typeof details.tableName === 'string'
      ? details.tableName
      : membership[0] ?? null
  if (!table) return { refusal: `finding ${findingId} names no table, so no subsystem can be resolved` }

  const map = await computeSubsystems(projectId)
  const subsystem = subsystemOf(map, table)
  if (!subsystem) {
    return { refusal: `table "${table}" is not in an eligible subsystem` }
  }

  // The diagnosis is re-run rather than recalled. A plan built from a stale
  // diagnosis is a remedy for a problem that may already be gone.
  const diagnosis = await diagnoseStructuralCause(projectId, [...subsystem.membership])
  const catalogFingerprint = await computeCatalogFingerprint(projectId)

  const plan = buildMaintenancePlan({
    findingId,
    diagnosis,
    subsystem: { fingerprint: subsystem.fingerprint, membership: [...subsystem.membership] },
    catalogFingerprint,
  })

  return {
    plan,
    subsystem: { fingerprint: subsystem.fingerprint, membership: [...subsystem.membership] },
    catalogFingerprint,
    table,
  }
}
