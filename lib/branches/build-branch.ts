/**
 * backend_chat building on a preview branch, on a project whose production is
 * protected.
 *
 * The gate (./protection.ts) refuses every schema change an agent makes on
 * main. Run anyway, backend_chat's turn was a refusal per table, and it came
 * back as a plan for the coding agent to carry out with branch and
 * apply_migration: production QA (2026-11-09, report 97) watched it work two
 * minutes and hand back a design document. The builder sold as "Backenly runs
 * its own model for you" was a planner on Cloud, where protection is the
 * default.
 *
 * Now the turn builds the schema itself, on a preview branch, and asks a
 * person once: one merge of that branch into production, through the same
 * request a coding agent's `branch { action: "merge" }` raises
 * (./merge-request.ts: the statements pinned, what they do to production's
 * rows, and a refusal before anyone is asked when they would fail there).
 *
 * ── How a typed call reaches the branch ─────────────────────────────────────
 *
 * The brain speaks in typed calls (create_table { tableName, columns }); a
 * branch keeps SQL, because a merge replays the statements it logged through
 * apply_migration's main path (./migrate.ts). Each typed schema call is
 * written as the SQL statement it stands for and applied with
 * applyBranchMigration, so the branch, its log and the replay on production
 * all come from the same statement read by the same parser. Like any
 * migration, it is applied as written: nothing is inferred from a column's
 * name, so a key is declared with `fkTo` and a unique column with
 * `unique: true`.
 *
 * ── What waits for the merge ────────────────────────────────────────────────
 *
 * Steps that are not schema changes but act on a table only the branch has
 * (its REST API, row security, realtime, triggers, seed rows) cannot run on
 * production before the table is there. They are saved, and run on production
 * when the agent says "continue" after the merge.
 */

import { prisma } from '@/lib/db/prisma'
import { exactSqlType } from '@/lib/mcp/migration-parser'
import type { BlueprintStep } from '@/lib/ai/blueprints/types'

// ── Typed schema calls, written as SQL ──────────────────────────────────────

const ident = (name: string) => `"${String(name).replace(/"/g, '""')}"`

/** The typed vocabulary's type names, as SQL the migration parser reads back. */
const TYPED_SQL_TYPES: Record<string, string> = {
  text: 'text', string: 'text', varchar: 'text', char: 'text', citext: 'text',
  int: 'integer', integer: 'integer', int4: 'integer', smallint: 'smallint', int2: 'smallint',
  bigint: 'bigint', int8: 'bigint',
  boolean: 'boolean', bool: 'boolean',
  // As the typed path creates them (normalizeColumnType): a timestamp without a zone.
  timestamp: 'timestamp', timestamptz: 'timestamptz', datetime: 'timestamp',
  date: 'date', time: 'time',
  uuid: 'uuid',
  json: 'jsonb', jsonb: 'jsonb',
  numeric: 'numeric', decimal: 'numeric', money: 'numeric',
  float: 'double precision', double: 'double precision', real: 'real', 'double precision': 'double precision',
}

function sqlType(raw: unknown): string | null {
  const typed = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!typed) return null
  const array = typed.endsWith('[]')
  const base = array ? typed.slice(0, -2).trim() : typed
  // A spelling SQL already has (`numeric(10,2)`, `varchar(80)`) is kept exactly.
  const exact = exactSqlType(base) ? base : TYPED_SQL_TYPES[base]
  if (!exact) return null
  return array ? `${exact}[]` : exact
}

/**
 * A typed default, as the SQL expression it means. A model writes `pending`
 * for the text 'pending'; written bare, that would name a column. Numbers,
 * booleans, NULL, function calls, the CURRENT_* keywords and anything already
 * quoted or cast are kept as they are.
 */
