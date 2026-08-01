/**
 * Security probe fixtures — prove the four highest-stakes detectors can FIRE.
 *
 * ── Why these four, and why now ─────────────────────────────────────────────
 *
 * `lib/autonomy/sensor-health.ts` states the rule this file exists to satisfy:
 * a probe is not trusted because it ran quietly, it is trusted once it has been
 * OBSERVED producing a finding. Until then its silence is `unverified`, because
 * "no findings" and "cannot detect findings" are the same value.
 *
 * Measured on production 2026-07-31, only two of ~19 invariant probes had ever
 * been recorded firing, and CI's fixtures covered three more. Every detector
 * below was in the unverified majority — including `detectMissingRls`, which
 * really did sit dead in every environment for months behind a duplicate bind
 * parameter and a swallowing catch, while the dashboard rendered green.
 *
 * These four are the ones where being wrong is a data breach or a total outage:
 *
 *   detectMissingRls           a table any API key can read in full
 *   detectOverPermissiveRls    RLS on, policy USING(true) — protection is theatre
 *   detectRlsDeniesEverything  RLS on, zero policies — the table is dead, not safe
 *   detectUnregisteredSchema   the whole /db/* plane down for one project
 *
 * ── How these are built ─────────────────────────────────────────────────────
 *
 * Each constructs the violating state directly in a real PostgreSQL, asserts the
 * probe fires on it, then asserts it goes quiet once the violation is repaired.
 * Both halves are load-bearing: a detector that always fires is as useless as
 * one that never does, and only the second half distinguishes them.
 *
 * NOTHING here is stubbed. The probes under test ARE the SQL, so a mock would
 * assert that the mock works — the exact vacuity that let a negative probe test
 * pass against a stub before. Per AGENTS.md the database is never mocked.
 *
 * Reachability is granted EXPLICITLY rather than inherited from the environment.
 * Both RLS probes gate on "can a client role actually reach this table?", with a
 * fallback that treats a database with no `anon`/`authenticated` roles as
 * reachable. CI has no such roles and would take the fallback; the production
 * cluster has them and would not. A fixture that passed only via the fallback
 * would prove the probe fires in CI and say nothing about production, so the
 * roles and grants are created here and the real branch is the one tested.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

import { detectMissingRls, detectRlsDeniesEverything } from '@/lib/services/workspace-observer'
import { detectOverPermissiveRls } from '@/lib/core/drift-detector'
import { detectUnregisteredSchema } from '@/lib/autonomy/schema-registration'

const prisma = new PrismaClient()

let projectId: string
let userId: string
let schema: string

const q = (sql: string) => prisma.$executeRawUnsafe(sql)

/** Find the finding for one table, ignoring whatever else the schema contains. */
const forTable = (findings: Array<{ details?: unknown }>, table: string) =>
  findings.find((f) => (f.details as any)?.tableName === table)

/**
 * Create a table that a client role can genuinely reach — the precondition both
 * RLS probes check before reporting anything.
 */
async function createReachableTable(table: string, columns: string) {
  await q(`CREATE TABLE "${schema}"."${table}" (${columns})`)
  await q(`GRANT SELECT ON "${schema}"."${table}" TO anon, authenticated`)
}

