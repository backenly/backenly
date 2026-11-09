/**
 * A merge as a person is asked to approve it, whichever door asked: MCP's
 * `branch { action: "merge" }` (app/api/mcp/tool/route.ts) and backend_chat's
 * merge_branch, which its approval gate parks (lib/mcp/approvals.ts).
 *
 * The request pins the statements its card lists (`approvedMigrations`), so
 * approval replays exactly those or refuses with MERGE_STALE
 * (lib/branches/engine.ts, mergeBranch). backend_chat's merges used to be
 * parked with the branch id alone, so they replayed whatever the branch held
 * at approval, read or not. The card says what the merge does to rows already
 * in production and what Backenly adds to the new tables (./merge-impact.ts).
 */

import { prisma } from '@/lib/db/prisma'
import { impactText, mergeImpact } from './merge-impact'

export type MergeRequest =
  | {
      kind: 'ok'
      branch: string
      target: string
      message: string
      migrations: string[]
      toolArgs: { branchId: string; approvedMigrations: string[] }
    }
  | { kind: 'refused'; status: number; code: string; error: string; hint?: string }

/** `requestedBy` opens the card's text: "Requested by an agent over MCP". */
export async function mergeRequest(projectId: string, branchId: string, requestedBy: string): Promise<MergeRequest> {
  if (!branchId) {
    return { kind: 'refused', status: 400, code: 'BAD_BODY', error: 'A merge needs a branchId.', hint: 'branch { "action": "list" } shows the ids.' }
  }
  const { diffBranch } = await import('./engine')
  const diff = await diffBranch(projectId, branchId).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
  if (!diff.ok) return { kind: 'refused', status: 404, code: 'BRANCH_NOT_FOUND', error: (diff as { error: string }).error }
  const d = diff as Extract<typeof diff, { ok: true }>
  if (d.conflicts.length > 0) {
    return {
      kind: 'refused',
      status: 409,
      code: 'MERGE_CONFLICT',
      error:
        `Main has changed ${d.conflicts.join(', ')} since branch "${d.branch}" was cut, and its migrations touch ` +
        `${d.conflicts.length === 1 ? 'it' : 'them'}. Nothing was requested.`,
      hint: 'Create a new branch from main as it is now and apply the change there.',
    }
  }

  const row = await prisma.workspaceBranch.findFirst({ where: { id: branchId, projectId }, select: { schemaName: true } })
  const impact = row
    ? await mergeImpact(projectId, row.schemaName, d.migrations).catch(() => ({ existingRows: [], added: [] }))
    : { existingRows: [], added: [] }
  const what = impactText(impact)
  const target = `Merge preview branch "${d.branch}" into production`
  const statements = d.migrations.length
    ? d.migrations.map((s) => `  ${s}`).join('\n')
    : '  (no schema changes: the merge only closes the branch)'
  return {
    kind: 'ok',
    branch: d.branch,
    target,
    // The statements come last: the card sets every line after "in order:" as code.
    message: `${requestedBy}: ${target}.${what ? `\n${what}\n` : ' '}These statements will be applied to production, in order:\n${statements}`,
    migrations: d.migrations,
    toolArgs: { branchId, approvedMigrations: d.migrations },
  }
}
