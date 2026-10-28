/**
 * WHAT A RESTORE WOULD DO TO DATA WRITTEN SINCE THE CHANGE
 * ========================================================
 *
 * "The schema can be put back" is not "it is safe to put it back". Between a
 * change and its restore, the application keeps writing: rows into the table
 * the change created, values into the column it added, updates to rows it
 * rewrote. A restore that dropped those, or overwrote them with values from
 * before, would delete legitimate work while reporting success.
 *
 * So before any restore is called safe, this measures, against the live data:
 *
 *   rows_set_aside      rows in a table the restore removes that the change did
 *                       not itself create
 *   values_set_aside    values in a column the restore removes, other than what
 *                       the change itself produced (its default, or its
 *                       data migration's output)
 *   values_converted    values that would not survive converting a column back
 *                       to its previous type
 *   restore_incomplete  data the change destroyed and nothing kept
 *   unknown_since       a rewrite with nothing to tell old rows from new ones by
 *
 * Each of those leaves the application (nothing is deleted: it moves into the
 * restore's own vault, and reapplying brings it back), so each needs a person.
 * Two more are reported but are not losses:
 *
 *   writes_kept         rows updated since a retype or rewrite keep their
 *                       current value; only untouched rows get the original back
 *   rows_without_value  rows written since have no value for a column the
 *                       restore brings back
 *
 * And some restores cannot run at all (`blockers`): rows written since with no
 * value for a column that was required, or values that cannot be converted back.
 *
 * The same measurement runs twice: for the preview a person reads, and again
 * inside the restore's transaction after its tables are locked, where it is
 * authoritative. A restore runs only if that second measurement is covered by
 * what was approved (nothing, for one called lossless).
 */

import { createHash } from 'crypto'
import type { CatalogSnapshot, ColumnState, TableState } from './catalog'
import { canonicalJson } from './integrity'
import { columnKey } from './diff'
import { qualified, quoteIdent as q } from './names'
import type { PreservedEntry, TableChange } from './types'

export type ImpactEffect =
  | 'rows_set_aside'
  | 'values_set_aside'
  | 'values_converted'
  | 'restore_incomplete'
  | 'unknown_since'
  | 'writes_kept'
  | 'rows_without_value'

const NEEDS_APPROVAL: ReadonlySet<ImpactEffect> = new Set([
  'rows_set_aside', 'values_set_aside', 'values_converted', 'restore_incomplete', 'unknown_since',
])

export interface ImpactItem {
  effect: ImpactEffect
  table: string
  column?: string
  count: number
  needsApproval: boolean
  /** One plain sentence. */
  detail: string
}

export interface Impact {
  items: ImpactItem[]
  /** A restore that cannot run, whatever anyone approves, and why. */
  blockers: string[]
  needsApproval: boolean
  /** Identifies exactly what a person saw, for the approval to name. */
  fingerprint: string
}

/** What a person approved: the approval-needing items and their counts. */
export type AcknowledgedImpact = Record<string, number>

/** Added-table contents as the change left them, recorded when it closed. */
export type ResultData = Record<string, { rows: number; checksum: string }>

