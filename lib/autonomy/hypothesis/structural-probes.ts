/**
 * STRUCTURAL PROBES — evidence for why an area's repairs stop holding
 * ===================================================================
 *
 * Admissibility for every probe here was decided in advance and written down in
 * `docs/structural-probe-inventory.md`. That document is the gate: a probe that
 * cannot falsify a hypothesis does not ship, because a probe that runs and
 * returns something without separating any explanation produces a reasoning
 * trail that looks thorough and concludes nothing.
 *
 * ── The distinction this file is built around ───────────────────────────────
 *
 *     a probe that did not run  ≠  a probe that ran and found absence
 *
 * `pg_stat_statements` missing, fewer than 50 rows, `pg_policies` unreadable, a
 * catalog query failing — none of those are evidence about the backend. They are
 * evidence about the instruments. So they THROW, which the investigation loop
 * records as `unavailable` rather than folding in as an observation, and they
 * are reported separately as coverage.
 *
 * That is not a new idea here; `investigate.ts` already says a failed test "is
 * not a test that answered". This file just makes sure the structural probes
 * fail loudly instead of returning a confident negative.
 */

import { queryWorkspaceSchema } from '@/lib/services/workspaceDatabase'
import { queryWorkspaceAsOwner } from '@/lib/services/workspace-pool'
import { notReservedTableSql } from '@/lib/security/workspace-schema'
import { MIN_ROWS_FOR_DESIGN_CLAIM } from '@/lib/autonomy/schema-design'
import type { ProbeContext, ProbeFn } from './probes'

/** Identifier guard — these values reach raw SQL. */
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function members(ctx: ProbeContext): string[] {
  const m = (ctx as { membership?: string[] }).membership ?? []
  const safe = m.filter(t => IDENT.test(t))
  if (safe.length === 0) {
    throw new Error('structural probes require a subsystem membership list')
  }
  return safe
}

const rowsOf = (res: any): any[] => res?.rows ?? res ?? []

/**
 * Column names worth MEASURING for state semantics.
 *
 * Naming is used here and only here, to choose what to measure. It never
 * supports a conclusion — `fix-classifier.ts:63` refuses to act "on the strength
 * of a naming convention", and two similarly named columns are equally
 * consistent with one duplicated lifecycle and with two different concepts.
 * The measurement in `columnCoVariation` is what decides.
 */
const STATE_NAME = /(^|_)(status|state|stage|phase|step|kind|type|flag)(_|$)/i

// ── 1. Policy overlap (ADMISSIBLE — direct catalog fact) ─────────────────────

/**
 * Do several RLS policies apply to the same command on the same table?
 *
 * Decides `policy_fragmentation`. When more than one permissive policy covers a
 * command, the effective rule is the OR of all of them, which is not what any
 * single policy reads as — and that is exactly the condition under which a
 * repair to one policy appears to work and does not hold.
 */
export const policyOverlap: ProbeFn = async ctx => {
  const tables = members(ctx)
  const res = await queryWorkspaceSchema(
    ctx.projectId,
    // PERMISSIVE only, and `ALL` expanded to the commands it covers.
    //
    // The comment above says "more than one permissive policy" and the query
    // did not say that. RESTRICTIVE policies AND with everything else, so a
    // permissive/restrictive pair is a composition, not a fragmentation — the
    // same rule `drift-detector.ts:382` already applies. Counting them made
    // this probe report `overlapping` for a shape that is not overlapping.
    //
    // The grouping was also wrong in the opposite direction: `cmd` is `ALL`
    // for a policy that covers every command, and grouping that separately
    // from `SELECT` hid the real overlap between an ALL policy and a
    // per-command one — the exact case where the effective rule is not what
    // either policy reads as.
    `SELECT pp.tablename, x.cmd, count(*)::int AS n
       FROM pg_policies pp
       CROSS JOIN LATERAL unnest(
         CASE WHEN pp.cmd = 'ALL'
              THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']
              ELSE ARRAY[pp.cmd] END
       ) AS x(cmd)
      WHERE pp.schemaname = $1
        AND pp.tablename = ANY($2::text[])
        AND pp.permissive = 'PERMISSIVE'
      GROUP BY pp.tablename, x.cmd
      HAVING count(*) > 1
      ORDER BY n DESC`,
    `workspace_${ctx.projectId}`,
    tables,
  ).catch((err: unknown) => {
    // Not "no overlapping policies". `security-agent.ts:67` documents that
    // pg_policies may be unreadable, and reporting that as absence would let a
    // permissions problem masquerade as a clean bill of health.
    throw new Error(
      `pg_policies unreadable: ${err instanceof Error ? err.message : String(err)}`,
    )
  })

  const rows = rowsOf(res)
  if (rows.length === 0) return { outcome: 'single_per_command' }
  return {
    outcome: 'overlapping',
    detail: rows
      .slice(0, 3)
      .map((r: any) => `${r.tablename}.${r.cmd}×${r.n}`)
      .join(', '),
  }
}

