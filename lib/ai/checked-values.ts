/**
 * VALUES A TEST ROW MAY CARRY
 * ===========================
 * Backenly's own checks write test rows: the behavioral verifier before a
 * publish (lib/ai/behavioral-verifier.ts) and run_test's create
 * (lib/ai/brain/verify-create.ts). A row needs a value for each required
 * column, and a column under a CHECK constraint takes only some values.
 *
 * Those values used to be guessed: 0 for every number, and for a column under
 * a CHECK the first quoted text in its definition, whatever the rule was. A
 * rating that must be 1 to 5 was given 0, a column under (email ~* '^.+@.+$')
 * was given the pattern itself, the insert failed, and the failure was
 * reported as the project's: a store could not be published because of
 * Backenly's own test row (production QA, 2026-11-21, N1).
 *
 * Here nothing is assumed about what a rule means. Candidates are listed for
 * the column (the numbers and texts its rules mention and their neighbours,
 * then values of common shapes), and PostgreSQL is asked which of them its
 * rules accept, by evaluating the rules' own expressions over the candidates.
 * Whatever the rule is, a range, a list, a length, a pattern, a function, the
 * answer is the database's.
 *
 * A rule over several columns is not searched: each column gets a value its
 * own rules accept, and the INSERT decides the rest. A column none of whose
 * candidates is accepted gets no value, and the caller says the table could not
 * be tested, never that it is broken.
 */

import crypto from 'crypto'
import { workspaceRawClient } from '@/lib/data-plane/regional'

/** A column a test row needs a value for. */
export interface CheckedColumn {
  name: string
  /** format_type(): the exact type a value is cast to, schema-qualified where it must be. */
  type: string
  /** pg_type.typname: int4, text, timestamptz, _text, an enum's own name… */
  typname: string
  /** pg_type.typcategory: S string, N number, B boolean, D date and time, T interval, A array, E enum. */
  category: string
  enumLabels?: string[] | null
}

/** A CHECK constraint of a table. */
export interface TableCheck {
  name: string
  /** pg_get_expr(conbin, conrelid): the rule, naming the table's columns bare. */
  expression: string
  /** The columns the rule reads. */
  columns: string[]
}

