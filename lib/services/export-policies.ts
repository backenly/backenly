/**
 * What a portable database export does with row-level security policies.
 *
 * Production QA (2026-11-09): a portable export carried FORCE ROW LEVEL
 * SECURITY for nine tables and none of their policies, so a restore was a
 * backend that denied every row, or exposed every row once someone turned
 * row-level security off. The export dropped every CREATE POLICY on the
 * grounds that policies name Backenly's roles. Backenly's own rules name no
 * role: they apply to every role (lib/services/workspace-rls.ts) and read the
 * request's claims through a function in the same schema
 * (lib/postgrest/rls-translation.ts), so they restore anywhere.
 *
 * A policy written for particular roles (`TO …`) restores only where those
 * roles exist. The export creates it for those of its roles the server has: a
 * role that does not exist has no members, so the policy then behaves exactly
 * as it does here. When the server has none of them, the restore skips the
 * policy with a warning that names it, and skips a comment on it too. A
 * warning, because a dump sets client_min_messages to warning before anything
 * else, so psql would never show a notice.
 *
 * pg_dump's plain format makes this exact (PostgreSQL 16, src/bin/pg_dump):
 * every object follows a `-- Name: …; Type: …` header; a policy is one
 * statement, `CREATE POLICY name ON table[ AS RESTRICTIVE][ FOR cmd][ TO
 * roles][ USING (…)][ WITH CHECK (…)];`, with no TO clause when it applies to
 * every role; and table data sits between `COPY … FROM stdin;` and `\.`.
 * Nothing else is touched: a line of a function body or a row of data that
 * reads like a policy passes through as it is, and so does a policy in a shape
 * this file does not recognise.
 */
import { Transform } from 'stream'
import { StringDecoder } from 'string_decoder'

// How pg_dump writes a name: bare when it is lowercase letters, digits and
// underscores, starting with a letter or underscore; otherwise in double
// quotes, with any double quote in it doubled (fmtId, quote_ident).
const NAME = String.raw`(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_]*)`
const NAMES = new RegExp(NAME, 'g')
const CREATE_POLICY = new RegExp(
  String.raw`^CREATE POLICY (${NAME}) ON (${NAME}\.${NAME})((?: AS RESTRICTIVE)?(?: FOR (?:SELECT|INSERT|UPDATE|DELETE))?)` +
    String.raw`(?: TO (${NAME}(?:, ${NAME})*))?((?: USING \(| WITH CHECK \(|;)[\s\S]*)$`,
)
const COMMENT_ON_POLICY = new RegExp(String.raw`^COMMENT ON POLICY (${NAME} ON ${NAME}\.${NAME}) IS `)
const HEADER = /^-- (?:Data for )?Name: .*; Type: ([A-Z ]+); Schema: .*; Owner: .*$/
const COPY_FROM_STDIN = /^COPY .* FROM stdin;$/

