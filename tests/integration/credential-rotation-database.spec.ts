/**
 * ROTATING THE DATABASE CREDENTIALS, AND PROVING THE OLD ONE IS DEAD
 * =================================================================
 *
 * A rotation that is only proven by "the new password works" is not proven at
 * all. The point of rotating is that the OLD credential stops working — if it
 * still opens a connection, nothing was revoked and the exercise was theatre.
 * So every case here is the same five steps:
 *
 *   1. the credential works                (control)
 *   2. rotate through the SUPPORTED path
 *   3. the OLD credential is refused       (28P01, not a timeout)
 *   4. the NEW credential works
 *   5. the role's SECURITY PROPERTIES survived
 *
 * Step 5 is the one that is easy to skip and expensive to get wrong. A rotation
 * that quietly recreated `backenly_app` as a superuser would pass steps 1-4
 * perfectly while turning every FORCE RLS policy on the deployment into a
 * suggestion.
 *
 * ── Roles are CLUSTER-WIDE ──────────────────────────────────────────────────
 *
 * A separate database does not isolate a role. This suite therefore uses
 * throwaway role names throughout and drops them afterwards: rotating the real
 * `backenly_authenticator` on a shared cluster would take down any PostgREST
 * pointed at it, which is the hazard postgrest-roles-idempotency.test.ts exists
 * to pin.
 *
 * ── What is NOT rotated here, and why ───────────────────────────────────────
 *
 * MASTER_ENCRYPTION_KEY and the per-project JWT signing secret have no
 * supported rotation mechanism in this product. Rotating either by hand would
 * strand every value encrypted under the old key, or invalidate every live
 * end-user session with no migration path. They are recorded as unsupported
 * operational actions rather than rehearsed with an ad-hoc script written to
 * satisfy a checklist — inventing a dangerous procedure to tick a box is worse
 * than stating the constraint.
 */

import { execFileSync, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Client } from 'pg'

const ADMIN_BASE = process.env.TEST_DATABASE_URL!
const DB_NAME = `backenly_rot_${randomBytes(4).toString('hex')}`

/** Throwaway names, because a role is cluster-wide however isolated the database is. */
const APP_ROLE = `bkn_app_rot_${randomBytes(4).toString('hex')}`
const AUTHENTICATOR = `bkn_auth_rot_${randomBytes(4).toString('hex')}`
const BACKUP_ROLE = `bkn_backup_rot_${randomBytes(4).toString('hex')}`

let dbUrl = ''
let adminUrl = ''

function urlFor(base: string, name: string, user?: string, password?: string): string {
  const u = new URL(base)
  u.pathname = `/${name}`
  if (user) u.username = user
  if (password) u.password = password
  return u.toString()
}

async function admin<T = any>(query: string, params: any[] = []): Promise<T[]> {
  const c = new Client({ connectionString: adminUrl })
  c.on('error', () => {})
  await c.connect()
  try {
    return (await c.query(query, params)).rows as T[]
  } finally {
    await c.end()
  }
}

/**
 * Can this connection string open a session and run a query?
 *
 * Returns the SQLSTATE on refusal rather than a boolean, because "refused" and
 * "could not reach the server" are different outcomes and only one of them is
 * evidence that a credential was revoked.
 */
async function tryConnect(url: string): Promise<{ ok: boolean; code?: string; message?: string }> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 })
  c.on('error', () => {})
  try {
    await c.connect()
    await c.query('SELECT 1')
    return { ok: true }
  } catch (err: any) {
    return { ok: false, code: err?.code, message: String(err?.message ?? err) }
  } finally {
    await c.end().catch(() => {})
  }
}