function sqlDefault(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const v = String(value).trim()
  if (!v) return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return v
  if (/^(true|false|null)$/i.test(v)) return v
  if (/^(current_timestamp|current_date|current_time|localtimestamp|localtime)$/i.test(v)) return v
  if (/^[A-Za-z_][A-Za-z0-9_.]*\(\s*\)$/.test(v)) return v
  if (/^'[\s\S]*'(::[A-Za-z_][A-Za-z0-9_ \[\]]*)?$/.test(v)) return v
  return `'${v.replace(/'/g, "''")}'`
}

interface TypedColumn {
  name?: unknown
  type?: unknown
  nullable?: unknown
  notNull?: unknown
  required?: unknown
  unique?: unknown
  fkTo?: unknown
  default?: unknown
}

function columnSql(col: TypedColumn): string | { error: string } {
  const name = String(col.name ?? '').trim()
  if (!name) return { error: 'A column has no name.' }
  const type = sqlType(col.type)
  if (!type) return { error: `Column "${name}" has type "${String(col.type ?? '')}", which cannot be built on a branch.` }
  const parts = [ident(name), type]
  if (col.nullable === false || col.notNull === true || col.required === true) parts.push('NOT NULL')
  if (col.unique === true) parts.push('UNIQUE')
  const dflt = sqlDefault(col.default)
  if (dflt !== null) parts.push(`DEFAULT ${dflt}`)
  if (typeof col.fkTo === 'string' && col.fkTo.trim()) parts.push(`REFERENCES ${ident(col.fkTo.trim())} (${ident('id')})`)
  return parts.join(' ')
}

/**
 * The SQL statement a typed schema call stands for, or why it has none. Only
 * the calls a branch migration takes are written; the result is read back by
 * the migration parser before anything runs, so a statement it cannot read is
 * refused there, never applied as something else.
 */
