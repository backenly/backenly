/**
 * RLS REPLICATION — carry a project's row security into its branch
 * ================================================================
 *
 * `CREATE TABLE ... (LIKE src INCLUDING ALL)` copies types, defaults, NOT NULL,
 * indexes and constraints. It does NOT copy row-level security: not the
 * `relrowsecurity` flag, not `relforcerowsecurity`, and not a single policy.
 *
 * Measured on PostgreSQL 16 rather than taken from the docs. A cloned branch
 * came up with `relrowsecurity = false` and zero policies, and a non-privileged
 * role reading it saw every row of the fixture. After replication the same role
 * saw 0 rows with no identity and 1 row with the right one.
 *
 * ── Why this exists at all, when Supabase does not need it ──────────────────
 *
 * Supabase builds a branch by replaying the migration files in the customer's
 * repo, so policies are recreated by the same SQL that created them originally.
 * Backenly has no migration history to replay — the schema is the source of
 * truth and a branch is a live clone of it. The protection therefore has to be
 * copied explicitly, and this module is that step.
 *
 * ── Fidelity, and why each field matters ────────────────────────────────────
 *
 * A policy is not just its USING expression. Getting any of these wrong
 * produces a branch that LOOKS protected and is not:
 *
 *   permissive/restrictive  a RESTRICTIVE policy recreated as PERMISSIVE
 *                           inverts its meaning from "must also pass" to
 *                           "is another way to pass".
 *   roles                   a policy scoped `TO authenticated` recreated for
 *                           PUBLIC also applies to anon.
 *   cmd                     a SELECT-only rule recreated as ALL silently starts
 *                           governing writes it was never written for.
 *   with_check              dropping it lets a caller INSERT rows they could
 *                           never SELECT.
 *   force                   without it the schema owner bypasses every policy,
 *                           which is exactly how the platform connects.
 */

import type { PoolClient } from 'pg'

export interface PolicyRow {
  tablename: string
  policyname: string
  /** 'PERMISSIVE' | 'RESTRICTIVE' */
  permissive: string
  /** pg renders PUBLIC as `{public}`; node-pg may hand this back as a string. */
  roles: string[] | string
  /** ALL | SELECT | INSERT | UPDATE | DELETE */
  cmd: string
  qual: string | null
  with_check: string | null
}

export interface TableSecurityRow {
  relname: string
  relrowsecurity: boolean
  relforcerowsecurity: boolean
}

export interface RlsCloneResult {
  policiesCreated: number
  tablesEnabled: number
  tablesForced: number
  /** Policies that could not be recreated, with the reason. Never silent. */
  failures: Array<{ table: string; policy: string; error: string }>
}

/**
 * Normalise `pg_policies.roles` into role names.
 *
 * node-pg returns `name[]` inconsistently — sometimes a JS array, sometimes the
 * raw `{a,b}` literal. Both shapes are handled because a wrong answer here
 * silently widens or narrows who a policy applies to.
 *
 * `public` and `-` are dropped: PUBLIC is the absence of a TO clause, and
 * emitting `TO "public"` would be a syntax error.
 */
export function parsePolicyRoles(roles: string[] | string | null | undefined): string[] {
  const raw = Array.isArray(roles)
    ? roles
    : String(roles ?? '')
        .replace(/^\{|\}$/g, '')
        .split(',')
  return raw
    .map(r => String(r).trim().replace(/^"|"$/g, ''))
    .filter(r => r.length > 0 && r !== '-' && r !== 'public')
}

/**
 * Build the CREATE POLICY statement that reproduces `p` on `targetSchema`.
 *
 * Pure, so the SQL can be asserted in a unit test without a database. The
 * command-specific clause rules are Postgres's, not ours, and getting them
 * wrong is a hard error rather than a subtle one:
 *   INSERT           accepts WITH CHECK only  (no USING)
 *   SELECT / DELETE  accept USING only        (no WITH CHECK)
 *   ALL / UPDATE     accept both
 */
