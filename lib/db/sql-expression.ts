/**
 * SQL EXPRESSION VALIDATION
 * =========================
 * One closed grammar for the boolean expressions that reach raw DDL.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * A CHECK constraint, a partial index's WHERE clause and an RLS predicate all
 * share one uncomfortable property: they are DDL, so they cannot be
 * parameterised. `ADD CONSTRAINT x CHECK ($1)` is not valid SQL — the expression
 * has to land in the statement text. Quoting it as a literal would defeat the
 * point; the whole value of `CHECK (price > 0)` is that `price > 0` is code.
 *
 * So the boundary has to be a validator, and it has to be a CLOSED one:
 * anything not recognised is refused rather than passed through. A permissive
 * fallback here is arbitrary SQL execution wearing a constraint definition.
 *
 * ── Why it is shared ─────────────────────────────────────────────────────────
 *
 * Two callers reach the same DDL by different routes — `apply_migration` through
 * the SQL parser, and `add_constraint` called directly as a brain tool. When
 * each had its own idea of what was safe (and for a while the executor had none
 * at all), the guarantee was whichever was weaker. There is one grammar now, and
 * both paths run it.
 *
 * ── What it deliberately does NOT do ─────────────────────────────────────────
 *
 * It does not attempt to be a PostgreSQL parser. It accepts a conservative
 * subset — comparisons, boolean connectives, IN lists, BETWEEN, IS NULL, casts,
 * arithmetic, and a fixed set of pure functions — and refuses everything else,
 * including things Postgres would happily accept. A refusal costs an agent one
 * call and names the alternative; a false accept costs a customer their database.
 */

/** Identifier shape accepted anywhere an unquoted identifier appears. */
export const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/

/**
 * SQL keywords and literals that may appear in a predicate without being a
 * column reference.
 */
export const EXPR_KEYWORDS = new Set([
  'and', 'or', 'not', 'in', 'is', 'null', 'true', 'false', 'between', 'like',
  'ilike', 'similar', 'to', 'any', 'all', 'some', 'exists', 'case', 'when',
  'then', 'else', 'end', 'current_timestamp', 'current_date', 'current_user',
  'asc', 'desc', 'collate', 'array', 'distinct', 'from', 'symmetric', 'unknown',
])

/**
 * Pure, side-effect-free functions a predicate may call. Closed allowlist.
 *
 * Chosen for what schemas actually need — string length and case rules, numeric
 * rounding, null coalescing, array cardinality — and nothing that touches the
 * filesystem, the catalog, another table, or time in a way that would make a
 * CHECK non-deterministic (`random()`, `clock_timestamp()`).
 */
export const EXPR_FUNCTIONS = new Set([
  'char_length', 'character_length', 'length', 'octet_length', 'bit_length',
  'lower', 'upper', 'initcap', 'trim', 'btrim', 'ltrim', 'rtrim',
  'abs', 'round', 'floor', 'ceil', 'ceiling', 'sign', 'mod', 'div',
  'coalesce', 'nullif', 'greatest', 'least',
  'cardinality', 'array_length', 'array_position',
  'position', 'strpos', 'substr', 'substring', 'left', 'right', 'split_part',
  'md5', 'concat', 'concat_ws', 'replace',
  'date_part', 'extract', 'date_trunc', 'now',
  // Cast-style calls Postgres accepts in function form.
  'numeric', 'text', 'int', 'integer', 'bigint', 'boolean', 'uuid', 'jsonb',
  // ── Backenly's own claim reader ────────────────────────────────────────────
  //
  // `backenly_jwt_claim('sub')` is how a policy names the calling end-user, so a
  // `custom` RLS predicate that cannot call it cannot reference the caller — which
  // makes the entire escape hatch useless. It is a STABLE, per-schema SQL
  // function that reads `request.jwt.claims` and nothing else: no side effects, no
  // filesystem, no other table. It is also the ONLY way a caller can reach the
  // request identity, which is why it is named explicitly here rather than covered
  // by a prefix rule.
  'backenly_jwt_claim',
])

