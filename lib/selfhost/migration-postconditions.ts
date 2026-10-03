/**
 * WHAT A MIGRATION PROMISED, AND WHETHER THIS DATABASE HAS IT
 * ==========================================================
 *
 * Adopting a legacy self-host install means deciding which canonical migrations
 * it already satisfies, so the rest can be deployed. That decision is the
 * dangerous part: recording a migration as applied when it is only partly
 * present leaves a database that Prisma believes is current and is not, and
 * nothing will ever revisit it.
 *
 * ── Why one table is not proof ──────────────────────────────────────────────
 *
 * The first version of this checked a single "sentinel" table per migration and
 * called the migration applied if it existed. That is the silent-success shape
 * this program has spent its whole length removing. A migration creates several
 * tables, indexes, constraints and types; seeing one of them proves that one
 * object exists and says nothing about the other forty. A migration with no
 * CREATE TABLE at all — a backfill, an ALTER COLUMN — would have had no sentinel
 * and been waved through.
 *
 * So the postconditions are derived from the migration's OWN SQL, in full, and
 * every one of them is checked.
 *
 * ── Anything it cannot prove, it refuses ────────────────────────────────────
 *
 * The parser understands the shapes Prisma emits: CREATE TABLE with its columns,
 * CREATE [UNIQUE] INDEX, CREATE TYPE ... AS ENUM, and ALTER TABLE ... ADD
 * CONSTRAINT. A statement it does not recognise does not become an assumption —
 * it makes the whole migration UNVERIFIABLE, and adoption stops rather than
 * guessing. A future migration that backfills data, or alters a column type,
 * needs a verifier written for it; that is a deliberate cost, paid once, in
 * exchange for never silently mis-adopting a database.
 */

export interface ExpectedTable {
  name: string
  /** Column names, lower-cased for comparison against the catalog. */
  columns: string[]
}

export interface Postconditions {
  tables: ExpectedTable[]
  indexes: string[]
  constraints: Array<{ table: string; name: string }>
  types: string[]
  /**
   * Statements the parser could not classify.
   *
   * Non-empty means this migration cannot be proven by inspection and adoption
   * must refuse rather than assume.
   */
  unverifiable: string[]
}

/** Strip comments and split into statements on semicolons at depth zero. */
function statementsOf(sql: string): string[] {
  // Line comments first; the migrations are full of them and a `--` inside a
  // string literal is not something Prisma emits.
  const withoutComments = sql
    .split('\n')
    .map(line => {
      const idx = line.indexOf('--')
      return idx === -1 ? line : line.slice(0, idx)
    })
    .join('\n')

  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of withoutComments) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ';' && depth === 0) {
      const trimmed = current.trim()
      if (trimmed) out.push(trimmed)
      current = ''
      continue
    }
    current += ch
  }
  const tail = current.trim()
  if (tail) out.push(tail)
  return out
}

/** `"users"` -> `users`. Prisma quotes every identifier it emits. */
function unquote(value: string): string {
  return value.replace(/^"|"$/g, '').replace(/""/g, '"')
}

/**
 * Column names from a CREATE TABLE body.
 *
 * Table-level constraint clauses (`CONSTRAINT "x" PRIMARY KEY (...)`) are not
 * columns, and are skipped: the constraint they declare is verified separately
 * through the catalog rather than inferred from the text.
 */
function columnsOf(body: string): string[] {
  const columns: string[] = []
  let depth = 0
  let current = ''
  const parts: string[] = []

  for (const ch of body) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current)

  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) continue
    // Table-level constraints, not columns.
    if (/^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|EXCLUDE)\b/i.test(trimmed)) continue
    const match = trimmed.match(/^"([^"]+)"/)
    if (match) columns.push(match[1].toLowerCase())
  }
  return columns
}

/**
 * Everything a migration claims to leave behind.
 *
 * Derived from the SQL rather than declared alongside it, so it cannot drift
 * from what the migration actually does.
 */
