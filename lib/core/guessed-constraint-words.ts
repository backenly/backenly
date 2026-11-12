/**
 * What a `guessed_constraint` finding says (lib/autonomy/guessed-constraints.ts).
 *
 * One rule on a table that Backenly added because of a column's or a table's
 * name, which the request that made the table did not ask for. The finding
 * says which rule, what it does to writes today, and how sure Backenly is that
 * the request did not ask for it: the SQL itself, the column list the request
 * gave, or nothing recorded at all.
 *
 * Pure (no prisma), like finding-summaries and fix-actions, which read it, so
 * the Autonomy page, the agent's list and the hint say the same thing.
 */

export type GuessedRule = 'unique_by_name' | 'check_by_table_name'

/**
 * How Backenly knows the request did not ask for the rule.
 *   sql         the SQL that made the column is in History and declares no such rule
 *   request     the request's column list is recorded and asks for no such rule
 *   unrecorded  nothing kept says what the request asked for: the rule has
 *               exactly the name and definition Backenly's name rules give
 */
export type GuessEvidence = 'sql' | 'request' | 'unrecorded'

export interface GuessedConstraintDetails {
  tableName: string
  columnName: string
  constraintName: string
  rule: GuessedRule
  evidence: GuessEvidence
  /** check_by_table_name: the values the CHECK allows. */
  allowedValues?: string[]
  /** check_by_table_name: values another CHECK on the column allows and this one refuses. */
  refusesAllowedByOwnCheck?: string[]
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** "a, b and c" */
export function plainList(values: string[]): string {
  if (values.length <= 1) return values.join('')
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`
}

/** The details as written by the detector, or null when they cannot name the rule. */
export function readGuessedConstraint(details: Record<string, unknown> | null | undefined): GuessedConstraintDetails | null {
  const d = details ?? {}
  const rule = d.rule === 'unique_by_name' || d.rule === 'check_by_table_name' ? d.rule : null
  const evidence = d.evidence === 'sql' || d.evidence === 'request' || d.evidence === 'unrecorded' ? d.evidence : 'unrecorded'
  const tableName = str(d.tableName)
  const columnName = str(d.columnName)
  const constraintName = str(d.constraintName)
  if (!rule || !tableName || !columnName || !constraintName) return null
  return {
    tableName,
    columnName,
    constraintName,
    rule,
    evidence,
    allowedValues: strings(d.allowedValues),
    refusesAllowedByOwnCheck: strings(d.refusesAllowedByOwnCheck),
  }
}

/** Which part of the name the rule read: "email", "username" or "slug". */
function nameWord(column: string): string {
  const lower = column.toLowerCase()
  return ['email', 'username', 'slug'].find((w) => lower.includes(w)) ?? lower
}

/**
 * What the rule is and why Backenly says nobody asked for it, then what it
 * does to writes today. One paragraph, no advice: the caller adds the question
 * or the way to remove it.
 */
export function guessedConstraintSentence(g: GuessedConstraintDetails): string {
  const { tableName: t, columnName: c } = g
  if (g.rule === 'unique_by_name') {
    const effect = `it stops two rows of ${t} from having the same ${c}.`
    switch (g.evidence) {
      case 'sql':
        return `Backenly added UNIQUE on ${t}.${c}. Your SQL didn't ask for it, and ${effect}`
      case 'request':
        return `Backenly added UNIQUE on ${t}.${c} because of the column's name. The request didn't ask for it, and ${effect}`
      default:
        return (
          `Backenly's name rules added UNIQUE on ${t}.${c}, because the column's name has "${nameWord(c)}" in it. ` +
          `Nothing recorded shows the request asked for it, and ${effect}`
        )
    }
  }

  const allowed = g.allowedValues?.length ? plainList(g.allowedValues) : 'a fixed list of values'
  const what = `a CHECK on ${t}.${c} that allows only ${allowed}`
  const refused = g.refusesAllowedByOwnCheck ?? []
  const effect = refused.length
    ? `it refuses ${plainList(refused)}, which your own CHECK on ${c} allows.`
    : `it refuses any other ${c}.`
  switch (g.evidence) {
    case 'sql':
      return `Backenly added ${what}. Your SQL didn't ask for it, and ${effect}`
    case 'request':
      return `Backenly added ${what}, because of the table's name. The request didn't ask for it, and ${effect}`
    default:
      return (
        `Backenly's name rules added ${what}, because the table is named ${t}. ` +
        `Nothing recorded shows the request asked for it, and ${effect}`
      )
  }
}

/** The statement that removes the rule, as an agent would send it to apply_migration. */
export function dropStatementFor(g: Pick<GuessedConstraintDetails, 'tableName' | 'constraintName'>): string {
  const ident = (n: string) => (/^[a-z_][a-z0-9_]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`)
  return `ALTER TABLE ${ident(g.tableName)} DROP CONSTRAINT ${ident(g.constraintName)};`
}

/** The one-line finding, for the Autonomy page: the sentence and the offer. */
export function guessedConstraintSummary(details: Record<string, unknown> | null | undefined): string {
  const g = readGuessedConstraint(details)
  return g ? `${guessedConstraintSentence(g)} Remove it?` : 'A rule Backenly added from a name nobody asked for'
}

/**
 * The finding as an agent reads it in list_findings: the sentence, and who
 * decides. Kept short, since the list carries every open finding.
 */
export function guessedConstraintForAgent(details: Record<string, unknown> | null | undefined): string {
  const g = readGuessedConstraint(details)
  const sentence = g ? guessedConstraintSentence(g) : 'Backenly added a rule from a name, which the request did not ask for.'
  return `${sentence} Removing it waits for a person on the Autonomy page.`
}

/**
 * What to do about it, for anyone who asks (getManualRemediationHint): the
 * sentence, who decides, and the statement that removes it.
 */
export function guessedConstraintHint(details: Record<string, unknown> | null | undefined): string {
  const g = readGuessedConstraint(details)
  if (!g) return 'Backenly added a rule from a name, which the request did not ask for. A person decides on the Autonomy page whether to remove it.'
  return (
    `${guessedConstraintSentence(g)}\n\nIf your app needs rows it refuses, remove it on the Autonomy page: one click, ` +
    `recorded in History, which can restore it. An agent asked to remove it sends ${dropStatementFor(g)} to ` +
    `apply_migration, and a person approves it first (on a protected production, on a branch they merge).\n\n` +
    `If it should stay, keep it, and Backenly will not ask again.`
  )
}
