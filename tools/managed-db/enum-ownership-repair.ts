/**
 * The enum ownership repair, as data: the SQL file's permitted vocabulary, and
 * the exact script a launcher sends.
 *
 * Kept apart from the launcher so the tests run the SAME script against a real
 * database that `scripts/run-enum-ownership-repair.ts` sends to RDS, instead of
 * a copy that drifts.
 */

import { join } from 'node:path'

export const ENUM_REPAIR_SQL_PATH = join('tools', 'managed-db', 'sql', 'enum-ownership-repair.sql')

/** The one dynamic statement the file may execute. */
export const PERMITTED_EXECUTE = "EXECUTE format('ALTER TYPE %s OWNER TO %I', r.ident, app_role)"

export interface AuditFinding {
  statement: string
  why: string
}

/**
 * Anything outside "report enum owners, then move enum owners" is refused.
 *
 * Narrower than the cutover's audit, on purpose: the cutover creates a role and
 * sets a password, and this must be incapable of either. A repair job that
 * could rotate a credential would be the cutover again, which is the thing this
 * exists to avoid re-running.
 */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\bALTER\s+ROLE\b/i, why: 'roles are not this job' },
  { pattern: /\bCREATE\b/i, why: 'this repairs owners; it creates nothing' },
  { pattern: /\bPASSWORD\b/i, why: 'never touches a credential' },
  { pattern: /\bGRANT\b/i, why: 'privileges are not this job' },
  { pattern: /\bREVOKE\b/i, why: 'privileges are not this job' },
  { pattern: /\bDROP\b/i, why: 'this moves ownership, it never drops' },
  { pattern: /\bREASSIGN\s+OWNED\b/i, why: 'sweeps objects that must not move' },
  { pattern: /\bALTER\s+(TABLE|DATABASE|SCHEMA|FUNCTION|SEQUENCE|VIEW|DEFAULT|SYSTEM)\b/i, why: 'only types move' },
  { pattern: /\b(INSERT|UPDATE|DELETE|TRUNCATE|COPY)\b/i, why: 'no data is touched' },
  { pattern: /\bSET\s+(LOCAL\s+)?ROLE\b/i, why: 'runs as the role it connected as' },
  { pattern: /\bSECURITY\s+DEFINER\b/i, why: 'no elevated objects' },
]

export function auditEnumRepairSql(sql: string): AuditFinding[] {
  const findings: AuditFinding[] = []

  // Comments first: they explain the things the file refuses to do, and they
  // contain apostrophes that would otherwise open a phantom string literal.
  const withoutComments = sql
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('--'))
    .join('\n')
  const executable = withoutComments.replace(/'(?:[^']|'')*'/g, "''").replace(/--.*$/gm, '')

  for (const { pattern, why } of FORBIDDEN) {
    const m = executable.match(pattern)
    if (m) findings.push({ statement: m[0], why })
  }

  // Dynamic SQL hides behind a string literal, which the sweep above cannot
  // see. So every EXECUTE must be the one permitted statement, word for word.
  const executes = (executable.match(/\bEXECUTE\b/gi) ?? []).length
  const permitted = withoutComments.split(PERMITTED_EXECUTE).length - 1
  if (executes !== permitted) {
    findings.push({ statement: `${executes} EXECUTE, ${permitted} permitted`, why: 'the only dynamic statement allowed is ALTER TYPE ... OWNER TO' })
  }

  // At top level, DO blocks and nothing else.
  const outside = withoutComments.replace(/DO\s+\$\$[\s\S]*?\$\$\s*;/gi, '').trim()
  if (outside !== '') {
    findings.push({ statement: outside.slice(0, 120), why: 'only DO blocks are allowed at top level' })
  }

  return findings
}

export interface RepairSettings {
  apply: boolean
  database: string
  appRole: string
}

/** Lowercase PostgreSQL identifiers only: they are written into SQL. */
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/

/**
 * The script as sent: three settings, then the audited file unchanged.
 *
 * The settings are the ONLY launcher-supplied text, and each is a boolean or a
 * validated identifier, so nothing a caller passes can become SQL.
 */
export function buildEnumRepairScript(sql: string, s: RepairSettings): string {
  if (!IDENT.test(s.database)) throw new Error(`database name is not a plain identifier: ${s.database}`)
  if (!IDENT.test(s.appRole)) throw new Error(`application role is not a plain identifier: ${s.appRole}`)
  return [
    `SELECT set_config('backenly.repair_apply', '${s.apply ? 'true' : 'false'}', false);`,
    `SELECT set_config('backenly.repair_expect_database', '${s.database}', false);`,
    `SELECT set_config('backenly.repair_expect_app_role', '${s.appRole}', false);`,
    sql,
  ].join('\n')
}

export interface RepairResult {
  mode: 'apply' | 'report'
  wouldMove: number
  moved: number
  notOwnedByAppRole: number
}

/** The last line the SQL prints. Absent means the run did not complete. */
export function parseRepairResult(text: string): RepairResult | null {
  const m = text.match(/REPAIR_RESULT mode=(apply|report) would_move=(\d+) moved=(\d+) not_owned_by_app_role=(\d+)/)
  if (!m) return null
  return {
    mode: m[1] as 'apply' | 'report',
    wouldMove: Number(m[2]),
    moved: Number(m[3]),
    notOwnedByAppRole: Number(m[4]),
  }
}