/**
 * ── Why `kind` and not just `ok` ─────────────────────────────────────────────
 *
 * This project compiles with `strict: false`, where boolean literal types widen
 * and `ok: true` / `ok: false` therefore cannot narrow a union — every caller
 * would see `reason` and `hint` as missing properties even inside an `if (!ok)`
 * branch. A string discriminant narrows regardless of strictness, which is the
 * same reason lib/services/rls-ownership.ts discriminates `RlsPlan` on `kind`.
 *
 * `ok` is kept alongside it because `if (!checked.ok)` is what a reader expects
 * to write; `kind` is what makes it typecheck.
 */
/**
 * Whether an index predicate says "every row": `true`, in any case, with or
 * without parentheses. It is how a caller asks for a UNIQUE index that also
 * counts soft-deleted rows, which is the only kind an ON CONFLICT upsert can
 * target. It names no column, so the constraint grammar below would refuse it.
 */
export function isEveryRowPredicate(expr: string): boolean {
  let e = expr.trim()
  while (e.startsWith('(') && e.endsWith(')')) e = e.slice(1, -1).trim()
  return /^true$/i.test(e)
}

export type ExpressionCheck =
  | { kind: 'ok'; ok: true; expression: string; columns: string[] }
  | { kind: 'rejected'; ok: false; reason: string; hint: string }

export type ExpressionRejection = Extract<ExpressionCheck, { kind: 'rejected' }>

/**
 * ── The one legal way to read another table from a predicate ─────────────────
 *
 * Passing this to `validateBooleanExpression` opts into a SINGLE extra
 * production: `EXISTS (SELECT 1 FROM parent alias WHERE <predicate>)`. Nothing
 * else about the grammar changes.
 *
 * Why it exists: without it, a rule that spans two tables was unwritable. The
 * `related_rows` template builds exactly this shape internally, so the engine
 * has always emitted it — but a caller could not, because the statement-keyword
 * check refuses the word SELECT. That gap had a concrete cost. A chat app whose
 * messages belong to the participants of their parent conversation is the
 * canonical two-table rule, and the only way to express it was `related_rows`,
 * which applies ONE predicate to all four commands. The moment the author needed
 * "participants may read, but only the sender may edit", they had to drop to
 * `custom` — where the EXISTS was refused, so the parent lookup was silently
 * lost and the rule collapsed to `sender_id = sub`. Reported as "complex
 * predicates regress to the simplest owner-column form".
 *
 * It is safe because it is CLOSED, not because it is filtered:
 *   - the projection must be the literal `1` — never a column, never a function;
 *   - exactly one table, resolved against the caller-supplied catalog, so an
 *     unknown or cross-schema name is refused rather than qualified;
 *   - every column named must exist on the parent, the alias, or the policy's
 *     own table, so a typo cannot silently widen the rule to a cross join;
 *   - the WHERE clause is re-validated by this same function with `exists`
 *     withheld, so it inherits every rule above it and cannot nest;
 *   - LIMIT / ORDER BY / GROUP BY / HAVING / OFFSET / UNION / JOIN are refused,
 *     because none of them changes whether a row exists and all of them widen
 *     the parse surface.
 *
 * The emitted SQL is schema-qualified from `schemaName` rather than from
 * anything the author wrote, which is what stops a predicate from reaching
 * another tenant's table.
 */
export interface ExistsContext {
  /** Workspace schema. Qualifies the parent in the emitted SQL. */
  schemaName: string
  /** The table the policy is attached to; its columns may be referenced. */
  selfTable: string
  /** Tables this predicate may read, each with its column set. */
  tables: Map<string, Set<string>>
}

/**
 * Every column a predicate references, in first-appearance order.
 *
 * Quoted identifiers keep their case; unquoted ones are lower-cased, matching
 * PostgreSQL's own folding rules so the result can be compared against catalog
 * column names.
 */
