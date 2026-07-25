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

import { validateBooleanExpression } from '@/lib/db/sql-expression'

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

/**
 * Array types are a first-class column shape, not an exotic edge case.
 *
 * `text[]` was refused with "use backend_chat" — for a type that appears in
 * ordinary schemas (tags, role lists, image URLs) and that Postgres has
 * supported forever. The refusal pushed authors to `jsonb`, which silently
 * costs them the array operators (`&&`, `@>`, `ANY`) that were the reason to
 * choose an array in the first place. Reported as gap #9.
 *
 * Both spellings Postgres accepts are matched: the standard `text[]` suffix and
 * the SQL-standard `text ARRAY`. Multi-dimensional declarations (`text[][]`)
 * collapse to one dimension because Postgres does not actually enforce
 * dimensionality — pretending otherwise would be a promise the database does
 * not keep.
 */
function arrayElementOf(base: string): string | null {
  const suffix = /^(.*?)\s*(?:\[\s*\d*\s*\])+$/.exec(base)
  if (suffix) return suffix[1].trim()
  const kw = /^(.*?)\s+array(?:\s*\[\s*\d*\s*\])?$/.exec(base)
  if (kw) return kw[1].trim()
  return null
}

function mapType(rawType: string, stmt: string): string {
  // Strip precision/length — `numeric(10,2)` and `varchar(255)` map on the base.
  const base = rawType.replace(/\([^)]*\)/g, '').trim().toLowerCase().replace(/\s+/g, ' ')

  const element = arrayElementOf(base)
  if (element) {
    const mappedElement = TYPE_MAP[element]
    if (!mappedElement) {
      throw new MigrationParseError(
        `Unsupported array element type "${element}" in "${rawType.trim()}".`,
        'UNSUPPORTED_TYPE',
        `Arrays are supported over any scalar Backenly type: ${SUPPORTED_TYPE_LIST}. ` +
        `So text[], int[], uuid[] and numeric[] all work — "${element}[]" does not.`,
        stmt,
      )
    }
    return `${mappedElement}[]`
  }

  const mapped = TYPE_MAP[base]
  if (!mapped) {
    throw new MigrationParseError(
      `Unsupported column type "${rawType.trim()}".`,
      'UNSUPPORTED_TYPE',
      `Supported types: ${SUPPORTED_TYPE_LIST} ` +
      `(plus the usual aliases — varchar, serial, timestamptz, double precision), ` +
      `and an array of any of them (text[], int[], uuid[]). ` +
      `For enums, custom domains or PostGIS, use backend_chat and describe what you need.`,
      stmt,
    )
  }
  return mapped
}

/** Named once so the error text and the docs can never disagree. */
const SUPPORTED_TYPE_LIST = 'text, int, bigint, boolean, timestamp, uuid, jsonb, numeric'

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

// ── CHECK constraints ────────────────────────────────────────────────────────

/**
 * A CHECK lifted out of a CREATE TABLE, to be applied as a follow-up action.
 *
 * ── Why these are extracted rather than ignored ─────────────────────────────
 *
 * This parser used to drop every CHECK in a CREATE TABLE on the floor. Both
 * spellings — inline on the column
 *
 *     status text NOT NULL CHECK (status IN ('pending','accepted','declined'))
 *
 * and table-level
 *
 *     CONSTRAINT connections_no_self CHECK (requester_id <> addressee_id)
 *
 * were silently discarded and the migration reported ✅. The author believed
 * their schema enforced a value domain for as long as it took them to re-read
 * it; every row written in between could hold anything. Reported as defect #1,
 * and it is the worst class of bug this surface can have: a mutation tool that
 * says it did something it did not do.
 *
 * `create_table` cannot carry them (its contract is columns, not constraints),
 * so a CREATE TABLE now expands into create_table + one add_constraint per
 * CHECK. If any of those fail the caller is told exactly which, instead of
 * being told everything worked.
 */
interface ParsedCheck {
  /** The expression text, validated but otherwise verbatim from the author. */
  expression: string
  /** Every column the expression references. */
  columns: string[]
  /** The author's constraint name, when they gave one. */
  name?: string
}

/**
 * Scan for `CHECK (...)` clauses at paren depth 0, respecting string literals
 * and quoted identifiers, and return them along with the text that remains.
 *
 * A regex cannot do this: `CHECK (status IN ('a','b'))` has nested parens, and
 * `DEFAULT 'needs check (soon)'` has the keyword inside a literal. Both appear
 * in real migrations.
 */
