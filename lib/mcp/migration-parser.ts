/**
 * Migration SQL → governed typed actions.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Backenly's write governance requires typed actions: every mutation is planned,
 * verified and reversible because the kernel knows what it MEANS, not just what
 * text was executed. That is the product, and it is not negotiable.
 *
 * But it produced a reliability tax we were paying every single session. An
 * agent connecting over MCP has seen millions of lines of SQL and zero lines of
 * our tool vocabulary. Its prior — formed on `execute_sql` / `apply_migration`
 * style database tools, on psql, on every ORM — is "a database tool takes SQL".
 * Ours did not, so the agent guessed, and `run_query` refused it as NOT_READ_ONLY
 * over and over. Measured on the live key: writes-sent-to-the-read-tool were the
 * single largest error class.
 *
 * The fix is not to abandon typed actions. It is to stop making the agent speak
 * them. This module accepts the grammar the model already knows and TRANSLATES
 * it into the grammar the kernel already enforces. Familiar SQL ergonomics on
 * the outside; Backenly's governance underneath.
 *
 * ── Why a parser and not an LLM ─────────────────────────────────────────────
 *
 * Translating SQL→actions with a model would reintroduce exactly the
 * nondeterminism this exists to remove: the same migration could parse two ways
 * on two days, and a mis-parse would be a silent wrong write rather than a loud
 * refusal. Parsing is deterministic, testable, and fails closed.
 *
 * ── The refusal contract ────────────────────────────────────────────────────
 *
 * Anything this parser cannot map is REFUSED, never guessed — and every refusal
 * names the specific way forward. A dead-end error costs an agent a whole turn
 * of blind retrying; a refusal that names the alternative costs it one call.
 * That difference is most of the reliability gap we are closing.
 */

/**
 * The typed-action vocabulary the governance kernel accepts.
 *
 * `args` must match the dispatch contract in lib/ai/brain/tools.ts EXACTLY —
 * these are handed straight to `dispatchTool`. Emitting a plausible-looking but
 * wrong shape here (`{from, to}` where the tool wants `{oldName, newName}`) is
 * the worst bug this module can have: it type-checks, it reads correctly, and
 * it silently does nothing or the wrong thing. Tests assert against the real
 * contract for that reason, not against this parser's own idea of it.
 */
export interface PlannedAction {
  tool: string
  args: Record<string, unknown>
  /** The statement this came from, for the receipt and for error attribution. */
  source: string
  /** Anything the agent should know that isn't an error — e.g. skipped columns. */
  notes?: string[]
}

export class MigrationParseError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint?: string,
    readonly statement?: string,
  ) {
    super(message)
    this.name = 'MigrationParseError'
  }
}

// ── Statement splitting ──────────────────────────────────────────────────────

/**
 * Split on semicolons that are real statement terminators — not ones inside a
 * string literal, quoted identifier, comment, or dollar-quoted body.
 *
 * Unlike `run_query`, multi-statement input is WELCOME here: a migration is
 * naturally several statements, and forcing one call per statement would make a
 * five-column table take five round trips (and leave the schema half-built if
 * the agent stopped early).
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  while (i < sql.length) {
    const two = sql.slice(i, i + 2)
    if (two === '--') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? sql.length : nl
      continue
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      continue
    }
    const ch = sql[i]
    if (ch === "'" || ch === '"') {
      const quote = ch
      cur += ch
      i++
      while (i < sql.length) {
        cur += sql[i]
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { cur += sql[i + 1]; i += 2; continue }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length)
        const end = close === -1 ? sql.length : close + tag[0].length
        cur += sql.slice(i, end)
        i = end
        continue
      }
    }
    if (ch === ';') {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/**
 * Split a comma-separated list at depth 0 only, so `numeric(10,2)` stays one
 * item. Splitting naively on "," is the classic way a hand-rolled DDL parser
 * silently mangles precision types.
 */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === "'" || ch === '"') {
      const quote = ch
      cur += ch
      i++
      while (i < s.length) {
        cur += s[i]
        if (s[i] === quote) {
          if (s[i + 1] === quote) { cur += s[i + 1]; i += 2; continue }
          i++
          break
        }
        i++
      }
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      i++
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Extract the (...) body at the first top-level paren, with its bounds. */
function parenBody(s: string): { body: string; before: string } | null {
  const start = s.indexOf('(')
  if (start === -1) return null
  let depth = 0
  for (let i = start; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') {
      depth--
      if (depth === 0) return { body: s.slice(start + 1, i), before: s.slice(0, start) }
    }
  }
  return null
}

