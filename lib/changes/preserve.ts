/**
 * Destructive operations that keep what they destroy, and rewrites that keep
 * what they replaced.
 *
 * Approving "drop the projects table" means the table leaves the API and the
 * schema. It does not have to mean its rows are gone: until this existed they
 * were, and the executor's own message called the change "reversible via the
 * version history", which could restore an empty table at best.
 *
 * Inside a recorded change (lib/changes/ledger.ts) these move the data into the
 * change's vault instead, in the same transaction as the destructive statement
 * and under an exclusive lock on the table, so no write can land between the
 * copy and the drop. Restoring the state before the change brings it back.
 *
 * ── Before AND after, for anything rewritten in place ───────────────────────
 *
 * A retype or a data migration changes values rather than removing them, and
 * the rows go on being written afterwards. Putting every original value back
 * would silently overwrite those writes. So both images are kept: the value
 * before the change and the value the change produced. A restore puts the
 * original back only on rows whose value is still what the change produced,
 * and leaves rows written since as they are (lib/changes/impact.ts).
 *
 * Every vault table records its row count and checksum when it is filled, so a
 * restore can tell a vault that was altered afterwards from one it can trust
 * (lib/changes/integrity.ts).
 *
 * Outside a recorded change (integration mode, or the ledger switched off) these
 * do nothing and return `handled: false`, and the caller runs its destructive
 * statement exactly as it did before.
 */

import type { PoolClient } from 'pg'
import { currentChange, ensureVault, recordStatement, type OpenChange } from './ledger'
import { describeReaders, vaultReaders } from './dependents'
import { tableChecksum } from './integrity'
import { AFTER_COLUMN, qualified, quoteIdent as q, vaultTableName } from './names'
import type { CatalogSnapshot } from './catalog'
import { columnKey } from './diff'
import { isConstantDefault } from './impact'
import type { PreservedEntry, TableChange } from './types'

export { AFTER_COLUMN }

/** How long a destructive step waits for its table before giving up. */
const LOCK_TIMEOUT = '5s'

async function inTransaction<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN')
  try {
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
    const out = await fn()
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}

/** Run a statement on the change's connection, and put it on the change's record. */
async function run(change: OpenChange, sql: string, params?: unknown[]) {
  recordStatement(change, sql)
  return change.client.query(sql, params as unknown[])
}

async function primaryKey(client: Pick<PoolClient, 'query'>, target: string): Promise<string[]> {
  const pk = await client.query<{ col: string }>(
    `SELECT a.attname AS col
       FROM pg_constraint con
       JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      WHERE con.conrelid = $1::regclass AND con.contype = 'p'
      ORDER BY k.ord`,
    [target],
  )
  return pk.rows.map((r) => r.col)
}

/**
 * Remove a table from production by moving it, rows and all, into the vault.
 *
 * What DROP TABLE … CASCADE would have removed alongside it is removed here
 * too, so the visible result is the same: foreign keys from other tables that
 * point at it, its own foreign keys (left in place they would keep acting
 * between the vault and production, cascading deletes into archived rows or
 * refusing live ones), and policies on other tables whose expressions name it.
 * Every one of those is in the change's checkpoint, and comes back with it.
 *
 * Anything else that reads it (a view, a default drawing from its sequence, a
 * function whose body names it) refuses the drop, and nothing changes. Moved
 * with the table, each would keep reading the vault, and the vault's purge
 * would later drop it from the live schema (lib/changes/dependents.ts); a
 * CASCADE would have removed it unasked, which verification treats as damage.
 */
export async function archiveTable(
  projectId: string,
  schema: string,
  table: string,
): Promise<{ handled: false } | { handled: true; rows: number; vault: string; seq: number }> {
  const change = currentChange(projectId)
  if (!change) return { handled: false }
  const client = change.client
  const target = qualified(schema, table)
  // Not there: nothing to keep, and the caller's DROP … IF EXISTS is a no-op.
  const present = await client.query<{ oid: string | null }>('SELECT to_regclass($1)::oid AS oid', [target])
  if (!present.rows[0]?.oid) return { handled: false }
  const vault = await ensureVault(change)

  const kept = await inTransaction(client, async () => {
    await run(change, `LOCK TABLE ${target} IN ACCESS EXCLUSIVE MODE`)

    const fks = await client.query<{ tbl: string; name: string }>(
      `SELECT c.relname AS tbl, con.conname AS name
         FROM pg_constraint con
         JOIN pg_class c ON c.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype = 'f'
          AND (con.confrelid = $1::regclass OR con.conrelid = $1::regclass)
          AND n.nspname = $2`,
      [target, schema],
    )
    for (const fk of fks.rows) {
      await run(change, `ALTER TABLE ${qualified(schema, fk.tbl)} DROP CONSTRAINT IF EXISTS ${q(fk.name)}`)
    }

    const policies = await client.query<{ tbl: string; name: string }>(
      `SELECT DISTINCT c.relname AS tbl, pol.polname AS name
         FROM pg_depend d
         JOIN pg_policy pol ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid
         JOIN pg_class c ON c.oid = pol.polrelid
        WHERE d.refobjid = $1::regclass AND pol.polrelid <> $1::regclass`,
      [target],
    )
    for (const p of policies.rows) {
      await run(change, `DROP POLICY IF EXISTS ${q(p.name)} ON ${qualified(schema, p.tbl)}`)
    }

    await run(change, `ALTER TABLE ${target} SET SCHEMA ${q(vault)}`)
    const readers = await vaultReaders(async <R>(sql: string, params: unknown[]) => (await client.query(sql, params)).rows as R[], vault)
    if (readers.length > 0) {
      throw new Error(`${table} was not dropped, because other objects read it: ${describeReaders(readers)}. Remove or change them first, then drop ${table}.`)
    }
    return tableChecksum(client, vault, table)
  })

  change.preserved.push({ kind: 'table', table, vault, vaultTable: table, rows: kept.rows, checksum: kept.checksum })
  return { handled: true, rows: kept.rows, vault, seq: change.seq }
}