/**
 * Does this cluster authenticate at all?
 *
 * Measured with a password that is certainly wrong. A cluster whose pg_hba.conf
 * says `trust` accepts ANY password, so every "the old credential is refused"
 * assertion in this file would pass against a rotation that did nothing - and,
 * worse, would fail against one that worked.
 *
 * This developer's local PostgreSQL is exactly that: the first run of this
 * suite reported three rotations "not revoked" when all three had in fact
 * rotated correctly. That is an ENVIRONMENT limitation, not a product defect
 * and not a test-logic defect, and the difference matters enough to be
 * detected rather than guessed at.
 *
 * CI's postgres:16 service container is initialised with a password and
 * scram-sha-256, so the assertions are real there.
 */
let clusterEnforcesPasswords = false

async function measurePasswordEnforcement(): Promise<void> {
  const wrong = new URL(adminUrl)
  wrong.password = `certainly-not-the-password-${randomBytes(8).toString('hex')}`
  const result = await tryConnect(wrong.toString())
  clusterEnforcesPasswords = !result.ok
}

/**
 * Assert a credential was genuinely revoked, or refuse to pretend.
 *
 * Loud rather than skipped: a green tick beside an unproven rotation is the
 * reporting this programme exists to remove.
 */
function expectRevoked(result: { ok: boolean; code?: string }, which: string): void {
  if (!clusterEnforcesPasswords) {
    throw new Error(
      `Cannot prove ${which} was revoked: this PostgreSQL accepts ANY password ` +
        `(pg_hba.conf is set to trust), so the rotation assertions in this file ` +
        `are unprovable here. Run against a cluster with password authentication ` +
        `- CI's postgres:16 service container is one.`,
    )
  }
  expect(result.ok).toBe(false)
  // 28P01 is invalid_password. A timeout or refused socket would mean the
  // server was unreachable, which proves nothing about the credential.
  expect(result.code).toBe('28P01')
}

async function roleProperties(role: string) {
  const rows = await admin<{
    rolsuper: boolean
    rolbypassrls: boolean
    rolcanlogin: boolean
    rolinherit: boolean
  }>(
    `SELECT rolsuper, rolbypassrls, rolcanlogin, rolinherit FROM pg_roles WHERE rolname = $1`,
    [role],
  )
  return rows[0] ?? null
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  const base = new URL(ADMIN_BASE)
  adminUrl = urlFor(base.toString(), 'postgres')
  dbUrl = urlFor(base.toString(), DB_NAME)

  await admin(`DROP DATABASE IF EXISTS ${DB_NAME}`)
  await admin(`CREATE DATABASE ${DB_NAME}`)

  await measurePasswordEnforcement()
  // eslint-disable-next-line no-console
  console.log(
    `[rotation] this cluster ${clusterEnforcesPasswords ? 'ENFORCES' : 'does NOT enforce'} ` +
      `password authentication`,
  )
}, 300_000)

