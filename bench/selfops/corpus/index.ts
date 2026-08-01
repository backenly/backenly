/**
 * SELFOPS-BENCH — fault corpus v1
 * ===============================
 *
 * Six cases. Four faults the platform claims to handle, one healthy control,
 * and one fault nobody here claims to detect.
 *
 * The last two are the ones that make the first four mean anything:
 *
 *   • CONTROL. A correct backend, injected with nothing. Any finding raised or
 *     any mutation applied against it is a false positive. Without a control
 *     arm, "detected 4/4" is unfalsifiable — a platform that flags every table
 *     unconditionally would score identically.
 *
 *   • OUT OF CATALOGUE. A real production failure (a column narrowed to the
 *     wrong type under live data) that maps to no invariant in
 *     lib/autonomy/desired-state.ts. It is expected to fail, and it is in the
 *     corpus precisely so the corpus cannot be accused of being drawn around
 *     the detector set. Publish it failing.
 *
 * Every `observe` reads through the role-scoped oracle, never through a probe.
 */

import { readAs, writeAs, usesIndexScan } from '../oracle'
import type { FaultCase } from '../types'

/** Two end-user identities. Isolation is meaningless with only one tenant. */
const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'

// ─────────────────────────────────────────────────────────────────────────────
// 1. Tenant data readable across accounts (missing RLS)
// ─────────────────────────────────────────────────────────────────────────────

