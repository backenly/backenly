/**
 * apply_migration's core: SQL in, governed typed actions out, applied in order.
 *
 * Shared by three callers so they can never disagree about what a migration
 * means:
 *   - the MCP tool route, for a migration on main;
 *   - lib/branches/migrate.ts, for the same migration on a preview branch;
 *   - a branch merge, which replays the branch's statements onto main.
 *
 * The parse is all-or-nothing, so a migration can never half-apply from a
 * statement that could not be translated. Every statement is then checked
 * against the tables that exist (plus those the migration creates before it)
 * before anything runs. Execution stops at the first failure and reports
 * exactly what applied and what remains, because an agent that knows three of
 * five statements landed can finish the job, and one told only "failed" replays
 * the lot.
 */

import { prisma } from '@/lib/db/prisma'
import { MigrationParseError, parseMigration, type PlannedAction } from '@/lib/mcp/migration-parser'

export interface MigrationRefusal {
  ok: false
  code: string
  error: string
  hint?: string
  statement?: string
  applied: []
}

export interface MigrationFailure {
  ok: false
  code: 'MIGRATION_FAILED'
  error: string
  detail: string
  applied: AppliedStep[]
  remaining: string[]
  hint: string
}

export interface MigrationSuccess {
  ok: true
  summary: string
  applied: AppliedStep[]
  notes: string[]
}

export type MigrationOutcome = MigrationRefusal | MigrationFailure | MigrationSuccess

export interface AppliedStep {
  statement: string
  tool: string
  summary: string
}

export type StepRunner = (step: PlannedAction) => Promise<{ ok: boolean; summary: string }>

/** Parse, refusing an empty or untranslatable migration with nothing applied. */
export function planMigration(sql: string): { ok: true; planned: PlannedAction[] } | MigrationRefusal {
  if (!sql.trim()) {
    return {
      ok: false,
      code: 'EMPTY_MIGRATION',
      error: 'apply_migration requires { sql }.',
      hint: 'e.g. { "sql": "ALTER TABLE posts ADD COLUMN likes integer DEFAULT 0" }',
      applied: [],
    }
  }
  try {
    return { ok: true, planned: parseMigration(sql) }
  } catch (err) {
    if (!(err instanceof MigrationParseError)) throw err
    return {
      ok: false,
      code: err.code,
      error: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.statement ? { statement: err.statement } : {}),
      applied: [],
    }
  }
}

