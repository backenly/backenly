/**
 * A STATEMENT'S TEXT, READ THE WAY POSTGRESQL READS IT
 * ===================================================
 *
 * pg_stat_statements keeps each statement's text as it was sent, comments
 * included. Comments are not SQL, so a reader that asks what a statement reads
 * from, or which schema it names, has to take them out first; and quoted
 * identifiers, string literals and dollar-quoted bodies have to be skipped as
 * whole tokens, or a `--` inside a string reads as the start of a comment.
 *
 * Pure: no database, no imports.
 */

/** The end of a single- or double-quoted token starting at `i`, past its closing quote. */
function endOfQuoted(sql: string, i: number): number {
  const quote = sql[i]
  let j = i + 1
  while (j < sql.length) {
    if (sql[j] === quote) {
      // A doubled quote is one quote character inside the token.
      if (sql[j + 1] === quote) {
        j += 2
        continue
      }
      return j + 1
    }
    j++
  }
  return sql.length
}

/** A dollar-quote opening tag at `i` ($$ or $tag$), or null. `$1` is a parameter, never a tag. */
function dollarTagAt(sql: string, i: number): string | null {
  const m = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i, i + 64))
  return m ? m[0] : null
}

/** The end of the comment starting at `i` (`--` to the end of the line; block comments nest). */
function endOfComment(sql: string, i: number): number {
  if (sql.startsWith('--', i)) {
    const nl = sql.indexOf('\n', i)
    return nl === -1 ? sql.length : nl
  }
  let depth = 1
  let j = i + 2
  while (j < sql.length && depth > 0) {
    if (sql.startsWith('/*', j)) {
      depth++
      j += 2
    } else if (sql.startsWith('*/', j)) {
      depth--
      j += 2
    } else {
      j++
    }
  }
  return j
}

/**
 * The statement with its comments replaced by a space, and every other
 * character as written. Block comments nest in PostgreSQL, so they nest here.
 */
export function withoutComments(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    if (sql.startsWith('--', i) || sql.startsWith('/*', i)) {
      i = endOfComment(sql, i)
      out += ' '
      continue
    }
    const ch = sql[i]
    if (ch === "'" || ch === '"') {
      const end = endOfQuoted(sql, i)
      out += sql.slice(i, end)
      i = end
      continue
    }
    if (ch === '$') {
      const tag = dollarTagAt(sql, i)
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length)
        const end = close === -1 ? sql.length : close + tag.length
        out += sql.slice(i, end)
        i = end
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

/**
 * The statement as its clauses read: comments removed, and every string
 * literal and dollar-quoted body replaced by a placeholder, so nothing inside
 * a string or a function body is taken for a table, a column or a WHERE.
 * Quoted identifiers are kept as written.
 */
export function statementClauses(sql: string): string {
  const text = withoutComments(sql)
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") {
      i = endOfQuoted(text, i)
      out += '$0'
      continue
    }
    if (ch === '"') {
      const end = endOfQuoted(text, i)
      out += text.slice(i, end)
      i = end
      continue
    }
    if (ch === '$') {
      const tag = dollarTagAt(text, i)
      if (tag) {
        const close = text.indexOf(tag, i + tag.length)
        i = close === -1 ? text.length : close + tag.length
        out += '$0'
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

const IDENT_START = /[A-Za-z_\u0080-￿]/
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/

/**
 * Whether the statement, read as SQL, uses `schema` as a qualifier
 * (`"schema".table`, `schema.table`): an identifier equal to it, followed by a
 * dot. A quoted identifier is compared exactly, an unquoted one folded to lower
 * case as PostgreSQL folds it. Comments, string literals and dollar-quoted
 * bodies name nothing.
 */
export function namesSchema(sql: string, schema: string): boolean {
  const text = statementClauses(sql)
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    let ident: string | null = null
    let end = i + 1
    if (ch === '"') {
      end = endOfQuoted(text, i)
      ident = text.slice(i + 1, end - 1).replace(/""/g, '"')
    } else if (IDENT_START.test(ch) && !(i > 0 && IDENT_PART.test(text[i - 1]))) {
      end = i + 1
      while (end < text.length && IDENT_PART.test(text[end])) end++
      ident = text.slice(i, end).toLowerCase()
    }
    if (ident !== null && ident === schema) {
      let k = end
      while (k < text.length && /\s/.test(text[k])) k++
      if (text[k] === '.') return true
    }
    i = end
  }
  return false
}
