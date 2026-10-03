/**
 * THE APPLICATION ROLE CANNOT BYPASS ROW-LEVEL SECURITY
 * ====================================================
 * The application used to connect as `POSTGRES_USER`, the role initdb creates,
 * which is a SUPERUSER. Superusers bypass RLS — including FORCE ROW LEVEL
 * SECURITY — so every policy the platform wrote was advisory for the
 * application itself. Tenant isolation held because the code scoped its own
 * queries, not because PostgreSQL would have refused one that did not.
 *
 * That is the property this asserts, and it asserts it the only way that
 * means anything: by connecting as the role and watching the database refuse.
 * A test that inspected `pg_roles` and stopped there would pass against a role
 * whose grants were wrong in every other respect.
 *
 * It also asserts the role can still do its job. A credential that cannot
 * create a schema or alter a table has not been secured, it has been broken —
 * and production has already failed exactly once on a missing CREATE.
 *
 * Runs the real script against a real database, as a superuser, then reconnects
 * as the role it made.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals'
import { execFileSync } from 'child_process'
import { Client } from 'pg'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const DB_NAME = 'backenly_app_role_jest'
const APP_ROLE = 'backenly_app_jest'

function urlForDatabase(base: string, name: string): string {
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

let adminOnTarget = ''
let appUrl = ''

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!ADMIN_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = ADMIN_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const onPostgres = (sql: string) =>
  withClient(urlForDatabase(ADMIN_URL!, 'postgres'), c => c.query(sql))

beforeAll(async () => {
  assertSafeTestDatabase()
  adminOnTarget = urlForDatabase(ADMIN_URL!, DB_NAME)

  await onPostgres(`DROP DATABASE IF EXISTS ${DB_NAME}`)
  // The role is CLUSTER-wide, so it survives a dropped database and has to be
  // cleaned up separately.
  await onPostgres(`DROP ROLE IF EXISTS ${APP_ROLE}`)
  await onPostgres(`CREATE DATABASE ${DB_NAME}`)

  // The real script, with the real flags.
  const out = execFileSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', 'scripts/setup-app-role.ts', '--apply'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BACKENLY_ADMIN_DATABASE_URL: adminOnTarget,
        BACKENLY_APP_ROLE: APP_ROLE,
      },
    }
  )

  const match = out.match(/postgresql:\/\/[^\s]+/)
  if (!match) throw new Error(`setup-app-role printed no connection string:\n${out}`)
  appUrl = match[0]
}, 180_000)

afterAll(async () => {
  await onPostgres(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
  await onPostgres(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {})
}, 60_000)

describe('the role the application runs as', () => {
  test('is not a superuser and cannot bypass RLS', async () => {
    const rows = await withClient(adminOnTarget, c =>
      c.query(`SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb
                 FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].rolsuper).toBe(false)
    expect(rows.rows[0].rolbypassrls).toBe(false)
    expect(rows.rows[0].rolcanlogin).toBe(true)
    // Neither is needed to run the product, and both are routes back to power.
    expect(rows.rows[0].rolcreaterole).toBe(false)
    expect(rows.rows[0].rolcreatedb).toBe(false)
  })

  test('is what backenly.app_role names, which is the seam the SQL reads', async () => {
    // The privileged SQL routes every ownership and grant decision through
    // public.backenly_app_role(). If the setting did not move, the grants would
    // keep landing on the superuser and the split would be cosmetic.
    const r = await withClient(appUrl, c =>
      c.query(`SELECT current_setting('backenly.app_role', true) AS role`)
    )
    expect(r.rows[0].role).toBe(APP_ROLE)
  })

  test('can create a schema, which bootstrap does once per project', async () => {
    // Production failed exactly here once: the role lacked CREATE on the
    // database and project creation broke in production while staging worked.
    await withClient(appUrl, async c => {
      await c.query(`CREATE SCHEMA workspace_probe`)
      await c.query(`CREATE TABLE workspace_probe.things (id serial primary key, owner text, body text)`)
      await c.query(`ALTER TABLE workspace_probe.things ADD COLUMN extra text`)
    })
  })

  test('owns what it created, so ALTER and DROP keep working', async () => {
    const r = await withClient(adminOnTarget, c =>
      c.query(`SELECT tableowner FROM pg_tables WHERE schemaname = 'workspace_probe' AND tablename = 'things'`)
    )
    expect(r.rows[0].tableowner).toBe(APP_ROLE)
  })
})

describe('FORCE ROW LEVEL SECURITY actually applies to it', () => {
  beforeAll(async () => {
    await withClient(appUrl, async c => {
      // Seeded BEFORE the policy is enabled. Under FORCE the owner is subject
      // to its own policy, so inserting afterwards would be refused too and
      // the test could not tell a working policy from a broken insert.
      await c.query(`INSERT INTO workspace_probe.things(owner, body) VALUES ('alice','a'), ('bob','b')`)
      await c.query(`ALTER TABLE workspace_probe.things ENABLE ROW LEVEL SECURITY`)
      await c.query(`ALTER TABLE workspace_probe.things FORCE ROW LEVEL SECURITY`)
      await c.query(`CREATE POLICY only_alice ON workspace_probe.things USING (owner = 'alice')`)
    })
  })

  test('the owner sees only what the policy allows', async () => {
    // THE test. As a superuser this returns 2 rows and the policy is decoration.
    const r = await withClient(appUrl, c => c.query(`SELECT owner FROM workspace_probe.things ORDER BY owner`))
    expect(r.rows.map(x => x.owner)).toEqual(['alice'])
  })

  test('a superuser still sees everything, which is why this had to change', async () => {
    // States the contrast explicitly. Without it, the test above could pass
    // against a table that simply had one row, and nobody would notice.
    const r = await withClient(adminOnTarget, c =>
      c.query(`SELECT owner FROM workspace_probe.things ORDER BY owner`)
    )
    expect(r.rows.map(x => x.owner)).toEqual(['alice', 'bob'])
  })

  test('the policy is not merely recorded — a write outside it is refused', async () => {
    await expect(
      withClient(appUrl, c => c.query(`INSERT INTO workspace_probe.things(owner, body) VALUES ('carol','c')`))
    ).rejects.toThrow(/row-level security/i)
  })
})

describe('re-running the script', () => {
  test('does not rotate the password of a role already in use', async () => {
    // Rotating here would break a running deployment authenticating with the
    // old credential, which is the same reason the installer never regenerates
    // a secret it did not just create.
    const out = execFileSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'scripts/setup-app-role.ts', '--apply'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, BACKENLY_ADMIN_DATABASE_URL: adminOnTarget, BACKENLY_APP_ROLE: APP_ROLE },
      }
    )
    expect(out).toMatch(/already exists/i)

    // The credential still works, which is the property that matters.
    const r = await withClient(appUrl, c => c.query('SELECT 1 AS ok'))
    expect(r.rows[0].ok).toBe(1)
  }, 120_000)

  test('re-asserts NOSUPERUSER even if the role drifted', async () => {
    // A role hand-granted SUPERUSER is silently back to bypassing every policy
    // and nothing else in the system would notice. Converging every run is
    // what makes that self-healing rather than permanent.
    await withClient(adminOnTarget, c => c.query(`ALTER ROLE ${APP_ROLE} SUPERUSER BYPASSRLS`))

    execFileSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', 'scripts/setup-app-role.ts', '--apply'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, BACKENLY_ADMIN_DATABASE_URL: adminOnTarget, BACKENLY_APP_ROLE: APP_ROLE },
      }
    )

    const r = await withClient(adminOnTarget, c =>
      c.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [APP_ROLE])
    )
    expect(r.rows[0].rolsuper).toBe(false)
    expect(r.rows[0].rolbypassrls).toBe(false)
  }, 120_000)
})