function unquoteIdent(raw: string): string {
  const t = raw.trim().replace(/;$/, '').trim()
  if (t.startsWith('"') && t.endsWith('"') && t.length > 1) {
    return t.slice(1, -1).replace(/""/g, '"')
  }
  return t.toLowerCase()
}

/**
 * Reject a schema-qualified name. The MCP key already scopes every call to one
 * project, and the workspace schema is on the search_path — so a qualified name
 * is either redundant or an attempt to reach outside the tenant. Postgres grants
 * would refuse the latter anyway, but refusing it HERE gives the agent a message
 * it can act on instead of an opaque permission error.
 */
function assertUnqualified(name: string, stmt: string): void {
  if (name.includes('.')) {
    throw new MigrationParseError(
      `Schema-qualified name "${name}" is not allowed.`,
      'QUALIFIED_NAME',
      'Write the bare table name — your project schema is already in scope. Use `posts`, not `workspace_x.posts`.',
      stmt,
    )
  }
}

// ── Type mapping ─────────────────────────────────────────────────────────────

/**
 * PostgreSQL type → Backenly's column vocabulary.
 *
 * Aliases matter more than they look: an agent writes `VARCHAR(255)`, `SERIAL`,
 * `TIMESTAMPTZ` and `DOUBLE PRECISION` interchangeably, and every one of those
 * failing would just move the error from "wrong tool" to "wrong type name".
 */
const TYPE_MAP: Record<string, string> = {
  text: 'text', varchar: 'text', 'character varying': 'text', char: 'text',
  character: 'text', citext: 'text', name: 'text',
  int: 'int', integer: 'int', int4: 'int', smallint: 'int', int2: 'int', serial: 'int',
  bigint: 'bigint', int8: 'bigint', bigserial: 'bigint',
  boolean: 'boolean', bool: 'boolean',
  timestamp: 'timestamp', timestamptz: 'timestamp',
  'timestamp with time zone': 'timestamp', 'timestamp without time zone': 'timestamp',
  date: 'timestamp', 'time': 'timestamp',
  uuid: 'uuid',
  json: 'jsonb', jsonb: 'jsonb',
  numeric: 'numeric', decimal: 'numeric', real: 'numeric', float4: 'numeric',
  float8: 'numeric', 'double precision': 'numeric', money: 'numeric',
}

function mapType(rawType: string, stmt: string): string {
  // Strip precision/length — `numeric(10,2)` and `varchar(255)` map on the base.
  const base = rawType.replace(/\([^)]*\)/g, '').trim().toLowerCase().replace(/\s+/g, ' ')
  const mapped = TYPE_MAP[base]
  if (!mapped) {
    throw new MigrationParseError(
      `Unsupported column type "${rawType.trim()}".`,
      'UNSUPPORTED_TYPE',
      `Supported types: text, int, bigint, boolean, timestamp, uuid, jsonb, numeric ` +
      `(plus the usual aliases — varchar, serial, timestamptz, double precision). ` +
      `For anything exotic (arrays, enums, custom domains, PostGIS), use backend_chat and describe what you need.`,
      stmt,
    )
  }
  return mapped
}

// ── Column definition parsing ────────────────────────────────────────────────

interface ParsedColumn {
  name: string
  type: string
  nullable?: boolean
  unique?: boolean
  fkTo?: string
  default?: string
}

/** Identifiers that begin a table-level constraint rather than a column. */
const TABLE_CONSTRAINT = /^(primary\s+key|foreign\s+key|unique|check|constraint|exclude)\b/i