/** The tables, of those named, that exist in a schema. */
export async function existingTables(schema: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set()
  const found = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_name = ANY(${names})`
  return new Set(found.map((r) => r.table_name))
}

const tableOf = (p: { args: Record<string, unknown> }) => String(p.args.tableName ?? '')

/** Every table a plan names. */
export function tablesNamed(planned: PlannedAction[]): string[] {
  return [...new Set(planned.map(tableOf).filter(Boolean))]
}

/**
 * Check every statement against the tables that actually exist.
 *
 * The executors were never asked. create_table answered "Created table …" for
 * a table that was already there and changed nothing, and add_column on a
 * table that did not exist CREATED it, so a typo in `ALTER TABLE <name>` made a
 * new table instead of failing. CREATE TABLE of an existing table is refused;
 * CREATE TABLE IF NOT EXISTS leaves it as it is and says so; a statement on a
 * table that does not exist is refused.
 *
 * `where` names the target in messages: "in this project", "on branch \"x\"".
 */
export function checkPlan(
  planned: PlannedAction[],
  existing: Set<string>,
  where = 'in this project',
): { ok: true; planned: PlannedAction[]; notes: string[] } | MigrationRefusal {
  const willExist = new Set(existing)
  const skipped = new Set<string>()
  const notes: string[] = []
  for (const step of planned) {
    const table = tableOf(step)
    if (!table || skipped.has(step.source)) continue
    if (step.tool === 'create_table') {
      if (!willExist.has(table)) { willExist.add(table); continue }
      if (!/^\s*create\s+table\s+if\s+not\s+exists\b/i.test(step.source)) {
        return {
          ok: false,
          code: 'TABLE_EXISTS',
          error: `Table ${table} already exists, so CREATE TABLE would change nothing. Nothing was applied.`,
          statement: step.source,
          hint: `To add columns use ALTER TABLE ${table} ADD COLUMN …; get_table_schema shows what ${table} has now.`,
          applied: [],
        }
      }
      // IF NOT EXISTS: skip the statement and everything it expanded into.
      skipped.add(step.source)
      notes.push(`${table} already existed; CREATE TABLE IF NOT EXISTS left it unchanged.`)
      continue
    }
    if (!willExist.has(table)) {
      return {
        ok: false,
        code: 'TABLE_NOT_FOUND',
        error: `There is no table ${table} ${where}, so "${step.source}" cannot run. Nothing was applied.`,
        statement: step.source,
        hint: `Check the name with read_backend_state { section: "tables" }, or create it first with CREATE TABLE ${table} (…).`,
        applied: [],
      }
    }
  }
  return {
    ok: true,
    planned: planned.filter((p) => ![...skipped].some((s) => p.source === s || p.source.startsWith(`${s} → `))),
    notes: [...notes, ...planned.flatMap((p) => p.notes ?? [])],
  }
}

/** Run a checked plan in order, stopping at the first failure. */
export async function runPlan(
  planned: PlannedAction[],
  notes: string[],
  run: StepRunner,
): Promise<MigrationFailure | MigrationSuccess> {
  const applied: AppliedStep[] = []
  for (let i = 0; i < planned.length; i++) {
    const step = planned[i]
    let result: { ok: boolean; summary: string }
    try {
      result = await run(step)
    } catch (err) {
      result = { ok: false, summary: err instanceof Error ? err.message : 'Dispatch failed' }
    }
    if (!result.ok) {
      return {
        ok: false,
        code: 'MIGRATION_FAILED',
        error: `Migration stopped at: ${step.source}`,
        detail: result.summary,
        applied,
        remaining: planned.slice(i + 1).map((p) => p.source),
        hint: applied.length
          ? 'The statements in `applied` DID take effect — do not replay them. Fix the failing statement and re-send only what remains.'
          : 'Nothing was applied.',
      }
    }
    applied.push({ statement: step.source, tool: step.tool, summary: result.summary })
  }
  return {
    ok: true,
    summary:
      `Applied ${applied.length} statement(s): ` +
      applied.map((a) => a.summary).join(' · ') +
      (notes.length ? ` (${notes.join(' ')})` : ''),
    applied,
    notes,
  }
}

/**
 * The whole SQL statements that fully applied, in order.
 *
 * One statement may expand into several steps (`<stmt> → UNIQUE (…)`); it
 * counts only once every one of its steps applied. This is what a branch
 * records and what its merge replays.
 */
export function fullyAppliedStatements(planned: PlannedAction[], applied: AppliedStep[]): string[] {
  const statementOf = (source: string) => source.split(' → ')[0]
  const appliedSources = new Set(applied.map((a) => a.statement))
  const order: string[] = []
  const complete = new Map<string, boolean>()
  for (const step of planned) {
    const stmt = statementOf(step.source)
    if (!complete.has(stmt)) { complete.set(stmt, true); order.push(stmt) }
    if (!appliedSources.has(step.source)) complete.set(stmt, false)
  }
  return order.filter((s) => complete.get(s))
}

/**
 * Apply a migration to a project's MAIN schema through the brain's dispatch,
 * so approval gates, the intent ledger and rollback behave exactly as a typed
 * call would. `agentSurface` marks a coding agent as the caller, which is what
 * the protected-production gate in dispatchTool keys on; a merge replay that a
 * human approved does not set it.
 */
export async function applyMigrationToMain(
  projectId: string,
  userId: string,
  sql: string,
  opts: { agentSurface?: boolean; workspaceSchema: string },
): Promise<MigrationOutcome> {
  const plan = planMigration(sql)
  if (!plan.ok) return plan as MigrationRefusal
  const planned = (plan as { ok: true; planned: PlannedAction[] }).planned
  const existing = await existingTables(opts.workspaceSchema, tablesNamed(planned))
  const checked = checkPlan(planned, existing)
  if (!checked.ok) return checked as MigrationRefusal
  const ok = checked as Extract<typeof checked, { ok: true }>
  const { dispatchTool } = await import('@/lib/ai/brain/tools')
  return runPlan(ok.planned, ok.notes, (step) =>
    dispatchTool(step.tool, step.args, {
      projectId,
      userId,
      sessionToken: undefined,
      destructiveConfirmed: false,
      mcpOwnerConfirmed: true,
      agentSurface: opts.agentSurface === true,
      createdThisTurn: new Set<string>(),
    }),
  )
}
