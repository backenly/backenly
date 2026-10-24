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
 *
 * On main, a migration is also one governed change (lib/changes/ledger.ts):
 * a checkpoint is taken before its first statement, and protected verification
 * runs after its last. If a statement fails after others ran, or the migration
 * applies and then fails verification, Backenly restores the checkpoint on the
 * spot when that is provably lossless, and otherwise leaves it for a person.
 * The response says which: `applied` is what is in effect now, `rolledBack`
 * what ran and was undone, and `change` how its lifecycle ended.
 */

import { workspaceRawClient } from '@/lib/data-plane/regional'
import { MigrationParseError, parseMigration, type PlannedAction } from '@/lib/mcp/migration-parser'

export interface MigrationRefusal {
  ok: false
  code: string
  error: string
  hint?: string
  statement?: string
  applied: []
}

/** The governed change a migration on main became. */
export interface MigrationChange {
  id: string
  /** "change #12" in the console. */
  seq: number
  /** lib/changes/types.ts: healthy, unverified, recovered, awaiting_approval, manual_intervention_required, ... */
  status: string
  /** Protected verification confirmed the change. */
  verified: boolean
  /** When it failed: the check that failed, or why it could not be recovered. */
  reason?: string
  /** When Backenly recovered it: the recovery's change number. */
  recoverySeq?: number | null
  /** When recovering it waits for a person: the approval to poll. */
  approvalId?: string | null
}

export interface MigrationFailure {
  ok: false
  code: 'MIGRATION_FAILED' | 'VERIFICATION_FAILED'
  error: string
  detail: string
  /** What is in effect now. */
  applied: AppliedStep[]
  remaining: string[]
  hint: string
  change?: MigrationChange
  /** What ran and was then restored to the checkpoint. */
  rolledBack?: AppliedStep[]
  /** True when Backenly restored the previous state and verified it. */
  recovered?: boolean
}