const unquote = (name: string) => (name.startsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name)
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`

/** A policy statement as pg_dump writes it, split where its roles go. */
export interface DumpedPolicy {
  /** The policy's name, as written. */
  name: string
  /** Its table, schema-qualified, as written. */
  table: string
  /** The roles it is for, unquoted; empty when it applies to every role. */
  roles: string[]
  /** `CREATE POLICY name ON table[ AS RESTRICTIVE][ FOR cmd]` */
  head: string
  /** What follows the roles, `[ USING (…)][ WITH CHECK (…)]`, without the `;`. */
  tail: string
}

/** Reads one CREATE POLICY statement; null when it is not in pg_dump's shape. */
export function parseDumpedPolicy(statement: string): DumpedPolicy | null {
  const m = CREATE_POLICY.exec(statement.trimEnd())
  if (!m || !m[5].endsWith(';')) return null
  const [, name, table, options, roles, rest] = m
  return {
    name,
    table,
    roles: roles ? (roles.match(NAMES) ?? []).map(unquote) : [],
    head: `CREATE POLICY ${name} ON ${table}${options}`,
    tail: rest.slice(0, -1),
  }
}

function doBlock(lines: string[]): string {
  const body = lines.join('\n')
  let tag = '$portable$'
  for (let i = 1; body.includes(tag); i++) tag = `$portable${i}$`
  return `DO ${tag}\n${body}\n${tag};`
}

/** The policy, created for those of its roles the server it is restored on has. */
function forTheRolesThere(p: DumpedPolicy): string {
  const warning = `Policy ${p.name} on ${p.table} was not restored: this server has none of its roles (${p.roles.join(', ')}).`
  return doBlock([
    'DECLARE',
    '  present text;',
    'BEGIN',
    "  SELECT string_agg(quote_ident(rolname), ', ' ORDER BY rolname) INTO present",
    `    FROM pg_catalog.pg_roles WHERE rolname IN (${p.roles.map(literal).join(', ')});`,
    '  IF present IS NULL THEN',
    `    RAISE WARNING '%', ${literal(warning)};`,
    '  ELSE',
    `    EXECUTE ${literal(`${p.head} TO `)} || present || ${literal(p.tail)};`,
    '  END IF;',
    'END',
  ])
}

/** A comment on such a policy, made only where the policy was restored. */
function ifRestored(p: DumpedPolicy, comment: string): string {
  return doBlock([
    'BEGIN',
    `  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = ${literal(p.table)}::regclass AND polname = ${literal(unquote(p.name))}) THEN`,
    `    EXECUTE ${literal(comment.trimEnd().replace(/;$/, ''))};`,
    '  END IF;',
    'END',
  ])
}

/** The quote still open at the end of `text`, given the one open at its start. */
function openQuoteAfter(text: string, open: string | null): string | null {
  for (const ch of text) {
    if (open) {
      if (ch === open) open = null
    } else if (ch === '"' || ch === "'") {
      open = ch
    }
  }
  return open
}

/**
 * Streams a pg_dump plain-format script, changing only policies written for
 * particular roles and comments on them, as described above.
 */
export function portablePolicies(): Transform {
  const decoder = new StringDecoder('utf8')
  const forRoles = new Map<string, DumpedPolicy>() // `name ON table` → policy
  let carry = '' // the start of a line whose end has not arrived
  let entry: string | null = null // the type of the object pg_dump is writing
  let inCopy = false
  let statement: string[] | null = null
  let open: string | null = null

  const rewrite = (text: string): string => {
    if (text.startsWith('CREATE POLICY ')) {
      const policy = parseDumpedPolicy(text)
      if (!policy || policy.roles.length === 0) return text
      forRoles.set(`${policy.name} ON ${policy.table}`, policy)
      return forTheRolesThere(policy)
    }
    const on = COMMENT_ON_POLICY.exec(text)?.[1]
    const policy = on ? forRoles.get(on) : undefined
    return policy ? ifRestored(policy, text) : text
  }

  const take = (line: string, out: string[]): void => {
    if (!statement) {
      if (inCopy) {
        if (line === '\\.') inCopy = false
        out.push(line)
        return
      }
      const header = HEADER.exec(line)
      if (header) entry = header[1]
      else if (entry === 'TABLE DATA' && COPY_FROM_STDIN.test(line)) inCopy = true
      const starts =
        (entry === 'POLICY' && line.startsWith('CREATE POLICY ')) ||
        (entry === 'COMMENT' && line.startsWith('COMMENT ON POLICY '))
      if (!starts) {
        out.push(line)
        return
      }
      statement = []
      open = null
    }
    statement.push(line)
    open = openQuoteAfter(line, open)
    if (open === null && /;\s*$/.test(line)) {
      out.push(rewrite(statement.join('\n')))
      statement = null
      entry = null
    }
  }

  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      const lines = (carry + decoder.write(chunk)).split('\n')
      carry = lines.pop() ?? ''
      const out: string[] = []
      for (const line of lines) take(line, out)
      cb(null, out.length > 0 ? out.join('\n') + '\n' : '')
    },
    flush(cb) {
      const last = carry + decoder.end()
      const out: string[] = []
      if (last !== '') take(last, out)
      // A statement the dump never finished goes out as it came.
      if (statement) out.push(statement.join('\n') + (last === '' ? '\n' : ''))
      cb(null, out.join('\n'))
    },
  })
}