// ── 2. Constraint coverage (ADMISSIBLE — direct catalog fact) ────────────────

/**
 * Do the state-ish columns in this area carry any constraint at all?
 *
 * Decides `missing_constraint_permits_invalid_state`. A column the schema lets
 * hold anything will keep receiving values the application believes impossible,
 * and each repair cleans up after them rather than stopping them.
 *
 * Reports the ABSENCE of a constraint, never that one ought to exist. Whether it
 * should is a judgement about intent, and the schema does not record intent.
 */
export const constraintCoverage: ProbeFn = async ctx => {
  const tables = members(ctx)
  const schema = `workspace_${ctx.projectId}`

  const res = await queryWorkspaceSchema(
    ctx.projectId,
    `SELECT c.table_name, c.column_name, c.is_nullable
       FROM information_schema.columns c
      WHERE c.table_schema = $1
        AND c.table_name = ANY($2::text[])
        AND ${notReservedTableSql('c.table_name')}
        AND c.data_type IN ('text', 'character varying', 'character')
        AND NOT EXISTS (
          SELECT 1
            FROM information_schema.constraint_column_usage u
            JOIN information_schema.table_constraints tc
              ON tc.constraint_name = u.constraint_name
             AND tc.table_schema = u.table_schema
           WHERE u.table_schema = c.table_schema
             AND u.table_name = c.table_name
             AND u.column_name = c.column_name
             AND tc.constraint_type IN ('CHECK', 'UNIQUE', 'FOREIGN KEY')
        )`,
    schema,
    tables,
  ).catch((err: unknown) => {
    throw new Error(
      `constraint catalog unreadable: ${err instanceof Error ? err.message : String(err)}`,
    )
  })

  const unconstrained = rowsOf(res).filter((r: any) => STATE_NAME.test(r.column_name))
  if (unconstrained.length === 0) return { outcome: 'constrained' }
  return {
    outcome: 'state_columns_unconstrained',
    detail: unconstrained
      .slice(0, 3)
      .map((r: any) => `${r.table_name}.${r.column_name}`)
      .join(', '),
  }
}

// ── 3. Column co-variation (CONDITIONAL — needs a real sample) ───────────────

/**
 * Do two state-ish columns on one table encode the SAME state?
 *
 * Decides `duplicated_lifecycle_state`, and it is the only probe that speaks to
 * it directly — which is why the sample gate below is load-bearing rather than
 * cautious.
 *
 * The measurement: if `count(DISTINCT (a, b)) ≈ count(DISTINCT a)`, then each
 * value of `a` determines `b`, so the pair is one state machine recorded twice.
 * Two genuinely independent columns produce a product, not a mapping.
 *
 * Below MIN_ROWS_FOR_DESIGN_CLAIM this THROWS rather than answering. At five
 * rows "every value of a maps to one b" is unremarkable; at fifty it is
 * evidence. Returning `independent` on a small table would be a confident
 * negative drawn from nothing.
 */
