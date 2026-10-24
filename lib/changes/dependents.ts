/**
 * Live objects that read something kept in a vault.
 *
 * Moving a table into a vault (`ALTER TABLE … SET SCHEMA`) takes its indexes,
 * constraints, triggers, policies and owned sequences with it, but not what
 * other objects built on it: a view over it, a policy on another table whose
 * expression reads it, a default on another table that draws from its sequence,
 * a function whose body names it. PostgreSQL tracks those by oid, so they follow
 * the table into the vault and go on working against it: the view keeps
 * serving rows that left the application, the policy keeps deciding access
 * from rows nobody can change any more. And when the vault is purged, the
 * `DROP SCHEMA … CASCADE` takes each of them with it, in the live schema,
 * weeks later and with no record.
 *
 * So a vault must never be read from outside. A table moves into one only if
 * nothing outside it reads the table (lib/changes/preserve.ts, and the restore
 * proves it inside its own transaction, lib/changes/recovery.ts), and a vault
 * that something outside does read is not purged (lib/changes/retention.ts).
 */

import { isChangeVaultSchema } from '@/lib/security/workspace-schema'

export interface VaultReader {
  /** The object outside the vault, as a person would name it: "view order_totals". */
  dependent: string
  /** What it reads in the vault: "table orders". */
  reads: string
  /** The table or view the dependent belongs to (or the function itself), unqualified. */
  owner: string | null
}

/** Runs one parameterised query and returns its rows. */
export type DependentsQuery = <R>(sql: string, params: unknown[]) => Promise<R[]>

/**
 * Every dependency PostgreSQL records from an object outside `vault` onto one
 * inside it. Normal and automatic dependencies only: the internal ones (a
 * table's row type, its toast table) live and move with the table.
 */
const READERS_SQL = `
WITH v AS (SELECT oid FROM pg_namespace WHERE nspname = $1),
inside AS (
  SELECT 'pg_class'::regclass AS classid, c.oid AS objid FROM pg_class c JOIN v ON c.relnamespace = v.oid
  UNION ALL SELECT 'pg_type'::regclass, t.oid FROM pg_type t JOIN v ON t.typnamespace = v.oid
  UNION ALL SELECT 'pg_proc'::regclass, p.oid FROM pg_proc p JOIN v ON p.pronamespace = v.oid
),
deps AS (
  SELECT d.classid, d.objid, d.objsubid, d.refclassid, d.refobjid,
    CASE d.classid
      WHEN 'pg_class'::regclass THEN (SELECT c.relnamespace FROM pg_class c WHERE c.oid = d.objid)
      WHEN 'pg_rewrite'::regclass THEN (SELECT c.relnamespace FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE r.oid = d.objid)
      WHEN 'pg_policy'::regclass THEN (SELECT c.relnamespace FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE p.oid = d.objid)
      WHEN 'pg_attrdef'::regclass THEN (SELECT c.relnamespace FROM pg_attrdef a JOIN pg_class c ON c.oid = a.adrelid WHERE a.oid = d.objid)
      WHEN 'pg_constraint'::regclass THEN (SELECT k.connamespace FROM pg_constraint k WHERE k.oid = d.objid)
      WHEN 'pg_trigger'::regclass THEN (SELECT c.relnamespace FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.oid = d.objid)
      WHEN 'pg_proc'::regclass THEN (SELECT p.pronamespace FROM pg_proc p WHERE p.oid = d.objid)
      WHEN 'pg_type'::regclass THEN (SELECT t.typnamespace FROM pg_type t WHERE t.oid = d.objid)
    END AS ns,
    CASE d.classid
      WHEN 'pg_class'::regclass THEN (SELECT c.relname::text FROM pg_class c WHERE c.oid = d.objid)
      WHEN 'pg_rewrite'::regclass THEN (SELECT c.relname::text FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class WHERE r.oid = d.objid)
      WHEN 'pg_policy'::regclass THEN (SELECT c.relname::text FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE p.oid = d.objid)
      WHEN 'pg_attrdef'::regclass THEN (SELECT c.relname::text FROM pg_attrdef a JOIN pg_class c ON c.oid = a.adrelid WHERE a.oid = d.objid)
      WHEN 'pg_constraint'::regclass THEN (SELECT c.relname::text FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE k.oid = d.objid)
      WHEN 'pg_trigger'::regclass THEN (SELECT c.relname::text FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.oid = d.objid)
      WHEN 'pg_proc'::regclass THEN (SELECT p.proname::text FROM pg_proc p WHERE p.oid = d.objid)
      WHEN 'pg_type'::regclass THEN (SELECT t.typname::text FROM pg_type t WHERE t.oid = d.objid)
    END AS owner
  FROM pg_depend d
  JOIN inside i ON i.classid = d.refclassid AND i.objid = d.refobjid
  WHERE d.deptype IN ('n', 'a')
)
SELECT DISTINCT
  pg_describe_object(deps.classid, deps.objid, deps.objsubid) AS dependent,
  pg_describe_object(deps.refclassid, deps.refobjid, 0) AS reads,
  deps.owner
FROM deps JOIN v ON deps.ns IS NOT NULL AND deps.ns <> v.oid
ORDER BY 1, 2
`

/** Drop schema qualification ("workspace_<id>"."orders" → orders) and the view rule's own name. */
function plain(text: string): string {
  return text
    .replace(/"?workspace_[0-9a-f-]{36}(?:_r\d+|_pre[0-9a-f]+)?"?\./gi, '')
    .replace(/^rule _RETURN on (materialized view|view) /, '$1 ')
}

export async function vaultReaders(query: DependentsQuery, vault: string): Promise<VaultReader[]> {
  if (!isChangeVaultSchema(vault)) throw new Error(`Not a change vault: ${vault}`)
  return schemaReaders(query, vault)
}

/**
 * The same for any schema about to be dropped with CASCADE: a snapshot
 * restore's copy of the schema it replaced (lib/services/workspace-backup.ts),
 * whose types a vault's kept columns can still use.
 */
export async function schemaReaders(query: DependentsQuery, schema: string): Promise<VaultReader[]> {
  const rows = await query<{ dependent: string; reads: string; owner: string | null }>(READERS_SQL, [schema])
  return rows.map((r) => ({ dependent: plain(r.dependent), reads: plain(r.reads), owner: r.owner }))
}

/** One sentence per reader: "view order_totals reads table orders". */
export function describeReaders(readers: VaultReader[]): string {
  return readers.map((r) => `${r.dependent} reads ${r.reads}`).join('; ')
}
