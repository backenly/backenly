/**
 * PostgREST cutover — security parity spec.
 *
 * v1's data plane enforces its protections IMPERATIVELY, in TypeScript, inside
 * runtimeApiExecutor. PostgREST enforces nothing imperatively: it serves
 * whatever the connecting role is allowed to reach. So every v1 protection must
 * be re-expressed as a grant, an RLS policy, or a view before any project is
 * routed to PostgREST — and a protection that fails to translate does not throw
 * an error, it silently starts permitting things. That failure mode is why this
 * file exists and why it is written BEFORE the cutover rather than after.
 *
 * WHAT THIS FOUND (2026-07-20, prod): setup-postgrest-roles.ts issued
 * `GRANT SELECT ON ALL TABLES ... TO anon` with no exclusions. That would have
 * given unauthenticated reads of `users` (password hashes) and of
 * `_password_resets` / `_magic_links` / `_email_verifications` /
 * `_token_blacklist`, which carry single-use auth tokens and are NOT
 * RLS-protected — RLS could not have saved it because those tables have no
 * policies. PostgREST was already live on a real prod schema; the grants simply
 * had never been run, so the tables answered 42501. Running the cutover script
 * as written was the trigger.
 *
 * Each case names the v1 behaviour it is holding PostgREST to.
 *
 * All protections now have declarative equivalents, in ONE place each:
 *   internal tables   backenly_pgrst_revoke_internal   (schema-registry.sql)
 *   soft delete       backenly_pgrst_apply_soft_delete (schema-registry.sql)
 *   late tables       ddl_command_end event trigger    (ddl-sync.sql)
 *   readiness         backenly_pgrst_cutover_blockers  (schema-registry.sql)
 *
 * `allowedUpdateFields` is deliberately absent. It looked like a hard mismatch
 * — per-endpoint in v1, per-table in PostgREST — until grep showed it is only
 * ever READ. `config?.allowedUpdateFields` is undefined everywhere, so the
 * filter has never once applied. Dead code, not a parity gap.
 *
 * WHAT THESE TESTS DO NOT PROVE: that the event trigger fires in production.
 * Installing a cluster-wide event trigger here would affect every other suite
 * sharing this database, so invocation is asserted from source instead. Stated
 * plainly because a test that quietly proves less than it appears to is the
 * failure mode this whole file exists to prevent.
 */

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'crypto'

const prisma = new PrismaClient()

const suffix = randomUUID().replace(/-/g, '').slice(0, 10)
const SCHEMA = `workspace_pq_${suffix}`

/** Mirrors the PostgREST client roles. Never granted BYPASSRLS. */
const ANON = `pq_anon_${suffix}`
const AUTHED = `pq_authed_${suffix}`

async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(`SET ROLE "${role}"`)
  try {
    return await fn()
  } finally {
    await prisma.$executeRawUnsafe(`RESET ROLE`)
  }
}