export function referencedColumns(expr: string): string[] {
  const cleaned = expr
    .replace(/'(?:[^']|'')*'/g, ' ')                                  // string literals
    .replace(/::\s*[A-Za-z_][A-Za-z0-9_ ]*(\[\s*\])?/g, ' ')          // casts
  const found: string[] = []
  const seen = new Set<string>()
  const re = /("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s*(\()?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned))) {
    if (m[2]) continue                          // a function call, not a column
    const raw = m[1]
    const ident = raw.startsWith('"')
      ? raw.slice(1, -1).replace(/""/g, '"')
      : raw.toLowerCase()
    if (!raw.startsWith('"') && EXPR_KEYWORDS.has(ident)) continue
    if (/^\d/.test(ident)) continue
    if (seen.has(ident)) continue
    seen.add(ident)
    found.push(ident)
  }
  return found
}

/**
 * Validate a boolean predicate destined for raw DDL.
 *
 * @param expr           The expression text as the author wrote it.
 * @param opts.requireColumn  Refuse a predicate that names no column. True for a
 *                            CHECK (a constraint over nothing is meaningless);
 *                            false for an RLS predicate, which may legitimately
 *                            be a bare `true`.
 */
export function validateBooleanExpression(
  expr: unknown,
  opts: {
    requireColumn?: boolean
    maxLength?: number
    exists?: ExistsContext
    /** Functions allowed besides EXPR_FUNCTIONS (validateConversionExpression's). */
    extraFunctions?: ReadonlySet<string>
  } = {},
): ExpressionCheck {
  const { requireColumn = true, maxLength = 2000, exists, extraFunctions } = opts

  if (typeof expr !== 'string' || !expr.trim()) {
    return {
      kind: 'rejected',
      ok: false,
      reason: 'it is empty.',
      hint: 'Write the predicate itself, e.g. `price > 0`.',
    }
  }

  // A trailing semicolon is a habit, not an attack — strip one and evaluate the
  // rest. Any semicolon that survives is a real statement separator.
  const trimmed = expr.trim().replace(/;\s*$/, '').trim()

  if (trimmed.length > maxLength) {
    return {
      kind: 'rejected',
      ok: false,
      reason: `it exceeds ${maxLength} characters.`,
      hint: 'Express a rule this large as a database trigger — describe it via backend_chat.',
    }
  }
  if (trimmed.includes(';')) {
    return {
      kind: 'rejected',
      ok: false,
      reason: 'it contains a semicolon.',
      hint: 'This must be a single boolean expression — it cannot chain statements.',
    }
  }
  if (/--|\/\*|\*\//.test(trimmed)) {
    return {
      kind: 'rejected',
      ok: false,
      reason: 'it contains a comment marker.',
      hint: 'Remove the comment from inside the expression.',
    }
  }
  if (/\$[A-Za-z_0-9]*\$/.test(trimmed)) {
    return {
      kind: 'rejected',
      ok: false,
      reason: 'it contains dollar-quoting.',
      hint: 'Use ordinary single-quoted literals.',
    }
  }
  if (!balanced(trimmed)) {
    return {
      kind: 'rejected',
      ok: false,
      reason: 'its parentheses or quotes are unbalanced.',
      hint: 'Check that every ( has a matching ) and every quote is closed.',
    }
  }

  // ── EXISTS, when the caller opted in ───────────────────────────────────────
  //
  // Lifted out BEFORE the statement-keyword check and replaced with `TRUE`, so
  // every rule below still runs against a predicate that contains no SELECT.
  // `emitted` is what lands in DDL: identical to the author's text except that
  // each parent table is qualified from ExistsContext.schemaName.
  let emitted = trimmed
  let forChecks = trimmed
  if (exists) {
    const lifted = extractExistsClauses(trimmed, exists)
    if (lifted.kind === 'rejected') return lifted
    emitted = lifted.rewritten
    forChecks = lifted.blanked
  }

  // Statement keywords. A subquery is not legal in a CHECK anyway, and it is the
  // shape an injection attempt takes.
  const bare = forChecks.replace(/'(?:[^']|'')*'/g, "''")
  const stmtKeyword = /\b(select|insert|update|delete|merge|with|grant|revoke|copy|do|call|create|alter|drop|truncate|comment|vacuum|analyze|set|reset|begin|commit|rollback|listen|notify|prepare|execute)\b/i.exec(bare)
  if (stmtKeyword) {
    return {
      kind: 'rejected',
      ok: false,
      reason: `it contains the statement keyword "${stmtKeyword[1].toUpperCase()}".`,
      hint: exists
        ? 'The only subquery form accepted here is EXISTS (SELECT 1 FROM parent p WHERE p.id = ' +
          'this_table.parent_id AND …). Anything else — a scalar subquery, IN (SELECT …), a join — ' +
          'is refused. Model it as a trigger via backend_chat.'
        : 'This expression cannot contain a subquery or another statement. To enforce a rule that ' +
          'has to read a different table, use set_rls, whose predicates accept ' +
          'EXISTS (SELECT 1 FROM parent p WHERE …) — or describe it via backend_chat.',
    }
  }

  // Every function call must be on the allowlist.
  const callRe = /("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = callRe.exec(bare))) {
    if (m[1].startsWith('"')) {
      return {
        kind: 'rejected',
        ok: false,
        reason: `it calls a quoted function "${m[1]}".`,
        hint: 'Only the built-in functions in the allowlist may be called from a constraint.',
      }
    }
    const fn = m[1].toLowerCase()
    if (EXPR_KEYWORDS.has(fn)) continue          // `IN (`, `NOT (`, `AND (` …
    if (!EXPR_FUNCTIONS.has(fn) && !extraFunctions?.has(fn)) {
      return {
        kind: 'rejected',
        ok: false,
        reason: `it calls "${fn}()", which is not allowed here.`,
        hint:
          `Allowed functions include ${[...EXPR_FUNCTIONS].sort().slice(0, 10).join(', ')} and similar ` +
          `pure built-ins. For anything else, describe the rule via backend_chat.`,
      }
    }
  }

  // Only characters that can appear in the accepted grammar.
  const withoutStrings = forChecks.replace(/'(?:[^']|'')*'/g, "''")
  const illegal = /[^\w\s'"().,<>=!+\-*/%|&:\[\]$]/.exec(withoutStrings)
  if (illegal) {
    return {
      kind: 'rejected',
      ok: false,
      reason: `it contains the character "${illegal[0]}", which is not part of a supported predicate.`,
      hint: 'Use comparisons, AND/OR/NOT, IN (…), BETWEEN, IS NULL and arithmetic.',
    }
  }

  // Columns are read from the OUTER predicate only. A column that appears solely
  // inside an EXISTS belongs to the parent, and reporting it as a column of this
  // table would mislead every caller that uses this list to build DDL.
  const columns = referencedColumns(forChecks)
  if (requireColumn && columns.length === 0) {
    return {
      kind: 'rejected',
      ok: false,
      reason: 'it does not reference any column.',
      hint: 'A constraint restricts column values — name at least one column, e.g. `price > 0`.',
    }
  }

  return { kind: 'ok', ok: true, expression: emitted, columns }
}