export function schemaCallSql(tool: string, args: Record<string, unknown>): { sql: string } | { error: string } {
  const table = String(args.tableName ?? '').trim()
  if (!table) return { error: `${tool} needs a tableName.` }
  const t = ident(table)

  switch (tool) {
    case 'create_table': {
      const columns = Array.isArray(args.columns) ? (args.columns as TypedColumn[]) : []
      if (columns.length === 0) return { error: `create_table on "${table}" declares no columns.` }
      const defs: string[] = []
      for (const col of columns) {
        const def = columnSql(col)
        if (typeof def !== 'string') return def
        defs.push(def)
      }
      return { sql: `CREATE TABLE ${t} (${defs.join(', ')})` }
    }
    case 'add_column': {
      const column: TypedColumn =
        args.column && typeof args.column === 'object'
          ? (args.column as TypedColumn)
          : { name: args.columnName, type: args.columnType, nullable: args.nullable, default: args.default }
      const def = columnSql(column)
      if (typeof def !== 'string') return def
      return { sql: `ALTER TABLE ${t} ADD COLUMN ${def}` }
    }
    case 'create_index': {
      const columns = (Array.isArray(args.columns) ? args.columns : [args.columnName]).map((c) => String(c ?? '').trim()).filter(Boolean)
      if (columns.length === 0) return { error: `create_index on "${table}" names no columns.` }
      const name = typeof args.indexName === 'string' && args.indexName.trim() ? ` ${ident(args.indexName.trim())}` : ''
      const method = typeof args.method === 'string' && args.method.trim() ? ` USING ${args.method.trim().toLowerCase()}` : ''
      const where = typeof args.where === 'string' && args.where.trim() ? ` WHERE ${args.where.trim()}` : ''
      return { sql: `CREATE ${args.unique === true ? 'UNIQUE ' : ''}INDEX${name} ON ${t}${method} (${columns.map(ident).join(', ')})${where}` }
    }
    case 'rename_column': {
      const from = String(args.oldName ?? '').trim()
      const to = String(args.newName ?? '').trim()
      if (!from || !to) return { error: 'rename_column needs oldName and newName.' }
      return { sql: `ALTER TABLE ${t} RENAME COLUMN ${ident(from)} TO ${ident(to)}` }
    }
    case 'add_constraint': {
      const kind = String(args.constraintType ?? '').trim().toLowerCase().replace(/\s+/g, '_')
      const columns = (Array.isArray(args.columns) ? args.columns : [args.columnName]).map((c) => String(c ?? '').trim()).filter(Boolean)
      const column = String(args.columnName ?? columns[0] ?? '').trim()
      const named = typeof args.constraintName === 'string' && args.constraintName.trim() ? `CONSTRAINT ${ident(args.constraintName.trim())} ` : ''
      const expression = typeof args.expression === 'string' ? args.expression.trim() : ''
      switch (kind) {
        case 'unique':
          if (columns.length === 0) return { error: 'A UNIQUE constraint names no columns.' }
          return { sql: `ALTER TABLE ${t} ADD ${named}UNIQUE (${columns.map(ident).join(', ')})` }
        case 'check':
          if (!expression) return { error: 'A CHECK constraint needs an expression.' }
          return { sql: `ALTER TABLE ${t} ADD ${named}CHECK (${expression})` }
        case 'foreign_key':
        case 'fk': {
          const target = String(args.referencedTable ?? /^([A-Za-z_][A-Za-z0-9_$]*)\s*\(/.exec(expression)?.[1] ?? '').trim()
          if (!column || !target) return { error: 'A foreign key needs columnName and referencedTable.' }
          return { sql: `ALTER TABLE ${t} ADD ${named}FOREIGN KEY (${ident(column)}) REFERENCES ${ident(target)} (${ident('id')})` }
        }
        case 'not_null':
          if (!column) return { error: 'NOT NULL needs a columnName.' }
          return { sql: `ALTER TABLE ${t} ALTER COLUMN ${ident(column)} SET NOT NULL` }
        case 'drop_not_null':
          if (!column) return { error: 'DROP NOT NULL needs a columnName.' }
          return { sql: `ALTER TABLE ${t} ALTER COLUMN ${ident(column)} DROP NOT NULL` }
        case 'set_default':
        case 'default': {
          const dflt = sqlDefault(expression || args.default)
          if (!column || dflt === null) return { error: 'A default needs a columnName and a value.' }
          return { sql: `ALTER TABLE ${t} ALTER COLUMN ${ident(column)} SET DEFAULT ${dflt}` }
        }
        case 'drop_default':
          if (!column) return { error: 'DROP DEFAULT needs a columnName.' }
          return { sql: `ALTER TABLE ${t} ALTER COLUMN ${ident(column)} DROP DEFAULT` }
        default:
          return { error: `A "${kind || 'unnamed'}" constraint cannot be built on a branch.` }
      }
    }
    default:
      return { error: `${tool} cannot be built on a branch.` }
  }
}

// ── The turn's branch ───────────────────────────────────────────────────────

/** Steps that act on a table only the branch has: run on production after the merge. */
export const AFTER_MERGE_TOOLS: ReadonlySet<string> = new Set([
  'generate_api',
  'add_rls',
  'set_rls',
  'enable_realtime',
  'create_trigger',
  'seed_rows',
])

export interface TurnBranch {
  id: string
  name: string
  schemaName: string
}

/** A step saved to run on production once the merge has landed. */
export interface AfterMergeStep {
  label: string
  tool: string
  args: Record<string, unknown>
}

const PREF_TYPE = 'pending_plan'
const BRANCH_KEY = 'build_branch'
const AFTER_MERGE_KEY = 'after_merge'
/** As long as the merge request it waits for (lib/mcp/approvals.ts APPROVAL_TTL_MS). */
const AFTER_MERGE_TTL_MS = 24 * 60 * 60 * 1000

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'to', 'for', 'of', 'with', 'me', 'my', 'please', 'build', 'create', 'make', 'add',
  'i', 'we', 'want', 'need', 'can', 'you', 'on', 'in', 'into', 'backend', 'table', 'tables', 'app', 'that', 'this',
  'it', 'so', 'new', 'some', 'our', 'let', 'lets', 'should', 'be', 'is', 'are', 'set', 'up', 'support',
])

