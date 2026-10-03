/**
 * SOURCE↔TARGET RECONCILIATION — the safety oracle for expand/contract
 * =====================================================================
 *
 * Read-only. Compares a source column against the target column an expand step
 * introduced, under a declared transform, and answers whether they agree.
 *
 * ── Why this exists, and why it is built BEFORE dual-write ──────────────────
 *
 * The dual-write trigger must never abort a customer's write, so its body
 * swallows exceptions and records them. That mitigation creates a worse failure
 * than the one it prevents: a trigger that SUCCEEDS while writing the wrong
 * value — a bad cast, a truncation, a timezone shift — records nothing at all.
 *
 * So `mismatchCount == 0` is the reading you get both when everything worked and
 * when the instrumentation is blind. It is telemetry, not proof. This module is
 * the proof, and it is deliberately the first thing built: everything that
 * mutates arrives into an environment that can already check it.
 *
 * That distinction is not hypothetical here. `lib/autonomy/fix-acceptance.ts`
 * records the case it was written about: an agent cast a `timestamp` column to
 * `integer`, the migration reported success, every signal was green, and the
 * schema stayed wrong for months — because the only thing being checked was
 * whether the command ran.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 *     could not compare  ≠  compared and agreed
 *
 * A column that vanished, a query that failed, a transform nobody can recompute,
 * a table with nothing in it — none of those are evidence of consistency. They
 * return `inconclusive`, and the caller must treat that as a halt.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 *
 * No writes, no schema changes, no persistence, no jobs. The RDS rehearsal gates
 * the mutation half of Phase 6; a read-only verifier is outside that gate, which
 * is the only reason this ships ahead of it.
 */

import { queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { queryWorkspaceAsOwner, resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { transformProblem, transformSql, type Transform } from './transform'

/**
 * Rows below which every row is compared.
 *
 * Above it, sampling. The threshold is a cost bound, not a confidence
 * statement — which is why `coverage.complete` is reported separately rather
 * than folded into the verdict.
 */
export const FULL_COMPARE_MAX_ROWS = 50_000

/** Rows examined when sampling. */
export const SAMPLE_ROWS = 10_000

// ── The closed transform vocabulary ──────────────────────────────────────────

/**
 * Every transform reconciliation can independently recompute.
 *
 * Closed and typed ON PURPOSE, and closed NOW rather than when execution
 * arrives. The coupling that matters: whatever a dual-write trigger can
 * eventually apply must be exactly what this can recompute. If the trigger could
 * apply an arbitrary expression, the "independent" check would have to trust the
 * same expression it is supposed to be checking, and it would stop being
 * independent.
 *
 * It is also why no raw SQL or JavaScript is accepted. That is the same trade
 * `lib/services/derived-columns.ts` makes for its trigger bodies: full
 * capability through a governed vocabulary rather than an escape hatch that
 * cannot be reasoned about.
 *
 * Now that the dual-write trigger exists, the type and both of its SQL
 * renderings live in ./transform.ts, so the writer and the checker cannot drift
 * apart. Re-exported here because this module defined it first and callers
 * import it from here.
 */
export type { Transform }

export type ReconciliationVerdict = 'consistent' | 'inconsistent' | 'inconclusive'
export type ReconciliationMethod = 'full_compare' | 'deterministic_sample'

export interface ReconciliationResult {
  verdict: ReconciliationVerdict
  comparedRows: number
  mismatchedRows: number
  method: ReconciliationMethod | null
  coverage: {
    totalRows: number
    sampledRows: number
    /** True only when every row was compared. */
    complete: boolean
  }
  /** Why this verdict, in words, plus a bounded sample of disagreeing keys. */
  evidence: {
    reason: string
    mismatchExamples: Array<{ key: string; source: string | null; target: string | null }>
  }
}

export interface ReconcileInput {
  projectId: string
  table: string
  sourceColumn: string
  targetColumn: string
  transform: Transform
  /**
   * Stable identity for this comparison — the plan version.
   *
   * Salts the sample ordering so a retry inspects the SAME slice. A sample that
   * moves between runs turns a reproducible check into a flaky one, and a flaky
   * safety gate is worse than none: it gets retried until it passes.
   */
  planIdentity: string
  /** Overrides for tests. */
  fullCompareMaxRows?: number
  sampleRows?: number
}

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Raised for every "could not compare" condition. Never a verdict of its own. */
class Inconclusive extends Error {}

const rowsOf = (res: any): any[] => res?.rows ?? res ?? []

/** The primary key column, which the deterministic sample orders by. */
async function primaryKeyColumn(projectId: string, table: string): Promise<string> {
  const res = await queryWorkspaceSchema(
    projectId,
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = $1 AND tc.table_name = $2
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position
      LIMIT 1`,
    await resolveWorkspaceSchema(projectId),
    table,
  ).catch(() => null)

  const col = rowsOf(res)[0]?.column_name
  if (!col || !IDENT.test(col)) {
    // Without a stable key there is no reproducible sample, so a large table
    // cannot be checked reproducibly at all.
    throw new Inconclusive(`table "${table}" has no usable primary key to order a sample by`)
  }
  return col
}

async function assertColumnsExist(
  projectId: string,
  table: string,
  cols: string[],
): Promise<void> {
  const res = await queryWorkspaceSchema(
    projectId,
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = ANY($3::text[])`,
    await resolveWorkspaceSchema(projectId),
    table,
    cols,
  ).catch((err: unknown) => {
    throw new Inconclusive(
      `column catalog unreadable: ${err instanceof Error ? err.message : String(err)}`,
    )
  })

  const found = new Set(rowsOf(res).map((r: any) => r.column_name))
  const missing = cols.filter(c => !found.has(c))
  if (missing.length > 0) {
    // A column that disappeared mid-verification is the schema moving under the
    // check. Reporting agreement here would be agreement about nothing.
    throw new Inconclusive(`column(s) not found: ${missing.join(', ')}`)
  }
}

/**
 * Compare a source column against a target column under a declared transform.
 *
 * NULL semantics are explicit: comparison is `IS DISTINCT FROM`, so NULL on both
 * sides AGREES and NULL on one side only is a mismatch. Two rows that are both
 * unset are consistent, and that is the behaviour a dual-write should produce.
 */
export async function reconcileSourceTarget(
  input: ReconcileInput,
): Promise<ReconciliationResult> {
  const {
    projectId, table, sourceColumn, targetColumn, transform, planIdentity,
  } = input
  const maxFull = input.fullCompareMaxRows ?? FULL_COMPARE_MAX_ROWS
  const sampleSize = input.sampleRows ?? SAMPLE_ROWS

  const empty = (verdict: ReconciliationVerdict, reason: string): ReconciliationResult => ({
    verdict,
    comparedRows: 0,
    mismatchedRows: 0,
    method: null,
    coverage: { totalRows: 0, sampledRows: 0, complete: false },
    evidence: { reason, mismatchExamples: [] },
  })

  try {
    if (![table, sourceColumn, targetColumn].every(x => IDENT.test(x))) {
      throw new Inconclusive('table or column name is not a valid identifier')
    }
    const schema = await resolveWorkspaceSchema(projectId)
    await assertColumnsExist(projectId, table, [sourceColumn, targetColumn])

    // AS OWNER. The product enables RLS on every tenant table it creates, and
    // an ordinary workspace query sets no claim — so this counted ZERO on a
    // table holding 80 rows, and reconciliation reported "table has no rows"
    // for a table that was full. Measured in production 2026-09-16, where the
    // planner's own estimate said 80 while count(*) said 0.
    //
    // `queryWorkspaceAsOwner` applies the service-role claim inside a
    // transaction with `set_config(..., true)`, so the elevated context reverts
    // at commit and cannot leak onto the pooled connection.
    const countRes = await queryWorkspaceAsOwner(
      projectId,
      `SELECT count(*)::bigint AS n FROM "${schema}"."${table}"`,
    ).catch((err: unknown) => {
      throw new Inconclusive(`row count failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    const totalRows = Number(rowsOf(countRes)[0]?.n ?? 0)

    if (totalRows === 0) {
      // Defined explicitly rather than falling out as success. Nothing was
      // compared, so nothing was demonstrated — and "we verified an empty
      // table" must never be mistaken for evidence that a dual-write works.
      // A genuinely empty table is the orchestrator's case to handle openly.
      return empty('inconclusive', 'table has no rows, so consistency could not be demonstrated')
    }

    // A transform that cannot be rendered cannot be recomputed, so there is
    // nothing to compare against. Checked here rather than thrown from the
    // renderer, so the same guard reads identically on the dual-write side.
    const problem = transformProblem(transform)
    if (problem) throw new Inconclusive(problem)

    const params: unknown[] = []
    const expected = transformSql(transform, `"${sourceColumn}"`, params)

    let method: ReconciliationMethod
    let scope: string
    if (totalRows <= maxFull) {
      method = 'full_compare'
      scope = `SELECT "${sourceColumn}" AS src, "${targetColumn}" AS tgt,
                      ${expected} AS exp, NULL::text AS key
                 FROM "${schema}"."${table}"`
    } else {
      method = 'deterministic_sample'
      const pk = await primaryKeyColumn(projectId, table)
      params.push(planIdentity)
      const saltParam = `$${params.length}`
      // Stable for the same rows and the same plan: a retry inspects the same
      // slice. Ordering by a hash of the key salted with the plan identity is
      // reproducible without needing a stored row list.
      scope = `SELECT "${sourceColumn}" AS src, "${targetColumn}" AS tgt,
                      ${expected} AS exp, "${pk}"::text AS key
                 FROM "${schema}"."${table}"
                ORDER BY md5("${pk}"::text || ${saltParam})
                LIMIT ${sampleSize}`
    }

    // AS OWNER, for the same reason as the count above. Without a claim this
    // compares an empty set and reports agreement about nothing.
    const res = await queryWorkspaceAsOwner(
      projectId,
      `WITH scoped AS (${scope})
       SELECT count(*)::bigint AS compared,
              count(*) FILTER (WHERE tgt IS DISTINCT FROM exp)::bigint AS mismatched,
              (array_agg(ARRAY[coalesce(key,''), coalesce(src,''), coalesce(tgt,'')]
                         ORDER BY key)
                 FILTER (WHERE tgt IS DISTINCT FROM exp))[1:5] AS examples
         FROM scoped`,
      // An array, not a spread: queryWorkspaceAsOwner takes its parameters as
      // one, since it has to bind the claim's own parameters first.
      params,
    ).catch((err: unknown) => {
      throw new Inconclusive(
        `comparison query failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })

    const row = rowsOf(res)[0] ?? {}
    const comparedRows = Number(row.compared ?? 0)
    const mismatchedRows = Number(row.mismatched ?? 0)

    if (comparedRows === 0) {
      throw new Inconclusive('comparison returned no rows')
    }

    const mismatchExamples = (row.examples ?? []).map((e: string[]) => ({
      key: e?.[0] ?? '',
      source: e?.[1] ?? null,
      target: e?.[2] ?? null,
    }))

    const complete = method === 'full_compare'
    return {
      verdict: mismatchedRows === 0 ? 'consistent' : 'inconsistent',
      comparedRows,
      mismatchedRows,
      method,
      coverage: { totalRows, sampledRows: comparedRows, complete },
      evidence: {
        reason:
          mismatchedRows === 0
            ? `${comparedRows} rows compared, all agree` +
              (complete ? ' (every row)' : ` (deterministic sample of ${totalRows})`)
            : `${mismatchedRows} of ${comparedRows} compared rows disagree`,
        mismatchExamples,
      },
    }
  } catch (err) {
    if (err instanceof Inconclusive) return empty('inconclusive', err.message)
    return empty(
      'inconclusive',
      `reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * May readers be switched to the target column?
 *
 * The gate, stated once so no caller re-derives it. Two independent conditions,
 * and the second is the reason this module exists:
 *
 *   1. the dual-write mismatch ledger is empty, AND
 *   2. reconciliation independently DEMONSTRATED consistency.
 *
 * `inconclusive` fails this. A ledger reading zero because nothing was recorded
 * looks exactly like one reading zero because nothing went wrong, so the ledger
 * can never be the sole authority.
 */
export function maySwitchReaders(input: {
  mismatchLedgerCount: number
  reconciliation: ReconciliationResult
}): { allowed: boolean; reason: string } {
  if (input.mismatchLedgerCount > 0) {
    return {
      allowed: false,
      reason: `${input.mismatchLedgerCount} unreconciled dual-write mismatches`,
    }
  }
  if (input.reconciliation.verdict === 'inconsistent') {
    return {
      allowed: false,
      reason:
        `the mismatch ledger is empty but reconciliation found ` +
        `${input.reconciliation.mismatchedRows} disagreeing rows — the ledger only records ` +
        'writes that THREW, and a trigger that succeeded with a wrong value records nothing',
    }
  }
  if (input.reconciliation.verdict === 'inconclusive') {
    return {
      allowed: false,
      reason: `consistency was not demonstrated: ${input.reconciliation.evidence.reason}`,
    }
  }
  return {
    allowed: true,
    reason: input.reconciliation.evidence.reason,
  }
}
