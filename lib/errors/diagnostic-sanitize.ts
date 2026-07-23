/**
 * DIAGNOSTIC ERROR SANITIZER
 * ==========================
 * Converts raw Prisma / Postgres error messages into clean, specific
 * developer-facing diagnostics for surfaces like:
 *
 *   - Behavioral verifier check results
 *   - Production readiness gate details
 *   - /commit and /scan responses
 *   - The end-user runtime API (signup/login error envelopes)
 *
 * Design contract:
 *
 *   1. NEVER expose Prisma stack-trace vocabulary
 *      ("Invalid prisma.$queryRawUnsafe() invocation", "Raw query failed",
 *       "PrismaClientKnownRequestError", file paths, line numbers).
 *
 *   2. ALWAYS keep what the developer needs to act on
 *      (constraint name, table name, column name, the SQLSTATE category in
 *      plain English).
 *
 *   3. Provide actionable guidance per SQLSTATE family — not a single
 *      "something went wrong" collapse. This is the difference between a
 *      bug we can fix and a bug we can't.
 *
 * This is a *diagnostic* sanitizer (for the build/scan/deploy surfaces).
 * For end-user-facing app errors that should be fully generic, use
 * lib/errors/sanitize.ts:sanitizeError.
 */

/** Postgres SQLSTATE → plain-English category + fix guidance. */
const PG_CODE_MAP: Record<string, { label: string; hint: string }> = {
  '23502': {
    label: 'required value missing',
    hint: 'a NOT NULL column was inserted without a value',
  },
  '23503': {
    label: 'reference points to a row that does not exist',
    hint: 'the foreign key column references a row that has not been created yet',
  },
  '23505': {
    label: 'duplicate value',
    hint: 'a unique column already has this value',
  },
  '23514': {
    label: 'value is not allowed by a check rule',
    hint: 'the column has a CHECK constraint restricting which values are valid',
  },
  '42501': {
    label: 'permission denied',
    hint: 'row-level security blocked this operation for the current user context',
  },
  '42P01': {
    label: 'table does not exist',
    hint: 'the referenced table is missing from this workspace',
  },
  '42703': {
    label: 'column does not exist',
    hint: 'the referenced column is missing from the table',
  },
  '22P02': {
    label: 'invalid value format',
    hint: 'the value does not match the column type (e.g. text where a UUID is expected)',
  },
  '22001': {
    label: 'value too long',
    hint: 'the value exceeds the column length limit',
  },
  '40001': {
    label: 'concurrent write conflict',
    hint: 'a serialization conflict — retrying usually resolves it',
  },
  '57014': {
    label: 'query cancelled',
    hint: 'the statement was cancelled (usually a timeout)',
  },
}

const MAX_LEN = 320

/**
 * Strip Prisma envelope text from a message.
 *
 * Removes patterns like:
 *   "Invalid `prisma.$queryRawUnsafe()` invocation:\nRaw query failed. Code: `23503`. Message: `…`"
 *   "PrismaClientKnownRequestError: …"
 *   File paths with line:col coords
 */
function stripPrismaEnvelope(input: string): string {
  let s = input

  // Drop the Prisma invocation prefix entirely
  s = s.replace(/Invalid\s+`?prisma\.\$?\w+(?:Unsafe)?\(\)`?\s+invocation:?[\s\S]*?(?=Raw query failed|Message:|$)/i, '')

  // "Raw query failed. Code: `23xxx`. Message: `…`" → keep the inner message
  s = s.replace(/Raw query failed\.?\s*Code:\s*`?(\w+)`?\.?\s*Message:\s*`?/i, '[code=$1] ')

  // Trailing backtick from the message envelope
  s = s.replace(/`\s*$/, '')

  // PrismaClientKnownRequestError / PrismaClientUnknownRequestError prefix
  s = s.replace(/Prisma(?:Client)?\w*Error:?\s*/gi, '')

  // File path + line:col leaks (e.g. `at /var/www/app/lib/foo.ts:42:18`)
  s = s.replace(/\s*at\s+[^\s]+:\d+:\d+/g, '')
  s = s.replace(/[A-Za-z]:\\[^\s]+\.(ts|js|tsx|jsx):\d+:\d+/g, '')
  s = s.replace(/\/[^\s]+\.(ts|js|tsx|jsx):\d+:\d+/g, '')

  // Stack frames
  s = s.replace(/\n\s*at\s+.+(?=\n|$)/g, '')

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim()

  return s
}

