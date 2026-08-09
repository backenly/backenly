/**
 * Intent conformance — does the backend match what was ASKED for?
 *
 * WHY THIS EXISTS
 * ---------------
 * The autonomy loop checks infrastructure invariants: missing RLS, missing
 * foreign keys, missing indexes. Those all share a property — they can be
 * evaluated from the live catalog alone, because "correct" is defined by the
 * catalog itself.
 *
 * Type correctness is not like that. A column that is `integer` looks perfectly
 * healthy from the catalog. Nothing distinguishes it from a column that was
 * *supposed* to be `integer`. So when `{ name: "start_date", type: "timestamp" }`
 * was created as INTEGER in May, every probe stayed green for two months while
 * the loop ran continuously. The information needed to notice was not missing
 * from the database — it was never written down.
 *
 * This module closes that gap: `recordSchemaIntent` writes what was requested,
 * `checkIntentConformance` compares it against the live catalog. A senior
 * engineer notices "you asked for a date and got an integer" immediately;
 * this is the mechanism that lets the loop do the same.
 *
 * DESIGN RULE
 * -----------
 * Intent is recorded from the REQUEST, never reconciled from the catalog. A
 * ledger that self-heals to match reality agrees with reality by construction
 * and can never detect drift — the same failure as a monitor that cannot fail.
 */

import { prisma } from '@/lib/db/prisma'
import type { RawFinding, FindingSeverity } from '@/lib/core/types'

export interface RequestedColumn {
  name?: string
  type?: string
  nullable?: boolean
  notNull?: boolean
  unique?: boolean
  fkTo?: string
}

/**
 * Normalise a declared type to the PostgreSQL family it should land in, so
 * `timestamp` matches `timestamp without time zone` and `int` matches
 * `integer`. Deliberately coarse: this detects a column becoming a DIFFERENT
 * KIND of thing, not precision differences like numeric(10,2) vs numeric.
 */