// ── Column conversions: ALTER COLUMN … TYPE … USING ───────────────────────────

/**
 * Functions a column conversion may call besides EXPR_FUNCTIONS: the built-in
 * conversions a type change needs (epoch seconds to a time, text to a date or a
 * number, a delimited string to an array, a value to json). Pure, and none of
 * them reads a table.
 */
export const CONVERSION_FUNCTIONS: ReadonlySet<string> = new Set([
  'to_timestamp', 'to_date', 'to_number', 'to_char',
  'string_to_array', 'array_to_string', 'to_jsonb', 'timezone',
])

/** A type as a cast writes it: `integer`, `double precision`, `numeric(10,2)`, `timestamp with time zone`, `text[]`. */
const CAST_TYPE =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\s+(?:precision|varying))?(?:\s*\(\s*\d+\s*(?:,\s*\d+\s*)?\))?(?:\s+with(?:out)?\s+time\s+zone)?(?:\s*\[\s*\])*/

/**
 * The expression after USING in `ALTER COLUMN c TYPE t USING …`: how each row's
 * new value is computed from its old one.
 *
 * It runs once over every row, as the platform, so it is held to the closed
 * grammar above and to more:
 *   - it reads one column, the one being converted;
 *   - it calls only EXPR_FUNCTIONS and CONVERSION_FUNCTIONS, and nothing is
 *     reached through a schema or a table: a qualified name is refused;
 *   - a cast (`::t`, `CAST(x AS t)`) names a type `castType` accepts (the
 *     migration parser's declared types), never a catalog type like regclass;
 *   - AT TIME ZONE takes a literal zone name, and `interval` a literal;
 *   - no backslash, no E'…' or other prefixed string, no `$`: what is checked
 *     here is read exactly as PostgreSQL will read it.
 * The caller runs it with search_path set to pg_catalog, so every name it uses
 * is a built-in, whatever the project's own schema holds.
 *
 * The expression is returned as written.
 */
