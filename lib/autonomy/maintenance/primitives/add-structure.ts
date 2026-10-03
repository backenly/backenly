/**
 * ADD_STRUCTURE — exactly one column, and nothing that was not approved
 * =====================================================================
 *
 * The maintenance ladder's Tier-1 rung. It adds one nullable column. It is
 * classified "additive, snapshotted, and reversible by dropping what was added",
 * and this module exists because the generic executor could not honour that.
 *
 * ── What the first production run found ────────────────────────────────────
 *
 * `executeAction('ADD_COLUMN', …, allowReplan = false)` disables REPLANNING but
 * not DEPENDENCY EXPANSION. `resolveDependencies` in `lib/ai/minimal-executor.ts`
 * prepends a `CREATE_TABLE` whenever no `Table` METADATA row exists for the
 * named table:
 *
 *     if (!table) {
 *       console.log(`🤖 [Auto-Repair] Table "${tableName}" missing - adding CREATE_TABLE`)
 *       actions.push({ action: 'CREATE_TABLE', params: { tableName, columns: [] } })
 *     }
 *
 * On 2026-09-16 that recreated a production table and destroyed its 80 rows
 * while reporting `✅ Added "lifecycle_state"`. An approved mutation of "add one
 * nullable column" had expanded into "create the table first", which is a
 * different blast radius, different rollback semantics and a different approved
 * action set.
 *
 * ── The catalog is the source of truth, so a missing metadata row is not a
 *    missing table ────────────────────────────────────────────────────────────
 *
 * That is the whole confusion above. DDL arrives on this platform from psql and
 * from connection strings handed to project owners, so a table can exist and be
 * perfectly valid while the platform's `Table` row does not describe it. The
 * right response is to ADOPT it — which is a metadata concern with its own
 * consequences — never to overwrite it.
 *
 * So this module reads the live catalog first and refuses the disagreement
 * rather than resolving it:
 *
 *   physical table missing                    REFUSE
 *   physical present, metadata absent         REFUSE, "adopt/repair first"
 *   target column already present             REFUSE
 *
 * ── It proves no expansion happened, rather than trusting a flag ───────────
 *
 * The table's `oid` is captured before and compared after. A recreated table
 * gets a new one, so a `CREATE_TABLE` that slipped through is caught by the
 * catalog rather than by reading the executor's intentions. The row count is
 * carried the same way, because that is what was actually lost.
 */

import { prisma } from '@/lib/db'
import { queryWorkspaceAsOwner, resolveWorkspaceSchema } from '@/lib/services/workspace-pool'

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Column types this rung may add. Closed: the ladder adds state columns. */
export const ALLOWED_COLUMN_TYPES = ['text', 'boolean', 'integer', 'bigint', 'timestamptz', 'uuid', 'jsonb'] as const
export type AllowedColumnType = (typeof ALLOWED_COLUMN_TYPES)[number]

export interface AddStructureSpec {
  projectId: string
  table: string
  column: string
  columnType: string
}

export interface AddStructureResult {
  added: boolean
  refusal: string | null
  /** What the catalog said afterwards. Null when nothing was added. */
  observed: { column: string; dataType: string; isNullable: boolean } | null
  /** Proof the table was not recreated underneath the rung. */
  identity: { oidBefore: string; oidAfter: string | null; rowsBefore: number; rowsAfter: number | null } | null
}

interface TableFacts {
  oid: string
  rows: number
}