export interface Runner {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export interface ImpactInput {
  schema: string
  footprint: TableChange[]
  checkpoint: CatalogSnapshot
  resultState: CatalogSnapshot & { data?: ResultData }
  /** What the change kept, limited to what is still there and intact. */
  preserved: PreservedEntry[]
}

const itemKey = (i: Pick<ImpactItem, 'effect' | 'table' | 'column'>) => `${i.effect}:${i.table}:${i.column ?? ''}`

/** A literal default PostgreSQL evaluates once: `'new'::text`, `0`, `false`. */
export function isConstantDefault(expr: string | null): boolean {
  if (expr === null) return true
  return /^(?:'(?:[^']|'')*'|-?\d+(?:\.\d+)?|true|false|NULL)(?:::[a-z_ "().,\d[\]]+)?$/i.test(expr.trim())
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

export async function measureImpact(db: Runner, input: ImpactInput): Promise<Impact> {
  const { schema, footprint, checkpoint, resultState, preserved } = input
  const items: ImpactItem[] = []
  const blockers: string[] = []
  const add = (effect: ImpactEffect, table: string, column: string | undefined, count: number, detail: string) => {
    if (count > 0) items.push({ effect, table, ...(column ? { column } : {}), count, needsApproval: NEEDS_APPROVAL.has(effect), detail })
  }
  const one = async <T>(sql: string): Promise<T> => (await db.query<T>(sql)).rows[0]

  for (const c of footprint) {
    if (c.object) continue
    const A = c.after ? resultState.tables[c.after] : undefined
    const B = c.before ? checkpoint.tables[c.before] : undefined

    // ── A table the restore removes ───────────────────────────────────────
    if ((c.kind === 'added' || c.kind === 'replaced') && A) {
      const now = await one<{ n: string; h: string }>(
        `SELECT count(*)::bigint AS n, coalesce(sum(hashtextextended(t::text, 0)::numeric), 0)::text AS h FROM ${qualified(schema, A.name)} t`,
      )
      const rows = Number(now.n)
      const recorded = resultState.data?.[A.name]
      const changedSince = !recorded || recorded.checksum !== now.h
      if (rows > 0 && changedSince) {
        add('rows_set_aside', A.name, undefined, rows,
          `${plural(rows, 'row')} in ${A.name} ${recorded ? 'include writes made' : 'were written'} since this change. ` +
          `They would be kept in a recovery snapshot, not deleted, but no longer available to your app.`)
      }
    }

    if (c.kind !== 'modified' || !A || !B) continue
    const key = columnKey(A.oid === B.oid)
    const before = new Map(B.columns.map((col) => [key(col), col]))
    const after = new Map(A.columns.map((col) => [key(col), col]))

    // ── Columns the restore removes ───────────────────────────────────────
    for (const [k, ac] of after) {
      if (before.has(k) || ac.generated) continue
      // The values the change produced in it, when it kept them: a data
      // migration's output, or what a volatile default filled in.
      const rewritten = findEntry(preserved, A.name, ac.name, 'rewritten') ?? findEntry(preserved, A.name, ac.name, 'filled')
      let where: string
      if (rewritten && rewritten.keyColumns.length > 0 && rewritten.afterColumn) {
        const match = rewritten.keyColumns.map((kc) => `a.${q(kc)} = t.${q(kc)}`).join(' AND ')
        where = `t.${q(ac.name)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${qualified(rewritten.vault, rewritten.vaultTable)} a WHERE ${match} AND a.${q(rewritten.afterColumn!)} IS NOT DISTINCT FROM t.${q(ac.name)})`
      } else if (!ac.identity && isConstantDefault(ac.default)) {
        where = ac.default === null ? `t.${q(ac.name)} IS NOT NULL` : `t.${q(ac.name)} IS DISTINCT FROM (${ac.default})`
      } else {
        where = `t.${q(ac.name)} IS NOT NULL`
      }
      const r = await one<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${qualified(schema, A.name)} t WHERE ${where}`)
      const n = Number(r.n)
      add('values_set_aside', A.name, ac.name, n,
        `${plural(n, 'value')} in ${A.name}.${ac.name} ${rewritten || isConstantDefault(ac.default) ? 'were written' : 'may have been written'} since this change. ` +
        `They would be kept in a recovery snapshot, not deleted, but no longer available to your app.`)
    }

    // ── Columns the restore converts back ─────────────────────────────────
    for (const [k, ac] of after) {
      const bc = before.get(k)
      if (!bc) continue
      const entry = findEntry(preserved, A.name, ac.name, 'retyped') ?? findEntry(preserved, A.name, ac.name, 'rewritten')
      const typeChanged = ac.type !== bc.type
      if (!entry && !typeChanged) continue
      await measureRewritten(db, schema, A.name, ac, bc, entry, typeChanged, add, blockers)
    }

    // ── Columns the restore brings back ───────────────────────────────────
    for (const [k, bc] of before) {
      if (after.has(k)) continue
      const kept = findEntry(preserved, A.name, bc.name, 'dropped')
      if (!kept) {
        add('restore_incomplete', A.name, bc.name, 1,
          `${A.name}.${bc.name} would come back without its values: they were not kept when it was removed.`)
        continue
      }
      if (kept.keyColumns.length === 0) {
        add('unknown_since', A.name, bc.name, 1,
          `${A.name}.${bc.name}'s values are kept, but ${A.name} has no primary key to match them back by.`)
        continue
      }
      const match = kept.keyColumns.map((kc) => `v.${q(kc)} = t.${q(kc)}`).join(' AND ')
      const r = await one<{ n: string }>(
        `SELECT count(*)::bigint AS n FROM ${qualified(schema, A.name)} t WHERE NOT EXISTS (SELECT 1 FROM ${qualified(kept.vault, kept.vaultTable)} v WHERE ${match})`,
      )
      const n = Number(r.n)
      if (n > 0 && bc.notNull && bc.default === null && !bc.identity && !bc.generated) {
        blockers.push(
          `${plural(n, 'row')} in ${A.name} ${n === 1 ? 'has' : 'have'} no value for ${bc.name}, which was required before this change. ` +
          `Fill ${n === 1 ? 'it' : 'them'} in, then restore.`,
        )
      } else {
        add('rows_without_value', A.name, bc.name, n, `${plural(n, 'row')} in ${A.name} would have no value for ${bc.name}.`)
      }
    }
  }

