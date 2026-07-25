/**
 * DERIVED COLUMNS — "keep column X in sync with related rows"
 * ==========================================================
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * `conversations.last_message_at` is the canonical example. There is no
 * `CREATE TRIGGER` on this platform (structure mutates only through governed
 * actions), and `generate_function { trigger: 'on_insert' }` is a whole
 * serverless function — deployed code, an invocation quota, cold starts — for a
 * one-line derived value. So the only available answer was "do it from the
 * client after each insert": two round trips, and the value silently drifts
 * forever the moment the second one fails.
 *
 * Reported as a real cost: a client maintaining `last_message_at` by hand, aware
 * that it drifts, with no primitive to reach for.
 *
 * ── Why this is safe without a raw-SQL door ─────────────────────────────────
 *
 * Nothing here takes SQL from the caller. The trigger body is generated from a
 * CLOSED SET of aggregate shapes (latest / count / sum / max / min) over
 * validated identifiers that must exist in the catalog. That is the same trade
 * the rest of the platform makes: full capability through a governed vocabulary,
 * rather than an escape hatch that cannot be reasoned about.
 *
 * ── Why the trigger is SECURITY DEFINER ─────────────────────────────────────
 *
 * The role inserting a message is generally NOT allowed to UPDATE the parent
 * conversation — that is the point of row-level security. A derived column has to
 * be written by the platform, not by the caller, so the function runs as its
 * owner and sets the service-role claim for the duration of its own statement.
 * Without that, every message insert on an RLS-protected parent would either fail
 * or silently update zero rows, which is the same drift with extra steps.
 *
 * The claim is RESTORED afterwards (`set_config(..., is_local => true)` scopes it
 * to the transaction, and the previous value is put back explicitly), so a
 * trigger can never leave a session elevated.
 */

import { prisma } from '@/lib/db'
import { executeInWorkspaceSchema } from './workspaceDatabase'
import { jwtClaimFunctionSql, SERVICE_ROLE } from '@/lib/postgrest/rls-translation'
import { SAFE_IDENT } from '@/lib/db/sql-expression'

/** The aggregate shapes a derived column may take. Closed set, by design. */
export type DerivedCompute = 'latest' | 'count' | 'sum' | 'max' | 'min'

export const DERIVED_COMPUTES: DerivedCompute[] = ['latest', 'count', 'sum', 'max', 'min']

export interface DerivedColumnSpec {
  /** The CHILD table whose writes drive the value, e.g. "messages". */
  sourceTable: string
  /** The PARENT table holding the derived column, e.g. "conversations". */
  targetTable: string
  /** The derived column on the parent, e.g. "last_message_at". */
  targetColumn: string
  /** FK column on the child pointing at the parent's id, e.g. "conversation_id". */
  via: string
  compute: DerivedCompute
  /**
   * Child column being aggregated. Required for latest/sum/max/min; ignored (and
   * refused if given) for `count`, which aggregates rows rather than a value.
   */
  sourceColumn?: string
}

export interface DerivedColumnResult {
  success: boolean
  message: string
  /** Rows back-filled on install, so "it works" is a number and not a claim. */
  backfilled?: number
}

/** Deterministic, collision-free trigger + function name for one derived column. */
export function derivedObjectName(targetTable: string, targetColumn: string): string {
  const base = `bkn_sync_${targetTable}_${targetColumn}`
  return base.length <= 63 ? base : base.slice(0, 63)
}

interface ColumnFact {
  name: string
  dataType: string
  isNullable: boolean
}