/** What the choosing runs its statements on: a transaction that is rolled back. */
export interface ValueTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>
  $executeRawUnsafe(query: string, ...values: any[]): Promise<number>
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`

/** A table's CHECK constraints, from the catalog of the project's database. */
export async function loadTableChecks(projectId: string, schemaName: string, table: string): Promise<TableCheck[]> {
  const db = await workspaceRawClient(projectId)
  const rows = await db.$queryRawUnsafe<Array<{ name: string; expression: string | null; columns: string[] | null }>>(
    `SELECT c.conname::text AS name,
            pg_get_expr(c.conbin, c.conrelid) AS expression,
            ARRAY(SELECT a.attname::text
                    FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                   ORDER BY k.ord) AS columns
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype = 'c' AND n.nspname = $1 AND t.relname = $2
      ORDER BY c.conname`,
    schemaName,
    table,
  )
  return rows
    .filter((r) => typeof r.expression === 'string' && r.expression.length > 0)
    .map((r) => ({ name: r.name, expression: r.expression as string, columns: r.columns ?? [] }))
}

/** The rules that read this column and no other: the ones a value alone can meet. */
export function ownChecks(column: string, checks: TableCheck[]): TableCheck[] {
  return checks.filter((c) => c.columns.length === 1 && c.columns[0] === column)
}

const INTEGER_TYPES = new Set(['int2', 'int4', 'int8', 'oid'])

/** The element a one-element array of this type is tried with. */
function arrayElement(typname: string, salt: string): string {
  const element = typname.replace(/^_/, '')
  if (INTEGER_TYPES.has(element) || ['numeric', 'float4', 'float8'].includes(element)) return '1'
  if (element === 'bool') return 'false'
  if (element === 'uuid') return crypto.randomUUID()
  return `bv-probe-${salt}`
}

/**
 * Values worth trying for a column, as text PostgreSQL casts to the column's
 * type. The first is the value a column under no rule gets, and is always one
 * the type takes. After it come the values the column's own rules mention and
 * their neighbours: for (rating >= 1 AND rating <= 5) that is 1, 2, 0, 5, 6, 4,
 * and for a list of allowed texts it is the list. A mentioned text that is a
 * pattern, not a value, is one more candidate the rule itself turns down. Last
 * come values of common shapes.
 */
export function candidateValues(col: CheckedColumn, checks: TableCheck[], salt: string): string[] {
  const out: string[] = []
  const add = (...values: string[]) => {
    for (const v of values) if (!out.includes(v)) out.push(v)
  }
  const rules = ownChecks(col.name, checks).map((c) => c.expression).join('\n')
  const texts = Array.from(rules.matchAll(/'((?:[^']|'')*)'/g), (m) => m[1].replace(/''/g, "'"))
  // Numbers outside quotes: a rule's bounds, and a list's members.
  const numbers = Array.from(rules.replace(/'(?:[^']|'')*'/g, ' ').matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?![\w.])/g), (m) => m[0])

  if (col.enumLabels && col.enumLabels.length > 0) {
    add(...col.enumLabels)
    return out
  }

  // Noon today (UTC), not this instant: two columns of one row then get the
  // same time whenever they are asked for, so a rule that compares them
  // (ends_at > starts_at) is met or not met the same way on every run. The
  // days either side are there for a rule that compares a column with now().
  const today = new Date()
  const noon = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12)
  const day = 24 * 60 * 60 * 1000
  const at = (offset: number) => new Date(noon + offset).toISOString()

  switch (col.typname) {
    case 'uuid':
      add(crypto.randomUUID())
      return out
    case 'json':
    case 'jsonb':
      add('{}', '[]', '{"probe":true}', '"probe"', '1')
      return out
    case 'date':
      add(at(0).slice(0, 10), ...texts, at(day).slice(0, 10), at(-day).slice(0, 10), '2000-01-01', at(365 * day).slice(0, 10))
      return out
    case 'time':
    case 'timetz':
      add('12:00:00', ...texts, '00:00:00', '23:59:59')
      return out
    case 'inet':
    case 'cidr':
      add('192.0.2.1')
      return out
    case 'bytea':
      // The text form PostgreSQL reads as one zero byte: backslash, x, 0, 0.
      add(String.raw`\x00`)
      return out
  }

  switch (col.category) {
    case 'N': {
      const whole = INTEGER_TYPES.has(col.typname)
      // 1, not 0: a rule such as (amount > 0) is far commoner than one 1 breaks.
      add('1')
      for (const text of numbers) {
        const n = Number(text)
        if (!Number.isFinite(n) || (whole && !Number.isInteger(n))) continue
        add(String(n), String(n + 1), String(n - 1))
        if (!whole) add(String(n + 0.5))
      }
      add('0', '2', '5', '10', '100', '1000', '-1')
      if (!whole) add('0.5')
      return out
    }
    case 'B':
      add('false', 'true')
      return out
    case 'D':
      add(at(0), ...texts, at(day), at(-day), '2000-01-01T00:00:00Z', at(365 * day))
      return out
    case 'T':
      add('1 hour', ...texts, '1 day', '1 minute', '0')
      return out
    case 'A':
      add('{}', `{${arrayElement(col.typname, salt)}}`)
      return out
  }

  // Text, and any type not named above.
  const email = `bv-probe-${salt}@example.com`
  const plain = `__bv_probe_${salt}`
  add(
    /e[-_]?mail/i.test(col.name) ? email : plain,
    ...texts,
    plain,
    `bv-probe-${salt}`,
    `bvprobe${salt}`,
    `Bv Probe ${salt}`,
    email,
    `https://example.com/bv-probe-${salt}`,
    '+15555550100',
    '5555550100',
    'en',
    'US',
    'USD',
    '#000000',
    '2000-01-01',
    'a',
    'A',
    '1',
    `bv probe ${salt} `.repeat(12).trim(),
    '',
  )
  return out
}

