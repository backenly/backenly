/**
 * Rebuild an extraction plan from a spec and the live catalog.
 *
 * The single place a plan is constructed outside of tests, used at every point
 * that has to agree about what a version means: when it is shown, when it is
 * approved, and immediately before every attempt to run it. A plan is a pure
 * function of (spec, catalog), so rebuilding it is how the executor learns
 * whether the world moved — comparing a stored fingerprint to itself is not.
 */

import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { readTableFacts, relationExists, type TableFacts } from './facts'
import { buildExtractionPlan, type ExtractionPlan } from './plan'
import { isOurSatellite } from './primitives'
import { consumersOf, readProjectConsumers } from './sensing'
import { specProblem, type ExtractionSpec } from './sql'

export type ResolvedExtraction = { plan: ExtractionPlan; facts: TableFacts } | { refusal: string }

export const isResolveRefusal = (r: ResolvedExtraction): r is { refusal: string } => 'refusal' in r

/** Normalise what a caller sent before anything else reads it. */
export function normaliseSpec(raw: unknown): ExtractionSpec | null {
  const s = (raw ?? {}) as Record<string, unknown>
  if (typeof s.host !== 'string' || typeof s.satellite !== 'string' || !Array.isArray(s.members)) return null
  const members = s.members.filter((m): m is string => typeof m === 'string')
  if (members.length !== s.members.length) return null
  return {
    host: s.host.trim(),
    satellite: s.satellite.trim(),
    members: [...new Set(members.map(m => m.trim()))].sort(),
    label: typeof s.label === 'string' && s.label.trim() ? s.label.trim().slice(0, 60) : 'concern',
  }
}

export async function resolveExtractionPlan(projectId: string, spec: ExtractionSpec): Promise<ResolvedExtraction> {
  const problem = specProblem(spec)
  if (problem) return { refusal: problem }
  const schema = await resolveWorkspaceSchema(projectId)
  const facts = await readTableFacts(schema, spec.host)
  if (!facts) return { refusal: `table ${spec.host} does not exist in this project` }

  // A satellite this ladder already created is not a name collision — it is the
  // ladder's own work, and treating it as one would make every resumed run
  // refuse itself.
  const exists = await relationExists(schema, spec.satellite)
  const ours = exists ? isOurSatellite(await readTableFacts(schema, spec.satellite), spec) : false

  const consumers = consumersOf(await readProjectConsumers(projectId), spec.host, spec.members)
  return {
    plan: buildExtractionPlan({ projectId, spec, facts, satelliteExists: exists && !ours, consumers }),
    facts,
  }
}