afterAll(async () => {
  for (const role of [APP_ROLE, AUTHENTICATOR, BACKUP_ROLE]) {
    // Objects first, or DROP ROLE fails on dependencies and leaves the cluster
    // carrying a role from a test run for ever.
    const c = new Client({ connectionString: dbUrl })
    c.on('error', () => {})
    await c.connect().catch(() => {})
    await c.query(`DROP OWNED BY ${role} CASCADE`).catch(() => {})
    await c.end().catch(() => {})
    await admin(`REASSIGN OWNED BY ${role} TO CURRENT_USER`).catch(() => {})
    await admin(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
  }
  await admin(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
}, 300_000)

// ── A. The application database role ─────────────────────────────────────────

describe('A — the application role, through scripts/setup-app-role.ts', () => {
  const FIRST = `first_${randomBytes(8).toString('hex')}`
  const SECOND = `second_${randomBytes(8).toString('hex')}`

  function runSetup(args: string[]): { out: string; code: number } {
    const r = spawnSync(
      process.execPath,
      ['node_modules/tsx/dist/cli.mjs', join('scripts', 'setup-app-role.ts'), ...args],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          BACKENLY_APP_ROLE: APP_ROLE,
          BACKENLY_ADMIN_DATABASE_URL: dbUrl,
        },
      },
    )
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? 1 }
  }

  it('creates a role that can connect and do the work the app does', async () => {
    const created = runSetup(['--apply', '--password', FIRST])
    expect(created.code).toBe(0)

    const url = urlFor(dbUrl, DB_NAME, APP_ROLE, FIRST)
    const before = await tryConnect(url)
    // CONTROL. Without this, "the old credential fails" below would be equally
    // true of a credential that never worked.
    expect(before.ok).toBe(true)

    // And it can actually do the application's job, not merely log in:
    // bootstrap creates a schema per project, and production once failed
    // exactly here because the role lacked CREATE.
    const c = new Client({ connectionString: url })
    c.on('error', () => {})
    await c.connect()
    try {
      await c.query(`CREATE SCHEMA IF NOT EXISTS rotation_probe`)
      await c.query(`CREATE TABLE IF NOT EXISTS rotation_probe.t (id int)`)
      await c.query(`INSERT INTO rotation_probe.t VALUES (1)`)
      const rows = await c.query(`SELECT count(*)::int AS n FROM rotation_probe.t`)
      expect(rows.rows[0].n).toBe(1)
    } finally {
      await c.end()
    }

    const props = await roleProperties(APP_ROLE)
    expect(props).toMatchObject({ rolsuper: false, rolbypassrls: false, rolcanlogin: true })
  }, 300_000)

  it('rotates: the old password is REFUSED and the new one works', async () => {
    const rotated = runSetup(['--apply', '--password', SECOND])
    expect(rotated.code).toBe(0)

    const oldUrl = urlFor(dbUrl, DB_NAME, APP_ROLE, FIRST)
    const newUrl = urlFor(dbUrl, DB_NAME, APP_ROLE, SECOND)

    // The new credential FIRST, so a broken rotation fails on the useful
    // assertion rather than on the revocation one.
    expect((await tryConnect(newUrl)).ok).toBe(true)
    expectRevoked(await tryConnect(oldUrl), `the previous ${APP_ROLE} password`)
  }, 300_000)

  it('kept the role NOSUPERUSER, NOBYPASSRLS and its grants', async () => {
    // The expensive mistake: a rotation that recreated the role as a superuser
    // would pass every test above while turning every FORCE RLS policy on the
    // deployment into a suggestion.
    const props = await roleProperties(APP_ROLE)
    expect(props!.rolsuper).toBe(false)
    expect(props!.rolbypassrls).toBe(false)

    const c = new Client({ connectionString: urlFor(dbUrl, DB_NAME, APP_ROLE, SECOND) })
    c.on('error', () => {})
    await c.connect()
    try {
      // The data it owned before the rotation is still its own.
      const rows = await c.query(`SELECT count(*)::int AS n FROM rotation_probe.t`)
      expect(rows.rows[0].n).toBe(1)
      // And it can still create, which is what the installer needs.
      await c.query(`CREATE SCHEMA IF NOT EXISTS rotation_probe_after`)
    } finally {
      await c.end()
    }
  }, 300_000)
})

// ── B. The PostgREST authenticator ───────────────────────────────────────────

