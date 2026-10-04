/**
 * Schema changes ON a preview branch, and their replay onto main at merge.
 *
 * ── Applying to a branch ────────────────────────────────────────────────────
 *
 * apply_migration { sql, branchId } runs the same parser and the same
 * table-existence check as a migration on main (lib/mcp/apply-migration.ts),
 * then hands each typed action to the kernel's own handler in branch mode
 * (executeBranchSchemaAction). The handler issues the DDL main would get, into
 * the branch schema, and writes nothing keyed by the project, so a branch's
 * tables come out exactly the shape production's will after the merge, and
 * production is untouched until then.
 *
 * A table created on the branch then gets the row-level security production
 * would give it, inferred from the BRANCH's catalog. Without that, a preview
 * test of who-can-read-what would pass against an unprotected table that
 * production then protects.
 *
 * Every statement that fully applied is logged (WorkspaceBranchMigration).
 * That log is what a merge replays.
 *
 * ── Replaying onto main ─────────────────────────────────────────────────────
 *
 * A merge replays the logged statements, in order, through apply_migration's
 * main path: the governed kernel, its intent ledger, metadata, auto-RLS and
 * rollback, exactly as if the agent had applied them to main directly. It is
 * refused when main has changed since the branch was cut on a table the log
 * touches, because replaying onto a schema that moved could do something
 * nobody tested.
 */

import { prisma } from '@/lib/db/prisma'
import type { PlannedAction } from '@/lib/mcp/migration-parser'
import {
  applyMigrationToMain,
  checkPlan,
  existingTables,
  fullyAppliedStatements,
  planMigration,
  runPlan,
  tablesNamed,
  type MigrationOutcome,
  type MigrationRefusal,
  type MigrationSuccess,
} from '@/lib/mcp/apply-migration'

export interface BranchRef {
  id: string
  name: string
  schemaName: string
}

async function activeBranch(projectId: string, branchId: string): Promise<BranchRef | null> {
  return prisma.workspaceBranch.findFirst({
    where: { id: branchId, projectId, status: 'active' },
    select: { id: true, name: true, schemaName: true },
  })
}

/** apply_migration { sql, branchId }: the migration on the branch only. */
export async function applyBranchMigration(
  projectId: string,
  branchId: string,
  sql: string,
  userId: string,
): Promise<MigrationOutcome & { branch?: string; recorded?: string[] }> {
  const branch = await activeBranch(projectId, branchId)
  if (!branch) {
    return {
      ok: false,
      code: 'BRANCH_NOT_FOUND',
      error: 'No active preview branch with that id on this project.',
      hint: 'branch { "action": "list" } shows the active branches and their ids.',
      applied: [],
    }
  }

  const plan = planMigration(sql)
  if (!plan.ok) return plan as MigrationRefusal
  const planned = (plan as { ok: true; planned: PlannedAction[] }).planned
  const existing = await existingTables(branch.schemaName, tablesNamed(planned))
  const checked = checkPlan(planned, existing, `on branch "${branch.name}"`)
  if (!checked.ok) return checked as MigrationRefusal
  const ok = checked as Extract<typeof checked, { ok: true }>

  const { executeBranchSchemaAction } = await import('@/lib/ai/minimal-executor')
  const { TOOL_TO_ACTION } = await import('@/lib/ai/brain/tools')
  const created: string[] = []

  const outcome = await runPlan(ok.planned, ok.notes, async (step) => {
    const toAction = TOOL_TO_ACTION[step.tool]
    if (!toAction) return { ok: false, summary: `${step.tool} cannot be applied to a branch.` }
    const result = await executeBranchSchemaAction(toAction(step.args), projectId, branch.schemaName)
    if (result.success && step.tool === 'create_table') created.push(String(step.args.tableName))
    return { ok: result.success, summary: result.message }
  })

  // Row security for what was created, as production would install it.
  const rlsNotes: string[] = []
  if (created.length > 0) {
    const { autoApplyRlsIfNeeded } = await import('@/lib/services/workspace-rls')
    for (const table of created) {
      try {
        await autoApplyRlsIfNeeded(projectId, table, [], { schemaName: branch.schemaName })
      } catch (err) {
        rlsNotes.push(`Row security for ${table} could not be applied on the branch: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // Log what fully applied, success or not: a partial run still changed the
  // branch, and the merge must replay exactly what the branch holds.
  const recorded = fullyAppliedStatements(ok.planned, outcome.applied)
  if (recorded.length > 0) await recordMigration(branch.id, recorded, userId)

  if (!outcome.ok) return { ...outcome, branch: branch.name, recorded }
  const success = outcome as MigrationSuccess
  return {
    ...success,
    summary: `On branch "${branch.name}": ${success.summary}` + (rlsNotes.length ? ` ${rlsNotes.join(' ')}` : ''),
    notes: [...success.notes, ...rlsNotes],
    branch: branch.name,
    recorded,
  }
}

async function recordMigration(branchId: string, statements: string[], userId: string): Promise<void> {
  // seq is assigned under the unique (branchId, seq) index; a concurrent call
  // that loses the race retries once with the next number.
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = await prisma.workspaceBranchMigration.findFirst({
      where: { branchId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    })
    try {
      await prisma.workspaceBranchMigration.create({
        data: { branchId, seq: (last?.seq ?? 0) + 1, statements, appliedBy: userId },
      })
      return
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err
    }
  }
  throw new Error('Could not record the branch migration after three attempts.')
}

/** Every statement logged on a branch, in the order it was applied. */
export async function branchStatements(branchId: string): Promise<string[]> {
  const rows = await prisma.workspaceBranchMigration.findMany({
    where: { branchId },
    orderBy: { seq: 'asc' },
    select: { statements: true },
  })
  return rows.flatMap((r) => (Array.isArray(r.statements) ? (r.statements as unknown[]).map(String) : []))
}

/** The tables a list of statements touches, from the parser itself. */
export function tablesTouched(statements: string[]): string[] {
  const plan = planMigration(statements.join(';\n'))
  if (!plan.ok) return []
  return tablesNamed((plan as { ok: true; planned: PlannedAction[] }).planned)
}

/**
 * Replay a branch's logged statements onto main.
 *
 * Statement by statement through the main path, stopping at the first failure
 * with what applied and what remains, the same contract apply_migration gives
 * an agent. No agent flag: this runs because a human approved the merge, so the
 * protected-production gate does not apply to it.
 */
export async function replayOntoMain(
  projectId: string,
  userId: string,
  statements: string[],
): Promise<{ ok: true; applied: string[] } | { ok: false; applied: string[]; failedAt: string; detail: string; remaining: string[] }> {
  const { workspaceSchemaName } = await import('@/lib/security/workspace-schema')
  const workspaceSchema = workspaceSchemaName(projectId)
  const applied: string[] = []
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i]
    const outcome = await applyMigrationToMain(projectId, userId, stmt, { agentSurface: false, workspaceSchema })
    if (!outcome.ok) {
      // This tsconfig does not narrow on a boolean discriminant, so the failure
      // arms are named explicitly.
      const fail = outcome as MigrationRefusal | { error: string; detail: string }
      const detail = 'detail' in fail ? `${fail.error}: ${fail.detail}` : fail.error
      return { ok: false, applied, failedAt: stmt, detail, remaining: statements.slice(i + 1) }
    }
    applied.push(stmt)
  }
  return { ok: true, applied }
}
