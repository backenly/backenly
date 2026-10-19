/**
 * Identifiers for the change ledger, validated before they reach SQL.
 *
 * A change that destroys data does not destroy it: the table or the column's
 * values are moved into a VAULT, a schema of the change's own,
 * `workspace_<project>_r<seq>`. One schema per change rather than one per
 * project, because index, constraint and sequence names are scoped to a
 * schema: two archived versions of `orders` would both bring an `orders_pkey`
 * with them and the second move would fail.
 *
 * The vault shares the project's prefix (`workspace_<uuid>_`), so deleting a
 * project finds and drops it with the project's other schemas, and backups and
 * restores carry it. It is never registered with the data plane and no API role
 * is granted USAGE on it, so nothing in it is reachable over REST or a
 * direct-access connection (`isChangeVaultSchema` is how the code that walks
 * every workspace schema tells it apart). The backup role alone may read it,
 * so a deployment recovery bundle can dump it (`createVaultStatements`).
 */

import { createHash } from 'crypto'
import { assertValidProjectId, isChangeVaultSchema, quoteIdent } from '@/lib/security/workspace-schema'

/** The column in a vault table holding the value a change produced. */
export const AFTER_COLUMN = '__bkn_after'

/** PostgreSQL truncates identifiers beyond this many bytes. */
export const MAX_IDENT_BYTES = 63

export function vaultSchemaName(projectId: string, seq: number): string {
  assertValidProjectId(projectId)
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`Invalid change sequence: ${seq}`)
  // 10 + 36 + 2 + digits: a nine-digit sequence still leaves room under 63.
  return `workspace_${projectId}_r${seq}`
}

/** True for a schema that is one of this project's vaults. */
export function isVaultSchema(projectId: string, schema: string): boolean {
  assertValidProjectId(projectId)
  return isChangeVaultSchema(schema) && schema.startsWith(`workspace_${projectId}_r`)
}

/**
 * The statements that create a vault, readable by the backup role.
 *
 * A deployment recovery bundle dumps every `workspace_*` schema as the backup
 * role (lib/recovery/export.ts), which reads only what it was granted. Its
 * installer (scripts/setup-backup-role.ts) grants the schemas that existed when
 * it ran, and a vault is made later, by the change that needs it, so the next
 * bundle failed "permission denied for schema workspace_<id>_r<seq>".
 *
 * USAGE on the vault, and SELECT on what this role creates in it. A table moved
 * in keeps its own grants, so the vault is as readable as the schema it came
 * from. The role is named as backenly_direct_sync_schema names it
 * (scripts/setup-direct-access.sql), and an install without it gets no grant.
 */
export function createVaultStatements(vault: string): string[] {
  if (!isChangeVaultSchema(vault)) throw new Error(`Not a change vault: ${vault}`)
  const grant = (sql: string) => `EXECUTE format(${literal(sql)}, ${literal(vault)}, r);`
  return [
    `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(vault)}`,
    [
      `DO $$ DECLARE r text := coalesce(nullif(current_setting('backenly.backup_role', true), ''), 'backenly_backup');`,
      'BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN',
      grant('GRANT USAGE ON SCHEMA %I TO %I'),
      grant('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON TABLES TO %I'),
      grant('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT ON SEQUENCES TO %I'),
      'END IF; END $$',
    ].join(' '),
  ]
}

/**
 * A name inside a vault for the preserved values of one column, or a copy of a
 * table: readable when it fits, and still unique and under 63 bytes when it does
 * not. Uniqueness only has to hold within one vault, i.e. within one change.
 */
export function vaultTableName(...parts: string[]): string {
  const readable = parts.join('__')
  if (Buffer.byteLength(readable, 'utf8') <= MAX_IDENT_BYTES) return readable
  const hash = createHash('sha256').update(readable).digest('hex').slice(0, 8)
  const budget = Math.floor((MAX_IDENT_BYTES - hash.length - 1 - (parts.length - 1) * 2) / parts.length)
  const clipped = parts.map((p) => truncateBytes(p, Math.max(1, budget)))
  return `${clipped.join('__')}_${hash}`
}

function truncateBytes(s: string, maxBytes: number): string {
  let out = ''
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break
    out += ch
  }
  return out
}

/** `"schema"."name"`, each part quoted. */
export function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`
}

export { quoteIdent }

/** A string literal for SQL, for the places a value cannot be bound. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}