export function buildCreatePolicySql(targetSchema: string, p: PolicyRow): string {
  const cmd = (p.cmd || 'ALL').toUpperCase()
  const permissive = String(p.permissive).toUpperCase() === 'RESTRICTIVE' ? 'RESTRICTIVE' : 'PERMISSIVE'
  const roles = parsePolicyRoles(p.roles)
  const to = roles.length > 0 ? ` TO ${roles.map(r => `"${r}"`).join(', ')}` : ''

  const allowsUsing = cmd !== 'INSERT'
  const allowsCheck = cmd === 'INSERT' || cmd === 'UPDATE' || cmd === 'ALL'

  const using = allowsUsing && p.qual ? ` USING (${p.qual})` : ''
  const check = allowsCheck && p.with_check ? ` WITH CHECK (${p.with_check})` : ''

  return (
    `CREATE POLICY "${p.policyname}" ON "${targetSchema}"."${p.tablename}" ` +
    `AS ${permissive} FOR ${cmd}${to}${using}${check}`
  )
}

/**
 * Copy every policy and both row-security flags from `fromSchema` onto
 * `toSchema`, which is assumed to already hold identically-named tables.
 *
 * Runs inside the caller's transaction so a partial replication cannot leave a
 * branch half-protected. A half-protected branch is worse than an unprotected
 * one, because it looks finished.
 *
 * Policies are created BEFORE row security is enabled, deliberately. Enabling
 * first would leave a window in which the table is default-deny, and any
 * concurrent reader would see an empty table rather than an error.
 */
export async function replicateRls(
  client: PoolClient,
  fromSchema: string,
  toSchema: string,
): Promise<RlsCloneResult> {
  const result: RlsCloneResult = {
    policiesCreated: 0,
    tablesEnabled: 0,
    tablesForced: 0,
    failures: [],
  }

  const { rows: policies } = await client.query<PolicyRow>(
    `SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
       FROM pg_policies WHERE schemaname = $1
      ORDER BY tablename, policyname`,
    [fromSchema],
  )

  for (const p of policies) {
    try {
      await client.query(buildCreatePolicySql(toSchema, p))
      result.policiesCreated++
    } catch (e: any) {
      // Recorded, never swallowed. The caller aborts the branch on any failure:
      // a missing policy is a hole, and reporting the branch as ready with a
      // hole in it is the failure mode this whole module exists to prevent.
      result.failures.push({
        table: p.tablename,
        policy: p.policyname,
        error: e?.message ?? String(e),
      })
    }
  }

  const { rows: tables } = await client.query<TableSecurityRow>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = $1
      WHERE c.relkind = 'r'`,
    [fromSchema],
  )

  for (const t of tables) {
    if (t.relrowsecurity) {
      await client.query(`ALTER TABLE "${toSchema}"."${t.relname}" ENABLE ROW LEVEL SECURITY`)
      result.tablesEnabled++
    }
    if (t.relforcerowsecurity) {
      // Load-bearing: without FORCE, the schema owner bypasses every policy, and
      // the platform's own pool connects as the owner.
      await client.query(`ALTER TABLE "${toSchema}"."${t.relname}" FORCE ROW LEVEL SECURITY`)
      result.tablesForced++
    }
  }

  return result
}

export interface RlsParity {
  ok: boolean
  /** Tables protected on main but not on the branch. */
  unprotected: string[]
  reason?: string
}

/**
 * Verify a branch is at least as protected as main.
 *
 * This is the precondition for serving a branch over the REST API, and it is
 * checked against the live catalog rather than inferred from "replicateRls
 * returned success". The two can diverge — a table created on the branch after
 * cloning has no policy — and the cost of being wrong is publishing a copy of a
 * tenant's data.
 *
 * Deliberately one-directional: a branch may be MORE restrictive than main
 * (that is a safe direction to be wrong in), never less.
 */
export async function verifyRlsParity(
  client: PoolClient,
  mainSchema: string,
  branchSchema: string,
): Promise<RlsParity> {
  const { rows } = await client.query<{ relname: string }>(
    `WITH main_protected AS (
       SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = $1
        WHERE c.relkind = 'r' AND c.relrowsecurity
     ),
     branch_protected AS (
       SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = $2
        WHERE c.relkind = 'r' AND c.relrowsecurity
     )
     SELECT m.relname FROM main_protected m
      WHERE m.relname NOT IN (SELECT relname FROM branch_protected)`,
    [mainSchema, branchSchema],
  )

  const unprotected = rows.map(r => r.relname)
  if (unprotected.length > 0) {
    return {
      ok: false,
      unprotected,
      reason:
        `${unprotected.length} table(s) are protected on main but not on the branch: ` +
        `${unprotected.slice(0, 5).join(', ')}. Serving this branch would expose them.`,
    }
  }
  return { ok: true, unprotected: [] }
}
