/**
 * SQL RECORDER — what actually ran, in the audit row, without asking each
 * executor to remember to say so
 * =========================================================================
 *
 * The audit trail already answered three of the four questions a developer asks
 * about an autonomous change: WHAT changed (finding type, table, column), WHY
 * (because-copy), and whether it HELD (recheckGap + the acceptance gate). The
 * fourth — "show me the statement" — it could not answer. A
 * `WorkspaceSchemaSnapshot` is taken before and after, so the change is
 * derivable as a diff of two full-schema DDL dumps, but the statement itself was
 * never stored. "Backenly added an index on orders.customer_ref" is a summary;
 * `CREATE INDEX "idx_orders_customer_ref" ON …` is the thing you can read,
 * paste into a review, or hand to a DBA.
 *
 * ── Why this is a recorder and not a field on ExecutionResult ───────────────
 *
 * The obvious version is to have every `executeXxx` return its DDL in
 * `result.data.sql`. That is roughly a dozen edits, and — more to the point —
 * it is a convention rather than a mechanism. The thirteenth executor added
 * later silently records nothing, and nothing fails: the audit row just quietly
 * loses the statement, which is the same class of drift as a detector that
 * returns [] when it cannot look.
 *
 * So the capture happens where the statements actually leave the process. A
 * Prisma middleware sees every `$executeRaw*` / `$queryRaw*` call, and an
 * AsyncLocalStorage scope decides which ones belong to the governed action
 * currently running. An executor cannot forget to participate, because it is not
 * asked to.
 *
 * ── What is deliberately NOT recorded ──────────────────────────────────────
 *
 * Reads. A single fix runs a handful of catalog lookups (does the table exist,
 * does an index already lead with this column) around one or two mutations, and
 * a reader looking for "what changed" does not want to page through
 * `SELECT ... FROM information_schema.columns`. Only statements that can change
 * something are kept.
 *
 * Bound parameters are recorded alongside the statement text because a
 * parameterised DDL is unreadable without them, and every governed fix action
 * binds identifiers and thresholds rather than user data. Both are bounded in
 * size — an audit row is a record, not a log sink.
 */

import { AsyncLocalStorage } from 'async_hooks'

/** One statement the current governed action sent to PostgreSQL. */
export interface RecordedStatement {
  sql: string
  /** Bound values, stringified. Absent when the statement had none. */
  params?: string[]
}

interface Scope {
  statements: RecordedStatement[]
}

const storage = new AsyncLocalStorage<Scope>()

/**
 * Caps. A fix that somehow issues hundreds of statements is a bug worth seeing
 * in the count, not worth storing in full on every audit row.
 */
const MAX_STATEMENTS = 25
const MAX_SQL_CHARS = 4000
const MAX_PARAM_CHARS = 200

/**
 * Statements that can change something.
 *
 * Matched on the first keyword rather than by scanning for substrings anywhere:
 * `SELECT ... FROM pg_indexes WHERE indexdef LIKE '%CREATE%'` is a read, and a
 * substring match would file it as a mutation.
 */
const MUTATING = /^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|COMMENT|VACUUM|REINDEX|ANALYZE|REFRESH|SET|RESET|SECURITY\s+LABEL)\b/i

export function isMutatingStatement(sql: string): boolean {
  // Strip leading SQL comments so a documented statement is still classified by
  // its first real keyword.
  const stripped = sql.replace(/^(?:\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*/g, '')
  return MUTATING.test(stripped)
}

/**
 * Run `fn` with statement capture active, and return what it ran alongside its
 * result.
 *
 * Nested calls reuse the outer scope rather than opening a second one, so a fix
 * that internally calls another governed helper still produces ONE list in the
 * order the statements were issued.
 */
export async function withSqlCapture<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; statements: RecordedStatement[] }> {
  const existing = storage.getStore()
  if (existing) {
    // Already inside a capture: run in place and report what the whole scope has
    // accumulated so far. Opening a nested scope would hide the inner statements
    // from the outer audit row, which is the opposite of the point.
    const result = await fn()
    return { result, statements: existing.statements }
  }

  const scope: Scope = { statements: [] }
  const result = await storage.run(scope, fn)
  return { result, statements: scope.statements }
}

/** Record one statement against the active scope. No-op outside a capture. */
export function noteStatement(sql: string, params?: unknown[]): void {
  const scope = storage.getStore()
  if (!scope) return
  if (scope.statements.length >= MAX_STATEMENTS) return
  if (typeof sql !== 'string' || !sql.trim()) return
  if (!isMutatingStatement(sql)) return

  const entry: RecordedStatement = { sql: sql.trim().slice(0, MAX_SQL_CHARS) }
  if (Array.isArray(params) && params.length > 0) {
    entry.params = params.map(p => {
      const s = typeof p === 'string' ? p : JSON.stringify(p) ?? String(p)
      return s.length > MAX_PARAM_CHARS ? `${s.slice(0, MAX_PARAM_CHARS)}…` : s
    })
  }
  scope.statements.push(entry)
}

/** True when a capture scope is active. Exported for tests. */
export function isCapturing(): boolean {
  return storage.getStore() !== undefined
}

// ── Installation ─────────────────────────────────────────────────────────────

let installed = false

/**
 * Attach the recorder to the Prisma singleton.
 *
 * Idempotent, and installed lazily by the auto-fix engine rather than at module
 * load: a middleware on the shared client is a global side effect, and it should
 * exist because something is about to capture, not because a module was
 * imported.
 *
 * `$use` mutates the existing client in place. `$extends` would return a new one
 * and every `import { prisma }` in the codebase would keep the un-extended
 * singleton — the change would compile, run, and record nothing.
 */
export function installSqlRecorder(client: {
  $use?: (mw: (params: any, next: (p: any) => Promise<any>) => Promise<any>) => void
}): void {
  if (installed || typeof client.$use !== 'function') return
  installed = true

  client.$use(async (params: any, next: (p: any) => Promise<any>) => {
    // Raw operations arrive as action 'executeRaw' / 'queryRaw' with no model,
    // and args[0] is the SQL (string for the *Unsafe variants, a Sql template
    // object otherwise). Typed model operations are not recorded: their effect
    // is already described by the finding and its rollbackData.
    if (!params.model && (params.action === 'executeRaw' || params.action === 'queryRaw')) {
      const args = params.args as unknown[]
      const head = args?.[0]
      const sql =
        typeof head === 'string'
          ? head
          : typeof (head as any)?.sql === 'string'
            ? (head as any).sql
            : null
      if (sql) noteStatement(sql, Array.isArray(args) ? args.slice(1) : undefined)
    }
    return next(params)
  })
}

/** Reset for tests. Never call in production — the middleware cannot be removed. */
export function __resetInstalledForTests(): void {
  installed = false
}
