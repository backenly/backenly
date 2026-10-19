/**
 * What a change did, derived rather than declared.
 *
 * The footprint of a change is the difference between the catalog before it
 * and after it, table by table. It is computed from the database and never
 * taken from what the change said it would do: an executor that reported
 * "Created table posts" while also installing three policies and a trigger is
 * exactly the kind of change whose rollback has to know about all five.
 *
 * Tables are matched by oid first, then by name. An oid survives
 * `ALTER TABLE … RENAME`, so a renamed table is recognised as the same table
 * rather than as a drop and an unrelated create; a table that was dropped and
 * created again under the same name has a new oid and is reported as
 * `replaced`. Columns are matched the same way, by attnum.
 */

import type { CatalogSnapshot, ColumnState, ObjectState, TableState } from './catalog'
import { sameObject, sameTable } from './catalog'
import type { TableChange } from './types'

export function diffCatalogs(before: CatalogSnapshot, after: CatalogSnapshot): TableChange[] {
  const out: TableChange[] = []
  const beforeByOid = new Map<number, TableState>()
  for (const t of Object.values(before.tables)) beforeByOid.set(t.oid, t)

  const matchedBefore = new Set<string>()
  const pending: TableState[] = []

  // Pass 1: same oid. A rename keeps it.
  for (const a of Object.values(after.tables)) {
    const b = beforeByOid.get(a.oid)
    if (b) {
      matchedBefore.add(b.name)
      if (b.name !== a.name || !sameTable(a, b)) {
        out.push({ kind: 'modified', before: b.name, after: a.name, details: describeTableChange(b, a) })
      }
    } else {
      pending.push(a)
    }
  }

  // Pass 2: same name, different oid: dropped and created again.
  for (const a of pending) {
    const b = before.tables[a.name]
    if (b && !matchedBefore.has(b.name)) {
      matchedBefore.add(b.name)
      out.push({ kind: 'replaced', before: b.name, after: a.name, details: ['dropped and created again', ...describeTableChange(b, a)] })
    } else {
      out.push({ kind: 'added', before: null, after: a.name, details: describeNewTable(a) })
    }
  }

  for (const b of Object.values(before.tables)) {
    if (!matchedBefore.has(b.name)) {
      out.push({ kind: 'removed', before: b.name, after: null, details: [`table removed (${b.columns.length} columns)`] })
    }
  }

  out.sort((x, y) => (label(x) < label(y) ? -1 : label(x) > label(y) ? 1 : 0))
  return [...out, ...diffObjects(before.objects, after.objects)]
}

const label = (c: TableChange) => c.after ?? c.before ?? ''

const NOUN: Record<ObjectState['kind'], string> = {
  view: 'view',
  materialized_view: 'materialized view',
  function: 'function',
  type: 'type',
}

/**
 * Views, functions and types, by identity. Snapshots taken before objects were
 * captured have no `objects`; comparing one of those with a newer snapshot
 * would report every object as added, so either side missing means no diff.
 */
function diffObjects(
  before: Record<string, ObjectState> | undefined,
  after: Record<string, ObjectState> | undefined,
): TableChange[] {
  if (!before || !after) return []
  const out: TableChange[] = []
  const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  for (const id of ids) {
    const b = before[id]
    const a = after[id]
    if (a && !b) out.push({ kind: 'added', object: a.kind, before: null, after: id, details: [`${NOUN[a.kind]} created`] })
    else if (b && !a) out.push({ kind: 'removed', object: b.kind, before: id, after: null, details: [`${NOUN[b.kind]} removed`] })
    else if (a && b && !sameObject(a, b)) {
      out.push({ kind: 'modified', object: a.kind, before: id, after: id, details: [`${NOUN[a.kind]} definition changed`] })
    }
  }
  return out
}

/**
 * How a column is identified across two states of one table: by attnum while
 * it is the same table (a rename keeps the number), by name once it is not.
 */
export function columnKey(sameTable: boolean): (c: ColumnState) => string {
  return sameTable ? (c) => `#${c.attnum}` : (c) => c.name
}

/** The tables a footprint names, on each side. */
export function footprintTables(footprint: TableChange[]): { before: string[]; after: string[] } {
  const tables = footprint.filter((c) => !c.object)
  return {
    before: tables.map((c) => c.before).filter((n): n is string => !!n),
    after: tables.map((c) => c.after).filter((n): n is string => !!n),
  }
}

/** The views, functions and types a footprint names, on each side. */
export function footprintObjects(footprint: TableChange[]): { before: string[]; after: string[] } {
  const objects = footprint.filter((c) => !!c.object)
  return {
    before: objects.map((c) => c.before).filter((n): n is string => !!n),
    after: objects.map((c) => c.after).filter((n): n is string => !!n),
  }
}

// ── Human-readable lines ─────────────────────────────────────────────────────