beforeAll(async () => {
  userId = randomUUID()
  projectId = randomUUID()
  schema = `workspace_${projectId}`

  await prisma.user.create({
    data: {
      id: userId,
      email: `security-probes+${userId.slice(0, 8)}@backenly.test`,
      name: 'security probe fixtures',
      password: 'not-a-real-hash',
    },
  })
  await prisma.project.create({
    data: { id: projectId, name: 'security-probe-fixtures', userId },
  })

  // The data-plane roles. Created only when absent so this is a no-op on a
  // cluster that already has them (production) and a real setup step on one that
  // does not (CI). They are cluster-wide, so they are deliberately NOT dropped in
  // teardown — removing a role production depends on would be catastrophic, and
  // every grant made here is scoped to a schema that IS dropped.
  await q(`DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_authenticator') THEN
        CREATE ROLE backenly_authenticator NOLOGIN;
      END IF;
    END $$;`)

  await q(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await q(`GRANT USAGE ON SCHEMA "${schema}" TO anon, authenticated`)

  // The REAL registry reader, not a stand-in. It resolves to '' when the
  // authenticator role carries no pgrst.db_schemas setting, which is exactly the
  // unregistered state the probe must catch. Installing the genuine function
  // matters: a hand-written stub would be asserting against itself.
  await q(`
    CREATE OR REPLACE FUNCTION public.backenly_pgrst_current_schemas()
    RETURNS text
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $fn$
      SELECT COALESCE(
        split_part(
          (SELECT s.setting
             FROM pg_db_role_setting r
             CROSS JOIN LATERAL unnest(r.setconfig) AS s(setting)
            WHERE r.setrole = (SELECT oid FROM pg_roles WHERE rolname = 'backenly_authenticator')
              AND s.setting LIKE 'pgrst.db_schemas=%'
            LIMIT 1),
          '=', 2),
        '')
    $fn$;`)
}, 120_000)

afterAll(async () => {
  await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
  await prisma.$disconnect()
}, 120_000)

// ── user_data_is_rls_protected ───────────────────────────────────────────────

describe('detectMissingRls', () => {
  const table = 'orders'

  it('FIRES for a client-reachable table with RLS off', async () => {
    await createReachableTable(table, 'id uuid PRIMARY KEY, user_id uuid, total numeric')

    const findings = await detectMissingRls(projectId)
    const hit = forTable(findings, table)

    expect(hit).toBeDefined()
    expect(hit!.type).toBe('missing_rls')
  }, 120_000)

  it('FIRES for a table with NO ownership column, which the old query missed', async () => {
    // The probe used to require user_id/owner_id, on the reasoning that a table
    // without one is not user data. Under PostgREST exposure is decided by
    // grants alone, so `products` with RLS off is fully readable by anyone
    // holding an API key and the old query said nothing. This is that case.
    const products = 'products'
    await createReachableTable(products, 'id uuid PRIMARY KEY, name text, price numeric')

    expect(forTable(await detectMissingRls(projectId), products)).toBeDefined()
  }, 120_000)

  it('goes QUIET once RLS is enabled on that table', async () => {
    await q(`ALTER TABLE "${schema}"."${table}" ENABLE ROW LEVEL SECURITY`)

    expect(forTable(await detectMissingRls(projectId), table)).toBeUndefined()
  }, 120_000)

  it('never reports the platform-managed users table', async () => {
    // `users` holds end-user credentials and is revoked from the data-plane
    // roles by design, so it is excluded by name. Flagging it would put a
    // permanent un-actionable critical on every project.
    await q(`CREATE TABLE "${schema}"."users" (id uuid PRIMARY KEY, email text, password text)`)

    expect(forTable(await detectMissingRls(projectId), 'users')).toBeUndefined()
  }, 120_000)

  it('never reports underscore-prefixed platform internals', async () => {
    await q(`CREATE TABLE "${schema}"."_token_blacklist" (id uuid PRIMARY KEY, token text)`)
    await q(`GRANT SELECT ON "${schema}"."_token_blacklist" TO anon`)

    expect(forTable(await detectMissingRls(projectId), '_token_blacklist')).toBeUndefined()
  }, 120_000)
})

// ── rls_is_not_deny_all ──────────────────────────────────────────────────────

describe('detectRlsDeniesEverything', () => {
  const table = 'invoices'

  it('FIRES for a table with RLS enabled and zero policies', async () => {
    // PostgreSQL denies by default, so this table answers 200 with an empty
    // array for every end-user read. It looks identical to "the user has no
    // data" from every surface except the one that matters.
    await createReachableTable(table, 'id uuid PRIMARY KEY, user_id uuid, amount numeric')
    await q(`ALTER TABLE "${schema}"."${table}" ENABLE ROW LEVEL SECURITY`)

    const hit = forTable(await detectRlsDeniesEverything(projectId), table)

    expect(hit).toBeDefined()
    expect(hit!.type).toBe('rls_denies_everything')
    expect(hit!.severity).toBe('critical')
  }, 120_000)

  it('goes QUIET once any policy exists', async () => {
    await q(`
      CREATE POLICY invoices_own_rows ON "${schema}"."${table}"
      FOR SELECT TO authenticated
      USING (user_id::text = current_setting('request.jwt.claims', true)::json->>'sub')`)

    expect(forTable(await detectRlsDeniesEverything(projectId), table)).toBeUndefined()
  }, 120_000)

  it('stays silent for a table with RLS off entirely', async () => {
    // RLS off is a DIFFERENT fault, owned by detectMissingRls. This probe must
    // not double-report it, or one condition produces two findings and two
    // competing repairs.
    const open = 'public_notices'
    await createReachableTable(open, 'id uuid PRIMARY KEY, body text')

    expect(forTable(await detectRlsDeniesEverything(projectId), open)).toBeUndefined()
  }, 120_000)
})

// ── rls_policies_are_not_wide_open ───────────────────────────────────────────

describe('detectOverPermissiveRls', () => {
  const table = 'documents'

  it('FIRES for a policy that exposes every row via USING (true)', async () => {
    // The misconfiguration a missing-RLS check structurally cannot catch: the
    // table reports RLS enabled in every dashboard while serving every row to
    // everyone.
    await createReachableTable(table, 'id uuid PRIMARY KEY, user_id uuid, body text')
    await q(`ALTER TABLE "${schema}"."${table}" ENABLE ROW LEVEL SECURITY`)
    await q(`CREATE POLICY documents_wide_open ON "${schema}"."${table}"
             FOR SELECT TO authenticated USING (true)`)

    const hit = forTable(await detectOverPermissiveRls(projectId), table)

    expect(hit).toBeDefined()
    expect(hit!.type).toBe('rls_expression_invalid')
    expect((hit!.details as any).policyName).toBe('documents_wide_open')
  }, 120_000)

  it('goes QUIET once the policy is scoped to the row owner', async () => {
    await q(`DROP POLICY documents_wide_open ON "${schema}"."${table}"`)
    await q(`
      CREATE POLICY documents_own_rows ON "${schema}"."${table}"
      FOR SELECT TO authenticated
      USING (user_id::text = current_setting('request.jwt.claims', true)::json->>'sub')`)

    expect(forTable(await detectOverPermissiveRls(projectId), table)).toBeUndefined()
  }, 120_000)

  it('does NOT flag the platform own-credential pass-through roles', async () => {
    // Regression guard for a real production incident (2026-07-20): the probe
    // flagged the bkn_* direct-access policies, which exist BY DESIGN and are
    // the project owner's own credential. The queued "auto-safe" repair could
    // never remove them — correctly — so every attempt failed verification and
    // escalated. Nine false approvals in one day. A USING(true) policy is only
    // an exposure if it reaches a principal the request path can run as.
    const direct = 'ledger_entries'
    await createReachableTable(direct, 'id uuid PRIMARY KEY, user_id uuid, memo text')
    await q(`ALTER TABLE "${schema}"."${direct}" ENABLE ROW LEVEL SECURITY`)
    await q(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bkn_probe_fixture_ro') THEN
          CREATE ROLE bkn_probe_fixture_ro NOLOGIN;
        END IF;
      END $$;`)
    await q(`GRANT USAGE ON SCHEMA "${schema}" TO bkn_probe_fixture_ro`)
    await q(`GRANT SELECT ON "${schema}"."${direct}" TO bkn_probe_fixture_ro`)
    await q(`CREATE POLICY ledger_direct_read ON "${schema}"."${direct}"
             FOR SELECT TO bkn_probe_fixture_ro USING (true)`)

    expect(forTable(await detectOverPermissiveRls(projectId), direct)).toBeUndefined()

    await q(`DROP POLICY ledger_direct_read ON "${schema}"."${direct}"`)
    await q(`REVOKE ALL ON "${schema}"."${direct}" FROM bkn_probe_fixture_ro`)
    await q(`REVOKE ALL ON SCHEMA "${schema}" FROM bkn_probe_fixture_ro`)
    await q(`DROP ROLE IF EXISTS bkn_probe_fixture_ro`).catch(() => {})
  }, 120_000)
})

// ── data_plane_is_registered ─────────────────────────────────────────────────

describe('detectUnregisteredSchema', () => {
  it('FIRES when the schema exists but PostgREST was never told about it', async () => {
    // The quiet half of the data-plane fault: every /db/* request for this one
    // project answers PGRST106 while /auth/* and /fn/* keep working on the
    // Express runtime, so nothing else looks wrong. Five of nine production
    // schemas were in this state, and a customer found it, not the platform.
    const findings = await detectUnregisteredSchema(projectId)

    expect(findings).toHaveLength(1)
    expect(findings[0].type).toBe('schema_not_registered')
    expect(findings[0].severity).toBe('critical')
    expect((findings[0].details as any).schema).toBe(schema)
    // Auto-fixable is what lets the loop restore the plane without a human.
    expect(findings[0].autoFixable).toBe(true)
  }, 120_000)

  it('counts the tables that are actually dark', async () => {
    const detail = (await detectUnregisteredSchema(projectId))[0].details as any
    // Underscore-prefixed internals are excluded from the count — the number is
    // meant to say how much of the customer's API is down.
    expect(detail.tableCount).toBeGreaterThan(0)
    expect(detail.reason).toContain('PGRST106')
  }, 120_000)

  it('goes QUIET once the schema is on the exposed list', async () => {
    await q(`ALTER ROLE backenly_authenticator SET pgrst.db_schemas = '${schema}'`)

    expect(await detectUnregisteredSchema(projectId)).toHaveLength(0)
  }, 120_000)

  it('is not fooled by a schema whose name is a prefix of a registered one', async () => {
    // Substring matching would read `workspace_abc` as present because
    // `workspace_abcdef` is. The comparison is against the comma-delimited list
    // for exactly this reason, and this is the case that distinguishes them.
    await q(`ALTER ROLE backenly_authenticator SET pgrst.db_schemas = '${schema}_extra'`)

    const findings = await detectUnregisteredSchema(projectId)
    expect(findings).toHaveLength(1)

    await q(`ALTER ROLE backenly_authenticator RESET pgrst.db_schemas`)
  }, 120_000)

  it('stays silent for a project whose schema was never provisioned', async () => {
    // Not-yet-provisioned is a correct state, not an outage. Reporting it would
    // put a critical on every project between creation and first build.
    const ghost = randomUUID()
    expect(await detectUnregisteredSchema(ghost)).toHaveLength(0)
  }, 120_000)
})
