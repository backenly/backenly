/**
 * CARRY CONSTRAINTS — give the new column the old column's domain
 * ===============================================================
 *
 * Expand/contract replaces one column with another. `add_structure` creates the
 * target as a bare column, and if nothing ever gives it the source's
 * constraints then `contract` drops a constrained column and leaves an
 * unconstrained one. The migration reports success and the schema is weaker
 * than it was — silently, because every rung passed.
 *
 * Found in production on 2026-09-16. `sessions.status` carried
 * `CHECK (status IN ('active','archived','pending'))`; the ladder added
 * `lifecycle_state text` with no constraint at all.
 *
 * ── The domain is TRANSFORMED, never copied ─────────────────────────────────
 *
 * The obvious implementation copies the source's CHECK onto the target, and it
 * is wrong. The target holds `transform(source)`, so for `upper` the source
 * domain `{active, archived, pending}` becomes `{ACTIVE, ARCHIVED, PENDING}`.
 * A verbatim copy would reject every value the dual-write trigger writes, and
 * because that trigger swallows its own exceptions the rejection would be
 * invisible: writes would keep succeeding with the target left unset.
 *
 * So the target's domain is computed by applying the transform to each member
 * of the source's domain, using `transformValue` — the same Transform
 * definition the writer and the checker already share.
 *
 * ── And the caller must have said the same thing ────────────────────────────
 *
 * The computed domain is then required to EQUAL the domain the binding
 * declares. The operator states the target's allowed values as typed data; this
 * derives them independently from the catalog; a disagreement refuses.
 *
 * That is the point of the rung. A derivation nobody checked is a guess with
 * extra steps, and a declaration nobody derived is a value someone typed. Only
 * the agreement of two independent routes to the same answer is evidence, which
 * is the same reason reconciliation recomputes rather than trusts.
 *
 * ── Placed before dual_write, deliberately ──────────────────────────────────
 *
 * Immediately after `add_structure`, so the catalog never comes to rest with an
 * unconstrained state column. It is not only a tidiness argument: the structural
 * diagnosis reads the live catalog, an unconstrained state column raises
 * `missing_constraint_permits_invalid_state`, and a ladder that halts mid-run
 * for a backfill could not be resumed because its own expand rung had changed
 * the diagnosis underneath it. The ladder blocked itself.
 *
 * Running here is also when validation is cheapest: the target is entirely NULL
 * before the backfill, and NULL satisfies a CHECK.
 */

import { prisma } from '@/lib/db'
import { queryWorkspaceAsOwner, resolveWorkspaceSchema } from '@/lib/services/workspace-pool'
import { asciiOnly, sqlLiteral, transformValue, type Transform } from '../transform'

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface CarryConstraintsInput {
  projectId: string
  table: string
  sourceColumn: string
  targetColumn: string
  transform: Transform
  /** The target's domain, as the operator declares it. Checked, never trusted. */
  allowedValues: string[]
}

export interface CarryConstraintsResult {
  applied: boolean
  refusal?: string
  constraintName?: string
  /** The source's declared domain, read from the catalog. */
  sourceDomain?: string[]
  /** That domain with the transform applied — what was actually written. */
  derivedDomain?: string[]
}

/**
 * The source column's CHECK constraints, as PostgreSQL renders them.
 *
 * `pg_get_constraintdef` rather than the raw `consrc`, which was removed in
 * PostgreSQL 12 and would silently return nothing on every supported version.
 */
async function sourceChecks(schema: string, table: string, column: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ def: string }>>(
    `SELECT pg_get_constraintdef(co.oid) AS def
       FROM pg_constraint co
       JOIN pg_class c ON c.oid = co.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = $2
        AND co.contype = 'c'
        AND EXISTS (
          SELECT 1 FROM unnest(co.conkey) AS k(attnum)
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
          WHERE a.attname = $3
        )`,
    schema,
    table,
    column,
  )
  return rows.map(r => r.def)
}

/**
 * The enumerable domain a CHECK declares, or null when it is not enumerable.
 *
 * PostgreSQL renders `x IN ('a','b')` as `((x)::text = ANY ((ARRAY['a'::text,
 * 'b'::text])::text[]))`. Only that shape is read. Anything else — a range, a
 * regex, a function call, a multi-column condition — returns null and the rung
 * refuses rather than guessing at a domain it cannot enumerate.
 */
export function enumerableDomain(constraintDef: string): string[] | null {
  // [\s\S] rather than the `s` flag, which this tsconfig's target predates.
  const arrayPart = /ARRAY\[([\s\S]*?)\]/.exec(constraintDef)
  if (!arrayPart) return null

  const values: string[] = []
  // Single-quoted literals, with '' as the escaped quote, each optionally cast.
  const literal = /'((?:[^']|'')*)'/g
  let m: RegExpExecArray | null
  while ((m = literal.exec(arrayPart[1])) !== null) {
    values.push(m[1].replace(/''/g, "'"))
  }
  return values.length > 0 ? values : null
}

