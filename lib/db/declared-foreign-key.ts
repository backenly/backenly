/**
 * A foreign key exactly as its author declared it.
 *
 * apply_migration used to keep only the referenced TABLE of a REFERENCES
 * clause, and the executor chose everything else: the referenced column (`id`),
 * the constraint's name (`fk_<table>_<column>`) and the actions, from the
 * column's nullability or a naming rule. So
 *
 *   ALTER TABLE enrolments ADD CONSTRAINT enrolments_clan_fkey
 *     FOREIGN KEY (clan_id) REFERENCES guilds(id) ON DELETE SET NULL
 *
 * installed `fk_enrolments_clan ... ON DELETE CASCADE`, and deleting a guild
 * deleted every enrolment in it. A declared foreign key now carries what its
 * author wrote, and the executor installs exactly that or nothing.
 *
 * What SQL leaves unsaid takes SQL's meaning: a REFERENCES clause with no ON
 * DELETE is ON DELETE NO ACTION, which refuses to delete a parent that still
 * has children instead of deleting them, and one that names no column
 * references the table's primary key, which PostgreSQL resolves itself.
 *
 * Pure: no database and no imports, so the parser, the executor and tests share
 * one definition.
 */

export const REFERENTIAL_ACTIONS = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'] as const
export type ReferentialAction = (typeof REFERENTIAL_ACTIONS)[number]

export interface DeclaredForeignKey {
  /** The referenced table, unqualified. */
  table: string
  /** The referenced column; absent, the referenced table's primary key. */
  column?: string
  onDelete: ReferentialAction
  onUpdate: ReferentialAction
  /** The constraint's name, when its author gave one. */
  name?: string
}

/** A name this module will put in DDL, quoted. Anything else is refused. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/

function quote(name: string): string {
  return `"${name}"`
}

/** True when `value` is a complete declared foreign key with names safe for DDL. */
export function isDeclaredForeignKey(value: unknown): value is DeclaredForeignKey {
  if (!value || typeof value !== 'object') return false
  const fk = value as Record<string, unknown>
  return (
    typeof fk.table === 'string' && IDENT.test(fk.table) &&
    (fk.column === undefined || (typeof fk.column === 'string' && IDENT.test(fk.column))) &&
    (REFERENTIAL_ACTIONS as readonly unknown[]).includes(fk.onDelete) &&
    (REFERENTIAL_ACTIONS as readonly unknown[]).includes(fk.onUpdate) &&
    (fk.name === undefined || (typeof fk.name === 'string' && IDENT.test(fk.name)))
  )
}

/**
 * PostgreSQL's own name for an unnamed single-column foreign key, so a
 * migration that names none gets the name it would get from PostgreSQL itself.
 */
export function defaultForeignKeyName(table: string, column: string): string {
  return `${table}_${column}_fkey`.slice(0, 63)
}

/** The name a declared foreign key on `table.column` is installed under. */
export function foreignKeyName(table: string, column: string, fk: DeclaredForeignKey): string {
  return fk.name ?? defaultForeignKeyName(table, column)
}

/** `table(column)`, or the table alone when the key references its primary key. */
export function describeTarget(fk: DeclaredForeignKey): string {
  return fk.column ? `${fk.table}(${fk.column})` : fk.table
}

/**
 * `REFERENCES "schema"."table"("column") ON DELETE … ON UPDATE …`: the clause
 * itself, for a column definition or a table constraint. Both actions are always
 * written out, so what was installed can be read from the statement.
 */
export function referencesSql(schema: string, fk: DeclaredForeignKey): string {
  if (!isDeclaredForeignKey(fk)) throw new Error('Not a declared foreign key this path can install.')
  const column = fk.column ? `(${quote(fk.column)})` : ''
  return `REFERENCES ${quote(schema)}.${quote(fk.table)}${column} ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`
}

/** `CONSTRAINT "name" REFERENCES …`, for a column definition. */
export function columnForeignKeySql(schema: string, table: string, column: string, fk: DeclaredForeignKey): string {
  const name = foreignKeyName(table, column, fk)
  if (!IDENT.test(name)) throw new Error(`"${name}" is not a constraint name this path can install.`)
  return `CONSTRAINT ${quote(name)} ${referencesSql(schema, fk)}`
}

/** `ADD CONSTRAINT "name" FOREIGN KEY ("column") REFERENCES …`, for ALTER TABLE. */
export function addForeignKeySql(schema: string, table: string, column: string, fk: DeclaredForeignKey): string {
  if (!IDENT.test(table) || !IDENT.test(column)) throw new Error('Not a table or column this path can constrain.')
  const name = foreignKeyName(table, column, fk)
  if (!IDENT.test(name)) throw new Error(`"${name}" is not a constraint name this path can install.`)
  return `ALTER TABLE ${quote(schema)}.${quote(table)} ADD CONSTRAINT ${quote(name)} FOREIGN KEY (${quote(column)}) ${referencesSql(schema, fk)}`
}
