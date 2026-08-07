/**
 * SEQUENCE ISOLATION — give a branch its own counters
 * ===================================================
 *
 * `CREATE TABLE ... (LIKE src INCLUDING ALL)` copies a column's DEFAULT
 * expression verbatim. For a `serial` column that default is
 * `nextval('main_schema.orders_id_seq'::regclass)` — a reference to a sequence
 * that lives in the ORIGINAL schema. INCLUDING ALL creates no sequence of its
 * own, so the clone silently shares the project's counters.
 *
 * Measured on PostgreSQL 16, not inferred: one insert into main and one into the
 * branch produced ids 1 and 2 from the same sequence. That means a write against
 * a "staging" branch advances PRODUCTION's counter, and the two schemas can hand
 * out interleaved ids forever after. An environment that mutates the thing it is
 * supposed to be isolated from is not an environment.
 *
 * ── What this does NOT need to handle ───────────────────────────────────────
 *
 * Identity columns (`GENERATED ... AS IDENTITY`) are already correct: LIKE
 * INCLUDING IDENTITY creates a fresh sequence for them. Only the older `serial`
 * form — a plain default plus a separately-owned sequence — is broken, so this
 * rewrites nextval defaults and nothing else.
 *
 * ── Why the value is copied forward ─────────────────────────────────────────
 *
 * The new sequence is set to main's current value rather than restarted at 1.
 * A branch created with `includeData` holds rows whose ids came from main, and a
 * counter starting at 1 would collide with every one of them on the first
 * insert. Starting level with main is correct whether or not data was copied.
 */

import type { PoolClient } from 'pg'

/** A branch column still pointing at a sequence outside the branch. */
export interface SharedSequence {
  tableName: string
  columnName: string
  /** Fully-qualified sequence the default currently references. */
  sourceSequence: string
}

export interface SequenceIsolationResult {
  isolated: number
  details: Array<{ table: string; column: string; from: string; to: string; startsAt: string }>
}

/**
 * Does this default expression reference a sequence, and which one?
 *
 * Pure so the parse can be asserted without a database. Postgres renders the
 * default as `nextval('"schema".table_col_seq'::regclass)`, with quoting that
 * varies by whether the identifier needs it — which is exactly the kind of
 * detail a hand-rolled regex gets wrong once and then never again.
 */
export function parseNextvalTarget(defaultExpr: string | null | undefined): string | null {
  if (!defaultExpr) return null
  const m = /nextval\(\s*'([^']+)'(?:::regclass)?\s*\)/i.exec(defaultExpr)
  return m ? m[1] : null
}

/** Strip Postgres's optional double-quoting from a possibly-qualified ident. */
export function unquoteIdent(qualified: string): { schema: string | null; name: string } {
  const parts: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < qualified.length; i++) {
    const ch = qualified[i]
    if (ch === '"') {
      // Doubled quotes inside a quoted identifier are a literal quote.
      if (inQuotes && qualified[i + 1] === '"') { cur += '"'; i++; continue }
      inQuotes = !inQuotes
      continue
    }
    if (ch === '.' && !inQuotes) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  parts.push(cur)
  return parts.length > 1
    ? { schema: parts[0], name: parts.slice(1).join('.') }
    : { schema: null, name: parts[0] }
}

/**
 * Find every branch column whose default still points outside the branch.
 *
 * Only defaults referencing a sequence NOT in `branchSchema` are returned:
 * re-pointing one that is already local would be a no-op that resets a counter.
 */
export async function findSharedSequences(
  client: PoolClient,
  branchSchema: string,
): Promise<SharedSequence[]> {
  const { rows } = await client.query<{
    table_name: string
    column_name: string
    default_expr: string
  }>(
    `SELECT c.relname AS table_name,
            a.attname AS column_name,
            pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = $1
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       JOIN pg_attrdef  d ON d.adrelid  = c.oid AND d.adnum  = a.attnum
      WHERE c.relkind = 'r'`,
    [branchSchema],
  )

  const out: SharedSequence[] = []
  for (const r of rows) {
    const target = parseNextvalTarget(r.default_expr)
    if (!target) continue
    const { schema } = unquoteIdent(target)
    // A sequence already inside the branch is correct and left alone.
    if (schema === branchSchema) continue
    out.push({ tableName: r.table_name, columnName: r.column_name, sourceSequence: target })
  }
  return out
}

/**
 * Give the branch its own sequence for every column that shares one.
 *
 * Runs inside the caller's transaction: a partially-isolated branch is worse
 * than a fully-shared one, because some writes would touch production's counter
 * and others would not, and nothing would say which.
 */
export async function isolateBranchSequences(
  client: PoolClient,
  branchSchema: string,
): Promise<SequenceIsolationResult> {
  const shared = await findSharedSequences(client, branchSchema)
  const result: SequenceIsolationResult = { isolated: 0, details: [] }

  for (const s of shared) {
    const newSeq = `${s.tableName}_${s.columnName}_seq`
    const qualified = `"${branchSchema}"."${newSeq}"`

    // Start level with the source. A branch created with copied data holds rows
    // whose ids came from main; restarting at 1 collides with all of them.
    const { rows } = await client.query<{ last_value: string }>(
      `SELECT last_value FROM ${quoteQualified(s.sourceSequence)}`,
    )
    const startsAt = rows[0]?.last_value ?? '1'

    await client.query(`CREATE SEQUENCE IF NOT EXISTS ${qualified}`)
    await client.query(`SELECT setval('${branchSchema}.${newSeq}', $1::bigint, true)`, [startsAt])
    await client.query(
      `ALTER TABLE "${branchSchema}"."${s.tableName}" ` +
      `ALTER COLUMN "${s.columnName}" SET DEFAULT nextval('${branchSchema}.${newSeq}'::regclass)`,
    )
    // OWNED BY makes the sequence drop with its table, so discarding a branch
    // leaves nothing behind. LIKE never creates this link, which is half of why
    // the clone shared main's sequence in the first place.
    await client.query(
      `ALTER SEQUENCE ${qualified} OWNED BY "${branchSchema}"."${s.tableName}"."${s.columnName}"`,
    )

    result.isolated++
    result.details.push({
      table: s.tableName,
      column: s.columnName,
      from: s.sourceSequence,
      to: `${branchSchema}.${newSeq}`,
      startsAt,
    })
  }

  return result
}

/**
 * Re-quote a possibly-qualified identifier for use in SQL.
 *
 * The value comes from Postgres's own rendering of a default expression, not
 * from a user, but it is still re-quoted rather than interpolated raw: it
 * reaches a query, and "it came from the catalog" is the kind of assumption that
 * stops being true when someone names a table with a dot in it.
 */
function quoteQualified(qualified: string): string {
  const { schema, name } = unquoteIdent(qualified)
  return schema ? `"${schema}"."${name}"` : `"${name}"`
}

/**
 * Assert no column in the branch still points at a sequence outside it.
 * The precondition for serving a branch, checked against the live catalog.
 */
export async function verifySequenceIsolation(
  client: PoolClient,
  branchSchema: string,
): Promise<{ ok: boolean; shared: SharedSequence[]; reason?: string }> {
  const shared = await findSharedSequences(client, branchSchema)
  if (shared.length === 0) return { ok: true, shared: [] }
  return {
    ok: false,
    shared,
    reason:
      `${shared.length} column(s) still use a sequence outside the branch ` +
      `(${shared.slice(0, 3).map(s => `${s.tableName}.${s.columnName}`).join(', ')}). ` +
      `Writes would advance the project's counters.`,
  }
}