export function validateConversionExpression(
  expr: unknown,
  opts: { column: string; castType: (type: string) => boolean },
): ExpressionCheck {
  const refuse = (reason: string, hint: string): ExpressionRejection => ({ kind: 'rejected', ok: false, reason, hint })
  const example = `e.g. USING ${opts.column}::integer, or USING NULLIF(${opts.column}, '')::numeric`
  if (typeof expr !== 'string' || !expr.trim()) return refuse('it is empty.', `Write how the new value is computed from the old one, ${example}.`)
  const written = expr.trim().replace(/;\s*$/, '').trim()
  if (written.length > 1000) return refuse('it exceeds 1000 characters.', 'Convert in steps: add a column, fill it with run_data_migration, then drop the old one.')

  // Literals out first, so nothing below can mistake text inside one for code.
  const literals: string[] = []
  let shape = ''
  for (let i = 0; i < written.length; ) {
    const ch = written[i]
    if (ch === '\\' || ch === '$') return refuse(`it contains "${ch}".`, `Use plain single-quoted literals, ${example}.`)
    if (ch === '"') {
      const end = closingQuote(written, i, '"')
      if (end < 0) return refuse('a quoted name is not closed.', 'Check that every " has a match.')
      shape += written.slice(i, end + 1)
      i = end + 1
      continue
    }
    if (ch === "'") {
      if (i > 0 && /[A-Za-z0-9_&]/.test(written[i - 1])) {
        return refuse('it contains a prefixed string such as E\'…\'.', `Use plain single-quoted literals, ${example}.`)
      }
      const end = closingQuote(written, i, "'")
      if (end < 0) return refuse('a string literal is not closed.', "Check that every ' has a match.")
      literals.push(written.slice(i, end + 1))
      shape += ` __lit${literals.length - 1}__ `
      i = end + 1
      continue
    }
    shape += ch
    i++
  }
  const literal = (n: string) => literals[Number(n)].slice(1, -1).replace(/''/g, "'")

  if (/[A-Za-z0-9_"]\s*\.\s*[A-Za-z_"]/.test(shape)) {
    return refuse('it names something through a schema or a table.', `Use the column's bare name and built-in functions, ${example}.`)
  }

  // AT TIME ZONE '<zone>' and interval '<literal>' are literals, not names.
  for (const m of shape.matchAll(/\bat\s+time\s+zone\s+__lit(\d+)__/gi)) {
    if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(literal(m[1]))) {
      return refuse(`"${literal(m[1])}" is not a time zone name.`, "Name the zone, e.g. AT TIME ZONE 'UTC' or 'Asia/Kolkata'.")
    }
  }
  shape = shape.replace(/\bat\s+time\s+zone\s+__lit\d+__/gi, ' ').replace(/\binterval\s+__lit\d+__/gi, ' ')

  // CAST(x AS t) reads as (x) once t is a type it may name.
  for (let m = /\bcast\s*\(/i.exec(shape); m; m = /\bcast\s*\(/i.exec(shape)) {
    const open = m.index + m[0].length - 1
    const close = matchParen(shape, open)
    if (close < 0) return refuse('a CAST has no closing parenthesis.', 'Check that every ( has a matching ).')
    const body = shape.slice(open + 1, close)
    let as = -1
    let depth = 0
    for (let k = 0; k < body.length; k++) {
      if (body[k] === '(') depth++
      else if (body[k] === ')') depth--
      else if (depth === 0 && /\bas\b/i.test(body.slice(k, k + 3)) && /\s/.test(body[k - 1] ?? '') && /\s/.test(body[k + 2] ?? '')) as = k
    }
    const type = as < 0 ? '' : body.slice(as + 2).trim()
    if (as < 0 || CAST_TYPE.exec(type)?.[0] !== type || !opts.castType(type)) {
      return refuse(`CAST(… AS ${type || '?'}) names a type that cannot be used here.`, 'Cast to one of the column types a migration declares: text, integer, bigint, numeric, boolean, date, timestamptz, uuid, jsonb, …')
    }
    shape = `${shape.slice(0, m.index)}(${body.slice(0, as)})${shape.slice(close + 1)}`
  }

  // x::t reads as x once t is a type it may name.
  for (let m = /::\s*/.exec(shape); m; m = /::\s*/.exec(shape)) {
    const rest = shape.slice(m.index + m[0].length)
    const type = CAST_TYPE.exec(rest)?.[0]
    if (!type || !opts.castType(type.trim())) {
      return refuse(`::${(type ?? rest).trim().slice(0, 40)} names a type that cannot be used here.`, 'Cast to one of the column types a migration declares: text, integer, bigint, numeric, boolean, date, timestamptz, uuid, jsonb, …')
    }
    shape = `${shape.slice(0, m.index)} ${rest.slice(type.length)}`
  }

  const checked = validateBooleanExpression(shape.replace(/__lit\d+__/g, "''"), {
    requireColumn: true,
    maxLength: 2000,
    extraFunctions: CONVERSION_FUNCTIONS,
  })
  if (checked.kind !== 'ok') {
    return refuse(
      checked.reason,
      `A conversion computes each row's new value from the column's own value, with casts and built-in functions ` +
      `such as nullif, trim, round, lower, to_timestamp, to_date, to_number and string_to_array (${example}). ` +
      `To use other columns or tables, add a column and fill it with run_data_migration.`,
    )
  }
  const other = checked.columns.filter((c) => c !== opts.column)
  if (other.length > 0) {
    return refuse(
      `it reads ${other.map((c) => `"${c}"`).join(', ')}, and a conversion reads only the column it converts ("${opts.column}").`,
      'To compute a value from other columns, add a new column and fill it with run_data_migration.',
    )
  }
  return { kind: 'ok', ok: true, expression: written, columns: checked.columns }
}

/** Index of the quote closing the one at `open` (a doubled quote is part of the text), or -1. */
function closingQuote(s: string, open: number, quote: string): number {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] !== quote) continue
    if (s[i + 1] === quote) { i++; continue }
    return i
  }
  return -1
}