async function denied(role: string, sql: string): Promise<boolean> {
  try {
    await asRole(role, () => prisma.$executeRawUnsafe(sql))
    return false
  } catch (err) {
    return /permission denied/i.test(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Mirrors backenly_pgrst_revoke_internal + backenly_pgrst_apply_soft_delete,
 * applied AFTER the blanket grants exactly as production does — so the test
 * proves the ORDERING too, which is the actual protection.
 *
 * The production functions name the real anon/authenticated roles; here they
 * are parameterised to this test's throwaway roles. Behaviour is otherwise
 * identical, including the RESTRICTIVE policy shape, which is the part that
 * would silently widen access if it were permissive.
 */
async function applyCanonicalSeal(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    DO $$
    DECLARE t record;
    BEGIN
      FOR t IN
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${SCHEMA}' AND c.relkind IN ('r','p','v','m')
          AND (c.relname LIKE '\\_%' OR c.relname = 'users')
      LOOP
        EXECUTE format('REVOKE ALL ON %I.%I FROM "${ANON}", "${AUTHED}"', '${SCHEMA}', t.relname);
      END LOOP;

      FOR t IN
        SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${SCHEMA}' AND c.relkind IN ('r','p') AND c.relrowsecurity
          AND EXISTS (SELECT 1 FROM pg_attribute a
                      WHERE a.attrelid = c.oid AND a.attname = 'deleted_at'
                        AND a.attnum > 0 AND NOT a.attisdropped)
          AND NOT EXISTS (SELECT 1 FROM pg_policies p
                          WHERE p.schemaname = '${SCHEMA}' AND p.tablename = c.relname
                            AND p.policyname = 'bkn_pgrst_soft_delete')
      LOOP
        EXECUTE format(
          'CREATE POLICY bkn_pgrst_soft_delete ON %I.%I AS RESTRICTIVE FOR SELECT '
          || 'TO "${ANON}", "${AUTHED}" USING (deleted_at IS NULL)', '${SCHEMA}', t.relname);
      END LOOP;
    END $$`)
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${SCHEMA}"`)

  for (const r of [ANON, AUTHED]) {
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${r}"`)
    await prisma.$executeRawUnsafe(`CREATE ROLE "${r}" NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`)
  }

  // A normal end-user table, plus the two classes v1 blocks by name.
  await prisma.$executeRawUnsafe(`CREATE TABLE "${SCHEMA}".posts (id int primary key, title text, deleted_at timestamptz)`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${SCHEMA}".users (id int primary key, email text, password_hash text)`)
  await prisma.$executeRawUnsafe(`CREATE TABLE "${SCHEMA}"._password_resets (id int primary key, token text)`)
  await prisma.$executeRawUnsafe(`INSERT INTO "${SCHEMA}".posts VALUES (1,'live',NULL),(2,'gone',now())`)
  // RLS on + a permissive read policy. The soft-delete filter is RESTRICTIVE,
  // so without a permissive policy to AND against, the table would read empty
  // and the test would "pass" for entirely the wrong reason.
  await prisma.$executeRawUnsafe(`ALTER TABLE "${SCHEMA}".posts ENABLE ROW LEVEL SECURITY`)
  await prisma.$executeRawUnsafe(
    `CREATE POLICY posts_read ON "${SCHEMA}".posts FOR SELECT TO "${ANON}", "${AUTHED}" USING (true)`)
  await prisma.$executeRawUnsafe(`INSERT INTO "${SCHEMA}".users VALUES (1,'a@b.c','$2b$10$hash')`)
  await prisma.$executeRawUnsafe(`INSERT INTO "${SCHEMA}"._password_resets VALUES (1,'single-use-token')`)

  // Exactly what the cutover script does, in the same order.
  await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${SCHEMA}" TO "${ANON}", "${AUTHED}"`)
  await prisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${SCHEMA}" TO "${AUTHED}"`)
  await prisma.$executeRawUnsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA "${SCHEMA}" TO "${ANON}"`)
  await applyCanonicalSeal()
}, 90_000)

afterAll(async () => {
  await prisma.$executeRawUnsafe(`RESET ROLE`).catch(() => {})
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`).catch(() => {})
  for (const r of [ANON, AUTHED]) {
    await prisma.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA "${SCHEMA}" FROM "${r}"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP OWNED BY "${r}"`).catch(() => {})
    await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${r}"`).catch(() => {})
  }
  await prisma.$disconnect()
}, 90_000)

describe('parity: auth-managed tables (v1 404s /db/users)', () => {
  it('anon cannot read users', async () => {
    expect(await denied(ANON, `SELECT * FROM "${SCHEMA}".users`)).toBe(true)
  })

  it('an AUTHENTICATED end-user cannot read users either', async () => {
    // The dangerous half. Signing up is free, so "requires a JWT" is not a
    // protection — a logged-in end user must be as blocked as an anonymous one.
    expect(await denied(AUTHED, `SELECT * FROM "${SCHEMA}".users`)).toBe(true)
  })

  it('password_hash is unreachable even column-wise', async () => {
    expect(await denied(ANON, `SELECT password_hash FROM "${SCHEMA}".users`)).toBe(true)
  })
})