describe('B — the PostgREST authenticator, through its supported rotation flag', () => {
  const TEMP_SCRIPT = join('scripts', `.rotation-under-test-${randomBytes(3).toString('hex')}.ts`)
  const FIRST = `auth_first_${randomBytes(8).toString('hex')}`
  const SECOND = `auth_second_${randomBytes(8).toString('hex')}`
  let projectId = ''

  beforeAll(async () => {
    projectId = `11111111-2222-3333-4444-${randomBytes(6).toString('hex')}`

    // The prerequisite SQL, then a workspace schema, because the script refuses
    // without one. Same order the installer uses.
    const c = new Client({ connectionString: dbUrl })
    c.on('error', () => {})
    await c.connect()
    try {
      for (const file of ['postgrest-schema-registry.sql', 'postgrest-ddl-sync.sql']) {
        await c.query(readFileSync(join(process.cwd(), 'scripts', 'sql', file), 'utf8'))
      }
      await c.query(`CREATE SCHEMA IF NOT EXISTS "workspace_${projectId}"`)
    } finally {
      await c.end()
    }

    // The authenticator name is a module constant, so a copy targeting a
    // throwaway role is the only way to exercise the genuine code path without
    // rotating the cluster's real authenticator.
    const source = readFileSync(join(process.cwd(), 'scripts', 'setup-postgrest-roles.ts'), 'utf8')
    writeFileSync(
      TEMP_SCRIPT,
      source.replace(
        "const AUTHENTICATOR = 'backenly_authenticator'",
        `const AUTHENTICATOR = '${AUTHENTICATOR}'`,
      ),
      'utf8',
    )
  }, 300_000)

  afterAll(() => {
    rmSync(TEMP_SCRIPT, { force: true })
  })

  function runRoles(args: string[]): { out: string; code: number } {
    const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', TEMP_SCRIPT, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
    })
    return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? 1 }
  }

  it('sets a first credential the authenticator can log in with', async () => {
    const r = runRoles(['--project', projectId, '--apply', '--password', FIRST])
    expect(r.code).toBe(0)

    const before = await tryConnect(urlFor(dbUrl, DB_NAME, AUTHENTICATOR, FIRST))
    expect(before.ok).toBe(true)

    // NOINHERIT is what keeps it powerless: it can log in and SET ROLE, and
    // nothing else. A rotation that dropped it would hand every PostgREST
    // request the union of anon, authenticated and service_role.
    const props = await roleProperties(AUTHENTICATOR)
    expect(props).toMatchObject({ rolcanlogin: true, rolinherit: false, rolsuper: false })
  }, 300_000)

  it('leaves the credential ALONE on a plain converge run', async () => {
    // The defect this flag exists because of: `--apply` used to rotate
    // unconditionally, so re-running a script documented as idempotent took the
    // whole data plane down at the next PostgREST reconnect.
    const r = runRoles(['--project', projectId, '--apply'])
    expect(r.code).toBe(0)
    expect((await tryConnect(urlFor(dbUrl, DB_NAME, AUTHENTICATOR, FIRST))).ok).toBe(true)
  }, 300_000)

  it('rotates only when asked, and the old credential is then REFUSED', async () => {
    const r = runRoles(['--project', projectId, '--apply', '--rotate-password', '--password', SECOND])
    expect(r.code).toBe(0)
    // The warning is part of the contract: this role is cluster-wide and every
    // PostgREST on it will fail at its next reconnect.
    expect(r.out).toMatch(/ROTATING the password/i)

    expect((await tryConnect(urlFor(dbUrl, DB_NAME, AUTHENTICATOR, SECOND))).ok).toBe(true)
    expectRevoked(
      await tryConnect(urlFor(dbUrl, DB_NAME, AUTHENTICATOR, FIRST)),
      'the previous authenticator password',
    )

    const props = await roleProperties(AUTHENTICATOR)
    expect(props).toMatchObject({ rolinherit: false, rolsuper: false, rolbypassrls: false })
  }, 300_000)
})

// ── C. The backup credential ─────────────────────────────────────────────────