async function readColumns(schemaName: string, tableName: string): Promise<ColumnFact[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string; is_nullable: string }>>(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`,
    schemaName,
    tableName,
  )
  return rows.map((r) => ({
    name: r.column_name,
    dataType: r.data_type,
    isNullable: r.is_nullable === 'YES',
  }))
}

/**
 * Install (or replace) a derived column.
 *
 * Every identifier is checked against the LIVE catalog before any DDL runs, so a
 * typo is a clean refusal naming the real columns rather than a trigger that
 * errors on every future insert — a failure mode that would break writes to the
 * child table for a feature nobody asked to be load-bearing.
 */
export async function applyDerivedColumn(
  projectId: string,
  spec: DerivedColumnSpec,
): Promise<DerivedColumnResult> {
  const schemaName = `workspace_${projectId}`
  const { sourceTable, targetTable, targetColumn, via, compute } = spec
  const sourceColumn = spec.sourceColumn

  for (const [label, ident] of [
    ['sourceTable', sourceTable],
    ['targetTable', targetTable],
    ['targetColumn', targetColumn],
    ['via', via],
    ...(sourceColumn ? ([['sourceColumn', sourceColumn]] as const) : []),
  ] as Array<[string, string]>) {
    if (!ident || !SAFE_IDENT.test(ident)) {
      return { success: false, message: `${label} "${ident}" is not a valid PostgreSQL identifier.` }
    }
  }

  if (!DERIVED_COMPUTES.includes(compute)) {
    return {
      success: false,
      message:
        `Unknown compute "${compute}". Available: ${DERIVED_COMPUTES.join(', ')}. ` +
        `"latest" copies the newest child value; "count" counts child rows; ` +
        `"sum"/"max"/"min" aggregate a child column.`,
    }
  }

  if (compute === 'count') {
    if (sourceColumn) {
      return {
        success: false,
        message:
          `compute "count" counts child ROWS, so it takes no sourceColumn (got "${sourceColumn}"). ` +
          `Drop sourceColumn, or use "sum" if you meant to total a value.`,
      }
    }
  } else if (!sourceColumn) {
    return {
      success: false,
      message:
        `compute "${compute}" needs a sourceColumn — the column on "${sourceTable}" to aggregate. ` +
        `For example { compute: "latest", sourceColumn: "created_at" }.`,
    }
  }

  // ── Verify against the catalog BEFORE writing DDL ──────────────────────────
  const [sourceCols, targetCols] = await Promise.all([
    readColumns(schemaName, sourceTable).catch(() => [] as ColumnFact[]),
    readColumns(schemaName, targetTable).catch(() => [] as ColumnFact[]),
  ])

  if (sourceCols.length === 0) {
    return { success: false, message: `Table "${sourceTable}" does not exist in this project.` }
  }
  if (targetCols.length === 0) {
    return { success: false, message: `Table "${targetTable}" does not exist in this project.` }
  }

  const findIn = (cols: ColumnFact[], name: string) =>
    cols.find((c) => c.name.toLowerCase() === name.toLowerCase())

  const viaCol = findIn(sourceCols, via)
  if (!viaCol) {
    return {
      success: false,
      message:
        `"${sourceTable}" has no column "${via}" to link it to "${targetTable}". ` +
        `Columns on ${sourceTable}: ${sourceCols.map((c) => c.name).join(', ')}.`,
    }
  }
  const derived = findIn(targetCols, targetColumn)
  if (!derived) {
    return {
      success: false,
      message:
        `"${targetTable}" has no column "${targetColumn}" to keep in sync. Add it first ` +
        `(apply_migration: ALTER TABLE ${targetTable} ADD COLUMN ${targetColumn} ` +
        `${compute === 'count' ? 'integer NOT NULL DEFAULT 0' : 'timestamptz'}), then set up the sync. ` +
        `Columns on ${targetTable}: ${targetCols.map((c) => c.name).join(', ')}.`,
    }
  }
  if (sourceColumn && !findIn(sourceCols, sourceColumn)) {
    return {
      success: false,
      message:
        `"${sourceTable}" has no column "${sourceColumn}" to aggregate. ` +
        `Columns on ${sourceTable}: ${sourceCols.map((c) => c.name).join(', ')}.`,
    }
  }

  // A NOT NULL derived column with no default cannot be maintained: an aggregate
  // over zero child rows is NULL (or 0 for count), and the UPDATE would fail.
  if (compute !== 'count' && !derived.isNullable) {
    return {
      success: false,
      message:
        `"${targetTable}"."${targetColumn}" is NOT NULL, but a "${compute}" over zero child rows is NULL — ` +
        `the sync would fail for every parent that has no ${sourceTable} yet. Make the column nullable ` +
        `(apply_migration: ALTER TABLE ${targetTable} ALTER COLUMN ${targetColumn} DROP NOT NULL), or use ` +
        `compute "count", which is 0 rather than NULL when there are no rows.`,
    }
  }

  const objName = derivedObjectName(targetTable, targetColumn)
  const fq = (t: string) => `"${schemaName}"."${t}"`

  // The aggregate expression. Generated from the closed set above — never from
  // caller-supplied SQL.
  const aggregate =
    compute === 'count'
      ? `count(*)`
      : compute === 'latest'
        ? `max("${sourceColumn}")`
        : `${compute}("${sourceColumn}")`
  // `count` has a natural zero; the others are genuinely unknown with no rows.
  const emptyValue = compute === 'count' ? '0' : 'NULL'

  try {
    await executeInWorkspaceSchema(projectId, jwtClaimFunctionSql(schemaName))

    // ── The recompute function ───────────────────────────────────────────────
    //
    // It recomputes from the child rows rather than incrementing, which is the
    // difference between a value that is correct and one that is merely usually
    // correct: an incremental counter drifts on any UPDATE that moves a row
    // between parents, on any DELETE the trigger missed, and on any backfill.
    // Recomputing is O(children of one parent) against the FK index.
    const fnSql = `
CREATE OR REPLACE FUNCTION "${schemaName}"."${objName}"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = "${schemaName}", pg_temp
AS $bkn$
DECLARE
  prev_claims text := current_setting('request.jwt.claims', true);
  parent_ids  text[];
  parent_id   text;
BEGIN
  -- Write as the platform, not as the caller: the role inserting a child row is
  -- generally not permitted to UPDATE the parent, and must not be.
  PERFORM set_config('request.jwt.claims', '{"role":"${SERVICE_ROLE}"}', true);

  -- Both sides of the row, de-duplicated. An UPDATE that MOVES a child between
  -- parents has to fix the old parent as well as the new one; an UPDATE that
  -- leaves it in place yields one id, not two.
  parent_ids := ARRAY(
    SELECT DISTINCT x FROM unnest(array_remove(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN (OLD."${via}")::text END,
      CASE WHEN TG_OP <> 'DELETE' THEN (NEW."${via}")::text END
    ], NULL)) AS x
  );

  FOREACH parent_id IN ARRAY parent_ids
  LOOP
    UPDATE ${fq(targetTable)} t
       SET "${targetColumn}" = COALESCE(
             (SELECT ${aggregate} FROM ${fq(sourceTable)} s WHERE (s."${via}")::text = parent_id),
             ${emptyValue}
           )
     WHERE (t."id")::text = parent_id;
  END LOOP;

  PERFORM set_config('request.jwt.claims', COALESCE(prev_claims, ''), true);
  RETURN NULL;
