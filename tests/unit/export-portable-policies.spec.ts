/**
 * A portable export keeps row-level security whole.
 *
 * Production QA (2026-11-09): schema-export.sql had FORCE ROW LEVEL SECURITY on
 * nine tables and no policies, because the portable filter left out every
 * CREATE POLICY. A restore was a backend that denied every row. Backenly's own
 * policies apply to every role, so they restore anywhere; a policy written for
 * particular roles is created for those of its roles the destination has.
 *
 * The fixture follows pg_dump 16.15's plain format (src/bin/pg_dump:
 * _printTocEntry, dumpPolicy, dumpCommentExtended, dumpTableData_copy).
 */
import { parseDumpedPolicy, portablePolicies } from '@/lib/services/export-policies'

const RESTRICT_KEY = 'ZbVg1f0Uq2mT8yK4cR7wX9nP3sD6hJ5aL0eQ2iO8uY4tB7vN1mC3xZ5kW9gF6jH'
const header = (name: string, type: string, prefix = '') =>
  `--\n-- ${prefix}Name: ${name}; Type: ${type}; Schema: workspace_x; Owner: -\n--\n\n`

const PREAMBLE =
  `--\n-- PostgreSQL database dump\n--\n\n\\restrict ${RESTRICT_KEY}\n\n` +
  `-- Dumped from database version 16.15\n-- Dumped by pg_dump version 16.15\n\n` +
  `SET statement_timeout = 0;\nSET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n` +
  `SELECT pg_catalog.set_config('search_path', '', false);\nSET row_security = off;\n\n`

// A function whose body has a line that reads like a policy.
const FUNCTION =
  header('grant_reads()', 'FUNCTION') +
  `CREATE FUNCTION workspace_x.grant_reads() RETURNS void\n    LANGUAGE sql\n    AS $$\n` +
  `CREATE POLICY reads ON workspace_x.orders TO backenly_external USING (true);\n$$;\n\n\n`

const TABLES =
  header('orders', 'TABLE') +
  `CREATE TABLE workspace_x.orders (\n    id uuid NOT NULL,\n    user_id text,\n    deleted_at timestamp with time zone\n);\n\n` +
  `ALTER TABLE ONLY workspace_x.orders FORCE ROW LEVEL SECURITY;\n\n\n` +
  header('snippets', 'TABLE') +
  `CREATE TABLE workspace_x.snippets (\n    body text\n);\n\n\n`

// Rows of data that read like a header and like policies.
const DATA =
  header('snippets', 'TABLE DATA', 'Data for ') +
  `COPY workspace_x.snippets (body) FROM stdin;\n` +
  `CREATE POLICY copied ON workspace_x.orders TO anon USING (true);\n` +
  `-- Name: orders copied; Type: POLICY; Schema: workspace_x; Owner: -\n` +
  `CREATE POLICY copied_again ON workspace_x.orders TO anon USING (true);\n` +
  `café ☕\n\\.\n\n\n`

const EVERY_ROLE =
  header('orders', 'ROW SECURITY') +
  `ALTER TABLE workspace_x.orders ENABLE ROW LEVEL SECURITY;\n\n` +
  header('orders backenly_own_rows_select', 'POLICY') +
  `CREATE POLICY backenly_own_rows_select ON workspace_x.orders FOR SELECT USING (((workspace_x.backenly_jwt_claim('role'::text) = 'service_role'::text) OR (user_id = workspace_x.backenly_jwt_claim('sub'::text))));\n\n\n` +
  header('POLICY backenly_own_rows_select ON orders', 'COMMENT') +
  `COMMENT ON POLICY backenly_own_rows_select ON workspace_x.orders IS 'Each person reads their own rows';\n\n\n`

const SOFT_DELETE_STATEMENT =
  'CREATE POLICY bkn_pgrst_soft_delete ON workspace_x.orders AS RESTRICTIVE FOR SELECT TO anon, authenticated USING ((deleted_at IS NULL));'
const STAFF_STATEMENT =
  `CREATE POLICY "Staff can edit" ON workspace_x."order items" FOR UPDATE TO "app staff", bkn_rw_x USING (true) WITH CHECK ((note <> 'café;\n☕'::text));`
const STAFF_COMMENT = `COMMENT ON POLICY "Staff can edit" ON workspace_x."order items" IS 'Staff; only';`
const ODD_STATEMENT = 'CREATE POLICY odd ON workspace_x.orders FOR SELECT TO anon SOMETHING NEW USING (true);'

const FOR_ROLES =
  header('orders bkn_pgrst_soft_delete', 'POLICY') +
  `${SOFT_DELETE_STATEMENT}\n\n\n` +
  header('order items Staff can edit', 'POLICY') +
  `${STAFF_STATEMENT}\n\n\n` +
  header('POLICY "Staff can edit" ON "order items"', 'COMMENT') +
  `${STAFF_COMMENT}\n\n\n` +
  header('orders odd', 'POLICY') +
  `${ODD_STATEMENT}\n\n\n`