export async function carryConstraints(
  input: CarryConstraintsInput,
): Promise<CarryConstraintsResult> {
  const { projectId, table, sourceColumn, targetColumn, transform, allowedValues } = input

  for (const [what, id] of [
    ['table', table],
    ['source column', sourceColumn],
    ['target column', targetColumn],
  ] as const) {
    if (!IDENT.test(id)) return { applied: false, refusal: `${what} is not a plain identifier: ${id}` }
  }

  const schema = await resolveWorkspaceSchema(projectId)

  // ── The source's domain, from the catalog ──────────────────────────────────
  const checks = await sourceChecks(schema, table, sourceColumn)
  if (checks.length === 0) {
    return {
      applied: false,
      refusal:
        `${table}.${sourceColumn} carries no CHECK constraint, so there is no domain to carry. ` +
        'Nothing is written rather than inventing one.',
    }
  }
  if (checks.length > 1) {
    return {
      applied: false,
      refusal:
        `${table}.${sourceColumn} carries ${checks.length} CHECK constraints (${checks.join(' | ')}). ` +
        'Combining them is a judgement about intent; a person must state the target domain.',
    }
  }

  const sourceDomain = enumerableDomain(checks[0])
  if (!sourceDomain) {
    return {
      applied: false,
      refusal:
        `the domain of ${table}.${sourceColumn} is not an enumerable list: ${checks[0]}. ` +
        'Only an IN-list domain can be transformed member by member.',
    }
  }

  // ── That domain, transformed ───────────────────────────────────────────────
  if ((transform.kind === 'upper' || transform.kind === 'lower') && !sourceDomain.every(asciiOnly)) {
    return {
      applied: false,
      refusal:
        `${table}.${sourceColumn} has non-ASCII values in its domain and the transform is ` +
        `${transform.kind}. PostgreSQL case folding is collation-dependent and this derivation ` +
        'is not, so the two could disagree. A person must state the target domain.',
    }
  }

  const derived: string[] = []
  for (const v of sourceDomain) {
    const out = transformValue(transform, v)
    if (out === null) {
      return {
        applied: false,
        refusal: `the transform maps ${sqlLiteral(v)} to NULL, so the target's domain is not the source's`,
      }
    }
    if (!derived.includes(out)) derived.push(out)
  }

  // ── And the declaration must agree with the derivation ─────────────────────
  const declared = [...new Set(allowedValues)]
  const same =
    declared.length === derived.length && [...derived].sort().every((v, i) => v === [...declared].sort()[i])
  if (!same) {
    return {
      applied: false,
      sourceDomain,
      derivedDomain: derived,
      refusal:
        `the declared target domain {${declared.join(', ')}} is not the source domain ` +
        `{${sourceDomain.join(', ')}} under ${transform.kind}, which gives {${derived.join(', ')}}`,
    }
  }

  // ── Nothing already in the column may violate it ───────────────────────────
  //
  // AS OWNER: the product enables RLS on every table it creates, and an
  // unclaimed read counts zero rows on a full table — which would report "no
  // violations" for a column never looked at.
  const violating = await queryWorkspaceAsOwner<{ n: bigint }>(
    projectId,
    `SELECT count(*)::bigint AS n FROM "${schema}"."${table}"
      WHERE "${targetColumn}" IS NOT NULL
        AND "${targetColumn}" NOT IN (${derived.map(sqlLiteral).join(', ')})`,
  )
  const bad = Number(violating[0]?.n ?? 0)
  if (bad > 0) {
    return {
      applied: false,
      sourceDomain,
      derivedDomain: derived,
      refusal: `${bad} existing row(s) in ${table}.${targetColumn} fall outside the derived domain`,
    }
  }

  const constraintName = `bkn_cc_${table}_${targetColumn}`
  const existing = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
    `SELECT co.conname FROM pg_constraint co
       JOIN pg_class c ON c.oid = co.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND co.conname = $3`,
    schema,
    table,
    constraintName,
  )
  if (existing.length > 0) {
    return { applied: true, constraintName, sourceDomain, derivedDomain: derived }
  }

  // The product's own verb, the same one that created the source constraint.
  // Same call shape as `add-structure.ts`: one action, replanning OFF. The
  // sixth argument is what stops a failed constraint being turned into some
  // other action — replanning reached for "I don't know how to undefined" the
  // first time this was called with the wrong argument shape.
  const { executeAction } = await import('@/lib/ai/minimal-executor')
  const expression = `"${targetColumn}" IN (${derived.map(sqlLiteral).join(', ')})`
  const result = await executeAction(
    {
      action: 'ADD_CONSTRAINT',
      params: { tableName: table, columnName: targetColumn, constraintType: 'check', constraintName, expression },
    } as never,
    projectId,
    undefined,
    0,
    undefined,
    false,
  )
  if (!(result as { success?: boolean })?.success) {
    const r = result as { message?: string; error?: string }
    return {
      applied: false,
      sourceDomain,
      derivedDomain: derived,
      refusal: `ADD_CONSTRAINT refused: ${r?.error ?? r?.message ?? 'unknown'}`,
    }
  }

  // Proved from the catalog, not from the verb's return value.
  const after = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
    `SELECT co.conname FROM pg_constraint co
       JOIN pg_class c ON c.oid = co.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND co.conname = $3 AND co.contype = 'c'`,
    schema,
    table,
    constraintName,
  )
  if (after.length === 0) {
    return {
      applied: false,
      sourceDomain,
      derivedDomain: derived,
      refusal: 'ADD_CONSTRAINT reported no error but pg_constraint has no such constraint',
    }
  }

  return { applied: true, constraintName, sourceDomain, derivedDomain: derived }
}