function columnLine(c: ColumnState): string {
  const parts = [c.type]
  if (c.generated) parts.push(`GENERATED ALWAYS AS (${c.generated}) STORED`)
  if (c.identity === 'a') parts.push('GENERATED ALWAYS AS IDENTITY')
  if (c.identity === 'd') parts.push('GENERATED BY DEFAULT AS IDENTITY')
  if (c.notNull) parts.push('NOT NULL')
  if (c.default) parts.push(`DEFAULT ${c.default}`)
  return `${c.name} ${parts.join(' ')}`
}

const CMD: Record<string, string> = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' }
const CON: Record<string, string> = { p: 'primary key', u: 'unique', c: 'check', f: 'foreign key', x: 'exclusion' }

function describeNewTable(t: TableState): string[] {
  const lines = [`table created (${t.columns.length} columns)`]
  for (const c of t.columns) lines.push(`+ column ${columnLine(c)}`)
  for (const c of t.constraints) if (c.type !== 'p') lines.push(`+ ${CON[c.type] ?? 'constraint'} ${c.name}: ${c.definition}`)
  for (const i of t.indexes) lines.push(`+ index ${i.name}`)
  if (t.rls.enabled) lines.push('row-level security on')
  for (const p of t.policies) lines.push(`+ policy ${p.name} (${CMD[p.cmd] ?? p.cmd})`)
  for (const g of t.triggers) lines.push(`+ trigger ${g.name}`)
  return lines
}

export function describeTableChange(b: TableState, a: TableState): string[] {
  const lines: string[] = []
  if (b.name !== a.name) lines.push(`table renamed from ${b.name}`)

  // Matched by attnum only while the table is the same table; a re-created
  // table numbers its columns afresh, so match those by name.
  const key = columnKey(a.oid === b.oid)
  const bByKey = new Map(b.columns.map((c) => [key(c), c]))
  const aByKey = new Map(a.columns.map((c) => [key(c), c]))

  for (const [key, ac] of aByKey) {
    const bc = bByKey.get(key)
    if (!bc) { lines.push(`+ column ${columnLine(ac)}`); continue }
    if (bc.name !== ac.name) lines.push(`column ${bc.name} renamed to ${ac.name}`)
    if (bc.type !== ac.type) lines.push(`~ column ${ac.name}: ${bc.type} → ${ac.type}`)
    if (bc.notNull !== ac.notNull) lines.push(`~ column ${ac.name}: ${ac.notNull ? 'now NOT NULL' : 'now nullable'}`)
    if (bc.default !== ac.default) lines.push(`~ column ${ac.name}: default ${bc.default ?? 'none'} → ${ac.default ?? 'none'}`)
    if (bc.identity !== ac.identity) lines.push(`~ column ${ac.name}: identity ${bc.identity || 'none'} → ${ac.identity || 'none'}`)
    if (bc.generated !== ac.generated) lines.push(`~ column ${ac.name}: generation expression changed`)
  }
  for (const [key, bc] of bByKey) if (!aByKey.has(key)) lines.push(`− column ${bc.name} ${bc.type}`)

  diffNamed(b.constraints, a.constraints, (c) => c.definition, lines, (c) => `${CON[c.type] ?? 'constraint'} ${c.name}`, (c) => `: ${c.definition}`)
  diffNamed(b.indexes, a.indexes, (i) => i.definition, lines, (i) => `index ${i.name}`)
  diffNamed(b.policies, a.policies, (p) => JSON.stringify([p.cmd, p.permissive, [...p.roles].sort(), p.using, p.check]), lines, (p) => `policy ${p.name} (${CMD[p.cmd] ?? p.cmd})`)
  diffNamed(b.triggers, a.triggers, (g) => `${g.definition}|${g.enabled}`, lines, (g) => `trigger ${g.name}`)

  if (b.rls.enabled !== a.rls.enabled) lines.push(`row-level security ${a.rls.enabled ? 'enabled' : 'disabled'}`)
  if (b.rls.forced !== a.rls.forced) lines.push(`row-level security ${a.rls.forced ? 'forced' : 'no longer forced'} for the owner`)
  return lines
}

function diffNamed<T extends { name: string }>(
  before: T[],
  after: T[],
  body: (x: T) => string,
  lines: string[],
  name: (x: T) => string,
  added: (x: T) => string = () => '',
): void {
  const b = new Map(before.map((x) => [x.name, x]))
  const a = new Map(after.map((x) => [x.name, x]))
  for (const [n, ax] of a) {
    const bx = b.get(n)
    if (!bx) lines.push(`+ ${name(ax)}${added(ax)}`)
    else if (body(bx) !== body(ax)) lines.push(`~ ${name(ax)} changed`)
  }
  for (const [n, bx] of b) if (!a.has(n)) lines.push(`− ${name(bx)}`)
}