/** Run one statement so that its failure leaves the transaction usable. */
async function tried<T>(tx: ValueTx, run: () => Promise<T>): Promise<T | undefined> {
  await tx.$executeRawUnsafe('SAVEPOINT bv_checked_value')
  try {
    const result = await run()
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT bv_checked_value')
    return result
  } catch {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT bv_checked_value')
    return undefined
  }
}

/**
 * A value for `col` that every rule of its own accepts, or null when none of
 * the candidates is accepted. Runs in the caller's transaction, which must be
 * one that is rolled back: a rule may call any function.
 *
 * A CHECK accepts a row when its expression is true or unknown, so that is
 * what is asked of each candidate.
 *
 * `not` is a value the answer must differ from, as the column's text: the one
 * a row already holds, for a test update that has to change it.
 */
export async function chooseCheckedValue(
  tx: ValueTx,
  col: CheckedColumn,
  checks: TableCheck[],
  salt: string,
  { not = null }: { not?: string | null } = {},
): Promise<string | null> {
  const candidates = candidateValues(col, checks, salt)
  const own = ownChecks(col.name, checks)
  if (own.length === 0) return candidates.find((c) => c !== not) ?? null

  const rule = own.map((c) => `(${c.expression})`).join(' AND ')
  const column = quoteIdent(col.name)

  // All candidates in one statement: the rule reads the column from a one-row
  // source built from each candidate in turn. The answer is the value as the
  // column holds it (a text cut to a varchar's length, say), so it is accepted
  // again however it is written next.
  const together = await tried(tx, () =>
    tx.$queryRawUnsafe<Array<{ value: string | null }>>(
      `SELECT bv_row.${column}::text AS value
         FROM json_array_elements_text($1::json) WITH ORDINALITY AS bv_candidate(bv_value, bv_ord)
        CROSS JOIN LATERAL (SELECT bv_candidate.bv_value::${col.type} AS ${column}) AS bv_row
        WHERE (${rule}) IS NOT FALSE
          AND ($2::text IS NULL OR bv_row.${column}::text IS DISTINCT FROM $2::text)
        ORDER BY bv_candidate.bv_ord
        LIMIT 1`,
      JSON.stringify(candidates),
      not,
    ),
  )
  if (together !== undefined) return together[0]?.value ?? null

  // One candidate did not cast to the type, or a rule raised on one: ask
  // about each alone, and a candidate that fails is simply not accepted.
  for (const candidate of candidates) {
    const alone = await tried(tx, () =>
      tx.$queryRawUnsafe<Array<{ accepted: boolean; value: string | null }>>(
        `SELECT ((${rule}) IS NOT FALSE) AS accepted, bv_row.${column}::text AS value
           FROM (SELECT $1::${col.type} AS ${column}) AS bv_row`,
        candidate,
      ),
    )
    const value = alone?.[0]?.accepted ? alone[0].value : null
    if (value !== null && value !== undefined && value !== not) return value
  }
  return null
}

/** Ends the transaction below with its result, so nothing in it is ever committed. */
class RolledBack<T> extends Error {
  constructor(readonly result: T) {
    super('rolled back')
  }
}

/**
 * chooseCheckedValue for several columns of one table, for a caller with no
 * transaction of its own: one transaction on the project's database, always
 * rolled back. Each column maps to its value, or to null when none was found.
 */
export async function chooseCheckedValues(
  projectId: string,
  columns: CheckedColumn[],
  checks: TableCheck[],
  salt: string,
): Promise<Map<string, string | null>> {
  const db = await workspaceRawClient(projectId)
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '5s'`)
        const chosen = new Map<string, string | null>()
        for (const col of columns) chosen.set(col.name, await chooseCheckedValue(tx, col, checks, salt))
        throw new RolledBack(chosen)
      },
      { maxWait: 5_000, timeout: 30_000 },
    )
  } catch (err) {
    if (err instanceof RolledBack) return err.result as Map<string, string | null>
    throw err
  }
  throw new Error('Choosing test values ended without a result.')
}