/** A branch name from the request's own words: "Add wishlists and product Q&A" → "wishlists-product-q". */
export function branchNameFor(request: string): string {
  const words = (request.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []).filter((w) => !STOP_WORDS.has(w))
  let name = ''
  for (const w of words.slice(0, 3)) {
    const next = name ? `${name}-${w}` : w
    if (next.length > 24) break
    name = next
  }
  return name.length >= 2 ? name : 'build'
}

/** Whether a merge of this branch is waiting for, or being run by, a person. */
export async function mergeAwaited(projectId: string, branchId: string): Promise<{ id: string; status: string } | null> {
  const rows = await prisma.agentApprovalRequest.findMany({
    where: { projectId, tool: 'merge_branch', status: { in: ['pending', 'approved'] } },
    select: { id: true, status: true, toolArgs: true },
    orderBy: { createdAt: 'desc' },
  })
  for (const r of rows) {
    const args = (r.toolArgs ?? {}) as Record<string, unknown>
    // A request kept in another region holds a stand-in here; it may be this branch's.
    if (args.branchId === branchId || typeof args.branchId !== 'string') return { id: r.id, status: r.status }
  }
  return null
}

/**
 * The preview branch one backend_chat turn builds on, opened on its first
 * schema call. The branch an earlier turn built on is used again while it is
 * active and no merge of it is waiting, so a build carried over several turns
 * ("continue") becomes one merge. A branch already put to a person is never
 * changed under them: its request pins the statements it lists, so the next
 * build starts a branch of its own.
 */
export class BuildBranch {
  private branch: TurnBranch | null = null
  private opening: Promise<TurnBranch | { error: string }> | null = null
  /** Statements this turn applied to the branch, in order. */
  readonly statements: string[] = []
  /** Steps this turn saved for after the merge. */
  readonly afterMerge: AfterMergeStep[] = []

  constructor(
    readonly projectId: string,
    readonly userId: string,
    /** The words a new branch is named after: the request, or the plan it runs. */
    private nameHint: string,
  ) {}

  /** Name a branch this turn has yet to open after `words` (a plan's title) rather than the message. */
  nameAfter(words: string | undefined): void {
    if (words && words.trim() && !this.branch) this.nameHint = words
  }

  get current(): TurnBranch | null {
    return this.branch
  }

  /** The turn's branch: the one it already has, an earlier turn's still open, or a new one. */
  open(): Promise<TurnBranch | { error: string }> {
    if (this.branch) return Promise.resolve(this.branch)
    if (!this.opening) {
      this.opening = this.openOnce().then((b) => {
        if ('id' in b) this.branch = b
        else this.opening = null
        return b
      })
    }
    return this.opening
  }

  private async openOnce(): Promise<TurnBranch | { error: string }> {
    const earlier = await loadBuildBranch(this.projectId)
    if (earlier) {
      const row = await prisma.workspaceBranch.findFirst({
        where: { id: earlier.branchId, projectId: this.projectId, status: 'active' },
        select: { id: true, name: true, schemaName: true },
      })
      if (row && !(await mergeAwaited(this.projectId, row.id))) return row
    }
    const { createBranch } = await import('./engine')
    const base = branchNameFor(this.nameHint)
    let lastError = 'the branch could not be created'
    for (let n = 1; n <= 5; n++) {
      const name = n === 1 ? base : `${base.slice(0, 27)}-${n}`
      const created = await createBranch(this.projectId, this.userId, name)
      if (created.ok) {
        const b = { id: created.branch.id, name: created.branch.name, schemaName: created.branch.schemaName }
        await saveBuildBranch(this.projectId, b).catch(() => {})
        return b
      }
      lastError = created.error
      if (!/already exists/i.test(created.error)) break
    }
    return { error: lastError }
  }