/**
 * Find each top-level `EXISTS ( … )` span, validate it as the closed production
 * documented on ExistsContext, and return the expression with every span
 * schema-qualified plus a copy with the spans blanked to `TRUE`.
 *
 * The blanked copy is what the ordinary grammar checks run against. That is the
 * whole trick: the outer predicate is held to exactly the rules it was always
 * held to — it never learns the word SELECT — while the inner clause is checked
 * by a separate, stricter pass. Neither one is loosened to accommodate the other.
 */
function extractExistsClauses(
  expr: string,
  ctx: ExistsContext,
): { kind: 'ok'; rewritten: string; blanked: string } | ExpressionRejection {
  let rewritten = ''
  let blanked = ''
  let i = 0

  while (i < expr.length) {
    // Only match EXISTS on a word boundary and outside a string literal.
    const ch = expr[i]
    if (ch === "'") {
      const start = i
      i++
      while (i < expr.length) {
        if (expr[i] === "'") { if (expr[i + 1] === "'") { i += 2; continue } i++; break }
        i++
      }
      const lit = expr.slice(start, i)
      rewritten += lit
      blanked += lit
      continue
    }

    const rest = expr.slice(i)
    const m = /^exists\s*\(/i.exec(rest)
    if (!m) { rewritten += ch; blanked += ch; i++; continue }

    // Take the balanced body of this EXISTS.
    const open = i + m[0].length - 1
    const close = matchParen(expr, open)
    if (close < 0) {
      return {
        kind: 'rejected',
        ok: false,
        reason: 'an EXISTS clause has no closing parenthesis.',
        hint: 'Check that every ( has a matching ).',
      }
    }
    const body = expr.slice(open + 1, close)
    const parsed = parseExistsBody(body, ctx)
    if (parsed.kind === 'rejected') return parsed

    rewritten += parsed.sql
    blanked += 'TRUE'
    i = close + 1
  }

  return { kind: 'ok', rewritten, blanked }
}

/** Index of the `)` matching the `(` at `open`, or -1. Skips string literals. */
function matchParen(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const ch = s[i]
    if (ch === "'") {
      i++
      while (i < s.length) {
        if (s[i] === "'") { if (s[i + 1] === "'") { i++; continue } break }
        i++
      }
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * `SELECT 1 FROM parent [AS] alias WHERE <predicate>` and nothing else.
 * Returns the schema-qualified SQL for the whole EXISTS clause.
 */
function parseExistsBody(
  body: string,
  ctx: ExistsContext,
): { kind: 'ok'; sql: string } | ExpressionRejection {
  const refuse = (reason: string, hint: string): ExpressionRejection =>
    ({ kind: 'rejected', ok: false, reason, hint })

  const shape =
    /^\s*select\s+1\s+from\s+("?[A-Za-z_][A-Za-z0-9_$]*"?)(?:\s+(?:as\s+)?("?[A-Za-z_][A-Za-z0-9_$]*"?))?\s+where\s+([\s\S]+)$/i
      .exec(body.trim())
  if (!shape) {
    return refuse(
      'an EXISTS clause is not in the one supported form.',
      "Write it as EXISTS (SELECT 1 FROM parent_table p WHERE p.id = this_table.parent_id AND …). " +
      'The projection must be literally `1`, there must be exactly one table, and a WHERE clause is required.',
    )
  }

  const parentRaw = unquote(shape[1])
  const aliasRaw = shape[2] ? unquote(shape[2]) : parentRaw
  const where = shape[3].trim()

  if (!SAFE_IDENT.test(parentRaw)) {
    return refuse(`"${parentRaw}" is not a valid table name.`, 'Name a table in this project.')
  }
  if (!SAFE_IDENT.test(aliasRaw)) {
    return refuse(`"${aliasRaw}" is not a valid alias.`, 'Use a plain identifier as the alias.')
  }

  const parentCols = ctx.tables.get(parentRaw)
  if (!parentCols) {
    const known = [...ctx.tables.keys()].sort().slice(0, 12).join(', ')
    return refuse(
      `an EXISTS clause reads "${parentRaw}", which is not a table in this project.`,
      `Tables available: ${known}${ctx.tables.size > 12 ? ', …' : ''}. ` +
      'A predicate can only read this project\'s own tables.',
    )
  }

  // Clauses that do not change existence but do widen the parse surface.
  const bareWhere = where.replace(/'(?:[^']|'')*'/g, "''")
  const banned = /\b(limit|offset|order\s+by|group\s+by|having|union|intersect|except|join|lateral|fetch|window|distinct)\b/i.exec(bareWhere)
  if (banned) {
    return refuse(
      `an EXISTS clause uses "${banned[0].toUpperCase()}".`,
      'EXISTS only asks whether a matching row exists, so ordering, grouping, limits and joins have ' +
      'no effect on the answer and are not accepted. Express the extra condition in the WHERE clause, ' +
      'or model the rule as a trigger via backend_chat.',
    )
  }

  // The inner predicate is held to the SAME grammar, with `exists` withheld so
  // it cannot nest. `requireColumn` is off: `WHERE p.id = t.pid` is all columns,
  // but a legitimate rule may compare only against the claim.
  const inner = validateBooleanExpression(where, { requireColumn: false })
  if (inner.kind !== 'ok') {
    return refuse(
      `the WHERE clause of an EXISTS is not valid: ${inner.reason}`,
      inner.hint,
    )
  }

  // Every qualified reference must resolve. An unresolvable prefix is how a
  // typo turns `p.user_a = sub` into a predicate that reads nothing and a rule
  // that matches every row.
  const selfCols = ctx.tables.get(ctx.selfTable)
  const qualRe = /("?[A-Za-z_][A-Za-z0-9_$]*"?)\s*\.\s*("?[A-Za-z_][A-Za-z0-9_$]*"?)/g
  let q: RegExpExecArray | null
  while ((q = qualRe.exec(where))) {
    const qual = unquote(q[1])
    const col = unquote(q[2])
    const isAlias = qual === aliasRaw || qual === parentRaw
    const isSelf = qual === ctx.selfTable
    if (!isAlias && !isSelf) {
      return refuse(
        `an EXISTS clause references "${qual}.${col}", but "${qual}" is neither the parent ` +
        `("${parentRaw}"${aliasRaw !== parentRaw ? ` aliased ${aliasRaw}` : ''}) nor the table being secured ("${ctx.selfTable}").`,
        'A predicate may only join the parent to the row being checked.',
      )
    }
    const cols = isAlias ? parentCols : selfCols
    if (cols && cols.size > 0 && !cols.has(col)) {
      return refuse(
        `an EXISTS clause references "${qual}.${col}", which does not exist on "${isAlias ? parentRaw : ctx.selfTable}".`,
        `Columns on ${isAlias ? parentRaw : ctx.selfTable}: ${[...cols].sort().slice(0, 15).join(', ')}. ` +
        'Check the name with get_table_schema.',
      )
    }
  }

  // Qualify the parent from OUR schema name, never from the author's text.
  const aliasSql = aliasRaw === parentRaw ? `"${parentRaw}"` : `"${parentRaw}" "${aliasRaw}"`
  return {
    kind: 'ok',
    sql: `EXISTS (SELECT 1 FROM "${ctx.schemaName}".${aliasSql} WHERE ${inner.expression})`,
  }
}

function unquote(ident: string): string {
  return ident.startsWith('"') && ident.endsWith('"')
    ? ident.slice(1, -1).replace(/""/g, '"')
    : ident
}

/** Parens and single/double quotes all closed. */
function balanced(s: string): boolean {
  let depth = 0
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === "'" || ch === '"') {
      const quote = ch
      i++
      let closed = false
      while (i < s.length) {
        if (s[i] === quote) {
          if (s[i + 1] === quote) { i += 2; continue }
          closed = true
          i++
          break
        }
        i++
      }
      if (!closed) return false
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') { depth--; if (depth < 0) return false }
    i++
  }
  return depth === 0
}