  // ── Tables the restore brings back ──────────────────────────────────────
  // A table dropped and created again under its name comes back as one removed
  // does, so its rows are measured the same way. Matched by either name, as the
  // plan finds them (planRestore): a restore that will bring a table back empty
  // always has an item here, or it would need an approval nothing could give.
  for (const c of footprint) {
    if (c.object || (c.kind !== 'removed' && c.kind !== 'replaced') || !c.before) continue
    if (!preserved.some((e) => e.kind === 'table' && (e.table === c.before || e.table === c.after))) {
      add('restore_incomplete', c.before, undefined, 1,
        `${c.before} would come back empty: its rows were not kept when it was removed.`)
    }
  }

  const needsApproval = items.some((i) => i.needsApproval)
  return { items, blockers, needsApproval, fingerprint: fingerprintOf(items) }
}

async function measureRewritten(
  db: Runner,
  schema: string,
  table: string,
  now: ColumnState,
  then: ColumnState,
  entry: Extract<PreservedEntry, { kind: 'column' }> | undefined,
  typeChanged: boolean,
  add: (effect: ImpactEffect, table: string, column: string | undefined, count: number, detail: string) => void,
  blockers: string[],
): Promise<void> {
  const col = `t.${q(now.name)}`
  const keyed = entry && entry.keyColumns.length > 0 && entry.afterColumn
  // Rows that will NOT get their original value back: written or updated since.
  // One join on the key, not a lookup per row. This was a correlated NOT EXISTS
  // inside FILTER, which PostgreSQL never turns into a join, so it scanned the
  // whole (unindexed) vault once per row: a rewrite of 133,000 values on a
  // 200,000-row table ran past the proof's two-minute limit. The vault holds one
  // row per key, the key of a table with a primary key, so the join adds none.
  const from = keyed
    ? `${qualified(schema, table)} t LEFT JOIN ${qualified(entry!.vault, entry!.vaultTable)} a ON ${entry!.keyColumns
        .map((kc) => `a.${q(kc)} = t.${q(kc)}`)
        .join(' AND ')}`
    : `${qualified(schema, table)} t`
  const notRestored = keyed
    ? `NOT (a.${q(entry!.keyColumns[0])} IS NOT NULL AND a.${q(entry!.afterColumn!)} IS NOT DISTINCT FROM ${col})`
    : 'true'
  const lossy = typeChanged ? `${col} IS NOT NULL AND (${col}::${then.type})::${now.type} IS DISTINCT FROM ${col}` : 'false'
  let r: { since: string; lossy: string }
  try {
    r = (
      await db.query<{ since: string; lossy: string }>(
        `SELECT count(*) FILTER (WHERE ${notRestored} AND ${col} IS NOT NULL)::bigint AS since,
                count(*) FILTER (WHERE ${notRestored} AND ${lossy})::bigint AS lossy
           FROM ${from}`,
      )
    ).rows[0]
  } catch (err: any) {
    // Only a failed conversion (SQLSTATE class 22, data exception) means a value
    // cannot be converted back. A timeout or a lost connection means it could not
    // be checked, and used to be reported as a conversion failure.
    const message = String(err?.message ?? err).split('\n')[0]
    blockers.push(String(err?.code ?? '').startsWith('22')
      ? `Some values in ${table}.${now.name} cannot be converted back to ${then.type} (${message}).`
      : `What restoring would do to ${table}.${now.name} could not be checked (${message}).`)
    return
  }
  const since = Number(r.since)
  const lost = Number(r.lossy)
  if (entry && !keyed) {
    add('unknown_since', table, now.name, 1, entry.keyColumns.length === 0
      ? `${table}.${now.name}'s values from before this change are kept, but ${table} has no primary key to tell rows written since from rows the change left.`
      : `${table}.${now.name}'s values from before this change are kept, but not what the change left on each row, so rows written since cannot be told apart.`)
    return
  }
  if (!entry && since > 0) {
    // Retyped with nothing kept: every value is converted back, none restored.
    if (lost > 0) {
      add('values_converted', table, now.name, lost,
        `${plural(lost, 'value')} in ${table}.${now.name} would change when converted back to ${then.type}. The current values would be kept in a recovery snapshot.`)
    }
    return
  }
  if (lost > 0) {
    add('values_converted', table, now.name, lost,
      `${plural(lost, 'value')} in ${table}.${now.name} written since this change would change when converted back to ${then.type}. The current values would be kept in a recovery snapshot.`)
  }
  const kept = since - lost
  add('writes_kept', table, now.name, kept,
    `${plural(kept, 'row')} in ${table} changed since this change ${kept === 1 ? 'keeps its' : 'keep their'} current ${now.name}; the rest get their original value back.`)
}