END;
$bkn$;
`.trim()

    await executeInWorkspaceSchema(projectId, fnSql)

    // AFTER, and STATEMENT-agnostic per row: the value must reflect committed
    // child rows, and an UPDATE that moves a row between parents has to fix BOTH.
    await executeInWorkspaceSchema(
      projectId,
      `DROP TRIGGER IF EXISTS "${objName}" ON ${fq(sourceTable)};`,
    )
    await executeInWorkspaceSchema(
      projectId,
      `CREATE TRIGGER "${objName}" AFTER INSERT OR UPDATE OR DELETE ON ${fq(sourceTable)} ` +
      `FOR EACH ROW EXECUTE FUNCTION "${schemaName}"."${objName}"();`,
    )

    // ── Back-fill, and COUNT it ──────────────────────────────────────────────
    //
    // A sync that only applies to future writes leaves every existing parent
    // wrong, which reads as "the feature does not work". The row count is
    // returned so the result is evidence rather than an assurance.
    const backfilled = await prisma.$executeRawUnsafe(
      `UPDATE ${fq(targetTable)} t
          SET "${targetColumn}" = COALESCE(
                (SELECT ${aggregate} FROM ${fq(sourceTable)} s WHERE (s."${via}")::text = (t."id")::text),
                ${emptyValue}
              )`,
    )

    // ── Verify the trigger is actually in the catalog ────────────────────────
    const installed = await prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
      `SELECT tgname FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND tg.tgname = $3 AND NOT tg.tgisinternal`,
      schemaName,
      sourceTable,
      objName,
    )
    if (installed.length === 0) {
      return {
        success: false,
        message:
          `CREATE TRIGGER reported no error but "${objName}" is not in the catalog, so the sync is NOT ` +
          `active. Nothing is maintaining ${targetTable}.${targetColumn}.`,
      }
    }

    const described =
      compute === 'count'
        ? `the number of ${sourceTable} rows`
        : compute === 'latest'
          ? `the newest ${sourceTable}.${sourceColumn}`
          : `the ${compute} of ${sourceTable}.${sourceColumn}`

    return {
      success: true,
      backfilled: Number(backfilled ?? 0),
      message:
        `${targetTable}.${targetColumn} now tracks ${described} for each parent, linked by ` +
        `${sourceTable}.${via}. Maintained by a database trigger on every INSERT, UPDATE and DELETE — ` +
        `no client round trip, and it cannot drift. Back-filled ${Number(backfilled ?? 0)} existing ` +
        `${targetTable} row(s).`,
    }
  } catch (err: any) {
    // Leave nothing half-installed: a trigger whose function is broken would
    // fail every future write to the child table.
    try {
      await executeInWorkspaceSchema(
        projectId,
        `DROP TRIGGER IF EXISTS "${objName}" ON ${fq(sourceTable)};`,
      )
      await executeInWorkspaceSchema(projectId, `DROP FUNCTION IF EXISTS "${schemaName}"."${objName}"();`)
    } catch {
      /* best effort */
    }
    return {
      success: false,
      message:
        `${targetTable}.${targetColumn} was NOT set up, and the partial trigger was removed so writes to ` +
        `${sourceTable} keep working. PostgreSQL rejected it: ${err?.message}. Check that ` +
        `${targetTable}.${targetColumn} can hold ${compute === 'count' ? 'an integer' : 'the aggregated type'}.`,
    }
  }
}

/** Remove a derived column's trigger and function. Leaves the column itself. */
export async function removeDerivedColumn(
  projectId: string,
  targetTable: string,
  targetColumn: string,
  sourceTable: string,
): Promise<DerivedColumnResult> {
  const schemaName = `workspace_${projectId}`
  const objName = derivedObjectName(targetTable, targetColumn)
  try {
    await executeInWorkspaceSchema(
      projectId,
      `DROP TRIGGER IF EXISTS "${objName}" ON "${schemaName}"."${sourceTable}";`,
    )
    await executeInWorkspaceSchema(projectId, `DROP FUNCTION IF EXISTS "${schemaName}"."${objName}"();`)
    return {
      success: true,
      message:
        `Stopped maintaining ${targetTable}.${targetColumn}. The column and its current values are ` +
        `untouched — they will simply stop updating.`,
    }
  } catch (err: any) {
    return { success: false, message: `Could not remove the sync: ${err?.message}` }
  }
}

/** Every derived column currently maintained in this project. */
export async function listDerivedColumns(
  projectId: string,
): Promise<Array<{ sourceTable: string; triggerName: string }>> {
  const schemaName = `workspace_${projectId}`
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ tgname: string; relname: string }>>(
      `SELECT tg.tgname, c.relname
         FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND NOT tg.tgisinternal AND tg.tgname LIKE 'bkn\\_sync\\_%'
        ORDER BY tg.tgname`,
      schemaName,
    )
    return rows.map((r) => ({ sourceTable: r.relname, triggerName: r.tgname }))
  } catch {
    return []
  }
}
