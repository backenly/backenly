/**
 * DUAL-WRITE — the trigger that keeps a new column in step with the old one
 * =========================================================================
 *
 * The expand rung of expand/contract. `add_structure` created the target
 * column; this keeps it equal to `transform(source)` for every write that
 * happens from now on, while `backfill` catches up the rows that already exist.
 *
 * It is the most dangerous step in the ladder and the tier reflects that:
 * `classifyMaintenanceStep` rates it Tier 2 regardless of capability, because a
 * trigger is not additive to BEHAVIOUR. It runs inside the caller's
 * transaction, on their write, on their latency budget.
 *
 * ── Three decisions, and why each is not the obvious one ────────────────────
 *
 * **BEFORE, not AFTER.** A BEFORE trigger assigns `NEW.target` and returns the
 * row, so the value lands in the same tuple the caller is already writing. The
 * AFTER form would need a second `UPDATE` of the row just written: another
 * write, another WAL record, another chance to deadlock with the statement that
 * triggered it, and re-entry into this trigger.
 *
 * **Not SECURITY DEFINER**, which is the opposite of what
 * `lib/services/derived-columns.ts` does, deliberately. That trigger updates a
 * DIFFERENT table and the inserting role usually may not write it, so it must
 * elevate. This one only sets a column on the row the caller is already writing,
 * so it needs no privilege the caller does not already hold — and taking one
 * anyway would mean every customer write briefly ran as the platform.
 *
 * **It swallows its own exceptions.** A transform that raises — a bad cast, a
 * value too long for the target — must not abort a write the customer's
 * application made. So the handler catches, records, and returns the row with
 * the target left unset.
 *
 * ── Which makes this module untrustworthy on its own ────────────────────────
 *
 * Swallowing converts a loud failure into a quiet one, and a trigger that
 * SUCCEEDS while writing a wrong value was never loud to begin with. The fault
 * counter here is telemetry: zero faults is the reading you get when everything
 * worked AND when the instrument is blind.
 *
 * `../reconcile.ts` is the proof, and it was built first for exactly this
 * reason. Nothing in this module may be read as evidence that the two columns
 * agree. Only reconciliation says that, and it recomputes the transform from
 * ./transform.ts — the same definition rendered here — so the checker and the
 * writer cannot drift.
 */

