/**
 * "How many REST resources does this project have?" — one answer, from the
 * source of truth.
 *
 * WHY THIS EXISTS
 * ---------------
 * Nine call sites asked that question as
 * `prisma.apiDefinition.count({ where: { projectId } })`. That table has had no
 * create path since the PostgREST cutover on 2026-07-21, so for every project
 * built after it the answer was 0 — permanently, regardless of how many working
 * tables the project had.
 *
 * Nine sites, one wrong number, nine different symptoms: the CLI reported no
 * APIs, the build verifier reported "0 REST endpoints generated" after a
 * successful build, the readiness scan skipped its security audit, and the AI
 * answerer told users their backend had no API surface. Each looked like its own
 * small bug. They were one fact, copied.
 *
 * Under PostgREST a table is reachable because it exists in the catalog and the
 * role holds a grant on it. That is what `listExposedTables` reads, and it is
 * the only thing that decides the answer at request time.
 *
 * Use these helpers rather than counting rows anywhere. The build gate
 * (scripts/assert-no-apidefinition-writes.ts) fails on new ApiDefinition
 * readers precisely so this stays true.
 */

import { listExposedTables, isAuthManagedTable } from '@/lib/mcp/schema-introspection'

export interface ExposedResource {
  /** Table name, which is also the URL segment: /db/<name>. */
  name: string
  /** Path relative to the project's API base. */
  basePath: string
}

/**
 * Every table reachable as a REST resource, sorted by name.
 *
 * Returns an empty list when the catalog cannot be read. That is deliberately
 * the same value as "genuinely nothing exposed", because a caller counting
 * resources for display has nothing better to show either way — but callers
 * that must distinguish "none" from "could not look" should call
 * `listExposedTables` directly and handle the rejection.
 *
 * AUTH-MANAGED TABLES ARE NOT RESOURCES. `listExposedTables` answers catalog
 * VISIBILITY ("is this a real table an agent may see"), which is deliberately
 * true for `users` — it is a real table and list_tables must show it. This
 * function answers REST SURFACE ("is this reachable as /db/<name>"), which
 * `isAuthManagedTable` states must never be true for the auth identity table:
 * it holds password hashes and is managed exclusively through /auth/*.
 *
 * Conflating the two made every freshly-created project report one exposed
 * resource (/db/users) before its owner had built anything. That single wrong
 * number flipped `hasContent` in /api/projects/[id]/state — which had correctly
 * excluded `users` from its own table term, then let the same scaffolding back
 * in through this one — so an empty project rendered the full "built" dashboard,
 * started the autonomy loop, and raised a workflow_broken finding about auth on
 * a backend that had no auth. An empty project must read empty on every surface.
 */
export async function listExposedResources(projectId: string): Promise<ExposedResource[]> {
  const tables = await listExposedTables(projectId).catch(() => [] as Array<{ name: string }>)
  return tables
    .filter(t => !isAuthManagedTable(t.name))
    .map(t => ({ name: t.name, basePath: `/db/${t.name}` }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** How many tables are reachable as REST resources. */
export async function countExposedResources(projectId: string): Promise<number> {
  return (await listExposedResources(projectId)).length
}
