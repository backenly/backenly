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
export type ExpressionCheck =
  | { kind: 'ok'; ok: true; expression: string; columns: string[] }
  | { kind: 'rejected'; ok: false; reason: string; hint: string }

export type ExpressionRejection = Extract<ExpressionCheck, { kind: 'rejected' }>

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
  opts: { requireColumn?: boolean; maxLength?: number } = {},
): ExpressionCheck {
  const { requireColumn = true, maxLength = 2000 } = opts

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

  // Statement keywords. A subquery is not legal in a CHECK anyway, and it is the
  // shape an injection attempt takes.
  const bare = trimmed.replace(/'(?:[^']|'')*'/g, "''")
  const stmtKeyword = /\b(select|insert|update|delete|merge|with|grant|revoke|copy|do|call|create|alter|drop|truncate|comment|vacuum|analyze|set|reset|begin|commit|rollback|listen|notify|prepare|execute)\b/i.exec(bare)
  if (stmtKeyword) {
    return {
      kind: 'rejected',
      ok: false,
      reason: `it contains the statement keyword "${stmtKeyword[1].toUpperCase()}".`,
      hint:
        'This expression cannot contain a subquery or another statement. To enforce a rule that ' +
        'has to read a different table, describe it via backend_chat — Backenly models it as a ' +
        'trigger or an RLS policy, which can.',
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
    if (!EXPR_FUNCTIONS.has(fn)) {
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
  const withoutStrings = trimmed.replace(/'(?:[^']|'')*'/g, "''")
  const illegal = /[^\w\s'"().,<>=!+\-*/%|&:\[\]$]/.exec(withoutStrings)
  if (illegal) {
    return {
      kind: 'rejected',
      ok: false,
      reason: `it contains the character "${illegal[0]}", which is not part of a supported predicate.`,
      hint: 'Use comparisons, AND/OR/NOT, IN (…), BETWEEN, IS NULL and arithmetic.',
    }
  }

  const columns = referencedColumns(trimmed)
  if (requireColumn && columns.length === 0) {
    return {
      kind: 'rejected',
      ok: false,
      reason: 'it does not reference any column.',
      hint: 'A constraint restricts column values — name at least one column, e.g. `price > 0`.',
    }
  }

  return { kind: 'ok', ok: true, expression: trimmed, columns }
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
