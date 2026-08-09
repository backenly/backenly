/**
 * MIGRATION RESIDUE — what a migration that did not finish leaves behind
 * ======================================================================
 *
 * ── Why this is not "detect failed migrations" ─────────────────────────────
 *
 * A failed migration is not directly observable here, and it is worth being
 * precise about why rather than shipping something that pretends otherwise.
 * Backenly records external DDL through the `ddl_command_end` and `sql_drop`
 * event triggers in scripts/setup-direct-access.sql, and PostgreSQL fires both
 * of those only on SUCCESS. There is no `ddl_command_error` event to hook. A
 * statement that failed leaves no row in SchemaDriftEvent, no audit entry, and
 * nothing in any table the platform can read.
 *
 * What a half-finished migration DOES leave is residue, and the residue is
 * exactly detectable. Each shape below was reproduced against a real database
 * before it was written:
 *
 *   INVALID INDEX
 *     `CREATE INDEX CONCURRENTLY` that fails leaves the index in place with
 *     indisvalid = false. This is the worst of the three because it is
 *     completely silent: the index is maintained on every insert and update,
 *     the planner will never use it, and it appears in every listing exactly
 *     like a working index. Pure cost, invisible, potentially for years.
 *
 *   UNVALIDATED CONSTRAINT
 *     `ADD CONSTRAINT ... NOT VALID` is step one of the standard two-step
 *     playbook for adding a constraint without a long lock. Step two is
 *     `VALIDATE CONSTRAINT`. When step two never runs, the constraint is
 *     enforced for new rows and the existing rows were never checked — so the
 *     schema claims a guarantee the data has never been held to.
 *
 *   PREPARED TRANSACTION
 *     A two-phase commit left hanging by a crashed migration tool. It holds
 *     every lock it took and pins the vacuum horizon for the whole cluster,
 *     indefinitely, surviving restarts. The most damaging item here and the one
 *     Backenly must never resolve on its own — `ROLLBACK PREPARED` discards
 *     whatever that transaction was doing, and `COMMIT PREPARED` applies it.
 *
 * Read-only.
 */

import { Pool } from 'pg'
import { queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { probeQueryFailed } from '@/lib/core/drift-detector'
import { directAccessRoleNames } from '@/lib/services/direct-access'
import type { RawFinding } from '@/lib/core/types'

export type ResidueKind = 'invalid_index' | 'unvalidated_constraint' | 'prepared_transaction'

let pool: Pool | null = null
function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  return pool
}

/**
 * How long a prepared transaction may sit before it is a problem rather than a
 * transaction. Legitimate two-phase commit resolves in milliseconds; anything
 * still hanging after five minutes is abandoned.
 */
export const PREPARED_XACT_MIN_AGE_SECONDS = 300