export function typeFamily(declared: string | undefined | null): string {
  const t = String(declared ?? '').toLowerCase().trim().replace(/\(.*$/, '')
  if (!t) return 'unknown'
  if (/^(timestamptz|timestamp with time zone)$/.test(t)) return 'timestamp'
  if (/^(timestamp|timestamp without time zone|datetime)$/.test(t)) return 'timestamp'
  if (/^(date)$/.test(t)) return 'date'
  if (/^(time|timetz|time without time zone|time with time zone)$/.test(t)) return 'time'
  if (/^(int|int2|int4|int8|integer|smallint|bigint|serial|bigserial)$/.test(t)) return 'integer'
  if (/^(numeric|decimal|money|real|double precision|float|float4|float8)$/.test(t)) return 'number'
  if (/^(bool|boolean)$/.test(t)) return 'boolean'
  if (/^(uuid)$/.test(t)) return 'uuid'
  if (/^(json|jsonb)$/.test(t)) return 'json'
  if (/^(text|varchar|character varying|character|char|citext|string)$/.test(t)) return 'text'
  if (/^(bytea)$/.test(t)) return 'bytes'
  if (/^(array)$/.test(t)) return 'array'
  return t
}

/**
 * Record what a caller asked for. Best-effort: a ledger write must never fail
 * a build, but a failure is logged loudly because a silent gap here recreates
 * exactly the blind spot this exists to remove.
 */
export async function recordSchemaIntent(
  projectId: string,
  tableName: string,
  columns: RequestedColumn[],
  source: 'create_table' | 'add_column',
): Promise<void> {
  const table = String(tableName || '').toLowerCase().trim()
  if (!table) return

  for (const col of columns) {
    const name = typeof col?.name === 'string' ? col.name.trim() : ''
    const type = typeof col?.type === 'string' ? col.type.trim() : ''
    if (!name || !type) continue // nothing was declared — nothing to hold anyone to

    const requestedNullable =
      typeof col.nullable === 'boolean' ? col.nullable
      : typeof col.notNull === 'boolean' ? !col.notNull
      : null

    try {
      await prisma.schemaIntent.upsert({
        where: {
          projectId_tableName_columnName: { projectId, tableName: table, columnName: name },
        },
        create: {
          projectId,
          tableName: table,
          columnName: name,
          requestedType: type,
          requestedNullable,
          requestedUnique: typeof col.unique === 'boolean' ? col.unique : null,
          requestedFkTo: typeof col.fkTo === 'string' && col.fkTo.trim() ? col.fkTo.trim().toLowerCase() : null,
          source,
        },
        // A later explicit request supersedes an earlier one — the developer
        // changed their mind, which is not drift.
        update: {
          requestedType: type,
          requestedNullable,
          requestedUnique: typeof col.unique === 'boolean' ? col.unique : null,
          requestedFkTo: typeof col.fkTo === 'string' && col.fkTo.trim() ? col.fkTo.trim().toLowerCase() : null,
          source,
        },
      })
    } catch (err: any) {
      console.error(
        `[IntentLedger] FAILED to record ${table}.${name} — conformance for this column is now unverifiable:`,
        err?.message,
      )
    }
  }
}

export interface ConformanceFinding {
  table: string
  column: string
  kind: 'type_drift' | 'nullability_drift' | 'missing_column' | 'missing_fk'
  requested: string
  actual: string
  detail: string
}

export interface ConformanceReport {
  checked: number
  findings: ConformanceFinding[]
  /** Columns with no recorded intent — unverifiable, not healthy. */
  unverifiable: number
}

/** The recorded shape, as stored in the ledger. */
export interface RecordedIntent {
  tableName: string
  columnName: string
  requestedType: string
  requestedNullable: boolean | null
  requestedUnique?: boolean | null
  requestedFkTo: string | null
}

/** A column as it actually exists in the catalog. */
export interface ActualColumn {
  tableName: string
  columnName: string
  dataType: string
  nullable: boolean
}

/**
 * Pure comparison — the whole detector, with no database in the way.
 *
 * Split out deliberately so drift detection can be proven to FIRE in a unit
 * test. A probe that has never been observed producing a finding is not
 * trusted here: `detectMissingRls` sat silently dead in every environment
 * (duplicate bind parameter, swallowed error) while the dashboard rendered
 * green, and the only reason nobody noticed was that nothing ever asserted it
 * could fail. This function is where that assertion becomes possible.
 */
export function compareIntentToActual(
  intents: RecordedIntent[],
  actualColumns: ActualColumn[],
  columnsWithFk: Set<string> = new Set(),
): ConformanceReport {
  const actual = new Map<string, ActualColumn>()
  const tablesPresent = new Set<string>()
  for (const c of actualColumns) {
    actual.set(`${c.tableName}.${c.columnName}`, c)
    tablesPresent.add(c.tableName)
  }

  const findings: ConformanceFinding[] = []
  let unverifiable = 0

  for (const intent of intents) {
    const key = `${intent.tableName}.${intent.columnName}`
    const live = actual.get(key)

    if (!live) {
      // A dropped table is a legitimate outcome; a missing column on a table
      // that still exists is not.
      if (tablesPresent.has(intent.tableName)) {
        findings.push({
          table: intent.tableName,
          column: intent.columnName,
          kind: 'missing_column',
          requested: intent.requestedType,
          actual: 'absent',
          detail: `Column "${intent.columnName}" was requested on "${intent.tableName}" but does not exist.`,
        })
      } else {
        unverifiable++
      }
      continue
    }

    const wanted = typeFamily(intent.requestedType)
    const got = typeFamily(live.dataType)
    if (wanted !== 'unknown' && wanted !== got) {
      findings.push({
        table: intent.tableName,
        column: intent.columnName,
        kind: 'type_drift',
        requested: intent.requestedType,
        actual: live.dataType,
        detail:
          `Column "${intent.columnName}" on "${intent.tableName}" was requested as ` +
          `${intent.requestedType} but is ${live.dataType}. Values written in the requested ` +
          `format will be rejected.`,
      })
    }

    if (intent.requestedNullable === true && !live.nullable) {
      findings.push({
        table: intent.tableName,
        column: intent.columnName,
        kind: 'nullability_drift',
        requested: 'nullable',
        actual: 'NOT NULL',
        detail:
          `Column "${intent.columnName}" on "${intent.tableName}" was requested as nullable ` +
          `but is NOT NULL, so inserts that omit it will fail.`,
      })
    }

    if (intent.requestedFkTo && !columnsWithFk.has(key)) {
      findings.push({
        table: intent.tableName,
        column: intent.columnName,
        kind: 'missing_fk',
        requested: `references ${intent.requestedFkTo}`,
        actual: 'no foreign key',
        detail:
          `Column "${intent.columnName}" was requested to reference "${intent.requestedFkTo}" ` +
          `but carries no foreign key, so orphan rows are possible.`,
      })
    }
  }

  return { checked: intents.length, findings, unverifiable }
}

/**
 * Compare every recorded intent against the live catalog.
 *
 * Returns findings rather than throwing, and reports `unverifiable` separately
 * so an empty findings list can never be mistaken for a verified-clean backend
 * when the real reason is that nothing was ever recorded.
 */
export async function checkIntentConformance(projectId: string): Promise<ConformanceReport> {
  const intents = await prisma.schemaIntent.findMany({
    where: { projectId },
    orderBy: [{ tableName: 'asc' }, { columnName: 'asc' }],
  })
  if (intents.length === 0) {
    return { checked: 0, findings: [], unverifiable: 0 }
  }

  const schema = `workspace_${projectId}`
  const rows = await prisma.$queryRawUnsafe<Array<{
    table_name: string; column_name: string; data_type: string; is_nullable: string
  }>>(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1`,
    schema,
  )

  const actualColumns: ActualColumn[] = rows.map((r) => ({
    tableName: r.table_name,
    columnName: r.column_name,
    dataType: r.data_type,
    nullable: r.is_nullable === 'YES',
  }))

  // Foreign keys actually present, so a requested fkTo can be verified.
  const fkRows = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string }>>(
    `SELECT kcu.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
    schema,
  ).catch(() => [] as Array<{ table_name: string; column_name: string }>)
  const hasFk = new Set(fkRows.map((r) => `${r.table_name}.${r.column_name}`))

  return compareIntentToActual(intents as RecordedIntent[], actualColumns, hasFk)
}

// ── Invariant-catalogue adapter ──────────────────────────────────────────────

/**
 * The conformance report, as findings the autonomy loop understands.
 *
 * ── Why this adapter exists ─────────────────────────────────────────────────
 *
 * `checkIntentConformance` was written, tested, and reachable from exactly one
 * place: a single MCP tool. It was never in the invariant catalogue, so the
 * per-minute loop never ran it, the reaper could not withdraw its findings, and
 * the trust report never counted it. The module's own docstring describes a
 * column requested as `timestamp` that was created as `integer` and stayed green
 * for two months — and the mechanism written to catch that was itself only
 * reachable if someone asked for it by hand.
 *
 * Everything below is projection. The comparison lives in
 * `compareIntentToActual`, which stays pure and unit-testable.
 *
 * ── Why nothing here is auto-fixable ────────────────────────────────────────
 *
 * Every remedy is a migration against live data. `ALTER TYPE` rewrites a column
 * and can lose precision, `SET NOT NULL` fails outright if a null exists and
 * takes a lock if it does not, and a column recorded as requested but absent may
 * have been dropped on purpose after the intent was written — the ledger records
 * the REQUEST and is deliberately never reconciled to reality, so its
 * disagreement with the catalog is evidence, not a verdict. Same rule as
 * `schema_design_defect`: state the exact migration and let the owner run it.
 */
export async function detectIntentDrift(projectId: string): Promise<RawFinding[]> {
  const report = await checkIntentConformance(projectId)
  if (report.findings.length === 0) return []

  return report.findings.map((f) => ({
    type: 'intent_drift' as const,
    // A column that is a different KIND of thing than requested silently
    // corrupts every read of it; a missing FK or a widened nullability is a
    // weaker guarantee than asked for but not a wrong value.
    severity: (f.kind === 'type_drift' ? 'critical' : 'warning') as FindingSeverity,
    autoFixable: false,
    details: {
      tableName: f.table,
      columnName: f.column,
      location: `${f.table}.${f.column}`,
      driftKind: f.kind,
      requested: f.requested,
      actual: f.actual,
      migration: intentDriftMigration(projectId, f),
      reason:
        `"${f.table}"."${f.column}" was asked for as ${f.requested} and the database has ` +
        `${f.actual}. ${f.detail} Nothing in the catalog distinguishes a column that is wrong ` +
        `from one that was always meant to be this way, which is why the request is recorded ` +
        `separately — this is the only check that can see the difference.`,
    },
  }))
}

/** The statement that would close this drift, stated rather than executed. */
function intentDriftMigration(projectId: string, f: ConformanceFinding): string {
  const schema = `workspace_${projectId}`
  const t = `"${schema}"."${f.table}"`
  switch (f.kind) {
    case 'type_drift':
      return `ALTER TABLE ${t} ALTER COLUMN "${f.column}" TYPE ${f.requested} USING "${f.column}"::${f.requested};`
    case 'nullability_drift':
      return f.requested.includes('NOT NULL')
        ? `ALTER TABLE ${t} ALTER COLUMN "${f.column}" SET NOT NULL;`
        : `ALTER TABLE ${t} ALTER COLUMN "${f.column}" DROP NOT NULL;`
    case 'missing_column':
      return `ALTER TABLE ${t} ADD COLUMN "${f.column}" ${f.requested};`
    case 'missing_fk':
      return `ALTER TABLE ${t} ADD CONSTRAINT "fk_${f.table}_${f.column}" FOREIGN KEY ("${f.column}") REFERENCES "${schema}"."${f.requested}"(id);`
  }
}