function parseColumnDef(def: string, stmt: string): ParsedColumn | null {
  if (TABLE_CONSTRAINT.test(def.trim())) return null // handled by the caller

  // name is the first token (possibly quoted); the type is what follows, up to
  // the first constraint keyword.
  // [\s\S] rather than `.` with the /s flag: the build targets below es2018,
  // where dotAll is a compile error. Column definitions do span lines.
  const m = /^\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+([\s\S]*)$/.exec(def)
  if (!m) {
    throw new MigrationParseError(
      `Could not parse column definition: "${def.trim()}".`,
      'BAD_COLUMN_DEF',
      'Expected `name type [constraints]`, e.g. `title text NOT NULL`.',
      stmt,
    )
  }
  const name = unquoteIdent(m[1])
  const rest = m[2].trim()

  // Type = everything before the first constraint keyword. Multi-word types
  // (`double precision`, `timestamp with time zone`) must survive this, so the
  // boundary is a keyword list, not the first space.
  const boundary = /\b(not\s+null|null|primary\s+key|unique|references|default|check|generated|collate|constraint)\b/i
  const bIdx = rest.search(boundary)
  const rawType = (bIdx === -1 ? rest : rest.slice(0, bIdx)).trim()
  const modifiers = bIdx === -1 ? '' : rest.slice(bIdx)

  const col: ParsedColumn = { name, type: mapType(rawType, stmt) }

  // ── Nullability: absence is a statement, not a gap ──────────────────────────
  //
  // In SQL, a column without NOT NULL IS NULLABLE. That is not an omission the
  // platform is free to fill in — it is the declaration.
  //
  // This used to leave `nullable` undefined whenever NOT NULL was absent, which
  // handed the decision to `deriveConstraints`, whose rule is
  // `isRequired = !name.includes('optional') && !name.startsWith('is_')` — i.e.
  // almost everything becomes NOT NULL. So a migration declaring
  //
  //   description text,
  //   image_url   text
  //
  // produced two NOT NULL columns, and `apply_migration` reported success. Every
  // insert that omitted either one then failed against a constraint the author
  // never wrote and could not see in their own migration.
  //
  // PRIMARY KEY is excluded because it implies NOT NULL in SQL itself; claiming
  // nullability there would contradict the same declaration this is honouring.
  if (/\bnot\s+null\b/i.test(modifiers)) col.nullable = false
  else if (/\bprimary\s+key\b/i.test(modifiers)) col.nullable = false
  else col.nullable = true

  if (/\bunique\b/i.test(modifiers) || /\bprimary\s+key\b/i.test(modifiers)) col.unique = true

  const ref = /\breferences\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$.]*)/i.exec(modifiers)
  if (ref) {
    const target = unquoteIdent(ref[1].replace(/\s*\(.*$/, ''))
    assertUnqualified(target, stmt)
    col.fkTo = target
  }

  const def_ = /\bdefault\s+([\s\S]+?)(?=\s+(?:not\s+null|null|unique|primary\s+key|references|check|collate|constraint)\b|$)/i.exec(modifiers)
  if (def_) col.default = def_[1].trim()

  return col
}

// ── Statement translation ────────────────────────────────────────────────────

/**
 * `id` / `created_at` / `updated_at` are provisioned by create_table itself.
 * An agent writing idiomatic SQL will almost always include them, and passing
 * them through would either duplicate the column or fight the platform's own
 * primary key. Dropping them silently is wrong too — the receipt reports it.
 */
const MANAGED_COLUMNS = new Set(['id', 'created_at', 'updated_at'])

function translateCreateTable(stmt: string): PlannedAction {
  const head = /^create\s+table\s+(?:if\s+not\s+exists\s+)?/i.exec(stmt)
  if (!head) throw new MigrationParseError('Malformed CREATE TABLE.', 'BAD_STATEMENT', undefined, stmt)

  const afterHead = stmt.slice(head[0].length)
  const paren = parenBody(afterHead)
  if (!paren) {
    throw new MigrationParseError(
      'CREATE TABLE needs a parenthesised column list.',
      'BAD_STATEMENT',
      'e.g. `CREATE TABLE posts (title text NOT NULL, body text)`.',
      stmt,
    )
  }

  const tableName = unquoteIdent(paren.before)
  assertUnqualified(tableName, stmt)

  const columns: ParsedColumn[] = []
  const dropped: string[] = []
  for (const part of splitTopLevel(paren.body)) {
    // Table-level FOREIGN KEY (col) REFERENCES other(id) — fold onto the column.
    const tableFk = /^foreign\s+key\s*\(\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\)\s*references\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$.]*)/i.exec(part.trim())
    if (tableFk) {
      const colName = unquoteIdent(tableFk[1])
      const target = unquoteIdent(tableFk[2].replace(/\s*\(.*$/, ''))
      assertUnqualified(target, stmt)
      const existing = columns.find((c) => c.name === colName)
      if (existing) existing.fkTo = target
      continue
    }
    // Table-level UNIQUE (col) — fold onto the column.
    const tableUnique = /^unique\s*\(\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\)/i.exec(part.trim())
    if (tableUnique) {
      const colName = unquoteIdent(tableUnique[1])
      const existing = columns.find((c) => c.name === colName)
      if (existing) existing.unique = true
      continue
    }
    const col = parseColumnDef(part, stmt)
    if (!col) continue
    if (MANAGED_COLUMNS.has(col.name)) { dropped.push(col.name); continue }
    columns.push(col)
  }

  if (columns.length === 0) {
    throw new MigrationParseError(
      `CREATE TABLE ${tableName} declares no columns Backenly can create.`,
      'NO_COLUMNS',
      `id, created_at and updated_at are added automatically — declare at least one column of your own.`,
      stmt,
    )
  }

  return {
    tool: 'create_table',
    args: { tableName, columns },
    source: stmt,
    ...(dropped.length
      ? { notes: [`${dropped.join(', ')} skipped — Backenly provisions these automatically.`] }
      : {}),
  }
}