function extractChecks(s: string): { checks: string[]; rest: string } {
  const checks: string[] = []
  let rest = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === "'" || ch === '"') {
      const quote = ch
      rest += ch
      i++
      while (i < s.length) {
        rest += s[i]
        if (s[i] === quote) {
          if (s[i + 1] === quote) { rest += s[i + 1]; i += 2; continue }
          i++
          break
        }
        i++
      }
      continue
    }
    const kw = /^check\s*\(/i.exec(s.slice(i))
    if (kw) {
      const paren = parenBody(s.slice(i + kw[0].length - 1))
      if (paren) {
        checks.push(paren.body.trim())
        // Skip past the whole `CHECK (...)` clause.
        i += kw[0].length - 1 + paren.body.length + 2
        continue
      }
    }
    rest += ch
    i++
  }
  return { checks, rest }
}

/**
 * Validate and normalise one CHECK into a ParsedCheck, or refuse it.
 *
 * The grammar lives in lib/db/sql-expression.ts because `add_constraint` is also
 * callable directly as a brain tool, without passing through this parser. When
 * the two paths had separate ideas of what was safe, the guarantee was whichever
 * was weaker — and for a while the executor had no validation at all.
 *
 * Multi-column expressions are accepted. A CHECK spanning two columns is not
 * ambiguous in SQL — it is a table-level constraint — and refusing it as
 * AMBIGUOUS_CONSTRAINT (defect #11) made `CHECK (user_a < user_b)` and
 * `CHECK (requester_id <> addressee_id)` inexpressible.
 */
function toParsedCheck(expression: string, stmt: string, name?: string): ParsedCheck {
  const checked = validateBooleanExpression(expression, { requireColumn: true })
  if (checked.kind !== 'ok') {
    throw new MigrationParseError(
      `CHECK expression rejected: ${checked.reason}`,
      'UNSAFE_CONSTRAINT',
      checked.hint,
      stmt,
    )
  }
  return { expression: checked.expression, columns: checked.columns, ...(name ? { name } : {}) }
}

/** Refuse a predicate that cannot safely reach DDL. Used for partial indexes. */
function assertSafeCheckExpression(expr: string, stmt: string): void {
  const checked = validateBooleanExpression(expr, { requireColumn: true })
  if (checked.kind !== 'ok') {
    throw new MigrationParseError(
      `WHERE predicate rejected: ${checked.reason}`,
      'UNSAFE_CONSTRAINT',
      checked.hint,
      stmt,
    )
  }
}

