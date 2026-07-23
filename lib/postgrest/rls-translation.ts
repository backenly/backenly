/**
 * PHASE 3 — RLS translation for the PostgREST data plane.
 *
 * Today every workspace policy is written against GUCs this platform sets by
 * hand before running a query:
 *
 *   current_setting('app.is_service_role', true) = 'true'
 *     OR user_id::text = current_setting('app.current_user_id', true)
 *
 * PostgREST does not set those. It validates the JWT itself and exposes the
 * claims as a single JSON GUC, `request.jwt.claims`, so the same rule becomes:
 *
 *   jwt_claim('role') = 'service_role'
 *     OR user_id::text = jwt_claim('sub')
 *
 * This is the highest-risk step of the whole migration. A mistranslation does
 * not fail loudly — it silently widens a policy, and a widened own-rows policy
 * is cross-tenant data exposure. So the translation is a pure, unit-tested
 * function, and the emitted policies are exercised by fixtures that assert one
 * user CANNOT see another's rows. Isolation is proven, never assumed.
 *
 * DESIGN NOTES
 *
 * 1. `nullif(..., '')` before the ::json cast is mandatory. An anonymous request
 *    leaves `request.jwt.claims` as the empty string, and ''::json raises
 *    22P02 — which surfaces as a query error rather than "no rows", turning an
 *    unauthenticated read into a 500 instead of an empty result.
 *
 * 2. Claims are read through a SECURITY-INVOKER helper rather than inlined, so
 *    the shape lives in exactly one place. Fixing a claim bug in fifty inlined
 *    policies is how a partial migration leaves half a schema exposed.
 *
 * 3. The service-role escape is preserved. Owner tooling (seeding, migrations,
 *    the MCP db_* tools) depends on it, and dropping it would break the build
 *    plane while "successfully" migrating the data plane.
 */

/** Claim used as the end-user identity. Matches what the gateway mints. */
export const SUBJECT_CLAIM = 'sub'
/** Claim carrying the role. `service_role` bypasses row filtering. */
export const ROLE_CLAIM = 'role'
export const SERVICE_ROLE = 'service_role'

/** Helper installed once per workspace schema; keeps claim access in one place. */
export const JWT_CLAIM_FN = 'backenly_jwt_claim'

/**
 * SQL for the per-schema claim reader.
 *
 * STABLE (not IMMUTABLE): the value changes between statements as the GUC
 * changes, but is constant within one statement — which is exactly what the
 * planner needs to use it inside a policy without re-evaluating per row.
 */
export function jwtClaimFunctionSql(schema: string): string {
  return `
CREATE OR REPLACE FUNCTION "${schema}"."${JWT_CLAIM_FN}"(claim text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::json ->> claim
$$;
`.trim()
}

/** An expression reading one claim, for use inside a policy. */
export function claimExpr(schema: string, claim: string): string {
  return `"${schema}"."${JWT_CLAIM_FN}"('${claim}')`
}

/** The service-role escape clause. */
export function serviceRoleClause(schema: string): string {
  return `${claimExpr(schema, ROLE_CLAIM)} = '${SERVICE_ROLE}'`
}

/**
 * The own-rows predicate: service role, or the row belongs to the caller.
 *
 * The owner column is cast to text because `sub` arrives as a JSON string;
 * comparing uuid = text directly raises 42883 and would take the policy down.
 */
export function ownRowsPredicate(schema: string, ownerColumn: string): string {
  return `(${serviceRoleClause(schema)} OR ("${ownerColumn}")::text = ${claimExpr(schema, SUBJECT_CLAIM)})`
}

export interface PolicyStatements {
  /** Run in order. Idempotent: drops each policy before creating it. */
  statements: string[]
  policyNames: string[]
}

/**
 * Emit the four own-rows policies for a table, PostgREST-flavoured.
 *
 * FORCE ROW LEVEL SECURITY is retained deliberately: without it the table owner
 * bypasses every policy, and the owner is precisely the role a pooled
 * connection is most likely to be running as.
 */
export function ownRowsPolicies(
  schema: string,
  table: string,
  ownerColumn: string,
): PolicyStatements {
  const pred = ownRowsPredicate(schema, ownerColumn)
  const q = `"${schema}"."${table}"`
  const names = {
    select: `pgrst_own_rows_select`,
    insert: `pgrst_own_rows_insert`,
    update: `pgrst_own_rows_update`,
    delete: `pgrst_own_rows_delete`,
  }

  return {
    policyNames: Object.values(names),
    statements: [
      `ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${q} FORCE ROW LEVEL SECURITY`,
      `DROP POLICY IF EXISTS "${names.select}" ON ${q}`,
      `CREATE POLICY "${names.select}" ON ${q} FOR SELECT USING ${pred}`,
      `DROP POLICY IF EXISTS "${names.insert}" ON ${q}`,
      `CREATE POLICY "${names.insert}" ON ${q} FOR INSERT WITH CHECK ${pred}`,
      `DROP POLICY IF EXISTS "${names.update}" ON ${q}`,
      `CREATE POLICY "${names.update}" ON ${q} FOR UPDATE USING ${pred} WITH CHECK ${pred}`,
      `DROP POLICY IF EXISTS "${names.delete}" ON ${q}`,
      `CREATE POLICY "${names.delete}" ON ${q} FOR DELETE USING ${pred}`,
    ],
  }
}

/**
 * Rewrite an EXISTING policy expression from the app.* GUCs to JWT claims.
 *
 * Used to migrate policies already in the database, where the exact expression
 * varies. Returns `null` when nothing recognisable was found, so the caller can
 * escalate rather than silently leave a policy on the old contract — a policy
 * that still reads `app.current_user_id` under PostgREST matches NOTHING, which
 * looks like "secure" right up until someone notices the table reads empty.
 */
export function translatePolicyExpression(
  expression: string,
  schema: string,
): string | null {
  if (!expression || !expression.trim()) return null

  let out = expression
  let changed = false

  // PostgreSQL renders stored policies with explicit casts on the literals —
  // pg_policies reports `current_setting('app.is_service_role'::text, true)`,
  // not the unadorned form seen in source. Both spellings must match, or the
  // translator silently skips every policy already in the database and reports
  // "nothing to translate" on exactly the policies that need translating.
  const CAST = String.raw`(?:\s*::\s*text)?`

  // current_setting('app.is_service_role', true) = 'true'  →  role claim check
  const serviceRe = new RegExp(
    String.raw`current_setting\(\s*'app\.is_service_role'${CAST}\s*(?:,\s*true\s*)?\)${CAST}\s*=\s*'true'${CAST}`,
    'gi',
  )
  if (serviceRe.test(out)) {
    out = out.replace(serviceRe, serviceRoleClause(schema))
    changed = true
  }

  // current_setting('app.current_user_id', true)  →  sub claim
  const userRe = new RegExp(
    String.raw`current_setting\(\s*'app\.current_user_id'${CAST}\s*(?:,\s*true\s*)?\)`,
    'gi',
  )
  if (userRe.test(out)) {
    out = out.replace(userRe, claimExpr(schema, SUBJECT_CLAIM))
    changed = true
  }

  return changed ? out : null
}

/** True when a policy still depends on GUCs PostgREST will never set. */
export function usesLegacyGucs(expression: string | null | undefined): boolean {
  if (!expression) return false
  return /current_setting\(\s*'app\./i.test(expression)
}
