/**
 * The graph without some tables.
 *
 * The active graph describes the workspace schema for the readers that trust
 * it: the Database page (lib/services/workspace-schema-resolver.ts) and the
 * agent's schema grounding, which hands the model the relationships it holds
 * (lib/ai/minimal-executor.ts). A table that is gone from the schema has to go
 * from the graph too: its entity, the API entries that serve it, and the
 * relationships other tables hold to it. Production QA (2026-11-09) found a
 * dropped table still listed on the Database page.
 *
 * Pure: the caller saves the result as a new version of the graph
 * (saveNewGraph), never by editing a version in place.
 */
import type { BackendStateGraph, RelationshipState } from './backend-state-graph'

/** `graph` without `tables` (any case), or null when nothing in it names them. */
export function withoutTables(graph: BackendStateGraph, tables: Iterable<string>): BackendStateGraph | null {
  const gone = new Set([...tables].map((t) => t.toLowerCase()))
  const isGone = (name: unknown) => typeof name === 'string' && gone.has(name.toLowerCase())
  const holdsGone = (r: RelationshipState) => isGone(r?.to) || isGone(r?.from)
  let changed = false

  const entities: BackendStateGraph['entities'] = {}
  for (const [name, entity] of Object.entries(graph.entities ?? {})) {
    if (isGone(name)) {
      changed = true
      continue
    }
    const relationships = entity.relationships
    if (Array.isArray(relationships) && relationships.some(holdsGone)) {
      entities[name] = { ...entity, relationships: relationships.filter((r) => !holdsGone(r)) }
      changed = true
    } else {
      entities[name] = entity
    }
  }

  // An entry serves a table when its path starts with the table's name as a
  // whole segment (`/reviews`, `/reviews/:id`, never `/reviews_archive`) or it
  // names the table as its entity.
  const apis: BackendStateGraph['apis'] = {}
  for (const [path, api] of Object.entries(graph.apis ?? {})) {
    const first = path.split('/').find((segment) => segment !== '')
    if (isGone(first) || isGone((api as { entity?: unknown } | undefined)?.entity)) {
      changed = true
      continue
    }
    apis[path] = api
  }

  return changed ? { ...graph, entities, apis } : null
}