describe('parity: reserved plumbing (v1 404s any _-prefixed table)', () => {
  it('anon cannot read single-use auth tokens', async () => {
    expect(await denied(ANON, `SELECT * FROM "${SCHEMA}"._password_resets`)).toBe(true)
  })

  it('an authenticated end-user cannot read them', async () => {
    expect(await denied(AUTHED, `SELECT * FROM "${SCHEMA}"._password_resets`)).toBe(true)
  })

  it('nor write them — forging a reset token is the takeover path', async () => {
    expect(await denied(AUTHED, `INSERT INTO "${SCHEMA}"._password_resets VALUES (2,'forged')`)).toBe(true)
  })
})

describe('parity: ordinary tables still work (or the plane is useless)', () => {
  it('anon can read a normal table', async () => {
    const rows = await asRole(ANON, () =>
      prisma.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM "${SCHEMA}".posts`),
    )
    expect(rows.length).toBeGreaterThan(0)
  })

  it('an authenticated user can write one', async () => {
    expect(await denied(AUTHED, `INSERT INTO "${SCHEMA}".posts VALUES (3,'new',NULL)`)).toBe(false)
  })
})

describe('parity: soft delete (v1 filters deleted_at IS NULL)', () => {
  it('hides soft-deleted rows from anon', async () => {
    const rows = await asRole(ANON, () =>
      prisma.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM "${SCHEMA}".posts`),
    )
    expect(rows.map((r) => r.id)).not.toContain(2)
  })

  it('still returns live rows — a filter that hides everything is not a filter', async () => {
    // The paired positive. A RESTRICTIVE policy with no permissive policy to AND
    // against returns nothing, which would satisfy the assertion above while
    // having broken the table completely.
    const rows = await asRole(ANON, () =>
      prisma.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM "${SCHEMA}".posts`),
    )
    expect(rows.map((r) => r.id)).toContain(1)
  })

  it('is RESTRICTIVE, so it ANDs with other policies instead of widening them', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ permissive: string }>>(
      `SELECT permissive FROM pg_policies
        WHERE schemaname = '${SCHEMA}' AND tablename = 'posts'
          AND policyname = 'bkn_pgrst_soft_delete'`,
    )
    expect(rows).toHaveLength(1)
    // PERMISSIVE here would mean every non-deleted row becomes visible to
    // everyone, regardless of ownership — a widening dressed as a filter.
    expect(rows[0].permissive).toBe('RESTRICTIVE')
  })
})

describe('parity: a table created AFTER setup is sealed too', () => {
  it('the seal blocks a reserved table created later', async () => {
    await prisma.$executeRawUnsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA "${SCHEMA}" GRANT SELECT ON TABLES TO "${ANON}"`,
    )
    await prisma.$executeRawUnsafe(`CREATE TABLE "${SCHEMA}"._magic_links (id int primary key, token text)`)

    // Production invokes this from an ddl_command_end event trigger; here it is
    // called directly. This proves the SEAL works on a late table. That the
    // trigger actually FIRES is asserted from source below, because installing a
    // cluster-wide event trigger inside a test suite would affect every other
    // suite sharing this database.
    await applyCanonicalSeal()

    expect(await denied(ANON, `SELECT * FROM "${SCHEMA}"._magic_links`)).toBe(true)
  })

  it('production wires that seal to a DDL event trigger', async () => {
    // Source-level parity check, same idea as docs-install-command.spec.ts: the
    // mechanism above is only worth anything if something invokes it, and the
    // invoker lives in SQL this suite does not install.
    const fs = await import('fs')
    const sql = fs.readFileSync('scripts/sql/postgrest-ddl-sync.sql', 'utf8')
    expect(sql).toMatch(/CREATE EVENT TRIGGER backenly_pgrst_ddl_sync/)
    expect(sql).toMatch(/ON ddl_command_end/)
    expect(sql).toMatch(/backenly_pgrst_revoke_internal/)
    expect(sql).toMatch(/backenly_pgrst_apply_soft_delete/)
  })

  it('cutover blockers are queryable, so readiness is checked not assumed', async () => {
    const fs = await import('fs')
    const sql = fs.readFileSync('scripts/sql/postgrest-schema-registry.sql', 'utf8')
    expect(sql).toMatch(/backenly_pgrst_cutover_blockers/)
    // Must catch deleted_at without RLS — the case where no policy can filter.
    expect(sql).toMatch(/RLS is disabled/)
  })
})