/**
 * SQL keywords and literals that can appear inside a CHECK expression without
 * being a column reference. Used to decide whether a CHECK names exactly one
 * column — see `singleColumnOf`.
 */
const EXPR_NOISE = new Set([
  'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false', 'between', 'like',
  'ilike', 'similar', 'to', 'any', 'all', 'some', 'exists', 'case', 'when',
  'then', 'else', 'end', 'current_timestamp', 'current_date', 'current_user',
  'asc', 'desc', 'collate', 'array',
])

/**
 * Find the single column a CHECK expression constrains, or null when it is
 * ambiguous.
 *
 * `add_constraint` is column-scoped, but SQL CHECK is table-scoped, so the two
 * only line up when the expression touches exactly one column. Rather than
 * guess a column for `CHECK (start_date < end_date)` — which would attach the
 * constraint to the wrong place and look like it worked — a multi-column or
 * zero-column expression is refused and routed to backend_chat.
 */
function singleColumnOf(expr: string): string | null {
  // Drop string literals so `CHECK (status IN ('draft','live'))` doesn't count
  // 'draft' as an identifier.
  const cleaned = expr.replace(/'(?:[^']|'')*'/g, ' ')
  const found = new Set<string>()
  const re = /([A-Za-z_][A-Za-z0-9_$]*)\s*(\()?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned))) {
    const ident = m[1].toLowerCase()
    if (m[2]) continue                // a function call, not a column
    if (EXPR_NOISE.has(ident)) continue
    found.add(ident)
  }
  return found.size === 1 ? [...found][0] : null
}

/**
 * Translate `ADD [CONSTRAINT name] <body>` into add_constraint's real contract:
 * `{ tableName, columnName, constraintType, expression }`.
 */
function translateAddConstraint(tableName: string, body: string, stmt: string): PlannedAction {
  // Strip an optional `CONSTRAINT <name>` prefix — the platform names its own.
  const named = /^constraint\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+([\s\S]*)$/i.exec(body.trim())
  const spec = (named ? named[2] : body).trim()

  const unique = /^unique\s*\(([^)]*)\)/i.exec(spec)
  if (unique) {
    const cols = splitTopLevel(unique[1]).map((c) => unquoteIdent(c))
    if (cols.length !== 1) {
      throw new MigrationParseError(
        `Multi-column UNIQUE constraints are not supported.`,
        'UNSUPPORTED_CONSTRAINT',
        `Use a unique index instead: CREATE UNIQUE INDEX ON ${tableName} (${cols.join(', ')}).`,
        stmt,
      )
    }
    return {
      tool: 'add_constraint',
      args: { tableName, columnName: cols[0], constraintType: 'unique' },
      source: stmt,
    }
  }

  const fk = /^foreign\s+key\s*\(([^)]*)\)\s*references\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$.]*)\s*(\(([^)]*)\))?/i.exec(spec)
  if (fk) {
    const cols = splitTopLevel(fk[1]).map((c) => unquoteIdent(c))
    if (cols.length !== 1) {
      throw new MigrationParseError(
        `Composite foreign keys are not supported.`,
        'UNSUPPORTED_CONSTRAINT',
        `Describe the relationship via backend_chat and it will be modelled for you.`,
        stmt,
      )
    }
    const target = unquoteIdent(fk[2])
    assertUnqualified(target, stmt)
    const targetCol = fk[4] ? unquoteIdent(fk[4]) : 'id'
    return {
      tool: 'add_constraint',
      args: {
        tableName,
        columnName: cols[0],
        constraintType: 'foreign_key',
        expression: `${target}(${targetCol})`,
      },
      source: stmt,
    }
  }

  const check = /^check\s*/i.test(spec) ? parenBody(spec) : null
  if (check) {
    const column = singleColumnOf(check.body)
    if (!column) {
      throw new MigrationParseError(
        `Cannot tell which column this CHECK constrains.`,
        'AMBIGUOUS_CONSTRAINT',
        `Backenly's constraints are column-scoped. A CHECK over one column works ` +
        `(e.g. CHECK (price > 0)); for one spanning several columns, use backend_chat and describe the rule.`,
        stmt,
      )
    }
    return {
      tool: 'add_constraint',
      args: { tableName, columnName: column, constraintType: 'check', expression: check.body.trim() },
      source: stmt,
    }
  }

  if (/^primary\s+key\b/i.test(spec)) {
    throw new MigrationParseError(
      `Primary keys cannot be added or changed.`,
      'UNSUPPORTED_CONSTRAINT',
      `Every Backenly table already has a managed \`id\` primary key. To enforce uniqueness on another column, use UNIQUE.`,
      stmt,
    )
  }

  throw new MigrationParseError(
    `Constraint type not supported: "${spec.slice(0, 60)}".`,
    'UNSUPPORTED_CONSTRAINT',
    `Supported: UNIQUE (col), FOREIGN KEY (col) REFERENCES other(id), CHECK (single-column expression).`,
    stmt,
  )
}