/**
 * Keep a column's values, then run the statement that destroys or rewrites
 * them, atomically.
 *
 * Values are keyed by the table's primary key so a restore can put each one
 * back on its own row. A table with no primary key has its whole rows copied
 * instead, which keeps the data but cannot be matched back automatically, and
 * the restore says so.
 *
 * A retype also records, beside each original value, the value the retype
 * produced, so a restore can leave alone the rows written since.
 */
export async function keepColumnValues(
  projectId: string,
  schema: string,
  table: string,
  column: string,
  reason: 'dropped' | 'retyped',
  destructiveSql: string,
): Promise<{ handled: false } | { handled: true; rows: number; vault: string; seq: number }> {
  const change = currentChange(projectId)
  if (!change) return { handled: false }
  const client = change.client
  const target = qualified(schema, table)
  const present = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid = to_regclass($1) AND attname = $2 AND attnum > 0 AND NOT attisdropped`,
    [target, column],
  )
  if (!present.rows[0]?.n) return { handled: false }
  const vault = await ensureVault(change)
  const vaultTable = uniqueVaultTable(change, reason === 'dropped' ? [table, column] : [table, column, 'before_retype'])

  const out = await inTransaction(client, async () => {
    await run(change, `LOCK TABLE ${target} IN ACCESS EXCLUSIVE MODE`)
    const keys = (await primaryKey(client, target)).filter((c) => c !== column)
    const select = keys.length > 0 ? [...keys, column].map(q).join(', ') : '*'
    await run(
      change,
      `CREATE TABLE ${qualified(vault, vaultTable)} AS SELECT ${select} FROM ${target} WHERE ${q(column)} IS NOT NULL`,
    )
    await run(change, destructiveSql)

    let afterColumn: string | undefined
    if (reason === 'retyped' && keys.length > 0) {
      // The value the retype produced, on the same row of the vault table.
      const type = await client.query<{ t: string }>(
        `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2 AND NOT attisdropped`,
        [target, column],
      )
      afterColumn = AFTER_COLUMN
      await run(change, `ALTER TABLE ${qualified(vault, vaultTable)} ADD COLUMN ${q(afterColumn)} ${type.rows[0].t}`)
      const match = keys.map((k) => `v.${q(k)} = t.${q(k)}`).join(' AND ')
      await run(
        change,
        `UPDATE ${qualified(vault, vaultTable)} AS v SET ${q(afterColumn)} = t.${q(column)} FROM ${target} AS t WHERE ${match}`,
      )
    }
    const sum = await tableChecksum(client, vault, vaultTable)
    return { keys, rows: sum.rows, checksum: sum.checksum, afterColumn }
  })

  change.preserved.push({
    kind: 'column',
    table,
    column,
    reason,
    keyColumns: out.keys,
    vault,
    vaultTable,
    rows: out.rows,
    checksum: out.checksum,
    ...(out.afterColumn ? { afterColumn: out.afterColumn } : {}),
  })
  return { handled: true, rows: out.rows, vault, seq: change.seq }
}

/** Something that runs a statement inside the caller's transaction (a Prisma interactive transaction). */
export interface TxRunner {
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>
  $queryRawUnsafe<T = unknown>(sql: string, ...params: unknown[]): Promise<T>
}

/**
 * The after-image of a data migration: the values it produced in each column it
 * rewrote, keyed by primary key, captured INSIDE the migration's transaction so
 * no write can land between the rewrite and the capture. The before-image is
 * the migration's own checkpoint table (`beforeTables`).
 *
 * Returns the entries to record, to be committed with `commit()` only once the
 * migration's transaction has: a rolled-back migration keeps nothing.
 */
export async function captureRewrite(
  tx: TxRunner,
  projectId: string,
  schema: string,
  rewrites: Array<{ table: string; columns: string[] }>,
  beforeTables: Record<string, string>,
): Promise<{ commit: () => void } | null> {
  const change = currentChange(projectId)
  if (!change || rewrites.length === 0) return null
  const vault = await ensureVault(change)
  const entries: PreservedEntry[] = []

  for (const { table, columns } of rewrites) {
    const target = qualified(schema, table)
    const keys = (
      await tx.$queryRawUnsafe<Array<{ col: string }>>(
        `SELECT a.attname AS col
           FROM pg_constraint con
           JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
           JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
          WHERE con.conrelid = $1::regclass AND con.contype = 'p'
          ORDER BY k.ord`,
        target,
      )
    ).map((r) => r.col)
    const cols = [...new Set(columns)].filter((c) => !keys.includes(c))
    if (keys.length === 0 || cols.length === 0) {
      // Nothing to key the images by. The restore says so rather than guessing.
      for (const column of cols) {
        entries.push({ kind: 'column', table, column, reason: 'rewritten', keyColumns: [], vault, vaultTable: '', rows: null })
      }
      continue
    }
    const vaultTable = uniqueVaultTable(change, [table, 'rewrite'], entries)
    const sql = `CREATE TABLE ${qualified(vault, vaultTable)} AS SELECT ${[...keys, ...cols].map(q).join(', ')} FROM ${target}`
    recordStatement(change, sql)
    await tx.$executeRawUnsafe(sql)
    const sum = await tx.$queryRawUnsafe<Array<{ n: string; h: string }>>(
      `SELECT count(*)::bigint AS n, coalesce(sum(hashtextextended(t::text, 0)::numeric), 0)::text AS h FROM ${qualified(vault, vaultTable)} t`,
    )
    for (const column of cols) {
      entries.push({
        kind: 'column',
        table,
        column,
        reason: 'rewritten',
        keyColumns: keys,
        vault,
        vaultTable,
        rows: Number(sum[0]?.n ?? 0),
        checksum: String(sum[0]?.h ?? '0'),
        afterColumn: column,
        ...(beforeTables[table] ? { beforeTable: beforeTables[table] } : {}),
      })
    }
  }
  return { commit: () => change.preserved.push(...entries) }
}

/**
 * The values a change filled into the columns it added, when their default is
 * not a constant (now(), gen_random_uuid(), an identity), keyed by primary key.
 *
 * A restore removes such a column, and has to say whether that sets aside data
 * written since the change. For a constant default it compares each value with
 * the default; for these there is nothing to compare with, so every value read
 * as possibly written since: the restore always needed a person, and an
 * automatic recovery of a change that added `seen_at timestamptz DEFAULT now()`
 * to a table with rows was never possible. With what the change filled in kept,
 * only the values that differ from it are writes since (lib/changes/impact.ts).
 *
 * Taken when the change closes, inside its lock, as the contents of the tables
 * a change creates are (resultDataFor). Bounded: a table estimated above
 * `maxRows` keeps nothing, and its restore asks a person as before.
 */
export async function keepFilledValues(
  change: OpenChange,
  before: CatalogSnapshot,
  after: CatalogSnapshot,
  footprint: TableChange[],
  maxRows = 100_000,
): Promise<void> {
  for (const c of footprint) {
    if (c.object || c.kind !== 'modified' || !c.before || !c.after) continue
    const B = before.tables[c.before]
    const A = after.tables[c.after]
    if (!A || !B) continue
    const key = columnKey(A.oid === B.oid)
    const had = new Set(B.columns.map(key))
    const pk = A.constraints.find((con) => con.type === 'p')?.columns ?? []
    if (pk.length === 0) continue
    const filled = A.columns.filter(
      (col) => !had.has(key(col)) && !col.generated && !pk.includes(col.name) && (!!col.identity || !isConstantDefault(col.default)),
    )
    if (filled.length === 0) continue
    const est = await change.client.query<{ n: string }>(
      `SELECT greatest(c.reltuples, 0)::bigint AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = $1 AND c.relname = $2`,
      [change.schema, A.name],
    )
    if (Number(est.rows[0]?.n ?? 0) > maxRows) continue
    const vault = await ensureVault(change)
    for (const col of filled) {
      const vaultTable = uniqueVaultTable(change, [A.name, col.name, 'filled'])
      await run(
        change,
        `CREATE TABLE ${qualified(vault, vaultTable)} AS SELECT ${pk.map(q).join(', ')}, ${q(col.name)} AS ${q(AFTER_COLUMN)} FROM ${qualified(change.schema, A.name)}`,
      )
      const sum = await tableChecksum(change.client, vault, vaultTable)
      change.preserved.push({
        kind: 'column', table: A.name, column: col.name, reason: 'filled', keyColumns: pk,
        vault, vaultTable, rows: sum.rows, checksum: sum.checksum, afterColumn: AFTER_COLUMN,
      })
    }
  }
}

function uniqueVaultTable(change: OpenChange, parts: string[], pending: PreservedEntry[] = []): string {
  const used = new Set([...change.preserved, ...pending].map((e) => e.vaultTable))
  let name = vaultTableName(...parts)
  for (let i = 2; used.has(name); i++) name = vaultTableName(...parts, String(i))
  return name
}
