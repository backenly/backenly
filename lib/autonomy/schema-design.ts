/**
 * SCHEMA DESIGN — the defects that only hurt once the table has real data
 * =======================================================================
 *
 * Every other probe in this catalogue asks whether the backend is wired
 * correctly. This one asks whether it was MODELLED correctly, which is the
 * complaint experienced developers actually make about managed-Postgres
 * platforms: not that the tool broke, but that a schema which looked fine at
 * ten rows became expensive to change at ten million.
 *
 * ── Why this can be honest about a subjective-sounding thing ────────────────
 *
 * "Bad schema design" is not decidable in general and this module does not try.
 * It detects four specific defects that are decidable, each one a case where the
 * DATA ITSELF contradicts the DECLARATION:
 *
 *   nullable_fk         a foreign key declared optional that has never once been
 *                       null. The application already treats it as required; the
 *                       schema does not, so nothing stops the row that breaks it.
 *   missing_unique      an email / slug / handle column whose values are already
 *                       all distinct, with no constraint keeping them that way.
 *                       The duplicate arrives later, usually at signup.
 *   unconstrained_enum  a text column holding a handful of repeated values with
 *                       no CHECK. Every typo'd 'complete' beside 'completed' is
 *                       a row that silently drops out of a filter.
 *   money_as_float      a price or amount stored in binary floating point, where
 *                       0.1 + 0.2 is not 0.3 and totals drift by cents.
 *
 * The first three are claims about the data, so they are gated on the data
 * existing. The fourth is wrong at zero rows and is reported at zero rows.
 *
 * ── Why it costs nothing to run every minute ────────────────────────────────
 *
 * It reads `pg_stats` and `pg_class.reltuples`, which are the planner's OWN
 * statistics, already maintained by autovacuum. There is no table scan, no
 * COUNT(*), and no per-column round trip: one catalog query answers for every
 * column of every table. Scanning user tables once a minute to hunt for design
 * smells would cost more than the smells do.
 *
 * `reltuples` is -1 on a table that has never been analysed, so the row-count
 * gate doubles as the evidence gate — a freshly built backend has no statistics,
 * fails every threshold, and is reported clean. That is deliberate: this probe
 * must never file a finding against output the builder just produced.
 */

import { queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { notReservedTableSql } from '@/lib/security/workspace-schema'
import { probeQueryFailed } from '@/lib/core/drift-detector'
import type { RawFinding } from '@/lib/core/types'

/**
 * Rows a table needs before its statistics are worth drawing a conclusion from.
 *
 * Set by what the claims require rather than by taste. "Every value is distinct"
 * is unremarkable at 5 rows and strong evidence at 50; "this column is never
 * null" says nothing about a table someone inserted twice into. Below this the
 * probe stays silent rather than guessing, because a false design finding costs
 * the owner a migration they did not need.
 */
export const MIN_ROWS_FOR_DESIGN_CLAIM = 50

/** Most values repeated across many rows is the shape of an enum. */
const ENUM_MAX_DISTINCT = 8
const ENUM_MIN_DISTINCT = 2

/** Columns whose meaning implies uniqueness in essentially every application. */
const UNIQUE_EXPECTED = new Set(['email', 'slug', 'username', 'handle'])

/** Columns whose meaning implies a closed set of values. */
const ENUM_EXPECTED = new Set(['status', 'state', 'type', 'kind', 'role', 'stage', 'tier'])

/** Columns that hold money, where binary floating point is a correctness bug. */
const MONEY_NAME = /(^|_)(price|amount|total|subtotal|cost|fee|balance|salary|revenue|discount|tax)(_|$)/i

/** Floating-point types. `numeric`/`decimal` are exact and never flagged. */
const FLOAT_TYPES = new Set(['real', 'double precision'])

export type DesignDefectKind =
  | 'nullable_fk'
  | 'missing_unique'
  | 'unconstrained_enum'
  | 'money_as_float'

/** One column, as the catalog and the planner's statistics describe it. */
export interface ColumnStat {
  tableName: string
  columnName: string
  dataType: string
  /** `pg_class.reltuples`. -1 when the table has never been analysed. */
  estRows: number
  notNull: boolean
  /** `pg_stats.null_frac`. Null when no statistics exist for this column. */
  nullFrac: number | null
  /**
   * `pg_stats.n_distinct`. Positive is an absolute count; NEGATIVE is a
   * fraction of the table (-1 meaning every value is distinct). Getting that
   * sign convention wrong is the difference between "this is an enum" and "this
   * is a primary key", so it is decoded explicitly below and never compared raw.
   */
  nDistinct: number | null
  hasFk: boolean
  hasCheck: boolean
  hasUnique: boolean
}

export interface DesignDefect {
  kind: DesignDefectKind
  tableName: string
  columnName: string
  dataType: string
  /** Plain-language statement of what is wrong. */
  problem: string
  /** The migration that fixes it. Shown to the owner, never executed here. */
  sql: string
  severity: 'critical' | 'warning' | 'info'
  /** What the probe measured, so the owner can judge the claim themselves. */
  evidence: Record<string, unknown>
}

/**
 * Decode `n_distinct` into an absolute count of distinct values.
 * Returns null when there is no usable statistic.
 */
export function distinctCount(nDistinct: number | null, estRows: number): number | null {
  if (nDistinct === null || nDistinct === 0) return null
  if (nDistinct > 0) return nDistinct
  // Negative: a fraction of the table's row count.
  if (estRows <= 0) return null
  return Math.round(-nDistinct * estRows)
}

/**
 * The whole rule set, as a pure function over catalog rows.
 *
 * Pure on purpose: these four judgements decide whether an owner is told their
 * schema is wrong, and a rule that can only be exercised against a live database
 * is a rule nobody re-checks. Every threshold and sign convention below is
 * covered by tests/unit/schema-design.spec.ts without a Postgres anywhere.
 */
export function classifyDesignDefects(columns: readonly ColumnStat[]): DesignDefect[] {
  const out: DesignDefect[] = []

  for (const c of columns) {
    const q = `"${c.tableName}"."${c.columnName}"`
    const lower = c.columnName.toLowerCase()
    const analysed = c.estRows >= MIN_ROWS_FOR_DESIGN_CLAIM

    // ── money_as_float ────────────────────────────────────────────────────────
    // Reported without a row threshold: the type is wrong on an empty table too,
    // and it is cheapest to change before there is data to migrate.
    if (FLOAT_TYPES.has(c.dataType) && MONEY_NAME.test(c.columnName)) {
      out.push({
        kind: 'money_as_float',
        tableName: c.tableName,
        columnName: c.columnName,
        dataType: c.dataType,
        problem:
          `${q} holds money in ${c.dataType}, which is binary floating point. ` +
          `Values like 0.1 cannot be represented exactly, so sums drift by fractions ` +
          `of a cent and two totals that should match will not.`,
        sql: `ALTER TABLE "${c.tableName}" ALTER COLUMN "${c.columnName}" TYPE numeric(12,2);`,
        severity: 'warning',
        evidence: { dataType: c.dataType },
      })
      continue
    }

    if (!analysed) continue

    // ── nullable_fk ───────────────────────────────────────────────────────────
    // A declared-optional relationship the data says is mandatory. Requires a
    // real FK: a bare `*_id` with no constraint is detectFkColumnsMissingConstraints'
    // finding, and reporting both would bill one mistake to the owner twice.
    if (c.hasFk && !c.notNull && c.nullFrac === 0) {
      out.push({
        kind: 'nullable_fk',
        tableName: c.tableName,
        columnName: c.columnName,
        dataType: c.dataType,
        problem:
          `${q} is a foreign key marked optional, but not one of the ` +
          `${c.estRows.toLocaleString()} rows has ever left it empty. The application ` +
          `already treats it as required; the database does not, so the first row that ` +
          `omits it will be accepted and every join will quietly skip it.`,
        sql: `ALTER TABLE "${c.tableName}" ALTER COLUMN "${c.columnName}" SET NOT NULL;`,
        severity: 'warning',
        evidence: { estRows: c.estRows, nullFraction: c.nullFrac },
      })
      continue
    }

    // ── missing_unique ────────────────────────────────────────────────────────
    // Every value already distinct, nothing keeping it that way. Named columns
    // only: "all values happen to be distinct" is true of plenty of columns where
    // uniqueness is not intended, and a wrong UNIQUE breaks writes.
    if (UNIQUE_EXPECTED.has(lower) && !c.hasUnique && c.nullFrac === 0) {
      const distinct = distinctCount(c.nDistinct, c.estRows)
      const allDistinct = c.nDistinct !== null && c.nDistinct === -1
      if (allDistinct) {
        out.push({
          kind: 'missing_unique',
          tableName: c.tableName,
          columnName: c.columnName,
          dataType: c.dataType,
          problem:
            `${q} holds ${c.estRows.toLocaleString()} values and every one is already ` +
            `distinct, but nothing enforces that. Duplicates get in through the path ` +
            `nobody tests, usually a second signup with the same address, and by then ` +
            `there are two rows and no way to tell which is the real one.`,
          sql:
            `CREATE UNIQUE INDEX CONCURRENTLY "uq_${c.tableName}_${c.columnName}" ` +
            `ON "${c.tableName}" ("${c.columnName}");`,
          severity: 'warning',
          evidence: { estRows: c.estRows, distinctValues: distinct, allDistinct: true },
        })
        continue
      }
    }

    // ── unconstrained_enum ────────────────────────────────────────────────────
    // A closed set of values held in an open type. Excludes FK columns, whose
    // allowed values are already constrained by the referenced table.
    if (
      ENUM_EXPECTED.has(lower) &&
      !c.hasCheck &&
      !c.hasFk &&
      (c.dataType === 'text' || c.dataType.startsWith('character varying'))
    ) {
      const distinct = distinctCount(c.nDistinct, c.estRows)
      if (distinct !== null && distinct >= ENUM_MIN_DISTINCT && distinct <= ENUM_MAX_DISTINCT) {
        out.push({
          kind: 'unconstrained_enum',
          tableName: c.tableName,
          columnName: c.columnName,
          dataType: c.dataType,
          problem:
            `${q} only ever holds ${distinct} different values across ` +
            `${c.estRows.toLocaleString()} rows, so it is an enum stored in a free-text ` +
            `column. Nothing rejects a typo: one row written as 'complete' beside ` +
            `'completed' disappears from every filter and no error is raised.`,
          sql:
            `-- Replace the list with your actual values first:\n` +
            `ALTER TABLE "${c.tableName}" ADD CONSTRAINT "ck_${c.tableName}_${c.columnName}" ` +
            `CHECK ("${c.columnName}" IN ('value_a', 'value_b'));`,
          severity: 'info',
          evidence: { estRows: c.estRows, distinctValues: distinct },
        })
      }
    }
  }

  return out
}

interface RawRow {
  table_name: string
  column_name: string
  data_type: string
  est_rows: string | number
  not_null: boolean
  null_frac: string | number | null
  n_distinct: string | number | null
  has_fk: boolean
  has_check: boolean
  has_unique: boolean
}

function num(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * INVARIANT PROBE — read the planner's statistics and report design defects.
 *
 * One query, no table scans. Fails loudly rather than returning [] when the
 * catalog cannot be read, per probeQueryFailed: a probe that could not look must
 * never be recorded as having looked and found nothing.
 */
export async function detectSchemaDesignDefects(projectId: string): Promise<RawFinding[]> {
  const schema = `workspace_${projectId}`

  const res = await queryWorkspaceSchema(
    projectId,
    `
    SELECT
      c.relname                            AS table_name,
      a.attname                            AS column_name,
      format_type(a.atttypid, a.atttypmod) AS data_type,
      c.reltuples::bigint                  AS est_rows,
      a.attnotnull                         AS not_null,
      s.null_frac,
      s.n_distinct,
      EXISTS (
        SELECT 1 FROM pg_constraint fk
         WHERE fk.conrelid = c.oid AND fk.contype = 'f'
           AND a.attnum = ANY(fk.conkey)
      ) AS has_fk,
      EXISTS (
        SELECT 1 FROM pg_constraint ck
         WHERE ck.conrelid = c.oid AND ck.contype = 'c'
           AND a.attnum = ANY(ck.conkey)
      ) AS has_check,
      -- Single-column unique constraints only. A composite unique index does not
      -- keep THIS column unique, and treating it as if it did would suppress a
      -- real finding.
      EXISTS (
        SELECT 1 FROM pg_index i
         WHERE i.indrelid = c.oid AND i.indisunique
           AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum
      ) AS has_unique
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_stats s
      ON s.schemaname = n.nspname AND s.tablename = c.relname AND s.attname = a.attname
    WHERE n.nspname = $1
      AND c.relkind = 'r'
      AND ${notReservedTableSql('c.relname')}
    `,
    schema,
  ).catch(probeQueryFailed('detectSchemaDesignDefects'))

  const rows: RawRow[] = res?.rows ?? res ?? []

  const columns: ColumnStat[] = rows.map(r => ({
    tableName: r.table_name,
    columnName: r.column_name,
    dataType: r.data_type,
    estRows: num(r.est_rows) ?? -1,
    notNull: !!r.not_null,
    nullFrac: num(r.null_frac),
    nDistinct: num(r.n_distinct),
    hasFk: !!r.has_fk,
    hasCheck: !!r.has_check,
    hasUnique: !!r.has_unique,
  }))

  return classifyDesignDefects(columns).map(d => ({
    type: 'schema_design_defect' as const,
    severity: d.severity,
    // Every repair here is a migration against live data: a type change that can
    // truncate, a NOT NULL that takes a lock, a UNIQUE that fails on the first
    // duplicate. The platform states the change and the owner runs it.
    autoFixable: false,
    details: {
      reason: d.problem,
      // The KIND is part of the identity: one column can carry more than one
      // defect, and a table-scoped key would let fixing the first withdraw the
      // finding for the second.
      location: `${d.kind}:${d.tableName}.${d.columnName}`,
      kind: d.kind,
      tableName: d.tableName,
      columnName: d.columnName,
      dataType: d.dataType,
      sql: d.sql,
      evidence: d.evidence,
    },
  }))
}