export const columnCoVariation: ProbeFn = async ctx => {
  const tables = members(ctx)
  const schema = `workspace_${ctx.projectId}`

  const colRes = await queryWorkspaceSchema(
    ctx.projectId,
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = ANY($2::text[])
        AND data_type IN ('text', 'character varying', 'character')`,
    schema,
    tables,
  ).catch((err: unknown) => {
    throw new Error(`column catalog unreadable: ${err instanceof Error ? err.message : String(err)}`)
  })

  const byTable = new Map<string, string[]>()
  for (const r of rowsOf(colRes)) {
    if (!STATE_NAME.test(r.column_name)) continue
    if (!IDENT.test(r.table_name) || !IDENT.test(r.column_name)) continue
    const list = byTable.get(r.table_name)
    if (list) list.push(r.column_name)
    else byTable.set(r.table_name, [r.column_name])
  }

  const pairs: Array<[string, string, string]> = []
  for (const [table, cols] of byTable) {
    for (let i = 0; i < cols.length; i++) {
      for (let j = i + 1; j < cols.length; j++) pairs.push([table, cols[i], cols[j]])
    }
  }

  if (pairs.length === 0) {
    // No two state-ish columns share a table, so the hypothesis has nothing to
    // be true OF. That is a genuine negative, not a missing measurement.
    return { outcome: 'independent', detail: 'no table carries two state columns' }
  }

  let bestSample = 0
  for (const [table, a, b] of pairs) {
    // AS OWNER. This is the one query in this file that reads TENANT ROWS
    // rather than a catalog, and the product enables RLS on every table it
    // creates. Without a claim the count is 0 on a full table, the probe
    // throws "insufficient sample", and the whole diagnosis degrades to
    // inconclusive — so no plan can ever be built for an RLS-protected
    // project, which is all of them.
    //
    // This was visible as a contradiction inside a single report:
    // `assessStructuralCoverage` reads `pg_class.reltuples`, a planner
    // estimate that RLS does not filter, and said 80 rows with the sample
    // sufficient, while this probe said 0. One table, two answers, and the
    // blinded one decided the verdict.
    const res = await queryWorkspaceAsOwner(
      ctx.projectId,
      `SELECT count(*)::int AS rows,
              count(DISTINCT "${a}")::int AS da,
              count(DISTINCT ("${a}", "${b}"))::int AS dab
         FROM "${schema}"."${table}"`,
    ).catch((err: unknown) => {
      throw new Error(`could not sample ${table}: ${err instanceof Error ? err.message : String(err)}`)
    })

    const row = rowsOf(res)[0] ?? { rows: 0, da: 0, dab: 0 }
    const rows = Number(row.rows)
    bestSample = Math.max(bestSample, rows)
    if (rows < MIN_ROWS_FOR_DESIGN_CLAIM) continue

    const da = Number(row.da)
    const dab = Number(row.dab)
    // Functional mapping, allowing one stray combination.
    if (da > 1 && dab <= da + 1) {
      return { outcome: 'co_varying', detail: `${table}.${a} determines ${table}.${b}` }
    }
  }

  if (bestSample < MIN_ROWS_FOR_DESIGN_CLAIM) {
    throw new Error(
      `insufficient sample: largest candidate table has ${bestSample} rows, ` +
      `need ${MIN_ROWS_FOR_DESIGN_CLAIM}`,
    )
  }

  return { outcome: 'independent' }
}

// ── 4. Write statement shapes (CONDITIONAL — raises only) ────────────────────

/**
 * How many distinct write statement shapes target these tables?
 *
 * RAISES `split_brain_writers` and cannot confirm it. Several distinct write
 * shapes against one table is consistent with two writers disagreeing, and
 * equally consistent with one application having several code paths. Nothing in
 * `pg_stat_statements` separates those.
 *
 * The inventory records why the probe that WOULD confirm it is inadmissible:
 * deciding which tables an `AiFunction` writes needs AST analysis of
 * `generatedCode`, this repository has no AST tooling, and `triggerTable`
 * records what fires a function rather than what it writes. String-scanning
 * arbitrary JavaScript would count a table named in a comment as a write.
 */
export const writeStatementShapes: ProbeFn = async ctx => {
  const tables = members(ctx)

  const ext = await queryWorkspaceSchema(
    ctx.projectId,
    `SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_stat_statements' LIMIT 1`,
  ).catch(() => null)

  if (!ext || rowsOf(ext).length === 0) {
    // Absent extension is not "one writer". It is no measurement at all.
    throw new Error('pg_stat_statements is not installed')
  }

  const schema = `workspace_${ctx.projectId}`
  const res = await queryWorkspaceSchema(
    ctx.projectId,
    `SELECT query FROM pg_stat_statements WHERE query ILIKE '%' || $1 || '%' LIMIT 500`,
    schema,
  ).catch((err: unknown) => {
    throw new Error(`pg_stat_statements unreadable: ${err instanceof Error ? err.message : String(err)}`)
  })

  const writes = rowsOf(res)
    .map((r: any) => String(r.query ?? ''))
    .filter(q => /\b(INSERT|UPDATE|DELETE)\b/i.test(q))
    .filter(q => tables.some(t => new RegExp(`\\b${t}\\b`).test(q)))

  const shapes = new Set(writes.map(q => q.replace(/\s+/g, ' ').slice(0, 160)))
  if (shapes.size > 2) {
    return { outcome: 'multiple_writers', detail: `${shapes.size} distinct write shapes` }
  }
  return { outcome: 'single_writer', detail: `${shapes.size} distinct write shapes` }
}

