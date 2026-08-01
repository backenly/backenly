/**
 * SELFOPS-BENCH — the oracle
 * ==========================
 *
 * How a case is graded. Never by asking a probe.
 *
 * Every reading here is taken over a Postgres connection configured exactly the
 * way PostgREST configures one when it serves an end-user request:
 *
 *   SET LOCAL ROLE authenticated;
 *   SELECT set_config('request.jwt.claims', '{"sub":"…","role":"authenticated"}', true);
 *
 * That is not an approximation of the data plane — it IS the data plane's
 * security context. `lib/postgrest/rls-translation.ts` compiles every policy
 * against `request.jwt.claims`, so a policy that passes here passes in
 * production and a policy that leaks here leaks in production.
 *
 * Two things this deliberately does NOT do:
 *
 *   • It does not connect as the owner. Table owners bypass row-level security
 *     unless FORCE ROW LEVEL SECURITY is set, so an owner connection reports a
 *     wide-open table and a locked table identically. Reading as the owner is
 *     the single easiest way to write a security benchmark that always passes.
 *
 *   • It does not treat `permission denied` as "no rows". A missing GRANT and a
 *     working RLS policy both yield zero rows to a careless caller, and they
 *     mean completely different things — one is a broken deployment, the other
 *     is the feature working. They are separate outcomes below.
 *
 * Every read runs inside a transaction that is always rolled back, so grading a
 * backend can never mutate it.
 */

import { Pool, type PoolClient } from 'pg'

/** Roles PostgREST serves requests under. Mirrors scripts/setup-postgrest-roles.ts. */
export type DataPlaneRole = 'anon' | 'authenticated' | 'service_role'

export interface ReadOutcome<T = Record<string, unknown>> {
  /** Rows visible to this identity. Empty when RLS filtered everything out. */
  rows: T[]
  /**
   * True when Postgres refused the statement outright (missing GRANT, missing
   * relation). Distinct from an empty result, which is RLS doing its job.
   */
  denied: boolean
  /** The raw error, when the statement did not run at all. */
  error?: string
}

let pool: Pool | null = null

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.BENCH_DATABASE_URL || process.env.DATABASE_URL
    if (!connectionString) {
      throw new Error(
        'selfops-bench needs a database. Set BENCH_DATABASE_URL (preferred — it keeps the ' +
        'benchmark off any database you care about) or DATABASE_URL.',
      )
    }
    pool = new Pool({ connectionString, max: 8 })
  }
  return pool
}

export async function closeOracle(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => {})
    pool = null
  }
}

/** Run a statement as the schema owner. Fixture construction only — never grading. */
export async function ownerExec(statement: string, params: unknown[] = []): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query(statement, params)
  } finally {
    client.release()
  }
}

/** Query as the schema owner. Fixture construction only — never grading. */
export async function ownerQuery<T = Record<string, unknown>>(
  statement: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await getPool().connect()
  try {
    const res = await client.query(statement, params)
    return res.rows as T[]
  } finally {
    client.release()
  }
}

/**
 * Make sure the three PostgREST roles exist and that the benchmark's connection
 * may assume them.
 *
 * The bench must be able to run against a bare Postgres (a CI service
 * container) as well as against a full platform database where
 * scripts/setup-postgrest-roles.ts has already run. Both are idempotent here.
 *
 * The GRANT to CURRENT_USER is what lets `SET LOCAL ROLE` work when the bench
 * connects as a non-superuser. Without it the oracle would fail closed on every
 * case and the suite would report a platform-wide outage that is really a
 * harness misconfiguration — so this is loud when it cannot be satisfied.
 */
export async function ensureDataPlaneRoles(): Promise<void> {
  // The application role. Production runs as `backenly_user`, and the PostgREST
  // helper SQL hardcodes it: `backenly_pgrst_prepare_schema` (installed as a
  // CREATE SCHEMA event trigger) executes
  // `ALTER DEFAULT PRIVILEGES FOR ROLE backenly_user`, so on a database where
  // the role is absent, *creating a workspace schema fails outright* and every
  // case dies in provisioning. Creating it here keeps the bench runnable on a
  // bare Postgres while matching the production role graph.
  await ownerExec(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_user') THEN
        CREATE ROLE backenly_user NOLOGIN;
      END IF;
      -- The PostgREST connection role. NOINHERIT is what keeps it powerless: it
      -- may only ACT as anon/authenticated/service_role by switching to them,
      -- never by holding their privileges directly. Re-asserted rather than set
      -- once, exactly as scripts/setup-postgrest-roles.ts does, so a bench
      -- database cannot drift into a weaker posture than production.
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_authenticator') THEN
        CREATE ROLE backenly_authenticator LOGIN NOINHERIT;
      END IF;
    END
    $$;
  `)
  await ownerExec(`ALTER ROLE backenly_authenticator NOINHERIT`)

  const roles: DataPlaneRole[] = ['anon', 'authenticated', 'service_role']
  for (const role of roles) {
    await ownerExec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} NOLOGIN;
        END IF;
      END
      $$;
    `)
    // Superusers can SET ROLE unconditionally; everyone else needs membership.
    await ownerExec(`
      DO $$
      BEGIN
        IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = CURRENT_USER) THEN
          EXECUTE format('GRANT ${role} TO %I', CURRENT_USER);
        END IF;
      END
      $$;
    `)
    await ownerExec(`GRANT ${role} TO backenly_authenticator`)
  }
}