  /** Whether `table` exists on this turn's branch and not on production. */
  async onlyOnBranch(table: string): Promise<boolean> {
    const branch = this.branch ?? (await this.earlierBranch())
    if (!branch || !table) return false
    const rows = await prisma.$queryRaw<Array<{ schema: string }>>`
      SELECT table_schema AS schema FROM information_schema.tables
       WHERE table_name = ${table} AND table_schema IN (${branch.schemaName}, ${`workspace_${this.projectId}`})`
    return rows.some((r) => r.schema === branch.schemaName) && !rows.some((r) => r.schema !== branch.schemaName)
  }

  /**
   * The branch this build has been building on, this turn or an earlier one
   * that stopped part-way, with every statement logged on it: what its merge
   * would bring. Null when there is none, or nothing is on it yet.
   */
  async buildInProgress(): Promise<{ branch: TurnBranch; statements: string[] } | null> {
    const branch = this.branch ?? (await this.earlierBranch())
    if (!branch) return null
    const { branchStatements } = await import('./migrate')
    const statements = await branchStatements(branch.id)
    return statements.length > 0 ? { branch, statements } : null
  }

  /** An earlier turn's branch that is still being built (open, not waiting on a merge). */
  private async earlierBranch(): Promise<TurnBranch | null> {
    const earlier = await loadBuildBranch(this.projectId)
    if (!earlier) return null
    const row = await prisma.workspaceBranch.findFirst({
      where: { id: earlier.branchId, projectId: this.projectId, status: 'active' },
      select: { id: true, name: true, schemaName: true },
    })
    if (!row || (await mergeAwaited(this.projectId, row.id))) return null
    return row
  }

  /**
   * One typed schema call, on the branch: written as SQL and applied as a
   * branch migration, which logs it for the merge.
   */
  async apply(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; summary: string; code?: string; data?: Record<string, unknown> }> {
    const written = schemaCallSql(tool, args)
    if ('error' in written) {
      return {
        ok: false,
        code: 'NOT_BUILDABLE_ON_BRANCH',
        summary: `${written.error} This project's production is protected, so its schema is built on a preview branch.`,
      }
    }
    const branch = await this.open()
    if ('error' in branch) {
      return {
        ok: false,
        code: 'BRANCH_UNAVAILABLE',
        summary: `Nothing was built: this project's production is protected, so its schema is built on a preview branch, and ${branch.error.replace(/^\w/, (c) => c.toLowerCase()).replace(/\.$/, '')}.`,
      }
    }
    const { applyBranchMigration } = await import('./migrate')
    const outcome = await applyBranchMigration(this.projectId, branch.id, written.sql, this.userId)
    const recorded = (outcome as { recorded?: string[] }).recorded ?? []
    this.statements.push(...recorded)
    if (!outcome.ok) {
      const fail = outcome as { error?: string; detail?: string; code?: string; hint?: string }
      return {
        ok: false,
        code: fail.code,
        summary: [`On preview branch "${branch.name}": ${fail.error ?? 'the change was refused'}`, fail.detail, fail.hint].filter(Boolean).join(' '),
        data: { branch: { id: branch.id, name: branch.name }, statements: recorded },
      }
    }
    return {
      ok: true,
      summary: (outcome as { summary: string }).summary,
      data: { onBranch: true, branch: { id: branch.id, name: branch.name }, statements: recorded },
    }
  }

  /** Save a step for after the merge, and say so. */
  defer(step: AfterMergeStep): { ok: true; summary: string; data: Record<string, unknown> } {
    this.afterMerge.push(step)
    return {
      ok: true,
      summary:
        `Saved for after the merge: ${step.label}. Its table is on preview branch "${this.branch?.name ?? 'this build'}" ` +
        `until a person approves the merge; then "continue" runs this on production.`,
      data: { afterMerge: true },
    }
  }
}