function parseColumnDef(def: string, stmt: string, checksOut?: ParsedCheck[]): ParsedColumn | null {
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
  // `array` is a boundary too: `text ARRAY NOT NULL` must not read the keyword
  // as part of a multi-word type name.
  const boundary = /\b(not\s+null|null|primary\s+key|unique|references|default|check|generated|collate|constraint)\b/i
  const bIdx = rest.search(boundary)
  const rawType = (bIdx === -1 ? rest : rest.slice(0, bIdx)).trim()
  let modifiers = bIdx === -1 ? '' : rest.slice(bIdx)

  // ── Inline CHECK, in both spellings ─────────────────────────────────────────
  //
  //   status text CHECK (status IN ('a','b'))
  //   status text CONSTRAINT status_valid CHECK (status IN ('a','b'))
  //
  // Lifted out FIRST so the remaining modifier text (NOT NULL / DEFAULT /
  // REFERENCES) is parsed without a nested paren body confusing it, and so a
  // `CONSTRAINT <name>` prefix that belongs to the CHECK is not mistaken for a
  // constraint on the column itself.
  {
    const namedInline = /\bconstraint\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+(?=check\s*\()/i.exec(modifiers)
    const inlineName = namedInline ? unquoteIdent(namedInline[1]) : undefined
    if (namedInline) {
      modifiers = modifiers.slice(0, namedInline.index) + modifiers.slice(namedInline.index + namedInline[0].length)
    }
    const { checks, rest: withoutChecks } = extractChecks(modifiers)
    modifiers = withoutChecks
    for (const expr of checks) {
      if (!checksOut) {
        // ALTER TABLE ADD COLUMN has no follow-up channel in its own action, so
        // a CHECK there must be refused rather than dropped. Naming the working
        // alternative costs the agent one call instead of a silent wrong schema.
        throw new MigrationParseError(
          `A CHECK cannot be declared inline on ADD COLUMN.`,
          'UNSUPPORTED_CONSTRAINT',
          `Add the column first, then the constraint: ` +
          `ALTER TABLE <table> ADD COLUMN ${name} ${rawType}; ` +
          `ALTER TABLE <table> ADD CONSTRAINT <name> CHECK (${expr});`,
          stmt,
        )
      }
      checksOut.push(toParsedCheck(expr, stmt, inlineName))
    }
  }

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
  // ── Every keyword search below runs against a MASKED copy ───────────────────
  //
  // `DEFAULT 'needs check (soon)'` used to produce `default: "'needs"`, because
  // the extraction's boundary lookahead matched the word `check` INSIDE the
  // string literal. The same hazard applies to every other keyword: a default of
  // `'not null yet'` would have made the column NOT NULL, and `'see references'`
  // would have invented a foreign key.
  //
  // Masking replaces each quoted region with spaces of identical length, so
  // offsets still line up with the original and values are sliced from the
  // original text. Searching the mask and slicing the source is the only version
  // of this that is correct for both.
  const mask = maskLiterals(modifiers)

  if (/\bnot\s+null\b/i.test(mask)) col.nullable = false
  else if (/\bprimary\s+key\b/i.test(mask)) col.nullable = false
  else col.nullable = true

  if (/\bunique\b/i.test(mask) || /\bprimary\s+key\b/i.test(mask)) col.unique = true

  const ref = /\breferences\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$.]*)/i.exec(mask)
  if (ref) {
    // Sliced from the ORIGINAL so a quoted identifier survives the mask.
    const raw = modifiers.slice(ref.index, ref.index + ref[0].length)
    const target = unquoteIdent(raw.replace(/^\s*references\s+/i, '').replace(/\s*\(.*$/, ''))
    assertUnqualified(target, stmt)
    col.fkTo = target
  }

  // Anchored on the keyword alone, never `default\s+`: a masked literal is a run
  // of spaces, and a greedy `\s+` would consume the very value being extracted.
  const defStart = /\bdefault\b/i.exec(mask)
  if (defStart) {
    let from = defStart.index + defStart[0].length
    while (from < modifiers.length && /\s/.test(modifiers[from])) from++
    const tail = mask.slice(from)
    const stop = tail.search(/\s+(?:not\s+null|null|unique|primary\s+key|references|check|collate|constraint|generated)\b/i)
    const value = modifiers.slice(from, stop === -1 ? undefined : from + stop).trim()
    if (value) col.default = value
  }

  return col
}

/**
 * Blank out every single-quoted string LITERAL, preserving length so offsets map
 * back onto the original text.
 *
 * Two deliberate choices:
 *
 *   - The filler is `~`, not a space. A space would make the masked region look
 *     like the `\s+` that separates modifiers, so `DEFAULT 'x' NOT NULL` would
 *     report its boundary at the start of the literal and extract an empty
 *     default. `~` cannot appear in an identifier or a keyword and is not
 *     whitespace, so it terminates a word scan without becoming a separator.
 *
 *   - Double-quoted identifiers are left ALONE. They are names, not values, and
 *     the REFERENCES scan has to be able to read `REFERENCES "Users"(id)` out of
 *     the mask. Only literals can carry the arbitrary user text this exists to
 *     neutralise.
 */
function maskLiterals(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === "'") {
      out += '~'
      i++
      while (i < s.length) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") { out += '~~'; i += 2; continue }
          out += '~'
          i++
          break
        }
        out += '~'
        i++
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

// ── Statement translation ────────────────────────────────────────────────────

/**
 * `id` / `created_at` / `updated_at` are provisioned by create_table itself.
 * An agent writing idiomatic SQL will almost always include them, and passing
 * them through would either duplicate the column or fight the platform's own
 * primary key. Dropping them silently is wrong too — the receipt reports it.
 */
const MANAGED_COLUMNS = new Set(['id', 'created_at', 'updated_at'])