/**
 * Apply the same grants the platform applies to a workspace schema.
 *
 * Deliberately mirrors setup-postgrest-roles.ts INCLUDING its narrowness: `anon`
 * gets SELECT only, and this is applied per-table by the caller rather than as a
 * blanket `ALL TABLES` grant. The blanket form is what handed `anon`
 * unauthenticated SELECT on password hashes during the PostgREST cutover; the
 * benchmark should not quietly reintroduce the exact grant that was the bug.
 */
export async function grantTableAccess(schema: string, table: string): Promise<void> {
  await ownerExec(`GRANT USAGE ON SCHEMA "${schema}" TO anon, authenticated, service_role`)
  await ownerExec(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "${schema}"."${table}" TO authenticated, service_role`,
  )
}

/**
 * Read the backend as a specific end-user identity, exactly as PostgREST would.
 *
 * `sub` is the end-user id that lands in `request.jwt.claims->>'sub'`, which is
 * what every translated own-rows policy compares against.
 */
export async function readAs<T = Record<string, unknown>>(
  identity: { role: DataPlaneRole; sub?: string },
  statement: string,
  params: unknown[] = [],
): Promise<ReadOutcome<T>> {
  const client: PoolClient = await getPool().connect()
  try {
    await client.query('BEGIN')
    // Claims first: SET ROLE drops the privilege needed to set a GUC on some
    // configurations, and PostgREST itself sets claims before switching role.
    const claims = JSON.stringify({
      role: identity.role,
      ...(identity.sub ? { sub: identity.sub } : {}),
    })
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims])
    await client.query(`SET LOCAL ROLE ${identity.role}`)

    const res = await client.query(statement, params)
    return { rows: res.rows as T[], denied: false }
  } catch (err: any) {
    // 42501 insufficient_privilege · 42P01 undefined_table — the statement never
    // ran, so this is emphatically not "zero rows".
    const denied = err?.code === '42501' || err?.code === '42P01'
    return { rows: [], denied, error: err?.message ?? String(err) }
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

/**
 * Attempt a write as an end-user identity. Always rolled back.
 *
 * Needed because read-only grading cannot see a whole class of real faults: a
 * column narrowed to the wrong type, a NOT NULL added under live rows, a policy
 * that permits SELECT but silently blocks INSERT. Those backends read perfectly
 * and are still broken for the customer's app.
 */
export async function writeAs(
  identity: { role: DataPlaneRole; sub?: string },
  statement: string,
  params: unknown[] = [],
): Promise<{ ok: boolean; error?: string; denied: boolean; rowCount: number }> {
  const client: PoolClient = await getPool().connect()
  try {
    await client.query('BEGIN')
    const claims = JSON.stringify({
      role: identity.role,
      ...(identity.sub ? { sub: identity.sub } : {}),
    })
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [claims])
    await client.query(`SET LOCAL ROLE ${identity.role}`)
    const res = await client.query(statement, params)
    // rowCount is load-bearing, not decoration. An UPDATE that RLS filters down
    // to zero rows succeeds — same `ok: true`, same absence of error — as one
    // that rewrote another tenant's data. Without the count, a write-path
    // authorization hole and a correctly-enforced policy are indistinguishable,
    // and the oracle would score the hole as safe.
    return { ok: true, denied: false, rowCount: res.rowCount ?? 0 }
  } catch (err: any) {
    const denied = err?.code === '42501' || err?.code === '42P01'
    return { ok: false, denied, error: err?.message ?? String(err), rowCount: 0 }
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

/**
 * Whether a query against `table` filtered by `column` uses an index.
 *
 * Graded from the planner rather than from pg_indexes, because the fault being
 * measured is "this query got slow", not "a row is missing from a catalog
 * table". An index that exists but that the planner will not use has not fixed
 * anything, and only EXPLAIN can tell the difference.
 *
 * Rows are seeded past the point where a sequential scan is genuinely cheaper,
 * so a Seq Scan here is a real planner preference and not small-table noise.
 */
export async function usesIndexScan(
  schema: string,
  table: string,
  column: string,
  value: unknown,
): Promise<{ indexed: boolean; plan: string }> {
  const rows = await ownerQuery<{ 'QUERY PLAN': any }>(
    `EXPLAIN (FORMAT JSON) SELECT * FROM "${schema}"."${table}" WHERE "${column}" = $1`,
    [value],
  )
  const plan = rows[0]?.['QUERY PLAN']
  const text = JSON.stringify(plan ?? {})
  const nodeType = plan?.[0]?.Plan?.['Node Type'] ?? 'unknown'
  return {
    indexed: /Index Scan|Index Only Scan|Bitmap Index Scan/.test(text),
    plan: nodeType,
  }
}