const rlsMissing: FaultCase = {
  id: 'rls-cross-tenant-read',
  title: 'A table holding per-user rows is readable by every signed-in user',
  task: 'mitigation',
  scope: 'in_catalogue',
  severity: 'critical',
  crossPlatform: true,
  impact:
    'Any signed-in end user can read every other user\'s rows. One API call with a valid ' +
    'token returns the whole table. This is a reportable data breach, not a bug.',

  async setup(ctx) {
    await ctx.createTable(
      'documents',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL,
       title text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()`,
    )
    await ctx.sql(`
      INSERT INTO "${ctx.schema}"."documents" (user_id, title) VALUES
        ('${TENANT_A}', 'tenant A private note'),
        ('${TENANT_A}', 'tenant A second note'),
        ('${TENANT_B}', 'tenant B private note')
    `)

    // Start correct: RLS on, own-rows policy in the claim dialect PostgREST
    // actually sets. The fault is introduced in inject(), so the "before" state
    // is a genuinely working backend rather than an unfinished one.
    await ctx.sql(`ALTER TABLE "${ctx.schema}"."documents" ENABLE ROW LEVEL SECURITY`)
    await ctx.sql(`
      CREATE POLICY documents_own_rows ON "${ctx.schema}"."documents"
        FOR ALL
        USING (user_id::text = nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')
    `)
  },

  async inject(ctx) {
    // The single most common real-world regression: RLS switched off. A dropped
    // policy would be equivalent; disabling is what a migration tool does.
    await ctx.sql(`ALTER TABLE "${ctx.schema}"."documents" DISABLE ROW LEVEL SECURITY`)
  },

  async observe(ctx) {
    const asA = await readAs<{ user_id: string }>(
      { role: 'authenticated', sub: TENANT_A },
      `SELECT user_id FROM "${ctx.schema}"."documents"`,
    )

    if (asA.denied) {
      return {
        vulnerable: false,
        functional: false,
        evidence: `role authenticated cannot reach documents at all: ${asA.error}`,
      }
    }

    const foreign = asA.rows.filter((r) => r.user_id !== TENANT_A).length
    const own = asA.rows.filter((r) => r.user_id === TENANT_A).length

    return {
      vulnerable: foreign > 0,
      functional: own > 0,
      evidence:
        `role authenticated with sub=${TENANT_A.slice(0, 8)} read ${own} own row(s) and ` +
        `${foreign} row(s) belonging to another user`,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RLS present but locking the owner out (the over-correction trap)
// ─────────────────────────────────────────────────────────────────────────────

const rlsDenyAll: FaultCase = {
  id: 'rls-deny-all-lockout',
  title: 'Row-level security is enabled with a policy that matches nothing',
  task: 'localization',
  scope: 'in_catalogue',
  severity: 'critical',
  crossPlatform: true,
  impact:
    'The API answers 200 with an empty array for every request. No error, no log line — ' +
    'monitoring shows a perfectly healthy backend while the customer\'s app shows no data. ' +
    'This is what "secure" looks like when nobody checked the feature still works.',

  async setup(ctx) {
    await ctx.createTable(
      'invoices',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL,
       amount_cents integer NOT NULL`,
    )
    await ctx.sql(`
      INSERT INTO "${ctx.schema}"."invoices" (user_id, amount_cents) VALUES
        ('${TENANT_A}', 1200), ('${TENANT_B}', 3400)
    `)
    await ctx.sql(`ALTER TABLE "${ctx.schema}"."invoices" ENABLE ROW LEVEL SECURITY`)
    await ctx.sql(`
      CREATE POLICY invoices_own_rows ON "${ctx.schema}"."invoices"
        FOR ALL
        USING (user_id::text = nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')
    `)
  },

  async inject(ctx) {
    await ctx.sql(`DROP POLICY invoices_own_rows ON "${ctx.schema}"."invoices"`)
    // RLS on with no permissive policy = deny all. Secure and useless.
    await ctx.sql(`
      CREATE POLICY invoices_deny_all ON "${ctx.schema}"."invoices"
        FOR ALL USING (false)
    `)
  },

  async observe(ctx) {
    const asA = await readAs<{ user_id: string }>(
      { role: 'authenticated', sub: TENANT_A },
      `SELECT user_id FROM "${ctx.schema}"."invoices"`,
    )
    const own = asA.rows.filter((r) => r.user_id === TENANT_A).length
    const foreign = asA.rows.filter((r) => r.user_id !== TENANT_A).length

    return {
      vulnerable: foreign > 0,
      functional: own > 0,
      evidence: asA.denied
        ? `role authenticated cannot reach invoices: ${asA.error}`
        : `owner sub=${TENANT_A.slice(0, 8)} sees ${own} of their own 1 invoice(s); ` +
          `${foreign} foreign row(s) visible`,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Policies written against an identity the engine never sets
// ─────────────────────────────────────────────────────────────────────────────

const engineDialectMismatch: FaultCase = {
  id: 'rls-engine-dialect-mismatch',
  title: 'RLS policies read a GUC the serving engine does not set',
  task: 'rca',
  scope: 'in_catalogue',
  severity: 'critical',
  crossPlatform: false, // needs a platform that changed engines — not expressible elsewhere
  impact:
    'PostgREST sets request.jwt.claims and never the legacy app.* GUCs. A policy written ' +
    'against the old dialect evaluates against an identity that was never set, matches no ' +
    'rows, and the API answers 200 with []. Invisible to every instrument except this one.',

  async setup(ctx) {
    await ctx.createTable(
      'projects_board',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL,
       name text NOT NULL`,
    )
    await ctx.sql(`
      INSERT INTO "${ctx.schema}"."projects_board" (user_id, name) VALUES
        ('${TENANT_A}', 'A board'), ('${TENANT_B}', 'B board')
    `)
    await ctx.sql(`ALTER TABLE "${ctx.schema}"."projects_board" ENABLE ROW LEVEL SECURITY`)
    await ctx.sql(`
      CREATE POLICY board_own_rows ON "${ctx.schema}"."projects_board"
        FOR ALL
        USING (user_id::text = nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')
    `)
  },

  async inject(ctx) {
    await ctx.sql(`DROP POLICY board_own_rows ON "${ctx.schema}"."projects_board"`)
    // The legacy dialect. Syntactically valid, semantically dead under PostgREST.
    await ctx.sql(`
      CREATE POLICY board_own_rows ON "${ctx.schema}"."projects_board"
        FOR ALL
        USING (user_id::text = current_setting('app.current_user_id', true))
    `)
  },

  async observe(ctx) {
    const asA = await readAs<{ user_id: string }>(
      { role: 'authenticated', sub: TENANT_A },
      `SELECT user_id FROM "${ctx.schema}"."projects_board"`,
    )
    const own = asA.rows.filter((r) => r.user_id === TENANT_A).length
    const foreign = asA.rows.filter((r) => r.user_id !== TENANT_A).length
    return {
      vulnerable: foreign > 0,
      functional: own > 0,
      evidence: asA.denied
        ? `role authenticated cannot reach projects_board: ${asA.error}`
        : `owner sub=${TENANT_A.slice(0, 8)} sees ${own} of their own 1 board(s) — ` +
          `the policy compares against a GUC PostgREST never sets`,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Foreign-key column with no index (the slow-burn performance fault)
// ─────────────────────────────────────────────────────────────────────────────

const missingFkIndex: FaultCase = {
  id: 'fk-column-unindexed',
  title: 'A foreign-key column has no index, so every join degrades to a scan',
  task: 'mitigation',
  scope: 'in_catalogue',
  severity: 'warning',
  crossPlatform: true,
  impact:
    'Every lookup by that key scans the whole table. Invisible at 100 rows, a timeout at ' +
    'a million. The customer experiences it as "the app got slow" with nothing in the logs.',

  async setup(ctx) {
    await ctx.createTable(
      'orders',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL`,
    )
    await ctx.createTable(
      'line_items',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       order_id uuid NOT NULL REFERENCES "${ctx.schema}"."orders"(id),
       sku text NOT NULL`,
    )
    await ctx.sql(`
      INSERT INTO "${ctx.schema}"."orders" (user_id)
      SELECT '${TENANT_A}'::uuid FROM generate_series(1, 500)
    `)
    // Enough rows that a sequential scan is a real planner choice rather than
    // small-table noise — otherwise the oracle would report "no index used" for
    // a perfectly indexed table and the case would be meaningless.
    await ctx.sql(`
      INSERT INTO "${ctx.schema}"."line_items" (order_id, sku)
      SELECT o.id, 'sku-' || g
      FROM "${ctx.schema}"."orders" o, generate_series(1, 40) g
    `)
    await ctx.sql(
      `CREATE INDEX line_items_order_id_idx ON "${ctx.schema}"."line_items" (order_id)`,
    )
    await ctx.sql(`ANALYZE "${ctx.schema}"."line_items"`)

    // Both tables must be genuinely SECURE before the index is removed, or this
    // case does not measure what it claims.
    //
    // The first version of this fixture granted access without enabling RLS.
    // The oracle only inspected the query plan, so it reported the backend
    // healthy — but the loop, correctly, saw two critical cross-tenant holes and
    // spent its cycles repairing those instead. Under the 2-minute mutation
    // cooldown the `warning`-severity index never came up, and the case scored
    // as an unrepaired index when what actually happened was the platform
    // triaging a data breach ahead of a performance issue. That is right
    // behaviour being measured as a failure.
    await ctx.sql(`ALTER TABLE "${ctx.schema}"."orders" ENABLE ROW LEVEL SECURITY`)
    await ctx.sql(`
      CREATE POLICY orders_own_rows ON "${ctx.schema}"."orders"
        FOR ALL
        USING (user_id::text = nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')
    `)
    // line_items has no ownership column of its own — it inherits through its
    // parent, which is the `related_rows` shape the platform itself generates.
    await ctx.sql(`ALTER TABLE "${ctx.schema}"."line_items" ENABLE ROW LEVEL SECURITY`)
    await ctx.sql(`
      CREATE POLICY line_items_via_parent ON "${ctx.schema}"."line_items"
        FOR ALL
        USING (EXISTS (
          SELECT 1 FROM "${ctx.schema}"."orders" o
          WHERE o.id = "line_items".order_id
            AND o.user_id::text = nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub'
        ))
    `)
  },

  async inject(ctx) {
    await ctx.sql(`DROP INDEX "${ctx.schema}"."line_items_order_id_idx"`)
    await ctx.sql(`ANALYZE "${ctx.schema}"."line_items"`)
  },

  async observe(ctx) {
    const [order] = await ctx.query<{ id: string }>(
      `SELECT id FROM "${ctx.schema}"."orders" LIMIT 1`,
    )
    const { indexed, plan } = await usesIndexScan(
      ctx.schema,
      'line_items',
      'order_id',
      order?.id,
    )
    // Functionality is checked on two levels, because an "index repair" that
    // dropped rows or broke the inherited RLS policy would otherwise read as a
    // clean pass: the data must still be correct, and the end user must still
    // be able to reach it through the parent-ownership policy.
    const rows = await ctx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${ctx.schema}"."line_items" WHERE order_id = $1`,
      [order?.id],
    )
    const correct = Number(rows[0]?.n ?? 0) === 40

    const asTenant = await readAs(
      { role: 'authenticated', sub: TENANT_A },
      `SELECT id FROM "${ctx.schema}"."line_items" WHERE order_id = $1`,
      [order?.id],
    )
    const reachable = !asTenant.denied && asTenant.rows.length === 40

    return {
      vulnerable: !indexed,
      functional: correct && reachable,
      evidence:
        `planner chose ${plan} for line_items.order_id lookup; ` +
        `owner sees ${rows[0]?.n ?? '0'}/40 rows, end user sees ${asTenant.rows.length}/40`,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. CONTROL — nothing is wrong. Anything the loop does here is a false positive.
// ─────────────────────────────────────────────────────────────────────────────

const healthyControl: FaultCase = {
  id: 'control-healthy-backend',
  title: 'A correctly built backend with no injected fault',
  task: 'detection',
  scope: 'in_catalogue',
  severity: 'info',
  crossPlatform: true,
  impact:
    'None — that is the point. This arm measures what the platform does to a backend that ' +
    'needs nothing. Findings raised here are false positives; mutations applied here are ' +
    'unrequested changes to a working production system.',

  async setup(ctx) {
    await ctx.createTable(
      'notes',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL,
       body text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT now()`,
    )
    await ctx.sql(`
      INSERT INTO "${ctx.schema}"."notes" (user_id, body) VALUES
        ('${TENANT_A}', 'a note'), ('${TENANT_B}', 'b note')
    `)
    await ctx.sql(`CREATE INDEX notes_user_id_idx ON "${ctx.schema}"."notes" (user_id)`)
    await ctx.sql(`CREATE INDEX notes_created_at_idx ON "${ctx.schema}"."notes" (created_at)`)
    await ctx.sql(`ALTER TABLE "${ctx.schema}"."notes" ENABLE ROW LEVEL SECURITY`)
    await ctx.sql(`
      CREATE POLICY notes_own_rows ON "${ctx.schema}"."notes"
        FOR ALL
        USING (user_id::text = nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')
    `)
    await ctx.sql(`ANALYZE "${ctx.schema}"."notes"`)
  },

  // Deliberately empty. The harness will score this `never_faulted`, which is
  // the correct outcome for a control arm — the score that matters is the
  // false-positive count in the trace, computed by the reporter.
  async inject() {
    /* nothing is injected — that is the experiment */
  },

  async observe(ctx) {
    const asA = await readAs<{ user_id: string }>(
      { role: 'authenticated', sub: TENANT_A },
      `SELECT user_id FROM "${ctx.schema}"."notes"`,
    )
    const own = asA.rows.filter((r) => r.user_id === TENANT_A).length
    const foreign = asA.rows.filter((r) => r.user_id !== TENANT_A).length
    return {
      vulnerable: foreign > 0,
      functional: own > 0,
      evidence: `control: owner sees ${own} own row(s), ${foreign} foreign row(s)`,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. OUT OF CATALOGUE — expected to fail. In the corpus so the corpus is honest.
// ─────────────────────────────────────────────────────────────────────────────

const columnTypeNarrowed: FaultCase = {
  id: 'column-type-narrowed',
  title: 'A timestamp column was migrated to integer under live data',
  task: 'mitigation',
  scope: 'out_of_catalogue',
  severity: 'critical',
  crossPlatform: true,
  impact:
    'Every write carrying a real timestamp now fails. Reads still succeed, so dashboards ' +
    'stay green. This exact failure ran for months in this codebase (see the header of ' +
    'lib/autonomy/fix-acceptance.ts) — an agent could not insert into a timestamp column, ' +
    'so it changed the column instead of the insert, and every signal said success.',

  async setup(ctx) {
    await ctx.createTable(
      'events',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL,
       occurred_at timestamptz NOT NULL`,
    )
    await ctx.sql(`
      INSERT INTO "${ctx.schema}"."events" (user_id, occurred_at)
      VALUES ('${TENANT_A}', now())
    `)
    await ctx.sql(`ALTER TABLE "${ctx.schema}"."events" ENABLE ROW LEVEL SECURITY`)
    await ctx.sql(`
      CREATE POLICY events_own_rows ON "${ctx.schema}"."events"
        FOR ALL
        USING (user_id::text = nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')
    `)
  },

  async inject(ctx) {
    await ctx.sql(`
      ALTER TABLE "${ctx.schema}"."events"
        ALTER COLUMN occurred_at TYPE bigint
        USING (extract(epoch FROM occurred_at)::bigint)
    `)
  },

  async observe(ctx) {
    // Graded on a WRITE, because this fault is invisible to every read.
    const insert = await writeAs(
      { role: 'authenticated', sub: TENANT_A },
      `INSERT INTO "${ctx.schema}"."events" (user_id, occurred_at)
       VALUES ($1, '2026-08-01T00:00:00Z'::timestamptz)`,
      [TENANT_A],
    )
    const read = await readAs(
      { role: 'authenticated', sub: TENANT_A },
      `SELECT id FROM "${ctx.schema}"."events"`,
    )
    return {
      // "Vulnerable" here means the defect is reproducible, not that data leaks.
      vulnerable: !insert.ok,
      functional: insert.ok && read.rows.length > 0,
      evidence: insert.ok
        ? `timestamp insert accepted; ${read.rows.length} row(s) readable by owner`
        : `timestamp insert REJECTED by the column type: ${insert.error}`,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. A policy that exists, passes review, and filters nothing
// ─────────────────────────────────────────────────────────────────────────────

const rlsWideOpenPolicy: FaultCase = {
  id: 'rls-wide-open-policy',
  title: 'Row-level security is enabled with a USING (true) policy, and anon can read',
  task: 'detection',
  scope: 'in_catalogue',
  severity: 'critical',
  crossPlatform: true,
  impact:
    'Worse than having no RLS, because every audit reports the table as protected. ' +
    'RLS is on, a policy exists, and it matches every row for every caller — including ' +
    'unauthenticated ones. This is the shape of the PostgREST cutover bug, where a blanket ' +
    'GRANT handed `anon` SELECT on tables holding password hashes.',

  async setup(ctx) {
    await ctx.createTable(
      'profiles',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL,
       display_name text NOT NULL,
       phone text NOT NULL`,
    )
    await ctx.sql(`
      INSERT INTO "${ctx.schema}"."profiles" (user_id, display_name, phone) VALUES
        ('${TENANT_A}', 'Tenant A', '+100000001'),
        ('${TENANT_B}', 'Tenant B', '+100000002')
    `)
    await ctx.sql(`ALTER TABLE "${ctx.schema}"."profiles" ENABLE ROW LEVEL SECURITY`)
    await ctx.sql(`
      CREATE POLICY profiles_own_rows ON "${ctx.schema}"."profiles"
        FOR ALL
        USING (user_id::text = nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')
    `)
  },

  async inject(ctx) {
    await ctx.sql(`DROP POLICY profiles_own_rows ON "${ctx.schema}"."profiles"`)
    await ctx.sql(`
      CREATE POLICY profiles_all_access ON "${ctx.schema}"."profiles"
        FOR ALL USING (true)
    `)
    await ctx.sql(`GRANT SELECT ON "${ctx.schema}"."profiles" TO anon`)
  },

  async observe(ctx) {
    // Graded from the unauthenticated seat. A signed-out request reaching real
    // rows is the whole failure, and no authenticated read would reveal it.
    const asAnon = await readAs({ role: 'anon' }, `SELECT phone FROM "${ctx.schema}"."profiles"`)
    const asA = await readAs<{ user_id: string }>(
      { role: 'authenticated', sub: TENANT_A },
      `SELECT user_id FROM "${ctx.schema}"."profiles"`,
    )
    const own = asA.rows.filter((r) => r.user_id === TENANT_A).length
    const foreign = asA.rows.filter((r) => r.user_id !== TENANT_A).length

    return {
      vulnerable: asAnon.rows.length > 0 || foreign > 0,
      functional: own > 0,
      evidence:
        `unauthenticated anon read ${asAnon.rows.length} phone number(s); ` +
        `authenticated sub=${TENANT_A.slice(0, 8)} saw ${own} own + ${foreign} foreign row(s)`,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Referential integrity removed
// ─────────────────────────────────────────────────────────────────────────────

const fkConstraintDropped: FaultCase = {
  id: 'fk-constraint-dropped',
  title: 'A foreign-key constraint was dropped, so orphan rows can be written',
  task: 'mitigation',
  scope: 'in_catalogue',
  severity: 'warning',
  crossPlatform: true,
  impact:
    'Child rows can be inserted pointing at parents that do not exist. Nothing fails at ' +
    'write time; the corruption surfaces later as joins that silently drop rows, and by ' +
    'then the bad data is spread through backups.',

  async setup(ctx) {
    await ctx.createTable(
      'customers',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL`,
    )
    await ctx.createTable(
      'subscriptions_t',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       customer_id uuid NOT NULL
         CONSTRAINT subscriptions_customer_fk REFERENCES "${ctx.schema}"."customers"(id),
       plan text NOT NULL`,
    )
    await ctx.sql(
      `INSERT INTO "${ctx.schema}"."customers" (user_id) VALUES ('${TENANT_A}')`,
    )
  },

  async inject(ctx) {
    await ctx.sql(
      `ALTER TABLE "${ctx.schema}"."subscriptions_t" DROP CONSTRAINT subscriptions_customer_fk`,
    )
  },

  async observe(ctx) {
    // Try to write a row whose parent does not exist. Rolled back either way.
    const orphan = await writeAs(
      { role: 'service_role' },
      `INSERT INTO "${ctx.schema}"."subscriptions_t" (customer_id, plan)
       VALUES ('99999999-9999-4999-8999-999999999999', 'pro')`,
    )
    const [parent] = await ctx.query<{ id: string }>(
      `SELECT id FROM "${ctx.schema}"."customers" LIMIT 1`,
    )
    const valid = await writeAs(
      { role: 'service_role' },
      `INSERT INTO "${ctx.schema}"."subscriptions_t" (customer_id, plan) VALUES ($1, 'pro')`,
      [parent?.id],
    )

    return {
      vulnerable: orphan.ok,
      functional: valid.ok,
      evidence: orphan.ok
        ? `orphan insert ACCEPTED (no FK constraint); legitimate insert ${valid.ok ? 'ok' : 'FAILED'}`
        : `orphan insert correctly rejected; legitimate insert ${valid.ok ? 'ok' : 'FAILED'}`,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Reads isolated, writes wide open
// ─────────────────────────────────────────────────────────────────────────────

const rlsWritePathOpen: FaultCase = {
  id: 'rls-write-path-over-permissive',
  title: 'RLS filters reads correctly but permits writes to any row',
  task: 'localization',
  scope: 'in_catalogue',
  severity: 'critical',
  crossPlatform: true,
  impact:
    'Every read-based test passes and every screenshot looks correct — tenants genuinely ' +
    'cannot SEE each other. They can still overwrite each other. A read-only audit of this ' +
    'table reports it healthy, which is what makes it dangerous.',

  async setup(ctx) {
    await ctx.createTable(
      'posts',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL,
       body text NOT NULL`,
    )
    await ctx.sql(`
      INSERT INTO "${ctx.schema}"."posts" (user_id, body) VALUES
        ('${TENANT_A}', 'A post'), ('${TENANT_B}', 'B post')
    `)
    await ctx.sql(`ALTER TABLE "${ctx.schema}"."posts" ENABLE ROW LEVEL SECURITY`)
    await ctx.sql(`
      CREATE POLICY posts_own_rows ON "${ctx.schema}"."posts"
        FOR ALL
        USING (user_id::text = nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')
    `)
  },

  async inject(ctx) {
    await ctx.sql(`DROP POLICY posts_own_rows ON "${ctx.schema}"."posts"`)
    // Reads stay correctly scoped…
    await ctx.sql(`
      CREATE POLICY posts_read_own ON "${ctx.schema}"."posts"
        FOR SELECT
        USING (user_id::text = nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')
    `)
    // …writes do not.
    await ctx.sql(`
      CREATE POLICY posts_write_any ON "${ctx.schema}"."posts"
        FOR UPDATE USING (true) WITH CHECK (true)
    `)
  },

  async observe(ctx) {
    // The attack is an UNQUALIFIED update, and that detail is the case.
    //
    // A `WHERE id = <victim>` update cannot exploit this hole: PostgreSQL applies
    // SELECT policies when locating rows for a qualified UPDATE, so the read
    // policy hides the victim row and the attack touches nothing. The first
    // version of this fixture did exactly that, and the harness correctly voided
    // the case — the injection had not produced an exploitable fault.
    //
    // Without a WHERE clause there is no row to locate, so only the UPDATE
    // policy's USING applies — and it says `true`. Tenant A rewrites every row
    // in the table without ever being able to read one of them.
    const attack = await writeAs(
      { role: 'authenticated', sub: TENANT_A },
      `UPDATE "${ctx.schema}"."posts" SET body = 'overwritten by A'`,
    )
    const ownRead = await readAs(
      { role: 'authenticated', sub: TENANT_A },
      `SELECT id FROM "${ctx.schema}"."posts"`,
    )

    // Tenant A legitimately owns exactly one row. Touching more than that means
    // the write reached another tenant's data.
    return {
      vulnerable: attack.rowCount > 1,
      functional: ownRead.rows.length > 0,
      evidence:
        `tenant A's unqualified UPDATE touched ${attack.rowCount} row(s) (owns 1); ` +
        `tenant A can read ${ownRead.rows.length} of their own row(s)`,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. OUT OF CATALOGUE — the identity sequence fell behind the data
// ─────────────────────────────────────────────────────────────────────────────

const sequenceDesync: FaultCase = {
  id: 'sequence-desync',
  title: 'The identity sequence is behind the table, so every insert collides',
  task: 'rca',
  scope: 'out_of_catalogue',
  severity: 'critical',
  crossPlatform: true,
  impact:
    'The classic aftermath of a restore or a bulk import: rows were written with explicit ' +
    'ids and the sequence was never advanced. Reads are perfect, the schema is valid, and ' +
    'every new insert fails on a duplicate primary key. No schema-shaped probe can see it, ' +
    'because nothing about the schema is wrong.',

  async setup(ctx) {
    await ctx.createTable(
      'tickets',
      `id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
       user_id uuid NOT NULL,
       subject text NOT NULL`,
    )
    await ctx.sql(`
      INSERT INTO "${ctx.schema}"."tickets" (user_id, subject) VALUES
        ('${TENANT_A}', 'first'), ('${TENANT_A}', 'second')
    `)
  },

  async inject(ctx) {
    // Rewind the sequence beneath the existing rows.
    await ctx.sql(`
      SELECT setval(pg_get_serial_sequence('"${ctx.schema}"."tickets"', 'id'), 1, false)
    `)
  },

  async observe(ctx) {
    const insert = await writeAs(
      { role: 'service_role' },
      `INSERT INTO "${ctx.schema}"."tickets" (user_id, subject) VALUES ($1, 'new ticket')`,
      [TENANT_A],
    )
    const read = await readAs(
      { role: 'service_role' },
      `SELECT id FROM "${ctx.schema}"."tickets"`,
    )
    return {
      vulnerable: !insert.ok,
      functional: insert.ok && read.rows.length > 0,
      evidence: insert.ok
        ? `insert accepted; ${read.rows.length} ticket(s) readable`
        : `insert REJECTED: ${insert.error}`,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. OUT OF CATALOGUE — the table became unreachable
// ─────────────────────────────────────────────────────────────────────────────

const grantRevoked: FaultCase = {
  id: 'grant-revoked-unreachable',
  title: 'SELECT was revoked from the end-user role, so the API 403s for everyone',
  task: 'detection',
  scope: 'out_of_catalogue',
  severity: 'critical',
  crossPlatform: true,
  impact:
    'A total outage for one table with no data loss and no schema change. RLS is correct, ' +
    'the rows are intact, and every signed-in user gets permission denied. Exactly what a ' +
    'careless REVOKE or a partial migration leaves behind.',

  async setup(ctx) {
    await ctx.createTable(
      'messages',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL,
       body text NOT NULL`,
    )
    await ctx.sql(`
      INSERT INTO "${ctx.schema}"."messages" (user_id, body) VALUES
        ('${TENANT_A}', 'hello'), ('${TENANT_B}', 'hi')
    `)
    await ctx.sql(`ALTER TABLE "${ctx.schema}"."messages" ENABLE ROW LEVEL SECURITY`)
    await ctx.sql(`
      CREATE POLICY messages_own_rows ON "${ctx.schema}"."messages"
        FOR ALL
        USING (user_id::text = nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')
    `)
  },

  async inject(ctx) {
    await ctx.sql(
      `REVOKE SELECT, INSERT, UPDATE, DELETE ON "${ctx.schema}"."messages" FROM authenticated`,
    )
  },

  async observe(ctx) {
    const asA = await readAs(
      { role: 'authenticated', sub: TENANT_A },
      `SELECT id FROM "${ctx.schema}"."messages"`,
    )
    return {
      // The defect that reproduces here is an outage, not a leak. `vulnerable`
      // means "the defect is observable", which a hard denial certainly is.
      vulnerable: asA.denied,
      functional: !asA.denied && asA.rows.length > 0,
      evidence: asA.denied
        ? `end-user role cannot reach messages at all: ${asA.error}`
        : `end user reads ${asA.rows.length} of their own message(s)`,
    }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. OUT OF CATALOGUE — a validation rule quietly removed
// ─────────────────────────────────────────────────────────────────────────────

const checkConstraintDropped: FaultCase = {
  id: 'check-constraint-dropped',
  title: 'A CHECK constraint was dropped, so invalid data is now accepted',
  task: 'mitigation',
  scope: 'out_of_catalogue',
  severity: 'warning',
  crossPlatform: true,
  impact:
    'Negative amounts, empty required strings, out-of-range statuses — whatever the rule ' +
    'protected is now writable. Nothing errors. The damage is discovered in reporting, ' +
    'weeks later, mixed into real data.',

  async setup(ctx) {
    await ctx.createTable(
      'payments',
      `id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id uuid NOT NULL,
       amount_cents integer NOT NULL
         CONSTRAINT payments_amount_positive CHECK (amount_cents > 0)`,
    )
    await ctx.sql(
      `INSERT INTO "${ctx.schema}"."payments" (user_id, amount_cents) VALUES ('${TENANT_A}', 500)`,
    )
  },

  async inject(ctx) {
    await ctx.sql(
      `ALTER TABLE "${ctx.schema}"."payments" DROP CONSTRAINT payments_amount_positive`,
    )
  },

  async observe(ctx) {
    const bad = await writeAs(
      { role: 'service_role' },
      `INSERT INTO "${ctx.schema}"."payments" (user_id, amount_cents) VALUES ($1, -9999)`,
      [TENANT_A],
    )
    const good = await writeAs(
      { role: 'service_role' },
      `INSERT INTO "${ctx.schema}"."payments" (user_id, amount_cents) VALUES ($1, 750)`,
      [TENANT_A],
    )
    return {
      vulnerable: bad.ok,
      functional: good.ok,
      evidence: bad.ok
        ? `a -9999 cent payment was ACCEPTED; valid payment ${good.ok ? 'ok' : 'FAILED'}`
        : `negative payment correctly rejected; valid payment ${good.ok ? 'ok' : 'FAILED'}`,
    }
  },
}

/**
 * Corpus v1 — 12 cases: 7 in-catalogue, 1 control, 4 out-of-catalogue.
 *
 * The out-of-catalogue share is deliberately large and deliberately hard. After
 * the advisory-lock fix the in-catalogue set scored 100%, and a clean sweep is
 * the easiest possible thing to dismiss: "your corpus is too easy" is
 * unanswerable unless the corpus visibly contains faults you do not handle.
 * These four are real production failures — a rewound identity sequence, a
 * revoked grant, a dropped CHECK, a narrowed column — chosen because no
 * invariant in lib/autonomy/desired-state.ts claims them.
 *
 * They are expected to fail. Publish them failing.
 */
export const CORPUS_V1: FaultCase[] = [
  rlsMissing,
  rlsDenyAll,
  engineDialectMismatch,
  missingFkIndex,
  rlsWideOpenPolicy,
  fkConstraintDropped,
  rlsWritePathOpen,
  healthyControl,
  columnTypeNarrowed,
  sequenceDesync,
  grantRevoked,
  checkConstraintDropped,
]