function translateCreateTable(stmt: string): PlannedAction[] {
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
  const checks: ParsedCheck[] = []
  /** Multi-column UNIQUE → a unique index, applied after the table exists. */
  const compositeUniques: string[][] = []

  for (const part of splitTopLevel(paren.body)) {
    const trimmed = part.trim()

    // An explicitly named table-level constraint: `CONSTRAINT <name> <spec>`.
    // The name is carried through rather than discarded — see translateAddConstraint.
    const named = /^constraint\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+([\s\S]*)$/i.exec(trimmed)
    const spec = named ? named[2].trim() : trimmed
    const specName = named ? unquoteIdent(named[1]) : undefined

    // Table-level FOREIGN KEY (col) REFERENCES other(id) — fold onto the column.
    const tableFk = /^foreign\s+key\s*\(\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\)\s*references\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$.]*)/i.exec(spec)
    if (tableFk) {
      const colName = unquoteIdent(tableFk[1])
      const target = unquoteIdent(tableFk[2].replace(/\s*\(.*$/, ''))
      assertUnqualified(target, stmt)
      const existing = columns.find((c) => c.name === colName)
      if (existing) existing.fkTo = target
      continue
    }

    // Table-level UNIQUE (...). One column folds onto the column definition;
    // several become a composite unique index, which is what a multi-column
    // UNIQUE constraint IS in Postgres (it is implemented by one). Refusing it
    // — as this used to — while the hint pointed at CREATE UNIQUE INDEX, which
    // then dropped both the composite-ness and the uniqueness, was defect #10
    // compounding defects #4 and #5.
    const tableUnique = /^unique\s*(?:\(([\s\S]*)\))?/i.exec(spec)
    if (tableUnique && /^unique\b/i.test(spec)) {
      const cols = splitTopLevel(tableUnique[1] ?? '').map((c) => unquoteIdent(c))
      if (cols.length === 1) {
        const existing = columns.find((c) => c.name === cols[0])
        if (existing) existing.unique = true
        else compositeUniques.push(cols)
        continue
      }
      if (cols.length > 1) { compositeUniques.push(cols); continue }
    }

    // Table-level CHECK — lifted out and applied as a follow-up action.
    if (/^check\s*\(/i.test(spec)) {
      const body = parenBody(spec)
      if (!body) {
        throw new MigrationParseError(
          `Malformed table-level CHECK: "${spec.slice(0, 60)}".`,
          'BAD_STATEMENT',
          'e.g. CHECK (start_date < end_date).',
          stmt,
        )
      }
      checks.push(toParsedCheck(body.body, stmt, specName))
      continue
    }

    // PRIMARY KEY (col) — Backenly provisions `id` itself, so an author's
    // primary key over a managed column is redundant rather than an error.
    if (/^primary\s+key\b/i.test(spec)) {
      const body = parenBody(spec)
      const pkCols = body ? splitTopLevel(body.body).map((c) => unquoteIdent(c)) : []
      if (pkCols.length === 1 && MANAGED_COLUMNS.has(pkCols[0])) continue
      throw new MigrationParseError(
        `Backenly manages the primary key — a table cannot declare its own.`,
        'UNSUPPORTED_CONSTRAINT',
        `Every table gets a managed \`id uuid PRIMARY KEY\`. To enforce uniqueness on ` +
        `${pkCols.length ? `(${pkCols.join(', ')})` : 'other columns'}, use UNIQUE instead — ` +
        `Backenly creates a unique index for it.`,
        stmt,
      )
    }

    if (/^exclude\b/i.test(spec)) {
      throw new MigrationParseError(
        `EXCLUDE constraints are not supported.`,
        'UNSUPPORTED_CONSTRAINT',
        `Most EXCLUDE rules can be expressed as a UNIQUE index or a CHECK. If yours cannot, ` +
        `describe it via backend_chat.`,
        stmt,
      )
    }

    // Anything left that began with CONSTRAINT is a constraint shape we do not
    // model. Refuse it — this is precisely the path that used to fall through
    // `parseColumnDef` returning null and vanish without a trace.
    if (named) {
      throw new MigrationParseError(
        `Constraint "${specName}" uses a form Backenly cannot translate: "${spec.slice(0, 60)}".`,
        'UNSUPPORTED_CONSTRAINT',
        `Supported inside CREATE TABLE: UNIQUE (…), FOREIGN KEY (…) REFERENCES …, CHECK (…). ` +
        `For anything else, describe the rule via backend_chat.`,
        stmt,
      )
    }

    const col = parseColumnDef(part, stmt, checks)
    if (!col) {
      throw new MigrationParseError(
        `Could not translate "${trimmed.slice(0, 60)}" inside CREATE TABLE ${tableName}.`,
        'UNSUPPORTED_CONSTRAINT',
        `Expected a column definition or a UNIQUE / FOREIGN KEY / CHECK constraint.`,
        stmt,
      )
    }
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

  const notes: string[] = []
  if (dropped.length) {
    notes.push(`${dropped.join(', ')} skipped — Backenly provisions these automatically.`)
  }

  const actions: PlannedAction[] = [{
    tool: 'create_table',
    args: { tableName, columns },
    source: stmt,
    ...(notes.length ? { notes } : {}),
  }]

  for (const cols of compositeUniques) {
    actions.push({
      tool: 'create_index',
      args: { tableName, columns: cols, unique: true },
      source: `${stmt} → UNIQUE (${cols.join(', ')})`,
      notes: [`UNIQUE (${cols.join(', ')}) on ${tableName} applied as a unique index — that is how Postgres enforces it.`],
    })
  }

  for (const check of checks) {
    actions.push(checkAction(tableName, check, stmt))
  }

  return actions
}

/**
 * A validated CHECK → the add_constraint action that installs it.
 *
 * `columns` carries every referenced column so the executor can name the
 * constraint deterministically and verify it landed, and `columnName` stays set
 * for the single-column case so the existing column-scoped contract is
 * unchanged.
 */
function checkAction(tableName: string, check: ParsedCheck, source: string): PlannedAction {
  return {
    tool: 'add_constraint',
    args: {
      tableName,
      constraintType: 'check',
      expression: check.expression,
      columns: check.columns,
      ...(check.columns.length === 1 ? { columnName: check.columns[0] } : {}),
      ...(check.name ? { constraintName: check.name } : {}),
    },
    source,
  }
}

/**
 * Translate `ADD [CONSTRAINT name] <body>` into the governed action that
 * installs it.
 *
 * The author's constraint name is now CARRIED THROUGH rather than dropped. It
 * used to be stripped on the grounds that "the platform names its own", and the
 * platform's name was `chk_<table>_<column>` — which collides with every other
 * constraint on the same column. Combined with an executor that treated
 * Postgres's duplicate-name error as success, that produced defect #2: a second
 * CHECK on `status` reported "✅ Constraint already exists" and installed
 * nothing. Honouring the author's name removes the collision at its source, and
 * a generated name now derives from the definition, not just the column.
 */
function translateAddConstraint(tableName: string, body: string, stmt: string): PlannedAction[] {
  const named = /^constraint\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+([\s\S]*)$/i.exec(body.trim())
  const spec = (named ? named[2] : body).trim()
  const constraintName = named ? unquoteIdent(named[1]) : undefined

  const unique = /^unique\s*\(([\s\S]*)\)/i.exec(spec)
  if (unique) {
    const cols = splitTopLevel(unique[1]).map((c) => unquoteIdent(c))
    if (cols.length === 0) {
      throw new MigrationParseError(
        `UNIQUE names no columns.`,
        'BAD_STATEMENT',
        `e.g. ALTER TABLE ${tableName} ADD UNIQUE (email).`,
        stmt,
      )
    }
    if (cols.length === 1) {
      return [{
        tool: 'add_constraint',
        args: { tableName, columnName: cols[0], constraintType: 'unique', ...(constraintName ? { constraintName } : {}) },
        source: stmt,
      }]
    }
    // Multi-column UNIQUE. Postgres implements a UNIQUE constraint AS a unique
    // index, so this is the same guarantee under a different name — not a
    // downgrade, and no longer a refusal (defect #10).
    return [{
      tool: 'create_index',
      args: { tableName, columns: cols, unique: true, ...(constraintName ? { indexName: constraintName } : {}) },
      source: stmt,
      notes: [
        `Multi-column UNIQUE (${cols.join(', ')}) applied as a unique index on ${tableName} — ` +
        `that is how PostgreSQL enforces a composite UNIQUE constraint. The guarantee is identical.`,
      ],
    }]
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
    return [{
      tool: 'add_constraint',
      args: {
        tableName,
        columnName: cols[0],
        constraintType: 'foreign_key',
        expression: `${target}(${targetCol})`,
        referencedTable: target,
        ...(constraintName ? { constraintName } : {}),
      },
      source: stmt,
    }]
  }

  if (/^check\s*\(/i.test(spec)) {
    const check = parenBody(spec)
    if (!check) {
      throw new MigrationParseError(
        `Malformed CHECK: "${spec.slice(0, 60)}".`,
        'BAD_STATEMENT',
        'e.g. ADD CONSTRAINT price_positive CHECK (price > 0).',
        stmt,
      )
    }
    // Nothing may follow the closing paren. Trailing text was silently dropped,
    // which is the same silent-loss class as the constraints themselves: an
    // unbalanced `CHECK (a > 0) AND` would have installed only the first half of
    // the author's intended predicate and reported success.
    const trailing = spec.slice(check.before.length + check.body.length + 2).trim()
    if (trailing.replace(/;$/, '').trim()) {
      throw new MigrationParseError(
        `Unexpected text after the CHECK expression: "${trailing.slice(0, 40)}".`,
        'BAD_STATEMENT',
        `Put the whole predicate inside the parentheses: CHECK (${check.body.trim()} AND …).`,
        stmt,
      )
    }
    // A CHECK over several columns is a TABLE-level constraint, which is exactly
    // what Postgres makes it. It used to be refused as AMBIGUOUS_CONSTRAINT
    // (defect #11) because the executor's contract was column-scoped; the
    // executor now takes the column list, so `CHECK (user_a < user_b)` and
    // `CHECK (requester_id <> addressee_id)` both work.
    return [checkAction(tableName, toParsedCheck(check.body, stmt, constraintName), stmt)]
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
    `Supported: UNIQUE (col[, col…]), FOREIGN KEY (col) REFERENCES other(id), CHECK (expression) — ` +
    `including a CHECK spanning several columns.`,
    stmt,
  )
}

function translateAlterTable(stmt: string): PlannedAction[] {
  const head = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$.]*)\s+([\s\S]*)$/i.exec(stmt)
  if (!head) throw new MigrationParseError('Malformed ALTER TABLE.', 'BAD_STATEMENT', undefined, stmt)

  const tableName = unquoteIdent(head[1])
  assertUnqualified(tableName, stmt)
  const action = head[2].trim()

  // RENAME COLUMN a TO b
  const rename = /^rename\s+(?:column\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+to\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)/i.exec(action)
  if (rename) {
    return [{
      tool: 'rename_column',
      args: { tableName, oldName: unquoteIdent(rename[1]), newName: unquoteIdent(rename[2]) },
      source: stmt,
    }]
  }

  // ALTER COLUMN c SET NOT NULL — the one ALTER COLUMN form that maps cleanly
  // onto a governed constraint. Type changes deliberately do not (they are a
  // data migration, not a constraint) and fall through to the refusal below.
  const setNotNull = /^alter\s+(?:column\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+set\s+not\s+null/i.exec(action)
  if (setNotNull) {
    return [{
      tool: 'add_constraint',
      args: { tableName, columnName: unquoteIdent(setNotNull[1]), constraintType: 'not_null' },
      source: stmt,
    }]
  }

  // ALTER COLUMN c DROP NOT NULL — the inverse. Relaxing a constraint destroys
  // no data, so it belongs here rather than behind the destructive gate.
  const dropNotNull = /^alter\s+(?:column\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+drop\s+not\s+null/i.exec(action)
  if (dropNotNull) {
    return [{
      tool: 'add_constraint',
      args: { tableName, columnName: unquoteIdent(dropNotNull[1]), constraintType: 'drop_not_null' },
      source: stmt,
    }]
  }

  // ALTER COLUMN c SET DEFAULT x / DROP DEFAULT
  const setDefault = /^alter\s+(?:column\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+set\s+default\s+([\s\S]+)$/i.exec(action)
  if (setDefault) {
    return [{
      tool: 'add_constraint',
      args: {
        tableName,
        columnName: unquoteIdent(setDefault[1]),
        constraintType: 'set_default',
        expression: setDefault[2].trim(),
      },
      source: stmt,
    }]
  }
  const dropDefault = /^alter\s+(?:column\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+drop\s+default/i.exec(action)
  if (dropDefault) {
    return [{
      tool: 'add_constraint',
      args: { tableName, columnName: unquoteIdent(dropDefault[1]), constraintType: 'drop_default' },
      source: stmt,
    }]
  }

  // ADD [COLUMN] [IF NOT EXISTS] def
  const add = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([\s\S]*)$/i.exec(action)
  if (add && !/^constraint\b/i.test(add[1].trim()) && !TABLE_CONSTRAINT.test(add[1].trim())) {
    // The CHECK channel is opened so a `CHECK` inline on ADD COLUMN becomes a
    // follow-up add_constraint instead of vanishing — the same defect #1 fix as
    // in CREATE TABLE, on the path an agent uses to evolve a live table.
    const checks: ParsedCheck[] = []
    const col = parseColumnDef(add[1], stmt, checks)
    if (!col) throw new MigrationParseError('Could not parse the added column.', 'BAD_COLUMN_DEF', undefined, stmt)
    const column: Record<string, unknown> = { name: col.name, type: col.type }
    if (col.nullable !== undefined) column.nullable = col.nullable
    if (col.default !== undefined) column.default = col.default
    if (col.unique !== undefined) column.unique = col.unique
    if (col.fkTo !== undefined) column.fkTo = col.fkTo
    const actions: PlannedAction[] = [{ tool: 'add_column', args: { tableName, column }, source: stmt }]
    for (const check of checks) actions.push(checkAction(tableName, check, stmt))
    return actions
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

/**
 * Index methods this translates. `btree` is the default and covers ordering and
 * equality; `gin` is the one an array or jsonb column actually needs, so
 * refusing it would take back most of the value of supporting arrays at all.
 */
const INDEX_METHODS = new Set(['btree', 'gin', 'gist', 'hash', 'brin'])

function translateCreateIndex(stmt: string): PlannedAction[] {
  const m = /^create\s+(unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(?:("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+)?on\s+("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$.]*)\s*([\s\S]*)$/i.exec(stmt)
  if (!m) throw new MigrationParseError('Malformed CREATE INDEX.', 'BAD_STATEMENT', undefined, stmt)

  const unique = !!m[1]
  const indexName = m[2] ? unquoteIdent(m[2]) : undefined
  const tableName = unquoteIdent(m[3])
  assertUnqualified(tableName, stmt)

  const tail = m[4] ?? ''
  const paren = parenBody(tail)
  if (!paren) {
    throw new MigrationParseError(
      'CREATE INDEX needs a parenthesised column list.',
      'BAD_STATEMENT',
      'e.g. `CREATE INDEX ON posts (author_id)`.',
      stmt,
    )
  }

  // ── Everything BEFORE the column list must be accounted for ────────────────
  // `CREATE INDEX ON t USING gin (tags)` put "USING gin " in `paren.before`,
  // which was thrown away without a word — the same silent-loss class as the
  // dropped UNIQUE. Anything here is either a method we translate or a refusal.
  let method: string | undefined
  const beforeCols = paren.before.trim()
  if (beforeCols) {
    const using = /^using\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(beforeCols)
    if (!using) {
      throw new MigrationParseError(
        `Unsupported clause before the column list: "${beforeCols.slice(0, 40)}".`,
        'UNSUPPORTED_STATEMENT',
        `Supported: CREATE [UNIQUE] INDEX [name] ON <table> [USING <method>] (col[, col…]).`,
        stmt,
      )
    }
    method = using[1].toLowerCase()
    if (!INDEX_METHODS.has(method)) {
      throw new MigrationParseError(
        `Index method "${method}" is not supported.`,
        'UNSUPPORTED_STATEMENT',
        `Supported methods: ${[...INDEX_METHODS].join(', ')}.`,
        stmt,
      )
    }
  }

  // ── And everything AFTER it ────────────────────────────────────────────────
  // A partial index's WHERE clause is the whole point of a partial index. It was
  // being dropped silently, producing an index over every row and a ✅.
  // `paren.before` is tail.slice(0, openIndex), so the ')' sits at
  // before.length + 1 + body.length — derive the offset, never search for it.
  const afterCols = tail.slice(paren.before.length + paren.body.length + 2).trim()
  if (afterCols) {
    const where = /^where\s+([\s\S]+)$/i.exec(afterCols.replace(/;$/, '').trim())
    if (!where) {
      throw new MigrationParseError(
        `Unsupported clause after the column list: "${afterCols.slice(0, 40)}".`,
        'UNSUPPORTED_STATEMENT',
        `Supported: an optional WHERE predicate for a partial index. INCLUDE, WITH and ` +
        `tablespace clauses are not translated — describe the need via backend_chat.`,
        stmt,
      )
    }
    assertSafeCheckExpression(where[1], stmt)
    return [{
      tool: 'create_index',
      args: {
        tableName, columns: indexColumns(paren.body), unique,
        ...(method ? { method } : {}),
        ...(indexName ? { indexName } : {}),
        where: where[1].trim(),
      },
      source: stmt,
    }]
  }

  // The caller's index NAME is honoured. It used to be dropped with a note
  // saying so — while the same call also silently dropped UNIQUE and every
  // column after the first (defects #4 and #5). The note drew attention to the
  // one harmless difference and said nothing about the two that mattered.
  return [{
    tool: 'create_index',
    args: {
      tableName,
      columns: indexColumns(paren.body),
      unique,
      ...(method ? { method } : {}),
      ...(indexName ? { indexName } : {}),
    },
    source: stmt,
  }]
}

/** Column list of an index, with ordering/nulls modifiers stripped. */
function indexColumns(body: string): string[] {
  return splitTopLevel(body).map((c) =>
    unquoteIdent(c.replace(/\s+(asc|desc|nulls\s+(first|last)|[a-z_]+_ops)\b/gi, '')),
  )
}

function translateDml(stmt: string, verb: string): never {
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

function translateStatement(stmt: string): PlannedAction[] {
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

  // A CREATE POLICY is a real thing to want and the reason an agent reaches for
  // raw SQL here. It cannot be translated (Backenly's policies are governed
  // objects with a template and an owner column, not free text), but the answer
  // is a specific tool, not a shrug.
  if (/^create\s+policy\b/i.test(s) || /^alter\s+table\s+[\s\S]*row\s+level\s+security/i.test(s)) {
    throw new MigrationParseError(
      `Row-Level Security is not set through apply_migration.`,
      'RLS_NOT_MIGRATION',
      `Use add_rls, which takes a policy template AND an optional explicit predicate: ` +
      `{ tableName, policy: "participants", partyColumns: ["user_a","user_b"] } for a two-party table, ` +
      `or { tableName, policy: "custom", using: "<predicate>" } for a rule the templates do not cover. ` +
      `read_backend_state {section:"rls"} shows what is currently installed.`,
      s,
    )
  }

  if (/^create\s+(or\s+replace\s+)?(function|trigger|type|view|materialized|extension|schema|sequence|domain)\b/i.test(s)) {
    const what = /^create\s+(?:or\s+replace\s+)?([a-z]+)/i.exec(s)?.[1]?.toLowerCase() ?? 'object'
    throw new MigrationParseError(
      `CREATE ${what.toUpperCase()} is not translated by apply_migration.`,
      'UNSUPPORTED_STATEMENT',
      what === 'trigger' ? `Describe the trigger via backend_chat — Backenly models it as a governed trigger with a rollback path.`
      : what === 'type' ? `Enums are not modelled as Postgres types. Use a text column with a CHECK: ` +
        `\`status text NOT NULL CHECK (status IN ('a','b'))\` — apply_migration applies that CHECK.`
      : what === 'function' ? `Use generate_function for application logic, or backend_chat to describe a database function.`
      : `Describe what you need via backend_chat.`,
      s,
    )
  }

  throw new MigrationParseError(
    `Statement not supported: "${s.slice(0, 60)}".`,
    'UNSUPPORTED_STATEMENT',
    `apply_migration supports CREATE TABLE, ALTER TABLE (ADD COLUMN / RENAME COLUMN / ADD CONSTRAINT / ` +
    `ALTER COLUMN SET|DROP NOT NULL / SET|DROP DEFAULT) and CREATE [UNIQUE] INDEX. ` +
    `For auth, storage, realtime, functions, RLS or anything else, call backend_chat and describe what you want.`,
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
 *
 * One statement may expand into SEVERAL actions: a CREATE TABLE carrying CHECK
 * constraints and composite UNIQUEs becomes create_table + add_constraint… +
 * create_index…, because `create_table`'s contract is columns and nothing else.
 * Before this, those constraints were dropped on the floor and the migration
 * still reported success — the single worst defect on this surface (#1).
 */
export function parseMigration(sql: string): PlannedAction[] {
  const statements = splitStatements(sql)
  if (statements.length === 0) {
    throw new MigrationParseError('Empty migration.', 'EMPTY_MIGRATION')
  }
  return statements.flatMap(translateStatement)
}