import { prisma } from '@/lib/db'
import { resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { executeInWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { transformLiteralSql, transformProblem, type Transform } from '../transform'

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Where swallowed trigger exceptions are counted. Telemetry, never proof. */
export const FAULT_TABLE = '_backenly_dual_write_faults'

export interface DualWriteSpec {
  projectId: string
  table: string
  sourceColumn: string
  targetColumn: string
  transform: Transform
}

export interface DualWriteResult {
  installed: boolean
  objectName: string
  /** Why it refused, when it did. Never null on a refusal. */
  refusal: string | null
  /** The function body as installed, so the ledger records what actually ran. */
  functionSql: string | null
}

/** Deterministic, collision-free trigger + function name for one dual-write. */
export function dualWriteObjectName(table: string, targetColumn: string): string {
  const base = `bkn_dw_${table}_${targetColumn}`
  return base.length <= 63 ? base : base.slice(0, 63)
}

interface ColumnFact { name: string; dataType: string }

async function readColumns(schema: string, table: string): Promise<ColumnFact[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`,
    schema,
    table,
  )
  return rows.map(r => ({ name: r.column_name, dataType: r.data_type }))
}

/**
 * The fault counter table.
 *
 * One row per trigger. Created on install rather than assumed, and its own
 * failure is not fatal: losing telemetry is not a reason to refuse a step whose
 * correctness is established by reconciliation anyway.
 */
function faultTableSql(schema: string): string {
  return `
CREATE TABLE IF NOT EXISTS "${schema}"."${FAULT_TABLE}" (
  object_name text PRIMARY KEY,
  faults      bigint      NOT NULL DEFAULT 0,
  last_error  text,
  last_at     timestamptz
);`.trim()
}

/**
 * The trigger function.
 *
 * The inner BEGIN/EXCEPTION around the counter write matters as much as the
 * outer one: if recording a fault could raise, the handler meant to protect the
 * caller's write would be the thing that aborted it.
 */
function functionSql(schema: string, objName: string, spec: DualWriteSpec): string {
  const assigned = transformLiteralSql(spec.transform, `NEW."${spec.sourceColumn}"`)
  return `
CREATE OR REPLACE FUNCTION "${schema}"."${objName}"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = "${schema}", pg_temp
AS $bkn$
BEGIN
  NEW."${spec.targetColumn}" := ${assigned};
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- The customer's write completes with the target left unset. Reconciliation
  -- is what notices; this only says the trigger knew it had failed.
  BEGIN
    INSERT INTO "${schema}"."${FAULT_TABLE}" AS f (object_name, faults, last_error, last_at)
    VALUES ('${objName}', 1, SQLERRM, now())
    ON CONFLICT (object_name) DO UPDATE
      SET faults = f.faults + 1, last_error = EXCLUDED.last_error, last_at = EXCLUDED.last_at;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$bkn$;`.trim()
}

/**
 * Install (or replace) the dual-write trigger.
 *
 * Every identifier is checked against the live catalog before any DDL runs. A
 * typo caught here is a refusal; the same typo caught by PostgreSQL is a trigger
 * that raises on every future write to a customer's table.
 */
export async function installDualWrite(spec: DualWriteSpec): Promise<DualWriteResult> {
  const { projectId, table, sourceColumn, targetColumn } = spec
  const objectName = dualWriteObjectName(table, targetColumn)
  const refuse = (refusal: string): DualWriteResult => ({ installed: false, objectName, refusal, functionSql: null })

  if (![table, sourceColumn, targetColumn].every(x => IDENT.test(x))) {
    return refuse('table or column name is not a valid identifier')
  }
  if (sourceColumn === targetColumn) {
    return refuse('source and target are the same column; a dual-write would write a column to itself')
  }
  const problem = transformProblem(spec.transform)
  if (problem) return refuse(problem)

  const schema = await resolveWorkspaceSchema(projectId)
  const columns = await readColumns(schema, table).catch(() => null)
  if (columns === null) return refuse('column catalog unreadable, so no identifier could be checked')
  if (columns.length === 0) return refuse(`table "${table}" does not exist in ${schema}`)

  const names = new Set(columns.map(c => c.name))
  for (const col of [sourceColumn, targetColumn]) {
    if (!names.has(col)) return refuse(`column "${col}" does not exist on ${table}`)
  }

  const sql = functionSql(schema, objectName, spec)
  try {
    // Telemetry is best-effort; the trigger's own handler tolerates its absence.
    await executeInWorkspaceSchema(projectId, faultTableSql(schema)).catch(() => {})
    await executeInWorkspaceSchema(projectId, sql)
    await executeInWorkspaceSchema(projectId, `DROP TRIGGER IF EXISTS "${objectName}" ON "${schema}"."${table}";`)
    await executeInWorkspaceSchema(
      projectId,
      `CREATE TRIGGER "${objectName}" BEFORE INSERT OR UPDATE ON "${schema}"."${table}" ` +
        `FOR EACH ROW EXECUTE FUNCTION "${schema}"."${objectName}"();`,
    )
  } catch (err) {
    return refuse(`installing the dual-write failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // CREATE TRIGGER reporting no error is not the same fact as the trigger being
  // in the catalog, and the difference is a column nothing is maintaining.
  if (!(await dualWriteInstalled(projectId, table, objectName))) {
    return refuse(
      `CREATE TRIGGER reported no error but "${objectName}" is not in the catalog, so nothing is ` +
        `maintaining ${table}.${targetColumn}`,
    )
  }

  return { installed: true, objectName, refusal: null, functionSql: sql }
}

/** Is the trigger actually there? Asked of pg_trigger, not of the DDL's silence. */
export async function dualWriteInstalled(projectId: string, table: string, objectName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
    `SELECT tgname FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND tg.tgname = $3 AND NOT tg.tgisinternal`,
    await resolveWorkspaceSchema(projectId),
    table,
    objectName,
  ).catch(() => [])
  return rows.length > 0
}

/**
 * Remove the dual-write, and confirm it is gone.
 *
 * This is the `revert_new_structure` rollback's first move. It drops only the
 * trigger and its function — never the target column, which `add_structure`
 * owns and rolls back separately.
 */
export async function removeDualWrite(
  projectId: string,
  table: string,
  targetColumn: string,
): Promise<{ removed: boolean; objectName: string; refusal: string | null }> {
  const objectName = dualWriteObjectName(table, targetColumn)
  if (![table, targetColumn].every(x => IDENT.test(x))) {
    return { removed: false, objectName, refusal: 'table or column name is not a valid identifier' }
  }
  const schema = await resolveWorkspaceSchema(projectId)
  try {
    await executeInWorkspaceSchema(projectId, `DROP TRIGGER IF EXISTS "${objectName}" ON "${schema}"."${table}";`)
    await executeInWorkspaceSchema(projectId, `DROP FUNCTION IF EXISTS "${schema}"."${objectName}"();`)
  } catch (err) {
    return { removed: false, objectName, refusal: `dropping the dual-write failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (await dualWriteInstalled(projectId, table, objectName)) {
    return { removed: false, objectName, refusal: `"${objectName}" is still in the catalog after DROP TRIGGER` }
  }
  return { removed: true, objectName, refusal: null }
}

export interface DualWriteFaults {
  objectName: string
  faults: number
  lastError: string | null
  lastAt: string | null
}

/**
 * Swallowed exceptions, if any were recorded.
 *
 * Read this as "what the trigger admitted to", never as a consistency verdict.
 * A dual-write writing the wrong value successfully reports zero here.
 */
export async function readDualWriteFaults(projectId: string, objectName: string): Promise<DualWriteFaults | null> {
  const schema = await resolveWorkspaceSchema(projectId)
  const rows = await prisma.$queryRawUnsafe<Array<{ object_name: string; faults: bigint; last_error: string | null; last_at: Date | null }>>(
    `SELECT object_name, faults, last_error, last_at FROM "${schema}"."${FAULT_TABLE}" WHERE object_name = $1`,
    objectName,
  ).catch(() => [])
  const row = rows[0]
  if (!row) return null
  return {
    objectName: row.object_name,
    faults: Number(row.faults),
    lastError: row.last_error,
    lastAt: row.last_at ? new Date(row.last_at).toISOString() : null,
  }
}