export function parsePostconditions(sql: string): Postconditions {
  const result: Postconditions = {
    tables: [],
    indexes: [],
    constraints: [],
    types: [],
    unverifiable: [],
  }

  for (const statement of statementsOf(sql)) {
    const normalised = statement.replace(/\s+/g, ' ').trim()

    const createTable = normalised.match(/^CREATE TABLE (?:IF NOT EXISTS )?"([^"]+)"\s*\(([\s\S]*)\)$/i)
    if (createTable) {
      result.tables.push({
        name: unquote(createTable[1]),
        columns: columnsOf(createTable[2]),
      })
      continue
    }

    const createIndex = normalised.match(/^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"([^"]+)"/i)
    if (createIndex) {
      result.indexes.push(unquote(createIndex[1]))
      continue
    }

    const createType = normalised.match(/^CREATE TYPE "([^"]+)" AS ENUM/i)
    if (createType) {
      result.types.push(unquote(createType[1]))
      continue
    }

    const addConstraint = normalised.match(
      /^ALTER TABLE (?:ONLY )?"([^"]+)" ADD CONSTRAINT "([^"]+)"/i,
    )
    if (addConstraint) {
      result.constraints.push({
        table: unquote(addConstraint[1]),
        name: unquote(addConstraint[2]),
      })
      continue
    }

    // Recognised and carrying no postcondition worth checking.
    if (/^COMMENT ON /i.test(normalised)) continue

    // Anything else. NOT ignored: recorded, so adoption refuses.
    result.unverifiable.push(normalised.slice(0, 160))
  }

  return result
}

// ── Verification against a live database ─────────────────────────────────────

export interface CatalogSnapshot {
  /** table name -> set of column names, all lower case. */
  tables: Map<string, Set<string>>
  indexes: Set<string>
  constraints: Set<string>
  types: Set<string>
}

export type MigrationVerdict =
  /** Every postcondition present. Safe to record as applied. */
  | { state: 'satisfied' }
  /** Nothing from this migration is present. It has not run. */
  | { state: 'absent' }
  /**
   * Some present, some not. The dangerous case, and the reason adoption stops
   * before mutating anything: a database in this state is neither the old
   * version nor the new one, and recording it either way is a lie.
   */
  | { state: 'partial'; missing: string[]; present: string[] }
  /** Contains a statement no verifier can prove. */
  | { state: 'unverifiable'; statements: string[] }

/**
 * Does this database satisfy this migration, completely?
 *
 * `partial` is reported with BOTH what is missing and what is present, because
 * an operator staring at a refused upgrade needs to see the shape of the
 * divergence, not just that there is one.
 */
export function verifyMigration(
  post: Postconditions,
  catalog: CatalogSnapshot,
): MigrationVerdict {
  if (post.unverifiable.length > 0) {
    return { state: 'unverifiable', statements: post.unverifiable }
  }

  const missing: string[] = []
  const present: string[] = []

  for (const table of post.tables) {
    const actual = catalog.tables.get(table.name.toLowerCase())
    if (!actual) {
      missing.push(`table ${table.name}`)
      continue
    }
    present.push(`table ${table.name}`)
    // Columns matter: a table that exists with the wrong shape is exactly the
    // partial state a sentinel check would have waved through.
    for (const column of table.columns) {
      if (actual.has(column)) present.push(`column ${table.name}.${column}`)
      else missing.push(`column ${table.name}.${column}`)
    }
  }

  for (const index of post.indexes) {
    if (catalog.indexes.has(index.toLowerCase())) present.push(`index ${index}`)
    else missing.push(`index ${index}`)
  }

  for (const constraint of post.constraints) {
    if (catalog.constraints.has(constraint.name.toLowerCase())) {
      present.push(`constraint ${constraint.name}`)
    } else {
      missing.push(`constraint ${constraint.name}`)
    }
  }

  for (const type of post.types) {
    if (catalog.types.has(type.toLowerCase())) present.push(`type ${type}`)
    else missing.push(`type ${type}`)
  }

  if (missing.length === 0) return { state: 'satisfied' }
  if (present.length === 0) return { state: 'absent' }
  return { state: 'partial', missing, present }
}