describe('C — the backup credential', () => {
  const FIRST = `backup_first_${randomBytes(8).toString('hex')}`
  const SECOND = `backup_second_${randomBytes(8).toString('hex')}`

  beforeAll(async () => {
    // The role the README documents: BYPASSRLS so a dump can read every row,
    // and nothing else. There is no Backenly script for it — it is created and
    // rotated with plain SQL, and named to the product through
    // BACKUP_DATABASE_URL — so that is what is exercised.
    await admin(`DROP ROLE IF EXISTS ${BACKUP_ROLE}`).catch(() => {})
    await admin(
      `CREATE ROLE ${BACKUP_ROLE} LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${FIRST}'`,
    )
    const c = new Client({ connectionString: dbUrl })
    c.on('error', () => {})
    await c.connect()
    try {
      await c.query(`GRANT CONNECT ON DATABASE ${DB_NAME} TO ${BACKUP_ROLE}`)
      await c.query(`CREATE SCHEMA IF NOT EXISTS backup_probe`)
      await c.query(`CREATE TABLE IF NOT EXISTS backup_probe.t (id int)`)
      await c.query(`INSERT INTO backup_probe.t VALUES (7)`)
      await c.query(`GRANT USAGE ON SCHEMA backup_probe TO ${BACKUP_ROLE}`)
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA backup_probe TO ${BACKUP_ROLE}`)
    } finally {
      await c.end()
    }
  }, 300_000)

  it('reads with the old credential, which is the control', async () => {
    const c = new Client({ connectionString: urlFor(dbUrl, DB_NAME, BACKUP_ROLE, FIRST) })
    c.on('error', () => {})
    await c.connect()
    try {
      const rows = await c.query(`SELECT count(*)::int AS n FROM backup_probe.t`)
      expect(rows.rows[0].n).toBe(1)
    } finally {
      await c.end()
    }
  }, 300_000)

  it('rotates: the old credential is REFUSED and the new one reads', async () => {
    await admin(`ALTER ROLE ${BACKUP_ROLE} PASSWORD '${SECOND}'`)

    const c = new Client({ connectionString: urlFor(dbUrl, DB_NAME, BACKUP_ROLE, SECOND) })
    c.on('error', () => {})
    await c.connect()
    try {
      const rows = await c.query(`SELECT count(*)::int AS n FROM backup_probe.t`)
      expect(rows.rows[0].n).toBe(1)
    } finally {
      await c.end()
    }

    expectRevoked(
      await tryConnect(urlFor(dbUrl, DB_NAME, BACKUP_ROLE, FIRST)),
      'the previous backup password',
    )
  }, 300_000)

  it('is still SELECT-only, NOSUPERUSER, and BYPASSRLS only where intended', async () => {
    const props = await roleProperties(BACKUP_ROLE)
    expect(props!.rolsuper).toBe(false)
    // BYPASSRLS is deliberate here and ONLY here: a dump that is subject to
    // policies silently writes an incomplete backup, which is the four-day
    // production outage lib/services/workspace-backup.ts records.
    expect(props!.rolbypassrls).toBe(true)

    const c = new Client({ connectionString: urlFor(dbUrl, DB_NAME, BACKUP_ROLE, SECOND) })
    c.on('error', () => {})
    await c.connect()
    try {
      // A backup credential that can write is a backup credential that can
      // destroy the thing it is backing up.
      await expect(c.query(`INSERT INTO backup_probe.t VALUES (99)`)).rejects.toMatchObject({
        code: '42501',
      })
    } finally {
      await c.end()
    }
  }, 300_000)

  it('is never the connection a RESTORE writes through', async () => {
    // Asserted against the product's own resolver rather than by reading the
    // code: restoring over BACKUP_DATABASE_URL would re-own the restored schema
    // to the backup role, which is how a recovery quietly produces a database
    // the application cannot write to.
    const { buildConnection } = await import('@/lib/services/workspace-backup')

    const previous = process.env.BACKUP_DATABASE_URL
    process.env.BACKUP_DATABASE_URL = urlFor(dbUrl, DB_NAME, BACKUP_ROLE, SECOND)
    try {
      const read = buildConnection('read')
      const write = buildConnection('write')

      // The dump uses the rotated backup credential...
      expect(read.args).toContain(BACKUP_ROLE)
      expect(read.env.PGPASSWORD).toBe(SECOND)

      // ...and the restore does NOT. Paired, so "write avoids it" cannot pass
      // because the resolver ignores BACKUP_DATABASE_URL entirely.
      expect(write.args).not.toContain(BACKUP_ROLE)
      expect(write.env.PGPASSWORD).not.toBe(SECOND)
    } finally {
      if (previous === undefined) delete process.env.BACKUP_DATABASE_URL
      else process.env.BACKUP_DATABASE_URL = previous
    }
  }, 300_000)
})
