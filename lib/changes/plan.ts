/**
 * The restore planner: from "how the change left things" back to "how they
 * were before it", as an ordered list of SQL statements.
 *
 * Pure. It reads nothing and runs nothing; lib/changes/recovery.ts gives it the
 * catalog and executes what it returns inside one transaction. Keeping it pure
 * is what lets every ordering rule below be tested without a database, and
 * what lets the same plan be proven (run and rolled back) before it is run for
 * real.
 *
 * ── The rules it keeps ──────────────────────────────────────────────────────
 *
 * Something is only restored if it still looks exactly the way the change left
 * it. Anything else means something changed it since, and restoring would also
 * undo that, silently. Those come back as conflicts and the plan is empty.
 *
 * Nothing is destroyed. A table the change created is moved into this
 * restore's vault with its rows; a column it added has its values copied there
 * before it is dropped; values that would not survive converting a column back
 * are copied there first. Reapplying the change brings all of it back.
 *
 * Writes made since the change are not overwritten. A column the change retyped
 * or rewrote gets its original value back only on rows whose value is still
 * the one the change produced; rows written since keep theirs. Before the
 * restore commits, it checks inside its own transaction that every value it
 * meant to put back is back.
 *
 * What the change destroyed comes back from the change's own vault when it was
 * kept there. When it was not, the structure is re-created and the plan says,
 * in `unrecoverable`, exactly which data cannot be restored.
 *
 * Every definition replayed here was produced by PostgreSQL's own deparser,
 * schema-qualified (lib/changes/catalog.ts), so it means the same thing
 * whatever search_path the transaction runs with.
 */

import type { CatalogSnapshot, ColumnState, ConstraintState, GrantState, ObjectState, PolicyState, TableState, TriggerState } from './catalog'
import { apiGrantsRemoved, CAPTURE_TRIGGER, enumLabels, isDomain, sameObject, sameTable } from './catalog'
import { columnKey, describeTableChange } from './diff'
import { AFTER_COLUMN, literal, qualified, quoteIdent as q, vaultTableName } from './names'
import type { PreservedEntry, TableChange } from './types'

export interface PlannedStep {
  phase: number
  sql: string
  /** One plain sentence: what this statement does and why. */
  describe: string
}

/** A statement run inside the restore's transaction after its steps, that must return zero. */
export interface InTransactionCheck {
  sql: string
  describe: string
}

export interface PlanConflict {
  table: string
  reason: string
}

export interface PlanRestore {
  table: string
  column?: string
  from: 'vault' | 'structure'
  /** For values put back from the vault: the vault table they come from. */
  kept?: { vault: string; vaultTable: string }
}

export interface RestorePlan {
  conflicts: PlanConflict[]
  steps: PlannedStep[]
  /** Checks that must find nothing wrong before the transaction commits. */
  checks: InTransactionCheck[]
  /** What this restore moves into its own vault instead of dropping. */
  archives: PreservedEntry[]
  /** What comes back, and whether its data comes with it. */
  restores: PlanRestore[]
  /** Data that cannot come back, said plainly. */
  unrecoverable: string[]
  /** Tables the restore takes an exclusive lock on before measuring and running. */
  lockTables: string[]
  /**
   * Functions and types the change created that stay, because something that
   * outlives the restore uses them: a later table's trigger, or a column of a
   * table this restore moves into its vault. Named with the reason, and the
   * only objects verification accepts as still there.
   */
  keptObjects: Array<{ identity: string; reason: string }>
}

export interface PlanInput {
  /** The workspace schema. */
  schema: string
  /** What the change touched… */
  footprint: TableChange[]
  /** …as it was before the change… */
  checkpoint: CatalogSnapshot
  /** …and as the change left it. */
  resultState: CatalogSnapshot
  /** What the change kept in its vault, limited to what is still there and intact. */
  preserved: PreservedEntry[]
  /** The workspace schema now. */
  live: CatalogSnapshot
  /** This restore's own vault, for what it moves aside. */
  vault: string
}

/**
 * Execution order. A statement can only depend on something an earlier phase
 * created or freed:
 *   - views go first, because they read columns about to change;
 *   - triggers and policies next, because either can name a column about to go;
 *   - foreign keys are dropped before the keys they reference and re-added last;
 *   - tables are moved aside before renames, so a name the change took over is
 *     free before the original is renamed back into it;
 *   - which rows still hold the change's values is recorded before any type is
 *     converted back, and the original values go back after it;
 *   - no value is written to a table until every column of it has its final
 *     shape: a PL/pgSQL trigger that fired earlier in the same transaction
 *     (the updatedAt helper every Backenly table has) keeps returning rows of
 *     the table's old shape, which drops what is written to a column added
 *     after it fired and garbles a column retyped after it fired;
 *   - what the restore leaves in a column it converts or fills is recorded once
 *     every value is in place, so reapplying can tell it from later writes;
 *   - columns get their values before NOT NULL is asserted on them;
 *   - types come back before the columns that use them, functions before the
 *     triggers and policies that call them, views after everything they read;
 *   - a function the change added goes only once every trigger, policy, default
 *     and column that could call it is gone.
 */
export const PHASE = {
  DROP_VIEWS: 0.5,
  DROP_TRIGGERS: 1,
  DROP_FUNCTIONS: 1.5,
  DROP_POLICIES: 2,
  DROP_FOREIGN_KEYS: 3,
  DROP_CONSTRAINTS: 4,
  DROP_PRIMARY_KEYS: 4.5,
  DROP_INDEXES: 5,
  ARCHIVE_TABLES: 6,
  ARCHIVE_COLUMNS: 7,
  MARK_UNCHANGED: 7.5,
  KEEP_CONVERTED: 7.6,
  RENAME_TABLES: 8,
  RENAME_COLUMNS: 8.5,
  CREATE_TYPES: 8.8,
  RESTORE_TABLES: 9,
  RESTORE_COLUMNS: 10,
  ALTER_COLUMNS: 11,
  RESTORE_COLUMN_VALUES: 11.4,
  RESTORE_VALUES: 11.5,
  AFTER_IMAGES: 11.8,
  DROP_ADDED_FUNCTIONS: 11.9,
  NOT_NULL: 12,
  IDENTITY: 12.5,
  ADD_PRIMARY_KEYS: 13,
  ADD_CONSTRAINTS: 13.5,
  ADD_FOREIGN_KEYS: 14,
  ADD_INDEXES: 15,
  CREATE_FUNCTIONS: 15.5,
  RLS: 16,
  CREATE_VIEWS: 16.5,
  ADD_POLICIES: 17,
  TRIGGERS: 18,
  ARCHIVE_CHECKPOINT_TABLES: 18.5,
  GRANTS: 19,
  DROP_TYPES: 19.5,
} as const

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const COMMAND: Record<string, string> = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' }