function translateAlterTable(stmt: string): PlannedAction {
  const head = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$.]*)\s+([\s\S]*)$/i.exec(stmt)
  if (!head) throw new MigrationParseError('Malformed ALTER TABLE.', 'BAD_STATEMENT', undefined, stmt)

  const tableName = unquoteIdent(head[1])
  assertUnqualified(tableName, stmt)
  const action = head[2].trim()

  // RENAME COLUMN a TO b
  const rename = /^rename\s+(?:column\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+to\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)/i.exec(action)
  if (rename) {
    return {
      tool: 'rename_column',
      args: { tableName, oldName: unquoteIdent(rename[1]), newName: unquoteIdent(rename[2]) },
      source: stmt,
    }
  }

  // ALTER COLUMN c SET NOT NULL — the one ALTER COLUMN form that maps cleanly
  // onto a governed constraint. Type changes deliberately do not (they are a
  // data migration, not a constraint) and fall through to the refusal below.
  const setNotNull = /^alter\s+(?:column\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+set\s+not\s+null/i.exec(action)
  if (setNotNull) {
    return {
      tool: 'add_constraint',
      args: { tableName, columnName: unquoteIdent(setNotNull[1]), constraintType: 'not_null' },
      source: stmt,
    }
  }

  // ADD [COLUMN] [IF NOT EXISTS] def
  const add = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\s\S]*)$/i.exec(action)
  if (add && !/^constraint\b/i.test(add[1].trim()) && !TABLE_CONSTRAINT.test(add[1].trim())) {
    const col = parseColumnDef(add[1], stmt)
    if (!col) throw new MigrationParseError('Could not parse the added column.', 'BAD_COLUMN_DEF', undefined, stmt)
    const column: Record<string, unknown> = { name: col.name, type: col.type }
    if (col.nullable !== undefined) column.nullable = col.nullable
    if (col.default !== undefined) column.default = col.default
    return { tool: 'add_column', args: { tableName, column }, source: stmt }
  }

  // ADD CONSTRAINT ... / ADD UNIQUE (...) / ADD FOREIGN KEY (...)
  if (add) return translateAddConstraint(tableName, add[1].trim(), stmt)

  // Everything else on ALTER TABLE is destructive or unmodelled.
  if (/^drop\b/i.test(action)) {
    throw new MigrationParseError(
      `Dropping columns is destructive and cannot run over MCP.`,
      'DESTRUCTIVE_REFUSED',
      `Describe it via backend_chat — it is parked in the Review Queue for human approval and you get an approval id to poll with check_approval.`,
      stmt,
    )
  }
  throw new MigrationParseError(
    `ALTER TABLE action not supported: "${action.slice(0, 60)}".`,
    'UNSUPPORTED_STATEMENT',
    `Supported: ADD COLUMN, RENAME COLUMN, ADD CONSTRAINT. For type changes or anything else, use backend_chat and describe the intent.`,
    stmt,
  )
}