async function saveBuildBranch(projectId: string, branch: TurnBranch): Promise<void> {
  const value = JSON.stringify({ branchId: branch.id, name: branch.name })
  await prisma.projectPreference.upsert({
    where: { projectId_type_key: { projectId, type: PREF_TYPE, key: BRANCH_KEY } },
    create: { projectId, type: PREF_TYPE, key: BRANCH_KEY, value, confidence: 1 },
    update: { value, confidence: 1, lastSeen: new Date() },
  })
}

async function loadBuildBranch(projectId: string): Promise<{ branchId: string; name: string } | null> {
  const pref = await prisma.projectPreference
    .findUnique({ where: { projectId_type_key: { projectId, type: PREF_TYPE, key: BRANCH_KEY } } })
    .catch(() => null)
  if (!pref) return null
  try {
    const v = JSON.parse(pref.value) as { branchId?: unknown; name?: unknown }
    return typeof v.branchId === 'string' ? { branchId: v.branchId, name: String(v.name ?? '') } : null
  } catch {
    return null
  }
}

// ── After the merge ─────────────────────────────────────────────────────────

export interface AfterMergeQueue {
  branchId: string
  branch: string
  steps: BlueprintStep[]
  createdAt: string
  expiresAt: string
}

/** Add steps to what runs on production once `branch` has merged. */
export async function saveAfterMerge(projectId: string, branch: TurnBranch, steps: AfterMergeStep[]): Promise<void> {
  if (steps.length === 0) return
  const now = Date.now()
  const earlier = await loadAfterMerge(projectId)
  const kept = earlier && earlier.branchId === branch.id ? earlier.steps : []
  const queue: AfterMergeQueue = {
    branchId: branch.id,
    branch: branch.name,
    steps: [...kept, ...steps.map((s) => ({ label: s.label, tool: s.tool, args: s.args }) as BlueprintStep)],
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + AFTER_MERGE_TTL_MS).toISOString(),
  }
  const value = JSON.stringify(queue)
  await prisma.projectPreference.upsert({
    where: { projectId_type_key: { projectId, type: PREF_TYPE, key: AFTER_MERGE_KEY } },
    create: { projectId, type: PREF_TYPE, key: AFTER_MERGE_KEY, value, confidence: 1 },
    update: { value, confidence: 1, lastSeen: new Date() },
  })
}

export async function loadAfterMerge(projectId: string): Promise<AfterMergeQueue | null> {
  const pref = await prisma.projectPreference
    .findUnique({ where: { projectId_type_key: { projectId, type: PREF_TYPE, key: AFTER_MERGE_KEY } } })
    .catch(() => null)
  if (!pref) return null
  try {
    const q = JSON.parse(pref.value) as AfterMergeQueue
    if (Date.parse(q.expiresAt) < Date.now() || !Array.isArray(q.steps) || q.steps.length === 0) return null
    return q
  } catch {
    return null
  }
}

export async function clearAfterMerge(projectId: string): Promise<void> {
  await prisma.projectPreference.deleteMany({ where: { projectId, type: PREF_TYPE, key: AFTER_MERGE_KEY } }).catch(() => {})
}

/** Where the merge an after-merge queue waits for stands. */
export async function mergeStateOf(
  projectId: string,
  branchId: string,
): Promise<{ state: 'merged' } | { state: 'waiting'; approvalId: string } | { state: 'not_requested' } | { state: 'gone' }> {
  const row = await prisma.workspaceBranch.findFirst({ where: { id: branchId, projectId }, select: { status: true } })
  if (!row || row.status === 'discarded') return { state: 'gone' }
  if (row.status === 'merged') return { state: 'merged' }
  const awaited = await mergeAwaited(projectId, branchId)
  return awaited ? { state: 'waiting', approvalId: awaited.id } : { state: 'not_requested' }
}