async function liveTable(projectId: string, schema: string, table: string): Promise<TableFacts | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ oid: string }>>(
    `SELECT c.oid::text AS oid FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
    schema,
    table,
  ).catch(() => [])
  if (rows.length === 0) return null

  // AS OWNER. This count is half of the proof that the table was not recreated,
  // and the product enables RLS on every table it creates — so an unclaimed
  // read returned 0 on a full table and the check compared 0 before with 0
  // after, agreeing every time. Production reported "0 row(s) preserved" for a
  // table holding 80, which is the reading a destroyed table would also give.
  //
  // The oid comparison still carries the other half, and it is the half that
  // caught the real incident. Both now measure something.
  const counted = await queryWorkspaceAsOwner<{ n: bigint }>(
    projectId,
    `SELECT count(*)::bigint AS n FROM "${schema}"."${table}"`,
  ).catch(() => [{ n: BigInt(-1) }])
  return { oid: rows[0].oid, rows: Number(counted[0]?.n ?? -1) }
}

async function liveColumn(
  schema: string,
  table: string,
  column: string,
): Promise<{ dataType: string; isNullable: boolean } | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ data_type: string; is_nullable: string }>>(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
    schema,
    table,
    column,
  ).catch(() => [])
  if (rows.length === 0) return null
  return { dataType: rows[0].data_type, isNullable: rows[0].is_nullable === 'YES' }
}

/**
 * Add exactly one column, or refuse.
 *
 * Every refusal happens before the mutation. The only thing after it is
 * verification, and verification that fails is reported as a failure of the
 * rung rather than quietly accepted.
 */
export async function executeMaintenanceAddStructure(spec: AddStructureSpec): Promise<AddStructureResult> {
  const { projectId, table, column, columnType } = spec
  const refuse = (refusal: string): AddStructureResult => ({ added: false, refusal, observed: null, identity: null })

  if (![table, column].every(x => IDENT.test(x))) return refuse('table or column name is not a valid identifier')
  if (!(ALLOWED_COLUMN_TYPES as readonly string[]).includes(columnType)) {
    return refuse(`column type "${columnType}" is not in the allowed set (${ALLOWED_COLUMN_TYPES.join(', ')})`)
  }

  const schema = await resolveWorkspaceSchema(projectId)

  // 1. The live catalog decides whether the table exists.
  const before = await liveTable(projectId, schema, table)
  if (!before) return refuse(`table "${table}" does not exist in ${schema}`)

  // 2. The target must be absent — that is this rung's precondition, and it is
  //    also what makes it reversible by dropping what it added.
  if (await liveColumn(schema, table, column)) {
    return refuse(`column "${column}" already exists on ${table}; add_structure requires the target to be absent`)
  }

  // 3. Metadata must agree enough to operate. A missing `Table` row is exactly
  //    the condition that makes the generic executor prepend a CREATE_TABLE, so
  //    refusing here is what prevents the expansion — not a flag, a precondition.
  const metadata = await prisma.table
    .findFirst({ where: { projectId, name: table }, select: { id: true } })
    .catch(() => null)
  if (!metadata) {
    return refuse(
      `metadata/catalog disagreement: "${table}" exists in ${schema} but the platform has no Table row for it. ` +
        'The catalog is the source of truth, so this table must be adopted or its metadata repaired first. ' +
        'This rung will not create or recreate it.',
    )
  }

  // 4. Exactly one action. Replanning off, and the dependency expansion that
  //    replanning does not cover has been made impossible by step 3.
  const { executeAction } = await import('@/lib/ai/minimal-executor')
  const result = await executeAction(
    { action: 'ADD_COLUMN', params: { tableName: table, columnName: column, columnType } } as never,
    projectId,
    undefined,
    0,
    undefined,
    false,
  )

  // 5. Read back from the catalog. `success` is the executor's opinion; the
  //    column's existence is a fact.
  const after = await liveTable(projectId, schema, table)
  const seen = await liveColumn(schema, table, column)
  const observed = seen ? { column, ...seen } : null
  const identity = {
    oidBefore: before.oid,
    oidAfter: after?.oid ?? null,
    rowsBefore: before.rows,
    rowsAfter: after?.rows ?? null,
  }

  // 6. The table must be the SAME table. A recreate gets a new oid, so this
  //    catches an expansion that slipped past every check above.
  if (!after) {
    return { added: false, refusal: `table "${table}" is gone after ADD_COLUMN`, observed: null, identity }
  }
  if (after.oid !== before.oid) {
    return {
      added: false,
      refusal:
        `the table was RECREATED: oid ${before.oid} became ${after.oid}. An approved "add one column" ` +
        'expanded into something else, and rows may have been lost.',
      observed,
      identity,
    }
  }
  if (after.rows !== before.rows) {
    return {
      added: false,
      refusal: `row count changed from ${before.rows} to ${after.rows}; adding a column must not touch rows`,
      observed,
      identity,
    }
  }
  if (!observed) {
    return {
      added: false,
      refusal: `ADD_COLUMN reported "${result.message}" but "${column}" is not in the catalog`,
      observed: null,
      identity,
    }
  }
  if (!observed.isNullable) {
    return {
      added: false,
      refusal: `"${column}" was added NOT NULL; the ladder adds nullable columns so the rung stays reversible`,
      observed,
      identity,
    }
  }

  return { added: true, refusal: null, observed, identity }
}