// ── Coverage ─────────────────────────────────────────────────────────────────

/**
 * What the instruments could actually see, independent of what they concluded.
 *
 * Reported ALONGSIDE the verdict and never folded into it. "Policy duplication
 * likely" and "statement telemetry unavailable" are different facts, and
 * multiplying them into one confidence number destroys the second — which is
 * precisely the number Phase 5 needs in order to refuse to plan.
 */
export interface EvidenceCoverage {
  policiesReadable: boolean
  constraintCatalogReadable: boolean
  statementTelemetryAvailable: boolean
  /** Largest candidate table, against MIN_ROWS_FOR_DESIGN_CLAIM. */
  largestSampleRows: number
  sampleSufficient: boolean
  notes: string[]
}

export async function assessStructuralCoverage(ctx: ProbeContext): Promise<EvidenceCoverage> {
  const notes: string[] = []
  const schema = `workspace_${ctx.projectId}`
  const tables = ((ctx as { membership?: string[] }).membership ?? []).filter(t => IDENT.test(t))

  const policiesReadable = await queryWorkspaceSchema(
    ctx.projectId,
    `SELECT 1 AS ok FROM pg_policies WHERE schemaname = $1 LIMIT 1`,
    schema,
  ).then(() => true).catch(() => false)
  if (!policiesReadable) notes.push('pg_policies could not be read')

  const constraintCatalogReadable = await queryWorkspaceSchema(
    ctx.projectId,
    `SELECT 1 AS ok FROM information_schema.table_constraints WHERE table_schema = $1 LIMIT 1`,
    schema,
  ).then(() => true).catch(() => false)
  if (!constraintCatalogReadable) notes.push('constraint catalog could not be read')

  const statementTelemetryAvailable = await queryWorkspaceSchema(
    ctx.projectId,
    `SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_stat_statements' LIMIT 1`,
  ).then(r => rowsOf(r).length > 0).catch(() => false)
  if (!statementTelemetryAvailable) {
    notes.push('pg_stat_statements absent — split_brain_writers cannot be raised')
  }

  let largestSampleRows = 0
  if (tables.length > 0) {
    const res = await queryWorkspaceSchema(
      ctx.projectId,
      `SELECT max(c.reltuples)::bigint AS n
         FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relkind = 'r'`,
      schema,
      tables,
    ).catch(() => null)
    const n = Number(rowsOf(res)[0]?.n ?? 0)
    largestSampleRows = Number.isFinite(n) && n > 0 ? n : 0
  }
  const sampleSufficient = largestSampleRows >= MIN_ROWS_FOR_DESIGN_CLAIM
  if (!sampleSufficient) {
    notes.push(
      `largest table ~${largestSampleRows} rows, below ${MIN_ROWS_FOR_DESIGN_CLAIM} — ` +
      'duplicated_lifecycle_state cannot be decided',
    )
  }

  return {
    policiesReadable,
    constraintCatalogReadable,
    statementTelemetryAvailable,
    largestSampleRows,
    sampleSufficient,
    notes,
  }
}

export const STRUCTURAL_PROBES: Record<string, ProbeFn> = {
  policy_overlap: policyOverlap,
  constraint_coverage: constraintCoverage,
  column_covariation: columnCoVariation,
  write_statement_shapes: writeStatementShapes,
}