function translateCreateIndex(stmt: string): PlannedAction {
  const m = /^create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+)?on\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$.]*)\s*([\s\S]*)$/i.exec(stmt)
  if (!m) throw new MigrationParseError('Malformed CREATE INDEX.', 'BAD_STATEMENT', undefined, stmt)

  const unique = !!m[1]
  const indexName = m[2] ? unquoteIdent(m[2]) : undefined
  const tableName = unquoteIdent(m[3])
  assertUnqualified(tableName, stmt)

  const paren = parenBody(m[4] ?? '')
  if (!paren) {
    throw new MigrationParseError(
      'CREATE INDEX needs a parenthesised column list.',
      'BAD_STATEMENT',
      'e.g. `CREATE INDEX ON posts (author_id)`.',
      stmt,
    )
  }
  const columns = splitTopLevel(paren.body).map((c) =>
    unquoteIdent(c.replace(/\s+(asc|desc|nulls\s+(first|last))\b/gi, '')),
  )

  // create_index takes {tableName, columns, unique} — it names the index itself.
  // A caller-supplied name is dropped rather than passed through as an arg the
  // executor would ignore, and the receipt says so instead of silently differing
  // from the SQL the agent wrote.
  return {
    tool: 'create_index',
    args: { tableName, columns, unique },
    source: stmt,
    ...(indexName
      ? { notes: [`Index name "${indexName}" ignored — Backenly names indexes automatically.`] }
      : {}),
  }
}

function translateDml(stmt: string, verb: string): PlannedAction {
  // DML is expressed far more naturally as SQL than as our filter DSL, but the
  // governed executors take structured input. Rather than build a second
  // half-parser for WHERE clauses — which would be wrong in subtle ways on
  // exactly the queries that matter — DML routes to the typed data tools and
  // says so explicitly.
  throw new MigrationParseError(
    `apply_migration handles schema changes, not row changes (got ${verb.toUpperCase()}).`,
    'DML_NOT_MIGRATION',
    `To change rows use the typed data tools: db_insert {table, row}, db_update {table, filter, patch}, db_delete {table, filter}. ` +
    `To READ rows use run_query with any SELECT.`,
    stmt,
  )
}

const DESTRUCTIVE_VERBS = /^(drop|truncate)\b/i

function translateStatement(stmt: string): PlannedAction {
  const s = stmt.trim()

  if (/^create\s+table\b/i.test(s)) return translateCreateTable(s)
  if (/^alter\s+table\b/i.test(s)) return translateAlterTable(s)
  if (/^create\s+(unique\s+)?index\b/i.test(s)) return translateCreateIndex(s)

  const dml = /^(insert|update|delete)\b/i.exec(s)
  if (dml) return translateDml(s, dml[1])

  if (DESTRUCTIVE_VERBS.test(s)) {
    throw new MigrationParseError(
      `Destructive statements cannot run over MCP.`,
      'DESTRUCTIVE_REFUSED',
      `Describe the operation via backend_chat — it is parked in the project's Review Queue for human approval, and you get an approval id to poll with check_approval.`,
      s,
    )
  }

  if (/^(select|with)\b/i.test(s)) {
    throw new MigrationParseError(
      `apply_migration is for schema changes; this is a read.`,
      'READ_NOT_MIGRATION',
      `Use run_query for any SELECT — it runs full PostgreSQL reads including joins, aggregates and CTEs.`,
      s,
    )
  }

  throw new MigrationParseError(
    `Statement not supported: "${s.slice(0, 60)}".`,
    'UNSUPPORTED_STATEMENT',
    `apply_migration supports CREATE TABLE, ALTER TABLE (ADD COLUMN / RENAME COLUMN / ADD CONSTRAINT) and CREATE INDEX. ` +
    `For auth, storage, realtime, functions or anything else, call backend_chat and describe what you want.`,
    s,
  )
}

/**
 * Parse a migration into an ordered list of governed actions.
 *
 * Parsing is all-or-nothing on purpose: if statement 4 of 5 is unsupported, we
 * refuse the whole migration rather than apply the first three. A partially
 * applied migration is the worst outcome available here — the agent believes it
 * succeeded, the schema disagrees, and nothing points at the seam.
 */
export function parseMigration(sql: string): PlannedAction[] {
  const statements = splitStatements(sql)
  if (statements.length === 0) {
    throw new MigrationParseError('Empty migration.', 'EMPTY_MIGRATION')
  }
  return statements.map(translateStatement)
}
