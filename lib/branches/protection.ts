/**
 * Protected production: on a protected project, a coding agent changes the
 * schema on a preview branch, and production receives it only through a merge
 * a human approved.
 *
 * The gate is the coding agent's door, not every door:
 *   - a human in the dashboard is the reviewer, so their changes are not gated;
 *   - autonomy's own governed fixes have their own guardrails and approvals;
 *   - row writes (db_insert/update/delete) are data, not schema;
 *   - destructive schema tools (drop_table, drop_column) already wait for a
 *     human, which is what protection asks for;
 *   - a merge replay, and any call a human approved, runs without the agent
 *     flag and so is not gated either.
 *
 * Backenly Cloud only. A self-hosted install has no branches, so protection
 * there would leave an agent no way to change the schema at all; it is never
 * reported as on, whatever the column says.
 */

import { prisma } from '@/lib/db/prisma'
import { isCloudEdition } from '@/lib/edition/cloud-only'

export const BRANCH_REQUIRED = 'BRANCH_REQUIRED'

/** Brain tools that change the schema without waiting for a human. */
export const GATED_SCHEMA_TOOLS: ReadonlySet<string> = new Set([
  'create_table',
  'add_column',
  'create_index',
  'rename_column',
  'add_constraint',
  'enable_vector_search',
  'run_data_migration',
  'enable_teams',
])

const CACHE_TTL_MS = 15_000
const cache = new Map<string, { protectedProduction: boolean; at: number }>()

/** Whether an agent must use a branch to change this project's schema. */
export async function isProductionProtected(projectId: string): Promise<boolean> {
  if (!isCloudEdition()) return false
  const hit = cache.get(projectId)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.protectedProduction
  const row = await prisma.project.findUnique({ where: { id: projectId }, select: { protectedProduction: true } })
  const protectedProduction = row?.protectedProduction === true
  cache.set(projectId, { protectedProduction, at: Date.now() })
  return protectedProduction
}

/** Forget a project's cached setting, after the owner changes it. */
export function forgetProtection(projectId?: string): void {
  if (projectId) cache.delete(projectId)
  else cache.clear()
}

/** The refusal an agent gets, naming the exact next call. */
export function branchRequired(what: string): { code: typeof BRANCH_REQUIRED; error: string; hint: string } {
  return {
    code: BRANCH_REQUIRED,
    error:
      `${what} was not applied: this project's production is protected, so schema changes are made on a ` +
      `preview branch and reach production through a merge a human approves.`,
    hint:
      'Create one with branch { "action": "create", "name": "<change>" }, apply the change with ' +
      'apply_migration { "sql": "…", "branchId": "<id>" }, test it against the branch\'s preview endpoint, ' +
      'then branch { "action": "merge", "branchId": "<id>" } to request the merge.',
  }
}