const END = `--\n-- PostgreSQL database dump complete\n--\n\n\\unrestrict ${RESTRICT_KEY}\n\n`

const DUMP = PREAMBLE + FUNCTION + TABLES + DATA + EVERY_ROLE + FOR_ROLES + END

/** Runs a dump through the filter in pieces of `size` bytes, as pg_dump's output arrives. */
const portable = (dump: string, size = Number.MAX_SAFE_INTEGER): Promise<string> =>
  new Promise((resolve, reject) => {
    const out: Buffer[] = []
    const filter = portablePolicies()
    filter.on('data', (d: Buffer) => out.push(Buffer.from(d)))
    filter.on('end', () => resolve(Buffer.concat(out).toString('utf8')))
    filter.on('error', reject)
    const bytes = Buffer.from(dump, 'utf8')
    for (let i = 0; i < bytes.length; i += size) filter.write(bytes.subarray(i, i + size))
    filter.end()
  })

describe('a portable export', () => {
  it('keeps every policy that applies to every role, and its comment, exactly as pg_dump wrote them', async () => {
    const out = await portable(DUMP)
    expect(out).toContain(EVERY_ROLE)
    expect(out).toContain('ALTER TABLE ONLY workspace_x.orders FORCE ROW LEVEL SECURITY;')
  })

  it('comes out byte for byte when no policy is written for particular roles', async () => {
    const dump = PREAMBLE + FUNCTION + TABLES + DATA + EVERY_ROLE + END
    expect(await portable(dump)).toBe(dump)
  })

  it('creates a policy written for particular roles for those of its roles the server has', async () => {
    const out = await portable(DUMP)
    expect(out).not.toContain(SOFT_DELETE_STATEMENT)
    expect(out).toContain(
      [
        'DO $portable$',
        'DECLARE',
        '  present text;',
        'BEGIN',
        "  SELECT string_agg(quote_ident(rolname), ', ' ORDER BY rolname) INTO present",
        "    FROM pg_catalog.pg_roles WHERE rolname IN ('anon', 'authenticated');",
        '  IF present IS NULL THEN',
        "    RAISE WARNING '%', 'Policy bkn_pgrst_soft_delete on workspace_x.orders was not restored: this server has none of its roles (anon, authenticated).';",
        '  ELSE',
        "    EXECUTE 'CREATE POLICY bkn_pgrst_soft_delete ON workspace_x.orders AS RESTRICTIVE FOR SELECT TO ' || present || ' USING ((deleted_at IS NULL))';",
        '  END IF;',
        'END',
        '$portable$;',
      ].join('\n'),
    )
  })

  it('reads quoted names, and a statement whose literal holds a semicolon and a line break', async () => {
    const out = await portable(DUMP)
    expect(out).not.toContain(STAFF_STATEMENT)
    expect(out).toContain("WHERE rolname IN ('app staff', 'bkn_rw_x');")
    expect(out).toContain(
      `EXECUTE 'CREATE POLICY "Staff can edit" ON workspace_x."order items" FOR UPDATE TO ' || present || ' USING (true) WITH CHECK ((note <> ''café;\n☕''::text))';`,
    )
  })

  it('makes a comment on such a policy only where the policy was restored', async () => {
    const out = await portable(DUMP)
    expect(out).not.toContain(`${STAFF_COMMENT}\n`)
    expect(out).toContain(
      `  IF EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = 'workspace_x."order items"'::regclass AND polname = 'Staff can edit') THEN\n` +
        `    EXECUTE 'COMMENT ON POLICY "Staff can edit" ON workspace_x."order items" IS ''Staff; only''';`,
    )
  })

  it('never touches a function body or a row of data, whatever it reads like', async () => {
    const out = await portable(DUMP)
    expect(out).toContain(FUNCTION)
    expect(out).toContain(DATA)
  })

  it('keeps a policy in a shape it does not recognise as pg_dump wrote it', async () => {
    expect(parseDumpedPolicy(ODD_STATEMENT)).toBeNull()
    expect(await portable(DUMP)).toContain(`${ODD_STATEMENT}\n`)
  })

  it('gives the same file however the dump arrives, even split inside a character', async () => {
    const whole = await portable(DUMP)
    for (const size of [1, 2, 3, 7, 64, 4096]) expect(await portable(DUMP, size)).toBe(whole)
  })
})

describe('parseDumpedPolicy', () => {
  it('finds the roles only in the TO clause, never in an expression', () => {
    expect(
      parseDumpedPolicy("CREATE POLICY p ON s.t USING ((current_user = 'x TO y'::name));")?.roles,
    ).toEqual([])
    expect(parseDumpedPolicy('CREATE POLICY p ON s.t FOR DELETE TO "a, b", c USING (true);')).toEqual({
      name: 'p',
      table: 's.t',
      roles: ['a, b', 'c'],
      head: 'CREATE POLICY p ON s.t FOR DELETE',
      tail: ' USING (true)',
    })
  })
})