function findEntry(
  preserved: PreservedEntry[],
  table: string,
  column: string,
  reason: 'dropped' | 'retyped' | 'rewritten' | 'filled',
): Extract<PreservedEntry, { kind: 'column' }> | undefined {
  return preserved.find(
    (e): e is Extract<PreservedEntry, { kind: 'column' }> =>
      e.kind === 'column' && e.reason === reason && e.table === table && e.column === column,
  )
}

export function fingerprintOf(items: ImpactItem[]): string {
  const relevant = items.filter((i) => i.needsApproval).map((i) => [itemKey(i), i.count]).sort()
  return createHash('sha256').update(canonicalJson(relevant)).digest('hex').slice(0, 32)
}

/** The approval-needing items, as a person approves them. */
export function acknowledgementOf(impact: Impact): AcknowledgedImpact {
  const out: AcknowledgedImpact = {}
  for (const i of impact.items) if (i.needsApproval) out[itemKey(i)] = i.count
  return out
}

/**
 * Is what the restore would do now within what was approved? Every item that
 * needs approval must have been approved, for at least as many rows. Fewer is
 * fine (rows deleted since); more, or anything new, is not.
 */
export function impactCovered(now: Impact, approved: AcknowledgedImpact | null | undefined): boolean {
  for (const i of now.items) {
    if (!i.needsApproval) continue
    const ok = approved?.[itemKey(i)]
    if (ok === undefined || ok < i.count) return false
  }
  return true
}

/** For tables the change created: their contents as it left them. */
export async function resultDataFor(
  db: Runner,
  schema: string,
  tables: Array<Pick<TableState, 'name'>>,
  maxRows = 100_000,
): Promise<ResultData> {
  const out: ResultData = {}
  for (const t of tables) {
    // Estimate first: hashing a large table on every additive change would make
    // ordinary changes slow. Above the bound nothing is recorded, and a restore
    // treats every row as written since, which asks a person rather than guessing.
    const est = await db.query<{ n: string }>(
      `SELECT greatest(c.reltuples, 0)::bigint AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = $1 AND c.relname = $2`,
      [schema, t.name],
    )
    if (Number(est.rows[0]?.n ?? 0) > maxRows) continue
    const r = await db.query<{ n: string; h: string }>(
      `SELECT count(*)::bigint AS n, coalesce(sum(hashtextextended(t::text, 0)::numeric), 0)::text AS h FROM ${qualified(schema, t.name)} t`,
    )
    out[t.name] = { rows: Number(r.rows[0]?.n ?? 0), checksum: String(r.rows[0]?.h ?? '0') }
  }
  return out
}