export function planRestore(input: PlanInput): RestorePlan {
  const { schema, footprint, checkpoint, resultState, live, vault } = input
  const plan: RestorePlan = { conflicts: [], steps: [], checks: [], archives: [], restores: [], unrecoverable: [], lockTables: [], keptObjects: [] }
  const T = (name: string) => qualified(schema, name)
  const add = (phase: number, sql: string, describe: string) => plan.steps.push({ phase, sql, describe })
  const tableEntries = footprint.filter((c) => !c.object)
  const objectEntries = footprint.filter((c) => !!c.object)
  // Names inside this restore's vault: an archived table keeps its own name
  // there, and every copy of values gets one no other copy has.
  const vaultNames = new Set(tableEntries.flatMap((c) => (c.kind === 'added' || c.kind === 'replaced') && c.after ? [c.after] : []))
  const vaultName = (...parts: string[]) => {
    let name = vaultTableName(...parts)
    for (let i = 2; vaultNames.has(name); i++) name = vaultTableName(...parts, String(i))
    vaultNames.add(name)
    return name
  }

  // ── 1. Does everything still look the way the change left it? ──────────────
  const currentNames = new Set(tableEntries.map((c) => c.after).filter((n): n is string => !!n))
  for (const c of tableEntries) {
    const A = c.after ? resultState.tables[c.after] : null
    const B = c.before ? checkpoint.tables[c.before] : null
    if ((c.after && !A) || (c.before && !B)) {
      plan.conflicts.push({ table: c.after ?? c.before ?? '?', reason: 'the record of this change is incomplete for this table' })
      continue
    }
    if (A) {
      const L = live.tables[A.name]
      if (!L) {
        plan.conflicts.push({ table: A.name, reason: `${A.name} no longer exists` })
      } else if (!sameTable(L, A)) {
        const since = describeTableChange(A, L).slice(0, 3).join('; ')
        plan.conflicts.push({ table: A.name, reason: `${A.name} has changed since this change${since ? ` (${since})` : ''}` })
      }
    }
    // The name the table returns to must be free, or held by a table this
    // restore itself moves or renames away.
    if (B && B.name !== A?.name && live.tables[B.name] && !currentNames.has(B.name)) {
      plan.conflicts.push({ table: B.name, reason: `a table named ${B.name} was created after this change` })
    }
  }
  for (const c of objectEntries) {
    const noun = c.object!.replace('_', ' ')
    if (c.object === 'materialized_view') {
      plan.conflicts.push({ table: c.after ?? c.before ?? '?', reason: `materialized view ${c.after ?? c.before} is restored by a person, not automatically` })
      continue
    }
    if (c.after) {
      const A = resultState.objects?.[c.after]
      const L = live.objects?.[c.after]
      if (!A) plan.conflicts.push({ table: c.after, reason: `the record of this change is incomplete for ${noun} ${c.after}` })
      else if (!L) plan.conflicts.push({ table: c.after, reason: `${noun} ${A.name} no longer exists` })
      else if (!sameObject(L, A)) plan.conflicts.push({ table: c.after, reason: `${noun} ${A.name} has changed since this change` })
    }
    if (c.before && !c.after) {
      const B = checkpoint.objects?.[c.before]
      if (!B) plan.conflicts.push({ table: c.before, reason: `the record of this change is incomplete for ${noun} ${c.before}` })
      else if (live.objects?.[c.before]) plan.conflicts.push({ table: c.before, reason: `a ${noun} named ${B.name} was created after this change` })
    }
    if (c.object === 'type' && c.kind === 'modified' && !enumRenames(checkpoint.objects?.[c.before ?? ''], resultState.objects?.[c.after ?? ''])) {
      const A = resultState.objects?.[c.after ?? '']
      plan.conflicts.push({
        table: c.after ?? '?',
        reason: A && isDomain(A)
          ? `domain ${c.after} was altered, and an altered domain is restored by a person, not automatically`
          : `values added to type ${c.after} cannot be removed again`,
      })
    }
  }

  // A table about to be moved aside must not be referenced from outside the
  // change: a foreign key to it would either block the move or keep pointing
  // at the vault.
  for (const c of tableEntries) {
    if (c.kind !== 'added' && c.kind !== 'replaced') continue
    const name = c.after!
    for (const L of Object.values(live.tables)) {
      if (currentNames.has(L.name)) continue
      for (const con of L.constraints) {
        if (con.type === 'f' && con.refTable === name && con.refSchema === schema) {
          plan.conflicts.push({ table: name, reason: `${L.name}.${con.name} references ${name} and was added after this change` })
        }
      }
    }
  }
  if (plan.conflicts.length > 0) return plan

  // ── 2. The statements ──────────────────────────────────────────────────────
  const checkpointTables = new Set(
    input.preserved.flatMap((e) => (e.kind === 'column' && e.beforeTable ? [e.beforeTable] : [])),
  )
  let tmp = 0
  for (const c of tableEntries) {
    const A = c.after ? resultState.tables[c.after] : null
    const B = c.before ? checkpoint.tables[c.before] : null
    if (A) plan.lockTables.push(A.name)
    if (c.kind === 'added' && A) archiveTable(A, checkpointTables.has(A.name))
    else if (c.kind === 'removed' && B) restoreTable(B, A)
    else if (c.kind === 'replaced' && A && B) { archiveTable(A, false); restoreTable(B, A) }
    else if (c.kind === 'modified' && A && B) modifyTable(B, A)
  }
  for (const c of objectEntries) restoreObject(c)
  if (plan.conflicts.length > 0) return { ...plan, steps: [], checks: [], archives: [], restores: [], keptObjects: [] }

  plan.steps.sort((x, y) => x.phase - y.phase)
  return plan

  // ── Moving a table aside ───────────────────────────────────────────────────

  function archiveTable(A: TableState, late: boolean) {
    // Its own foreign keys go first. Left in place, they would keep acting
    // between the vault and production: an ON DELETE CASCADE from a live parent
    // would delete archived rows, and a NO ACTION one would refuse a live
    // delete because of rows nobody can see any more.
    for (const con of A.constraints) {
      if (con.type === 'f') {
        add(PHASE.DROP_FOREIGN_KEYS, `ALTER TABLE ${T(A.name)} DROP CONSTRAINT ${q(con.name)}`,
          `Drop foreign key ${con.name} on ${A.name}, so the archived rows stay out of production's way.`)
      }
    }
    // An archived table runs nothing and is read by nobody. Its triggers and
    // policies would also keep the functions they call alive: the updatedAt
    // and auth helpers a new table brings with it could not be removed while
    // the archived table still pointed at them. They come back with the table
    // (restoreTable).
    for (const g of A.triggers) {
      add(PHASE.DROP_TRIGGERS, `DROP TRIGGER ${q(g.name)} ON ${T(A.name)}`, `Drop trigger ${g.name} on ${A.name}; an archived table runs nothing.`)
    }
    // Nor does row-event capture, which the catalog leaves out as Backenly's
    // plumbing; its sync gives the table the trigger again if it comes back.
    add(PHASE.DROP_TRIGGERS, `DROP TRIGGER IF EXISTS ${q(CAPTURE_TRIGGER)} ON ${T(A.name)}`,
      `Stop capturing ${A.name}'s row events for webhooks and functions, if it was; an archived table sends none.`)
    for (const p of A.policies) {
      add(PHASE.DROP_TRIGGERS, `DROP POLICY ${q(p.name)} ON ${T(A.name)}`, `Drop policy ${p.name} on ${A.name}; nobody reads an archived table.`)
    }
    // A data migration's checkpoint table is read to put values back, so it
    // leaves last.
    add(late ? PHASE.ARCHIVE_CHECKPOINT_TABLES : PHASE.ARCHIVE_TABLES, `ALTER TABLE ${T(A.name)} SET SCHEMA ${q(vault)}`,
      `Move ${A.name} and every row in it into the recovery snapshot. It leaves the API; nothing is deleted.`)
    plan.archives.push({ kind: 'table', table: A.name, vault, vaultTable: A.name, rows: null })
  }

  // ── Bringing a table back ──────────────────────────────────────────────────

  function restoreTable(B: TableState, A: TableState | null) {
    const kept = findTableEntry(input.preserved, B.name, A?.name)
    if (kept) {
      add(PHASE.RESTORE_TABLES, `ALTER TABLE ${qualified(kept.vault, kept.vaultTable)} SET SCHEMA ${q(schema)}`,
        `Bring ${B.name} back with all ${kept.rows ?? 'its'} rows.`)
      if (kept.vaultTable !== B.name) {
        add(PHASE.RESTORE_TABLES, `ALTER TABLE ${T(kept.vaultTable)} RENAME TO ${q(B.name)}`, `Restore the name ${B.name}.`)
      }
      // Its foreign keys and triggers were dropped when it was archived, so put
      // them back. DROP … IF EXISTS first so a vault table that kept one cannot
      // fail the add.
      for (const con of B.constraints) {
        if (con.type !== 'f') continue
        add(PHASE.ADD_FOREIGN_KEYS, `ALTER TABLE ${T(B.name)} DROP CONSTRAINT IF EXISTS ${q(con.name)}`, `Clear ${con.name} before re-adding it.`)
        add(PHASE.ADD_FOREIGN_KEYS, `ALTER TABLE ${T(B.name)} ADD CONSTRAINT ${q(con.name)} ${con.definition}`, `Re-add foreign key ${con.name} on ${B.name}.`)
      }
      for (const g of B.triggers) {
        add(PHASE.TRIGGERS, `DROP TRIGGER IF EXISTS ${q(g.name)} ON ${T(B.name)}`, `Clear trigger ${g.name} before re-adding it.`)
        add(PHASE.TRIGGERS, g.definition, `Re-create trigger ${g.name} on ${B.name}.`)
        if (g.enabled !== 'O') add(PHASE.TRIGGERS, triggerStateSql(B.name, g), `Restore trigger ${g.name}'s enabled state.`)
      }
      for (const p of B.policies) {
        add(PHASE.ADD_POLICIES, `DROP POLICY IF EXISTS ${q(p.name)} ON ${T(B.name)}`, `Clear policy ${p.name} before re-adding it.`)
        add(PHASE.ADD_POLICIES, createPolicySql(B.name, p), `Re-create policy ${p.name} on ${B.name}.`)
      }
      plan.restores.push({ table: B.name, from: 'vault', kept: { vault: kept.vault, vaultTable: kept.vaultTable } })
      return
    }
    recreateTable(B)
    plan.restores.push({ table: B.name, from: 'structure' })
    plan.unrecoverable.push(
      `${B.name} is re-created with its columns, keys, indexes and policies, but empty: its rows were not kept when it was removed.`,
    )
  }

  function recreateTable(B: TableState) {
    // A serial column's sequence was owned by the table and went with it.
    const sequences: Array<{ seq: string; column: string }> = []
    for (const col of B.columns) {
      const m = col.default ? /^nextval\('(.+)'::regclass\)$/.exec(col.default) : null
      if (m) sequences.push({ seq: m[1].replace(/''/g, "'"), column: col.name })
    }
    for (const s of sequences) {
      add(PHASE.RESTORE_TABLES, `CREATE SEQUENCE IF NOT EXISTS ${s.seq}`, `Re-create the sequence behind ${B.name}.${s.column}.`)
    }
    const columns = B.columns.map((col) => `${q(col.name)} ${columnTypeClause(col, true)}`)
    add(PHASE.RESTORE_TABLES, `CREATE TABLE ${T(B.name)} (\n  ${columns.join(',\n  ')}\n)`, `Re-create table ${B.name}.`)
    for (const s of sequences) {
      add(PHASE.RESTORE_TABLES, `ALTER SEQUENCE ${s.seq} OWNED BY ${T(B.name)}.${q(s.column)}`, `Tie the sequence to ${B.name}.${s.column} again.`)
    }
    for (const con of B.constraints) addConstraint(B.name, con)
    for (const idx of B.indexes) add(PHASE.ADD_INDEXES, idx.definition, `Re-create index ${idx.name}.`)
    if (B.rls.enabled) add(PHASE.RLS, `ALTER TABLE ${T(B.name)} ENABLE ROW LEVEL SECURITY`, `Turn row-level security back on for ${B.name}.`)
    if (B.rls.forced) add(PHASE.RLS, `ALTER TABLE ${T(B.name)} FORCE ROW LEVEL SECURITY`, `Apply ${B.name}'s policies to its owner again.`)
    for (const p of B.policies) add(PHASE.ADD_POLICIES, createPolicySql(B.name, p), `Re-create policy ${p.name}.`)
    for (const g of B.triggers) {
      add(PHASE.TRIGGERS, g.definition, `Re-create trigger ${g.name}.`)
      if (g.enabled !== 'O') add(PHASE.TRIGGERS, triggerStateSql(B.name, g), `Restore trigger ${g.name}'s enabled state.`)
    }
    for (const gr of B.grants) {
      if (GRANTABLE.test(gr.privilege)) add(PHASE.GRANTS, grantSql(B.name, gr), `Restore ${gr.grantee}'s ${gr.privilege} privilege.`)
    }
    if (B.comment) add(PHASE.GRANTS, `COMMENT ON TABLE ${T(B.name)} IS ${literal(B.comment)}`, `Restore ${B.name}'s description.`)
  }

  // ── Undoing changes to a table that stayed ─────────────────────────────────

  function modifyTable(B: TableState, A: TableState) {
    const cur = A.name // its name now
    const fin = B.name // its name again, from PHASE.RENAME_TABLES on

    // Triggers.
    diffByName(A.triggers, B.triggers, (x, y) => x.definition === y.definition, {
      drop: (g) => add(PHASE.DROP_TRIGGERS, `DROP TRIGGER ${q(g.name)} ON ${T(cur)}`, `Drop trigger ${g.name}.`),
      create: (g) => {
        add(PHASE.TRIGGERS, g.definition, `Re-create trigger ${g.name}.`)
        if (g.enabled !== 'O') add(PHASE.TRIGGERS, triggerStateSql(fin, g), `Restore trigger ${g.name}'s enabled state.`)
      },
      same: (now, then) => {
        if (now.enabled !== then.enabled) add(PHASE.TRIGGERS, triggerStateSql(fin, then), `Restore trigger ${then.name}'s enabled state.`)
      },
    })

    // Policies.
    const policyBody = (p: PolicyState) => JSON.stringify([p.cmd, p.permissive, [...p.roles].sort(), p.using, p.check])
    diffByName(A.policies, B.policies, (x, y) => policyBody(x) === policyBody(y), {
      drop: (p) => add(PHASE.DROP_POLICIES, `DROP POLICY ${q(p.name)} ON ${T(cur)}`, `Drop policy ${p.name}.`),
      create: (p) => add(PHASE.ADD_POLICIES, createPolicySql(fin, p), `Re-create policy ${p.name} as it was.`),
    })

    // Constraints.
    diffByName(A.constraints, B.constraints, (x, y) => x.definition === y.definition && x.type === y.type, {
      drop: (con) => add(
        con.type === 'f' ? PHASE.DROP_FOREIGN_KEYS : con.type === 'p' ? PHASE.DROP_PRIMARY_KEYS : PHASE.DROP_CONSTRAINTS,
        `ALTER TABLE ${T(cur)} DROP CONSTRAINT ${q(con.name)}`,
        `Drop ${constraintNoun(con)} ${con.name}.`,
      ),
      create: (con) => addConstraint(fin, con),
    })

    // Indexes. A definition names its table, so a renamed table's indexes
    // differ in text only; DROP INDEX and the checkpoint's definition handle
    // both cases the same way.
    diffByName(A.indexes, B.indexes, (x, y) => x.definition === y.definition, {
      drop: (i) => add(PHASE.DROP_INDEXES, `DROP INDEX ${qualified(schema, i.name)}`, `Drop index ${i.name}.`),
      create: (i) => add(PHASE.ADD_INDEXES, i.definition, `Re-create index ${i.name}.`),
    })

    // Columns, matched by attnum: a rename keeps the number.
    const key = columnKey(A.oid === B.oid)
    const aCols = new Map(A.columns.map((c) => [key(c), c]))
    const bCols = new Map(B.columns.map((c) => [key(c), c]))
    const pk = (A.constraints.find((con) => con.type === 'p')?.columns ?? []).filter((col) =>
      A.columns.some((c) => c.name === col),
    )

    // Columns the change added: keep their values, then drop them.
    for (const [k, ac] of aCols) {
      if (bCols.has(k)) continue
      const keys = pk.filter((col) => col !== ac.name)
      const vt = vaultName(cur, ac.name)
      const select = keys.length > 0 ? [...keys, ac.name].map(q).join(', ') : '*'
      add(PHASE.ARCHIVE_COLUMNS,
        `CREATE TABLE ${qualified(vault, vt)} AS SELECT ${select} FROM ${T(cur)} WHERE ${q(ac.name)} IS NOT NULL`,
        `Keep every value of ${cur}.${ac.name} in the recovery snapshot.`)
      add(PHASE.ARCHIVE_COLUMNS, `ALTER TABLE ${T(cur)} DROP COLUMN ${q(ac.name)}`, `Drop column ${ac.name} from ${cur}.`)
      plan.archives.push({ kind: 'column', table: cur, column: ac.name, reason: 'dropped', keyColumns: keys, vault, vaultTable: vt, rows: null })
    }

    if (cur !== fin) add(PHASE.RENAME_TABLES, `ALTER TABLE ${T(cur)} RENAME TO ${q(fin)}`, `Rename ${cur} back to ${fin}.`)

    // Renames. Through a temporary name when one rename's target is another's
    // source (a swap), which a direct rename would collide on.
    const renames = [...aCols].flatMap(([k, ac]) => {
      const bc = bCols.get(k)
      return bc && bc.name !== ac.name ? [{ from: ac.name, to: bc.name }] : []
    })
    // Names still held when the renames run (added columns are gone by then).
    const taken = new Set(A.columns.filter((c) => bCols.has(key(c))).map((c) => c.name))
    const collides = renames.some((r) => taken.has(r.to))
    renames.forEach((r, i) => {
      if (collides) {
        const tmpName = `__bkn_restore_${i}`
        add(PHASE.RENAME_COLUMNS, `ALTER TABLE ${T(fin)} RENAME COLUMN ${q(r.from)} TO ${q(tmpName)}`, `Move ${r.from} out of the way.`)
        add(PHASE.RENAME_COLUMNS + 0.1, `ALTER TABLE ${T(fin)} RENAME COLUMN ${q(tmpName)} TO ${q(r.to)}`, `Rename column back to ${r.to}.`)
      } else {
        add(PHASE.RENAME_COLUMNS, `ALTER TABLE ${T(fin)} RENAME COLUMN ${q(r.from)} TO ${q(r.to)}`, `Rename column ${r.from} back to ${r.to}.`)
      }
    })

    // Columns the change removed: back, with their values when they were kept.
    for (const [k, bc] of bCols) {
      if (aCols.has(k)) continue
      add(PHASE.RESTORE_COLUMNS, `ALTER TABLE ${T(fin)} ADD COLUMN ${q(bc.name)} ${columnTypeClause(bc, false)}`,
        `Re-add column ${bc.name} to ${fin}.`)
      const kept = findColumnEntry(input.preserved, [fin, cur], [bc.name], 'dropped')
      if (kept && kept.keyColumns.length > 0) {
        const match = kept.keyColumns.map((kc) => `t.${q(kc)} = v.${q(kc)}`).join(' AND ')
        add(PHASE.RESTORE_COLUMN_VALUES,
          `UPDATE ${T(fin)} AS t SET ${q(bc.name)} = v.${q(kept.column)} FROM ${qualified(kept.vault, kept.vaultTable)} AS v WHERE ${match}`,
          `Put back the kept values of ${fin}.${bc.name}, row by row.`)
        plan.checks.push({
          sql: `SELECT count(*)::bigint AS n FROM ${qualified(kept.vault, kept.vaultTable)} v JOIN ${T(fin)} t ON ${match} WHERE t.${q(bc.name)} IS DISTINCT FROM v.${q(kept.column)}`,
          describe: `Every kept value of ${fin}.${bc.name} is back on its row.`,
        })
        plan.restores.push({ table: fin, column: bc.name, from: 'vault', kept: { vault: kept.vault, vaultTable: kept.vaultTable } })
        // What this restore put back, so reapplying the change sets aside only
        // the values written after it, not these.
        const it = vaultName(fin, bc.name, 'restored')
        add(PHASE.AFTER_IMAGES,
          `CREATE TABLE ${qualified(vault, it)} AS SELECT ${kept.keyColumns.map((kc) => `t.${q(kc)}`).join(', ')}, t.${q(bc.name)} AS ${q(AFTER_COLUMN)} ` +
          `FROM ${T(fin)} AS t WHERE t.${q(bc.name)} IS NOT NULL`,
          `Record the values of ${fin}.${bc.name} this restore put back, so reapplying the change can tell them from values written after it.`)
        plan.archives.push({ kind: 'column', table: fin, column: bc.name, reason: 'rewritten', keyColumns: kept.keyColumns, vault, vaultTable: it, afterColumn: AFTER_COLUMN, rows: null })
      } else {
        plan.restores.push({ table: fin, column: bc.name, from: 'structure' })
        plan.unrecoverable.push(
          kept
            ? `${fin}.${bc.name}: its values are kept (${kept.vaultTable}), but ${fin} has no primary key to match them back by.`
            : `${fin}.${bc.name}: the column comes back, but its values were not kept when it was removed.`,
        )
      }
      if (bc.notNull && !bc.identity && !bc.generated) {
        if (kept || bc.default) {
          add(PHASE.NOT_NULL, `ALTER TABLE ${T(fin)} ALTER COLUMN ${q(bc.name)} SET NOT NULL`, `Make ${bc.name} required again.`)
        } else {
          plan.unrecoverable.push(`${fin}.${bc.name} stays optional: it was required, and with no kept values or default the rows have nothing to put in it.`)
        }
      }
      if (bc.identity) identitySteps(fin, bc, true)
    }

    // Columns the change altered.
    for (const [k, ac] of aCols) {
      const bc = bCols.get(k)
      if (!bc) continue
      const col = q(bc.name) // renamed back by now
      const typeChanged = ac.type !== bc.type
      const imaged = findColumnEntry(input.preserved, [cur, fin], [ac.name, bc.name], 'retyped')
        ?? findColumnEntry(input.preserved, [cur, fin], [ac.name, bc.name], 'rewritten')

      // Which rows still hold exactly what the change produced: only those get
      // their original value back. Recorded before any type is converted.
      let keep: string | null = null
      if (imaged && imaged.afterColumn && imaged.keyColumns.length > 0) {
        keep = `bkn_restore_keep_${tmp++}`
        const am = imaged.keyColumns.map((kc) => `a.${q(kc)} = t.${q(kc)}`).join(' AND ')
        add(PHASE.MARK_UNCHANGED,
          `CREATE TEMP TABLE ${q(keep)} ON COMMIT DROP AS SELECT ${imaged.keyColumns.map((kc) => `t.${q(kc)}`).join(', ')} ` +
          `FROM ${T(cur)} AS t JOIN ${qualified(imaged.vault, imaged.vaultTable)} AS a ON ${am} ` +
          `WHERE a.${q(imaged.afterColumn)} IS NOT DISTINCT FROM t.${q(ac.name)}`,
          `Find the rows of ${cur} whose ${ac.name} is still what the change left, so rows written since keep their values.`)
      }

      if (ac.identity && !bc.identity) {
        add(PHASE.ALTER_COLUMNS, `ALTER TABLE ${T(fin)} ALTER COLUMN ${col} DROP IDENTITY`, `Stop generating ${bc.name}.`)
      }
      if (ac.generated && !bc.generated) {
        add(PHASE.ALTER_COLUMNS, `ALTER TABLE ${T(fin)} ALTER COLUMN ${col} DROP EXPRESSION`, `Stop computing ${bc.name}.`)
      } else if (bc.generated && ac.generated !== bc.generated) {
        plan.conflicts.push({ table: fin, reason: `${fin}.${bc.name}'s generation expression cannot be restored in place by PostgreSQL` })
      }
      // Every current value, keyed, before any is converted or put back (values
      // converting back may not survive the conversion), and beside each, once
      // every value is in place, the value this restore leaves. Reapplying the
      // change then puts these back on the rows nobody has changed since, as
      // this restore does for the change.
      const keys = imaged?.keyColumns.length ? imaged.keyColumns : pk.filter((c) => c !== ac.name)
      if ((typeChanged || keep) && keys.length > 0) {
        const vt = vaultName(cur, ac.name, 'before_restore')
        add(PHASE.KEEP_CONVERTED,
          `CREATE TABLE ${qualified(vault, vt)} AS SELECT ${keys.map((kc) => `t.${q(kc)}`).join(', ')}, t.${q(ac.name)} AS ${col} FROM ${T(cur)} AS t`,
          `Keep every current value of ${cur}.${ac.name} in the recovery snapshot before it is ${typeChanged ? 'converted' : 'put'} back.`)
        add(PHASE.AFTER_IMAGES, `ALTER TABLE ${qualified(vault, vt)} ADD COLUMN ${q(AFTER_COLUMN)} ${bc.type}`,
          `Make room beside them for the values this restore leaves in ${fin}.${bc.name}.`)
        add(PHASE.AFTER_IMAGES,
          `UPDATE ${qualified(vault, vt)} AS v SET ${q(AFTER_COLUMN)} = t.${col} FROM ${T(fin)} AS t WHERE ${keys.map((kc) => `v.${q(kc)} = t.${q(kc)}`).join(' AND ')}`,
          `Record the values this restore leaves in ${fin}.${bc.name}, so reapplying the change can tell them from values written after it.`)
        plan.archives.push({
          kind: 'column', table: fin, column: bc.name, reason: typeChanged ? 'retyped' : 'rewritten',
          keyColumns: keys, vault, vaultTable: vt, afterColumn: AFTER_COLUMN, rows: null,
        })
      }
      if (typeChanged) {
        if (ac.default !== null) {
          add(PHASE.ALTER_COLUMNS, `ALTER TABLE ${T(fin)} ALTER COLUMN ${col} DROP DEFAULT`, `Lift ${bc.name}'s default while its type changes.`)
        }
        add(PHASE.ALTER_COLUMNS, `ALTER TABLE ${T(fin)} ALTER COLUMN ${col} TYPE ${bc.type} USING ${col}::${bc.type}`,
          `Change ${bc.name} back to ${bc.type}.`)
      }
      if (keep && imaged) {
        // The originals: the vault table for a retype, the migration's own
        // checkpoint table for a rewrite.
        const source = imaged.reason === 'rewritten' && imaged.beforeTable
          ? { table: T(imaged.beforeTable), column: bc.name }
          : { table: qualified(imaged.vault, imaged.vaultTable), column: imaged.column }
        const sm = imaged.keyColumns.map((kc) => `s.${q(kc)} = t.${q(kc)}`).join(' AND ')
        const km = imaged.keyColumns.map((kc) => `k.${q(kc)} = t.${q(kc)}`).join(' AND ')
        add(PHASE.RESTORE_VALUES,
          `UPDATE ${T(fin)} AS t SET ${col} = s.${q(source.column)} FROM ${source.table} AS s, ${q(keep)} AS k WHERE ${sm} AND ${km}`,
          `Put ${bc.name}'s original values back on the rows nobody has changed since.`)
        // The checks run after every step, by when a migration's checkpoint
        // table this restore archives has moved into the vault.
        const checkSource = imaged.reason === 'rewritten' && imaged.beforeTable &&
          tableEntries.some((e) => e.kind === 'added' && e.after === imaged.beforeTable)
          ? qualified(vault, imaged.beforeTable)
          : source.table
        plan.checks.push({
          sql: `SELECT count(*)::bigint AS n FROM ${T(fin)} t JOIN ${q(keep)} k ON ${km} JOIN ${checkSource} s ON ${sm} WHERE t.${col} IS DISTINCT FROM s.${q(source.column)}`,
          describe: `Every untouched row of ${fin} has its original ${bc.name} back.`,
        })
        plan.restores.push({ table: fin, column: bc.name, from: 'vault', kept: { vault: imaged.vault, vaultTable: imaged.vaultTable } })
      } else if (imaged && typeChanged) {
        plan.unrecoverable.push(imaged.keyColumns.length === 0
          ? `${fin}.${bc.name}: its original values are kept, but ${fin} has no primary key to put them back by; the column is converted back instead.`
          : `${fin}.${bc.name}: its original values are kept, but not which rows were written since; the column is converted back instead.`)
      }
      if (bc.default !== ac.default || (typeChanged && ac.default !== null)) {
        if (bc.default !== null) {
          add(PHASE.ALTER_COLUMNS, `ALTER TABLE ${T(fin)} ALTER COLUMN ${col} SET DEFAULT ${bc.default}`, `Restore ${bc.name}'s default.`)
        } else if (!typeChanged && ac.default !== null) {
          add(PHASE.ALTER_COLUMNS, `ALTER TABLE ${T(fin)} ALTER COLUMN ${col} DROP DEFAULT`, `Remove the default the change gave ${bc.name}.`)
        }
      }
      if (ac.notNull && !bc.notNull && !bc.identity) {
        add(PHASE.ALTER_COLUMNS, `ALTER TABLE ${T(fin)} ALTER COLUMN ${col} DROP NOT NULL`, `Make ${bc.name} optional again.`)
      }
      // An identity needs NOT NULL first, so it is asserted for those too.
      if (bc.notNull && !ac.notNull) {
        add(PHASE.NOT_NULL, `ALTER TABLE ${T(fin)} ALTER COLUMN ${col} SET NOT NULL`, `Make ${bc.name} required again.`)
      }
      if (bc.identity && !ac.identity) identitySteps(fin, bc, false)
      else if (bc.identity && ac.identity && bc.identity !== ac.identity) {
        add(PHASE.IDENTITY, `ALTER TABLE ${T(fin)} ALTER COLUMN ${col} SET GENERATED ${bc.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'}`,
          `Restore how ${bc.name} is generated.`)
      }
    }

    if (A.rls.enabled !== B.rls.enabled) {
      add(PHASE.RLS, `ALTER TABLE ${T(fin)} ${B.rls.enabled ? 'ENABLE' : 'DISABLE'} ROW LEVEL SECURITY`,
        `Turn row-level security ${B.rls.enabled ? 'back on' : 'off again'} for ${fin}.`)
    }
    if (A.rls.forced !== B.rls.forced) {
      add(PHASE.RLS, `ALTER TABLE ${T(fin)} ${B.rls.forced ? 'FORCE' : 'NO FORCE'} ROW LEVEL SECURITY`,
        `Restore whether ${fin}'s policies apply to its owner.`)
    }
    if ((A.comment ?? null) !== (B.comment ?? null)) {
      add(PHASE.GRANTS, `COMMENT ON TABLE ${T(fin)} IS ${B.comment === null ? 'NULL' : literal(B.comment)}`, `Restore ${fin}'s description.`)
    }

    // The API's privileges the change took away are given back, and only those.
    // Grants also move for reasons that have nothing to do with the change (the
    // data plane re-grants a schema's tables whenever one is created there), so
    // a grant the change added is left alone, as is any made since; and other
    // roles' grants are their own sync's (apiGrantsRemoved).
    const regranted = apiGrantsRemoved(B, A).filter((g) => GRANTABLE.test(g.privilege))
    for (const g of regranted) {
      add(PHASE.GRANTS, grantSql(fin, g), `Give ${g.grantee} back the ${g.privilege} privilege on ${fin} that the change took away.`)
    }
    const checked = regranted.filter((g) => g.grantee !== 'PUBLIC')
    if (checked.length > 0) {
      plan.checks.push({
        sql: `SELECT count(*)::bigint AS n FROM (VALUES ${checked.map((g) => `(${literal(g.grantee)}, ${literal(g.privilege)})`).join(', ')}) AS v(r, p) ` +
          `WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v.r) AND NOT has_table_privilege(v.r, ${literal(`${q(schema)}.${q(fin)}`)}, v.p)`,
        describe: `Every privilege the change took away on ${fin} is back.`,
      })
    }
  }

  // ── Views, functions, types ────────────────────────────────────────────────

  function restoreObject(c: TableChange) {
    const now = c.after ? resultState.objects?.[c.after] : undefined
    const then = c.before ? checkpoint.objects?.[c.before] : undefined
    if (now && !then) {
      // Created by the change. It goes, unless something that outlives this
      // restore uses it.
      const user = stillUsing(now)
      if (user) {
        plan.keptObjects.push({ identity: now.identity, reason: `${user} uses it` })
        return
      }
    }
    // Changed in place: put the old definition back over it. Dropping it first
    // would fail on every trigger and policy that calls it.
    if (now && then && now.kind === 'function') {
      createObject(then)
      return
    }
    // An enum whose values were renamed: renamed back. Rows hold the value, not
    // its label, so every row reads its old label again. Through a temporary
    // label when one rename's target is another's source.
    const renames = now && then ? enumRenames(then, now) : null
    if (renames) {
      const held = new Set(enumLabels(now) ?? [])
      const swap = renames.some((r) => held.has(r.to))
      renames.forEach((r, i) => {
        const from = literal(r.from)
        if (swap) {
          add(PHASE.CREATE_TYPES, `ALTER TYPE ${T(now!.name)} RENAME VALUE ${from} TO ${literal(`__bkn_restore_${i}`)}`, `Move value ${r.from} of ${now!.name} out of the way.`)
          add(PHASE.CREATE_TYPES + 0.05, `ALTER TYPE ${T(now!.name)} RENAME VALUE ${literal(`__bkn_restore_${i}`)} TO ${literal(r.to)}`, `Rename value ${r.from} of ${now!.name} back to ${r.to}.`)
        } else {
          add(PHASE.CREATE_TYPES, `ALTER TYPE ${T(now!.name)} RENAME VALUE ${from} TO ${literal(r.to)}`, `Rename value ${r.from} of ${now!.name} back to ${r.to}.`)
        }
      })
      return
    }
    if (now) dropObject(now, !then)
    if (then) createObject(then)
  }

  /**
   * What will still use a function or type once this restore is done: a
   * trigger, policy, default or column on a table this change did not touch,
   * or a default or column of a table this restore moves into its vault (which
   * keeps them, to come back as they were). Null when nothing does. Views read
   * through their own entries.
   */
  function stillUsing(o: ObjectState): string | null {
    if (o.kind !== 'function' && o.kind !== 'type') return null
    const calls = (text: string | null | undefined) => {
      if (!text) return false
      const t = text.replace(/"/g, '')
      return o.kind === 'function'
        ? new RegExp(`(^|[^a-zA-Z0-9_$])${escapeRegExp(o.name)}\\s*\\(`).test(t)
        : new RegExp(`(^|[^a-zA-Z0-9_$])${escapeRegExp(o.name)}(\\[\\])?$`).test(t.trim())
    }
    const touched = new Set(tableEntries.flatMap((c) => [c.before, c.after]).filter((n): n is string => !!n))
    for (const L of Object.values(live.tables)) {
      if (touched.has(L.name)) continue
      const g = L.triggers.find((x) => o.kind === 'function' && calls(x.definition))
      if (g) return `trigger ${g.name} on ${L.name}`
      const p = L.policies.find((x) => o.kind === 'function' && (calls(x.using) || calls(x.check)))
      if (p) return `policy ${p.name} on ${L.name}`
      const col = L.columns.find((x) => (o.kind === 'function' ? calls(x.default) : calls(x.type)))
      if (col) return `${L.name}.${col.name}`
    }
    for (const c of tableEntries) {
      if (c.kind !== 'added' && c.kind !== 'replaced') continue
      const A = c.after ? resultState.tables[c.after] : null
      const col = A?.columns.find((x) => (o.kind === 'function' ? calls(x.default) : calls(x.type)))
      if (A && col) return `${A.name}.${col.name}, kept in the recovery snapshot,`
    }
    // A copy this restore keeps of a column on a table that stays (one the
    // change added, or the current values of one it retyped) has the column's
    // type as it is now. A copy has no default, so only a type is held.
    if (o.kind === 'type') {
      for (const c of tableEntries) {
        if (c.kind !== 'modified') continue
        const A = c.after ? resultState.tables[c.after] : null
        const B = c.before ? checkpoint.tables[c.before] : null
        if (!A || !B) continue
        const key = columnKey(A.oid === B.oid)
        const then = new Map(B.columns.map((x) => [key(x), x]))
        const col = A.columns.find((x) => calls(x.type) && then.get(key(x))?.type !== x.type)
        if (col) return `${A.name}.${col.name}, kept in the recovery snapshot,`
      }
    }
    return null
  }

  function dropObject(o: ObjectState, added: boolean) {
    if (o.kind === 'view') add(PHASE.DROP_VIEWS, `DROP VIEW ${T(o.name)}`, `Remove view ${o.name}.`)
    else if (o.kind === 'function') add(added ? PHASE.DROP_ADDED_FUNCTIONS : PHASE.DROP_FUNCTIONS, `DROP FUNCTION ${qualified(schema, o.name)}(${o.identity.slice(o.name.length + 1, -1)})`, `Remove function ${o.identity}.`)
    else if (o.kind === 'type') add(PHASE.DROP_TYPES, `DROP ${isDomain(o) ? 'DOMAIN' : 'TYPE'} ${T(o.name)}`, `Remove ${isDomain(o) ? 'domain' : 'type'} ${o.name}.`)
  }

  function createObject(o: ObjectState) {
    if (o.kind === 'view') {
      const opts = o.options.length > 0 ? ` WITH (${o.options.join(', ')})` : ''
      add(PHASE.CREATE_VIEWS, `CREATE VIEW ${T(o.name)}${opts} AS ${o.definition.trim().replace(/;$/, '')}`, `Re-create view ${o.name}.`)
    } else if (o.kind === 'function') {
      add(PHASE.CREATE_FUNCTIONS, o.definition, `Re-create function ${o.identity}.`)
    } else if (o.kind === 'type') {
      add(PHASE.CREATE_TYPES, o.definition, `Re-create type ${o.name}.`)
    }
  }

  function addConstraint(table: string, con: ConstraintState) {
    const phase = con.type === 'f' ? PHASE.ADD_FOREIGN_KEYS : con.type === 'p' ? PHASE.ADD_PRIMARY_KEYS : PHASE.ADD_CONSTRAINTS
    add(phase, `ALTER TABLE ${T(table)} ADD CONSTRAINT ${q(con.name)} ${con.definition}`, `Re-add ${constraintNoun(con)} ${con.name}.`)
  }

  /**
   * An identity column re-added or re-declared. Its sequence starts again at 1,
   * so it is moved past the highest existing value or the next insert collides.
   */
  function identitySteps(table: string, col: ColumnState, readded: boolean) {
    if (!readded) {
      add(PHASE.IDENTITY, `ALTER TABLE ${T(table)} ALTER COLUMN ${q(col.name)} ADD GENERATED ${col.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`,
        `Generate ${col.name} again.`)
    } else if (col.identity === 'a') {
      add(PHASE.IDENTITY, `ALTER TABLE ${T(table)} ALTER COLUMN ${q(col.name)} SET GENERATED ALWAYS`, `Restore how ${col.name} is generated.`)
    }
    add(PHASE.IDENTITY + 0.1,
      `SELECT setval(pg_get_serial_sequence(${literal(`${q(schema)}.${q(table)}`)}, ${literal(col.name)}), ` +
      `coalesce((SELECT max(${q(col.name)}) FROM ${T(table)}), 0) + 1, false)`,
      `Continue ${col.name}'s sequence after its highest value.`)
  }

  function createPolicySql(table: string, p: PolicyState): string {
    const roles = p.roles.length === 0 ? 'PUBLIC' : p.roles.map((r) => (r === 'public' ? 'PUBLIC' : q(r))).join(', ')
    return (
      `CREATE POLICY ${q(p.name)} ON ${T(table)} AS ${p.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} ` +
      `FOR ${COMMAND[p.cmd] ?? 'ALL'} TO ${roles}` +
      (p.using ? ` USING (${p.using})` : '') +
      (p.check ? ` WITH CHECK (${p.check})` : '')
    )
  }

  function triggerStateSql(table: string, g: TriggerState): string {
    const verb = g.enabled === 'D' ? 'DISABLE' : g.enabled === 'R' ? 'ENABLE REPLICA' : g.enabled === 'A' ? 'ENABLE ALWAYS' : 'ENABLE'
    return `ALTER TABLE ${T(table)} ${verb} TRIGGER ${q(g.name)}`
  }

  /** A grant to a role that was dropped since has nobody to go back to, and is skipped rather than failing the restore. */
  function grantSql(table: string, g: GrantState): string {
    if (g.grantee === 'PUBLIC') return `GRANT ${g.privilege} ON ${T(table)} TO PUBLIC`
    const grant = `GRANT ${g.privilege} ON ${T(table)} TO ${q(g.grantee)}`
    return `DO $grant$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(g.grantee)}) THEN EXECUTE ${literal(grant)}; END IF; END $grant$`
  }
}

/** Table privileges as aclexplode names them; nothing else is replayed into a GRANT. */
const GRANTABLE = /^(SELECT|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|MAINTAIN)$/

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * `type [GENERATED …] [DEFAULT …] [NOT NULL]` for a column. NOT NULL is left out
 * when re-adding a column to a table that already has rows: the values arrive
 * afterwards, and NOT NULL is asserted once they have.
 */
export function columnTypeClause(col: ColumnState, withNotNull: boolean): string {
  const parts = [col.type]
  if (col.generated) parts.push(`GENERATED ALWAYS AS (${col.generated}) STORED`)
  else if (col.identity) parts.push(withNotNull && col.identity === 'a' ? 'GENERATED ALWAYS AS IDENTITY' : 'GENERATED BY DEFAULT AS IDENTITY')
  else if (col.default !== null) parts.push(`DEFAULT ${col.default}`)
  if (withNotNull && col.notNull && !col.identity) parts.push('NOT NULL')
  return parts.join(' ')
}

function constraintNoun(con: ConstraintState): string {
  return ({ p: 'primary key', u: 'unique constraint', c: 'check constraint', f: 'foreign key', x: 'exclusion constraint' } as Record<string, string>)[con.type] ?? 'constraint'
}

/**
 * Walk two named lists. `now` is the change's result, `then` the checkpoint:
 * what is only in `now`, or differs, is dropped; what is only in `then`, or
 * differs, is created. A definition that names its table (an index, a trigger)
 * differs after a table rename, so it is re-created from the checkpoint's
 * text, which names the table as it is about to be called again.
 */
function diffByName<X extends { name: string }>(
  now: X[],
  then: X[],
  equal: (a: X, b: X) => boolean,
  ops: { drop: (x: X) => void; create: (x: X) => void; same?: (now: X, then: X) => void },
): void {
  const thenByName = new Map(then.map((x) => [x.name, x]))
  const nowByName = new Map(now.map((x) => [x.name, x]))
  for (const [name, x] of nowByName) {
    const y = thenByName.get(name)
    if (!y || !equal(x, y)) ops.drop(x)
  }
  for (const [name, y] of thenByName) {
    const x = nowByName.get(name)
    if (!x || !equal(x, y)) ops.create(y)
    else if (ops.same) ops.same(x, y)
  }
}

/**
 * The renames that turn enum `now` back into `then`: the same number of values,
 * differing only in labels, position for position. Null when the two are not
 * both enums of that shape (a value was added, or it is not an enum).
 */
export function enumRenames(then: ObjectState | undefined, now: ObjectState | undefined): Array<{ from: string; to: string }> | null {
  const b = enumLabels(then)
  const a = enumLabels(now)
  if (!a || !b || a.length !== b.length) return null
  const renames = a.flatMap((label, i) => (label !== b[i] ? [{ from: label, to: b[i] }] : []))
  return renames.length > 0 ? renames : null
}

function findTableEntry(entries: PreservedEntry[], ...names: Array<string | undefined>) {
  return entries.find((e): e is Extract<PreservedEntry, { kind: 'table' }> => e.kind === 'table' && names.includes(e.table))
}

function findColumnEntry(entries: PreservedEntry[], tables: string[], columns: string[], reason: 'dropped' | 'retyped' | 'rewritten') {
  return entries.find(
    (e): e is Extract<PreservedEntry, { kind: 'column' }> =>
      e.kind === 'column' && e.reason === reason && tables.includes(e.table) && columns.includes(e.column) && !!e.vaultTable,
  )
}

// ── Verification ─────────────────────────────────────────────────────────────

export interface VerificationCheck {
  table: string
  ok: boolean
  /** What was expected and what is there. */
  detail: string
}

export interface Verification {
  ok: boolean
  checkedAt: string
  checks: VerificationCheck[]
}

/**
 * The independent check after a restore: read back from the catalog, compare
 * to the checkpoint. Takes nothing from the plan or from whoever asked for the
 * restore, so there is no argument with which to weaken it: everything the
 * change touched either matches the state recorded before the change, or the
 * mismatch is named.
 */
export function verifyAgainstCheckpoint(
  footprint: TableChange[],
  checkpoint: CatalogSnapshot,
  live: CatalogSnapshot,
  /** Objects the plan kept on purpose (RestorePlan.keptObjects), and why. */
  keptObjects: Array<{ identity: string; reason: string }> = [],
): Verification {
  const plural: Record<string, string> = { index: 'indexes', policy: 'policies' }
  const n = (count: number, noun: string) => `${count} ${count === 1 ? noun : plural[noun] ?? `${noun}s`}`
  const checks: VerificationCheck[] = []
  for (const c of footprint) {
    if (c.object) {
      const noun = c.object.replace('_', ' ')
      if (c.before) {
        const B = checkpoint.objects?.[c.before]
        const L = live.objects?.[c.before]
        if (!B) checks.push({ table: c.before, ok: false, detail: `${noun} has no record in the checkpoint` })
        else if (!L) checks.push({ table: B.name, ok: false, detail: `${noun} should exist and does not` })
        else if (!sameObject(L, B)) checks.push({ table: B.name, ok: false, detail: `${noun} differs from the checkpoint` })
        else checks.push({ table: B.name, ok: true, detail: `${noun} matches the checkpoint` })
      } else if (c.after) {
        const still = live.objects?.[c.after]
        const kept = keptObjects.find((k) => k.identity === c.after)
        checks.push(!still
          ? { table: c.after, ok: true, detail: `${noun} is no longer in the schema` }
          : kept
            ? { table: c.after, ok: true, detail: `${noun} kept: ${kept.reason}` }
            : { table: c.after, ok: false, detail: `${noun} should be gone and is still there` })
      }
      continue
    }
    if (c.before) {
      const B = checkpoint.tables[c.before]
      const L = B ? live.tables[B.name] : undefined
      if (!B) checks.push({ table: c.before, ok: false, detail: 'has no record in the checkpoint' })
      else if (!L) checks.push({ table: B.name, ok: false, detail: 'should exist and does not' })
      else if (!sameTable(L, B)) checks.push({ table: B.name, ok: false, detail: `differs from the checkpoint: ${describeTableChange(B, L).join('; ')}` })
      else {
        checks.push({
          table: B.name,
          ok: true,
          detail:
            `matches the checkpoint (${n(B.columns.length, 'column')}, ${n(B.constraints.length, 'constraint')}, ` +
            `${n(B.indexes.length, 'index')}, ${n(B.policies.length, 'policy')}, ${n(B.triggers.length, 'trigger')})`,
        })
      }
    }
    if (c.after && c.after !== c.before) {
      const still = live.tables[c.after]
      const takenBack = c.before ? checkpoint.tables[c.before]?.name === c.after : false
      if (still && !takenBack) checks.push({ table: c.after, ok: false, detail: 'should be gone and is still there' })
      else if (!still) checks.push({ table: c.after, ok: true, detail: 'is no longer in the schema' })
    }
  }
  return { ok: checks.every((c) => c.ok), checkedAt: new Date().toISOString(), checks }
}