export interface MigrationSuccess {
  ok: true
  summary: string
  applied: AppliedStep[]
  notes: string[]
  change?: MigrationChange
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

/**
 * The tables, of those named, that exist in a schema of the project's
 * database, in its region. Any other database has none of them, which would
 * refuse every ALTER and wave every CREATE through.
 */
export async function existingTables(projectId: string, schema: string, names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set()
  const db = await workspaceRawClient(projectId)
  const found = await db.$queryRaw<Array<{ table_name: string }>>`
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

/** "apply_migration: CREATE TABLE refunds (…) and 2 more statements" */
export function migrationTitle(planned: PlannedAction[]): string {
  const statements = [...new Set(planned.map((p) => p.source.split(' → ')[0]))]
  const first = statements[0]?.replace(/\s+/g, ' ').trim() ?? ''
  const head = first.length > 90 ? `${first.slice(0, 89)}…` : first
  const more = statements.length - 1
  return `apply_migration: ${head}${more > 0 ? ` and ${more} more statement${more === 1 ? '' : 's'}` : ''}`
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
  const existing = await existingTables(projectId, opts.workspaceSchema, tablesNamed(planned))
  const checked = checkPlan(planned, existing)
  if (!checked.ok) return checked as MigrationRefusal
  const ok = checked as Extract<typeof checked, { ok: true }>
  const { dispatchTool } = await import('@/lib/ai/brain/tools')
  const run = () => runPlan(ok.planned, ok.notes, (step) =>
    dispatchTool(step.tool, step.args, {
      projectId,
      userId,
      sessionToken: undefined,
      destructiveConfirmed: false,
      mcpOwnerConfirmed: true,
      agentSurface: opts.agentSurface === true,
      // The parser produced this exact action. On failure, return the source
      // statement to the migration caller rather than model-replanning it.
      allowReplan: false,
      createdThisTurn: new Set<string>(),
    }),
  )

  const { withGovernedChange } = await import('@/lib/changes/ledger')
  const { ChangeInProgressError } = await import('@/lib/changes/lock')
  try {
    const { result, change } = await withGovernedChange(
      {
        projectId,
        title: migrationTitle(ok.planned),
        // The title quotes the first statement, which can carry values: for a
        // project kept in another region the record says only how many.
        regionalTitle: `apply_migration: ${ok.planned.length} statement${ok.planned.length === 1 ? '' : 's'}`,
      },
      run,
      (outcome) => ({
        ok: outcome.ok,
        ...(outcome.ok ? {} : { error: `${(outcome as MigrationFailure).error} ${(outcome as MigrationFailure).detail}` }),
        steps: [
          ...outcome.applied.map((a) => ({ statement: a.statement, tool: a.tool, summary: a.summary, ok: true })),
          ...(outcome.ok ? [] : [{ statement: (outcome as MigrationFailure).error.replace(/^Migration stopped at: /, ''), summary: (outcome as MigrationFailure).detail, ok: false }]),
        ],
      }),
    )
    if (!change) return result
    const failing = change.verification?.checks.find((c) => c.outcome === 'contradicted')
    const recorded: MigrationChange = {
      id: change.id,
      seq: change.seq,
      status: change.status,
      verified: change.status === 'healthy',
      ...(failing ? { reason: `${failing.label}: ${failing.detail}` } : {}),
      ...(change.recovery?.recoverySeq ? { recoverySeq: change.recovery.recoverySeq } : {}),
      ...(change.recovery?.approvalId ? { approvalId: change.recovery.approvalId } : {}),
      ...(change.recovery && !failing ? { reason: change.recovery.explanation } : {}),
    }
    const ranSteps = result.ok ? (result as MigrationSuccess).applied : (result as MigrationFailure).applied

    // Applied, then failed protected verification.
    if (result.ok && change.recovery) {
      const base = {
        ok: false as const,
        code: 'VERIFICATION_FAILED' as const,
        error: `The migration applied, then failed production verification: ${recorded.reason ?? 'see the change'}.`,
        detail: change.recovery.explanation,
        remaining: [],
        change: recorded,
      }
      if (change.status === 'recovered') {
        return {
          ...base,
          applied: [],
          rolledBack: ranSteps,
          recovered: true,
          hint:
            `Nothing from this migration is in effect: Backenly restored the state before it and verified it ` +
            `(change #${change.seq}, recovery #${change.recovery.recoverySeq}). Fix what verification found, then send the migration again.`,
        }
      }
      return {
        ...base,
        applied: ranSteps,
        recovered: false,
        hint:
          change.status === 'awaiting_approval'
            ? `The migration is still in effect. Recovering it would affect data written since it applied, so a person decides` +
              `${change.recovery.approvalId ? `: poll check_approval { id: "${change.recovery.approvalId}" }` : ''}. Do not replay it.`
            : 'The migration is still in effect and needs a person to look at it. Do not replay it.',
      }
    }
    if (result.ok) {
      const success = result as MigrationSuccess
      return {
        ...success,
        change: recorded,
        ...(change.status === 'unverified'
          ? { notes: [...success.notes, 'Applied, but protected verification could not run, so it is not verified.'] }
          : {}),
      }
    }

    // Failed part-way.
    const failure = result as MigrationFailure
    if (change.status === 'recovered') {
      return {
        ...failure,
        applied: [],
        rolledBack: failure.applied,
        recovered: true,
        change: recorded,
        hint:
          `Nothing was applied. The ${failure.applied.length} statement(s) that ran before the failure were restored ` +
          `to the checkpoint automatically (change #${change.seq}, recovery #${change.recovery?.recoverySeq}). ` +
          'Fix the failing statement and send the whole migration again.',
      }
    }
    if (change.recovery) {
      return {
        ...failure,
        change: recorded,
        recovered: false,
        hint:
          'The statements in `applied` DID take effect, and restoring the checkpoint automatically was not possible ' +
          `(${change.recovery.explanation}) — do not replay them. A person decides from History.`,
      }
    }
    return { ...failure, change: recorded }
  } catch (err) {
    if (err instanceof ChangeInProgressError) {
      return {
        ok: false,
        code: err.code,
        error: err.message,
        hint: 'Another schema change is being applied to this project. Nothing was applied; send the migration again in a moment.',
        applied: [],
      }
    }
    throw err
  }
}