export async function detectMigrationResidue(projectId: string): Promise<RawFinding[]> {
  const schema = `workspace_${projectId}`
  const findings: RawFinding[] = []

  // ── Invalid indexes ────────────────────────────────────────────────────────
  //
  // `indisready = false` as well as `indisvalid = false`: the two flags fail at
  // different phases of a concurrent build and both leave an unusable index.
  const invalid = await queryWorkspaceSchema(
    projectId,
    `SELECT i.relname                AS index_name,
            t.relname                AS table_name,
            pg_relation_size(i.oid)  AS size_bytes,
            ix.indisunique           AS is_unique,
            pg_get_indexdef(i.oid)   AS definition
       FROM pg_index ix
       JOIN pg_class i     ON i.oid = ix.indexrelid
       JOIN pg_class t     ON t.oid = ix.indrelid
       JOIN pg_namespace n ON n.oid = i.relnamespace
      WHERE n.nspname = $1
        AND (NOT ix.indisvalid OR NOT ix.indisready)`,
    schema,
  ).catch(probeQueryFailed('detectMigrationResidue/invalid-index'))

  for (const r of (invalid?.rows ?? invalid ?? []) as Array<{
    index_name: string; table_name: string; size_bytes: string | number
    is_unique: boolean; definition: string
  }>) {
    const bytes = Number(r.size_bytes) || 0
    findings.push({
      type: 'migration_residue',
      // Silent and permanent, and it looks healthy from every listing.
      severity: 'warning',
      autoFixable: false,
      details: {
        residueKind: 'invalid_index' satisfies ResidueKind,
        tableName: r.table_name,
        indexName: r.index_name,
        location: `${r.table_name}.${r.index_name}`,
        sizeBytes: bytes,
        definition: r.definition,
        reason:
          `Index "${r.index_name}" on "${r.table_name}" exists but is marked invalid, which means ` +
          `a CREATE INDEX CONCURRENTLY did not finish. PostgreSQL keeps maintaining it on every ` +
          `insert and update and will never use it to answer a query, so it is pure write cost — ` +
          `and it appears in every index listing looking exactly like a working index. Rebuilding ` +
          `it completes what was started` +
          (r.is_unique
            ? `, and will fail if the duplicate rows that stopped it the first time are still there.`
            : `.`),
      },
    })
  }

  // ── Constraints added NOT VALID and never validated ────────────────────────
  const unvalidated = await queryWorkspaceSchema(
    projectId,
    `SELECT c.conname      AS constraint_name,
            rel.relname    AS table_name,
            c.contype      AS constraint_type,
            pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class rel   ON rel.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = $1
        AND NOT c.convalidated
        AND c.contype IN ('f', 'c')`,
    schema,
  ).catch(probeQueryFailed('detectMigrationResidue/unvalidated-constraint'))

  for (const r of (unvalidated?.rows ?? unvalidated ?? []) as Array<{
    constraint_name: string; table_name: string; constraint_type: string; definition: string
  }>) {
    const what = r.constraint_type === 'f' ? 'foreign key' : 'check constraint'
    findings.push({
      type: 'migration_residue',
      severity: 'warning',
      autoFixable: false,
      details: {
        residueKind: 'unvalidated_constraint' satisfies ResidueKind,
        tableName: r.table_name,
        constraintName: r.constraint_name,
        location: `${r.table_name}.${r.constraint_name}`,
        definition: r.definition,
        reason:
          `The ${what} "${r.constraint_name}" on "${r.table_name}" was added NOT VALID and never ` +
          `validated. That is step one of the standard two-step way to add a constraint without a ` +
          `long lock, and step two never ran — so new rows are checked and the rows already in the ` +
          `table never were. The schema is claiming a guarantee the existing data has not been held ` +
          `to. Validating it scans the table and tells you immediately whether that guarantee is true.`,
      },
    })
  }

  // ── Abandoned prepared transactions ────────────────────────────────────────
  //
  // Read directly rather than through the workspace pool: pg_prepared_xacts is
  // cluster-wide and filtered by OWNER, which is what makes it attributable to
  // one project (the same per-project roles connection-health uses).
  try {
    const roles = directAccessRoleNames(projectId)
    const res = await getPool().query<{ gid: string; age_seconds: string; owner: string }>(
      `SELECT gid,
              owner,
              EXTRACT(EPOCH FROM (now() - prepared))::int::text AS age_seconds
         FROM pg_prepared_xacts
        WHERE database = current_database()
          AND owner = ANY($1::text[])
          AND EXTRACT(EPOCH FROM (now() - prepared)) >= $2`,
      [[roles.ro, roles.rw, roles.owner], PREPARED_XACT_MIN_AGE_SECONDS],
    )

    for (const r of res.rows) {
      const minutes = Math.max(1, Math.round(Number(r.age_seconds) / 60))
      findings.push({
        type: 'migration_residue',
        // The only one of the three that is actively getting worse every minute.
        severity: 'critical',
        autoFixable: false,
        details: {
          residueKind: 'prepared_transaction' satisfies ResidueKind,
          location: `prepared:${r.gid}`,
          gid: r.gid,
          owner: r.owner,
          ageMinutes: minutes,
          reason:
            `A prepared transaction ("${r.gid}") has been waiting to be committed or rolled back ` +
            `for ${minutes} minutes. This is almost always a migration tool that crashed partway ` +
            `through a two-phase commit. It still holds every lock it took and pins the vacuum ` +
            `horizon for the whole database — so dead rows cannot be reclaimed anywhere, and it ` +
            `survives a restart. Backenly will not resolve it: committing applies work you may not ` +
            `want and rolling back discards work you may.`,
        },
      })
    }
  } catch (err: any) {
    throw new Error(`[detectMigrationResidue/prepared-xact] probe failed: ${err?.message ?? String(err)}`)
  }

  return findings
}