/** Extract the SQLSTATE code if present in the message. */
function extractCode(input: string): string | null {
  // Forms seen in the wild:
  //   "Code: `23503`"
  //   "[code=23503]"
  //   "(SQLSTATE 23503)"
  //   "PG error 23503"
  const m =
    input.match(/`(\d{5}|\w{5})`/) ||
    input.match(/\[code=(\w{5})\]/i) ||
    input.match(/SQLSTATE\s*(\w{5})/i) ||
    input.match(/\bPG(?:_error)?\s*(\w{5})\b/i)
  return m ? m[1] : null
}

/** Extract a constraint name from a Postgres detail message. */
function extractConstraintName(input: string): string | null {
  // `violates foreign key constraint "fk_carts_user"`
  // `violates check constraint "chk_users_role"`
  // `violates unique constraint "users_email_key"`
  const m = input.match(/constraint\s+"([^"]+)"/i)
  return m ? m[1] : null
}

/** Extract the table name from a Postgres detail message. */
function extractTableName(input: string): string | null {
  // `insert or update on table "carts" violates …`
  // `relation "workspace_xxx.carts" does not exist`
  // `null value in column "user_id" of relation "carts"`
  const m1 = input.match(/on\s+table\s+"([^"]+)"/i)
  if (m1) return m1[1]
  const m2 = input.match(/relation\s+"([^"]+\.)?([^"]+)"/i)
  if (m2) return m2[2]
  return null
}

/** Extract the column name from a Postgres detail message. */
function extractColumnName(input: string): string | null {
  // `null value in column "role" of relation "users"`
  // `column "is_blocked" does not exist`
  const m = input.match(/column\s+"([^"]+)"/i)
  return m ? m[1] : null
}

/**
 * Convert any internal error into a clean diagnostic message.
 *
 * Output shape: "<category> on <table>.<column> (<constraint>): <hint>"
 * — but only the parts that were actually extractable.
 */
export function sanitizeDiagnostic(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err ?? '')
  if (!raw) return 'Unknown error.'

  const stripped = stripPrismaEnvelope(raw)

  const code = extractCode(stripped) ?? extractCode(raw)
  const constraint = extractConstraintName(stripped)
  const table = extractTableName(stripped)
  const column = extractColumnName(stripped)
  const mapped = code ? PG_CODE_MAP[code] : null

  // Path 1 — Recognised SQLSTATE: build a structured one-liner.
  if (mapped) {
    const target = table && column ? `${table}.${column}` : table ?? column ?? null
    const parts: string[] = []
    parts.push(capitalize(mapped.label))
    if (target) parts.push(`on \`${target}\``)
    if (constraint) parts.push(`(${constraint})`)
    parts.push(`— ${mapped.hint}.`)
    return clamp(parts.join(' '))
  }

  // Path 2 — Recognisable Postgres detail without a mapped code.
  if (constraint || table || column) {
    const target = table && column ? `${table}.${column}` : table ?? column ?? null
    const parts: string[] = []
    if (target) parts.push(`Database error on \`${target}\``)
    else parts.push('Database error')
    if (constraint) parts.push(`(${constraint})`)
    return clamp(parts.join(' ') + '.')
  }

  // Path 3 — Stripped envelope but unstructured text. Filter obviously
  // unsafe vocab before returning.
  const stillUnsafe = /(prisma|stack trace|node_modules|\bat\s+\w+:|invocation:)/i.test(stripped)
  if (stillUnsafe || stripped.length < 4) {
    return 'Database error — see deploy logs for details.'
  }

  return clamp(capitalize(stripped))
}

/**
 * Quick guard — true when the input would be UNSAFE to display directly to a
 * user (contains Prisma vocab, file paths, stack frames, or invocation noise).
 */
export function looksUnsafeForUser(input: unknown): boolean {
  const s = input instanceof Error ? input.message : String(input ?? '')
  return /(prisma\.[a-z$]+|raw query failed|invocation:|stack trace|node_modules|\bat\s+[^\s]+:\d+:\d+)/i.test(s)
}

function clamp(s: string): string {
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN - 1).trimEnd() + '…' : s
}

function capitalize(s: string): string {
  if (!s) return s
  return s[0].toUpperCase() + s.slice(1)
}
