/**
 * THE BACKUP CREDENTIAL, AND THE FOUR-ROLE ARCHITECTURE ACTUALLY EXISTING
 * ======================================================================
 *
 * `scripts/setup-app-role.ts` has documented four roles since the credential
 * split, and README.md tabulates them. Three were created by code. The fourth,
 * `backenly_backup`, existed in prose and in a README section telling operators
 * to run the CREATE ROLE themselves — with a grant list covering the workspace
 * schema and NOT `public`, so even an operator who followed it was left with a
 * deployment that could not be recovered.
 *
 * Deployment Recovery therefore ran pg_dump over DATABASE_URL, and on a
 * correctly split install it failed:
 *
 *   pg_dump: error: query failed:
 *   ERROR: permission denied for table backenly_pgrst_schema_registry
 *
 * Every existing recovery test passed, because they run where the role is a
 * superuser. That is the same blind spot that hid the four-day backup outage
 * `workspace-backup.ts` records, and it is why this suite builds the roles for
 * real and uses them for real.
 *
 * ── Why granting the registry to the app role was the wrong fix ─────────────
 *
 * It clears the first error and stops at the next: workspace tables are FORCE
 * ROW LEVEL SECURITY and `backenly_app` is deliberately NOBYPASSRLS, so the
 * workspace dump fails too. The credential is the problem, not the grant. That
 * is asserted here rather than argued: the app role is made to try, and fails.
 *
 * ── Every capability is paired with the refusal beside it ──────────────────
 *
 * "The backup role can dump" is proven next to "the backup role cannot write",
 * and "the app role cannot bypass FORCE RLS" next to "the backup role can". A
 * suite that only showed the grants would pass equally against a role with
 * every privilege in the database.
 */

import { execFileSync, spawnSync } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Client } from 'pg'

const ADMIN_BASE = process.env.TEST_DATABASE_URL!
const DB_NAME = `backenly_backuprole_${randomBytes(4).toString('hex')}`

/** Throwaway names: a role is cluster-wide however isolated the database is. */
const APP_ROLE = `bkn_app_br_${randomBytes(4).toString('hex')}`
const BACKUP_ROLE = `bkn_backup_br_${randomBytes(4).toString('hex')}`
const APP_PASSWORD = `app_${randomBytes(10).toString('hex')}`

// A REAL workspace schema name, hyphens and all: `workspace_<project uuid>`.
// The first version used a hex string, so it never exercised the hyphen and
// the installer stopped on a live install with "unsafe identifier".
const WORKSPACE = `workspace_${randomUUID()}`
const SECRET_ROW = `force-rls-row-${randomBytes(6).toString('hex')}`
const REGISTRY_ROW = `registry-${randomBytes(6).toString('hex')}`

let adminUrl = ''
let dbUrl = ''
let backupUrl = ''
let appUrl = ''
let outDir = ''

function urlFor(base: string, name: string, user?: string, password?: string): string {
  const u = new URL(base)
  u.pathname = `/${name}`
  if (user) u.username = user
  if (password) u.password = password
  return u.toString()
}

async function sql<T = any>(url: string, query: string, params: any[] = []): Promise<T[]> {
  const c = new Client({ connectionString: url })
  c.on('error', () => {})
  await c.connect()
  try {
    return (await c.query(query, params)).rows as T[]
  } finally {
    await c.end()
  }
}

/** Run a statement and report the SQLSTATE rather than throwing. */
async function attempt(url: string, query: string): Promise<{ ok: boolean; code?: string }> {
  const c = new Client({ connectionString: url })
  c.on('error', () => {})
  try {
    await c.connect()
    await c.query(query)
    return { ok: true }
  } catch (err: any) {
    return { ok: false, code: err?.code }
  } finally {
    await c.end().catch(() => {})
  }
}

/** pg_dump, exactly as the product runs it: credentials in env, never argv. */
function pgDump(url: string, schema: string): { ok: boolean; out: string } {
  const parsed = new URL(url)
  const r = spawnSync(
    'pg_dump',
    [
      '--host', parsed.hostname,
      '--port', parsed.port || '5432',
      '--username', decodeURIComponent(parsed.username),
      '--dbname', parsed.pathname.replace(/^\//, ''),
      '--no-password',
      '--schema', schema,
      '--no-owner',
      '--no-privileges',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) },
      timeout: 120_000,
    },
  )
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function runSetupBackupRole(extra: string[] = []): { out: string; code: number } {
  const r = spawnSync(
    process.execPath,
    ['node_modules/tsx/dist/cli.mjs', join('scripts', 'setup-backup-role.ts'), '--apply', ...extra],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        BACKENLY_BACKUP_ROLE: BACKUP_ROLE,
        BACKENLY_APP_ROLE: APP_ROLE,
        BACKENLY_ADMIN_DATABASE_URL: dbUrl,
      },
      timeout: 120_000,
    },
  )
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? 1 }
}

const havePgDump = (() => {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  adminUrl = urlFor(ADMIN_BASE, 'postgres')
  dbUrl = urlFor(ADMIN_BASE, DB_NAME)
  outDir = mkdtempSync(join(tmpdir(), 'backup-role-'))

  await sql(adminUrl, `DROP DATABASE IF EXISTS ${DB_NAME}`)
  await sql(adminUrl, `CREATE DATABASE ${DB_NAME}`)

  // ── A deployment shaped like a real one ─────────────────────────────────
  //
  // The application role owns its schema, is NOSUPERUSER NOBYPASSRLS, and the
  // installer role owns the PostgREST registry in public. That ownership split
  // is the whole reason recovery failed, so the fixture reproduces it exactly.
  await sql(
    adminUrl,
    `CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE ` +
      `PASSWORD '${APP_PASSWORD}'`,
  )
  appUrl = urlFor(ADMIN_BASE, DB_NAME, APP_ROLE, APP_PASSWORD)

  await sql(dbUrl, `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${DB_NAME} TO ${APP_ROLE}`)
  await sql(dbUrl, `GRANT USAGE, CREATE ON SCHEMA public TO ${APP_ROLE}`)

  // Owned by the INSTALLER role, and locked down exactly as the real one is.
  await sql(
    dbUrl,
    `CREATE TABLE public.backenly_pgrst_schema_registry (
       schema_name text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`,
  )
  await sql(dbUrl, `REVOKE ALL ON TABLE public.backenly_pgrst_schema_registry FROM PUBLIC`)
  await sql(dbUrl, `INSERT INTO public.backenly_pgrst_schema_registry (schema_name) VALUES ($1)`, [
    REGISTRY_ROW,
  ])

  // Owned by the APPLICATION role, with FORCE RLS, as workspace tables are.
  await sql(appUrl, `CREATE SCHEMA "${WORKSPACE}"`)
  await sql(
    appUrl,
    `CREATE TABLE "${WORKSPACE}".secrets (id serial PRIMARY KEY, owner_id text NOT NULL, body text NOT NULL)`,
  )
  // Seeded BEFORE the table is protected. Under FORCE RLS the owner is subject
  // to its own policy, so an insert afterwards is refused by the very rule this
  // fixture exists to demonstrate - which is how the first run of this suite
  // failed, in its setup, with "new row violates row-level security policy".
  await sql(appUrl, `INSERT INTO "${WORKSPACE}".secrets (owner_id, body) VALUES ('someone', $1)`, [
    SECRET_ROW,
  ])
  await sql(appUrl, `ALTER TABLE "${WORKSPACE}".secrets ENABLE ROW LEVEL SECURITY`)
  await sql(appUrl, `ALTER TABLE "${WORKSPACE}".secrets FORCE ROW LEVEL SECURITY`)
  await sql(
    appUrl,
    `CREATE POLICY only_owner ON "${WORKSPACE}".secrets
       USING (owner_id = current_setting('request.jwt.claim.sub', true))`,
  )
}, 600_000)

afterAll(async () => {
  for (const role of [BACKUP_ROLE, APP_ROLE]) {
    await sql(dbUrl, `DROP OWNED BY ${role} CASCADE`).catch(() => {})
    await sql(adminUrl, `REASSIGN OWNED BY ${role} TO CURRENT_USER`).catch(() => {})
    await sql(adminUrl, `DROP ROLE IF EXISTS ${role}`).catch(() => {})
  }
  await sql(adminUrl, `DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
  rmSync(outDir, { recursive: true, force: true })
}, 600_000)

// ─────────────────────────────────────────────────────────────────────────────

describe('the application credential cannot do this job, which is why the role exists', () => {
  it('is refused by the registry it does not own', async () => {
    const refused = await attempt(appUrl, `SELECT * FROM public.backenly_pgrst_schema_registry`)
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('42501')
  }, 300_000)

  it('sees NO rows through FORCE RLS, even though it owns the table', async () => {
    // FORCE RLS is what makes owning the schema safe. It is also what makes a
    // dump over this credential silently incomplete - the failure that produced
    // four days of empty backups.
    const rows = await sql(appUrl, `SELECT * FROM "${WORKSPACE}".secrets`)
    expect(rows).toHaveLength(0)

    // CONTROL: the row is really there, read with elevation.
    const actual = await sql(dbUrl, `SELECT body FROM "${WORKSPACE}".secrets`)
    expect(actual.map((r: any) => r.body)).toContain(SECRET_ROW)
  }, 300_000)
})

describe('the installer creates the backup role it advertises', () => {
  it('converges a role with the documented properties', async () => {
    const r = runSetupBackupRole(['--rotate-password'])
    expect(r.code).toBe(0)

    const match = r.out.match(/postgresql:\/\/[^\s]+/)
    expect(match).toBeTruthy()
    backupUrl = match![0]

    const [role] = await sql<{
      rolsuper: boolean
      rolbypassrls: boolean
      rolcanlogin: boolean
      rolcreatedb: boolean
      rolcreaterole: boolean
      rolinherit: boolean
    }>(
      dbUrl,
      `SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole, rolinherit
         FROM pg_roles WHERE rolname = $1`,
      [BACKUP_ROLE],
    )
    expect(role).toBeTruthy()
    expect(role.rolsuper).toBe(false)
    // BYPASSRLS is deliberate and confined to this role.
    expect(role.rolbypassrls).toBe(true)
    expect(role.rolcanlogin).toBe(true)
    expect(role.rolcreatedb).toBe(false)
    expect(role.rolcreaterole).toBe(false)
    expect(role.rolinherit).toBe(false)
  }, 600_000)

  it('leaves the application role exactly as it was', async () => {
    // Creating a backup credential must not quietly widen the one that serves
    // live requests - which is what the rejected alternative would have done.
    const [app] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }>(
      dbUrl,
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE],
    )
    expect(app.rolsuper).toBe(false)
    expect(app.rolbypassrls).toBe(false)

    // And it STILL cannot read the registry: recovery needing access is not a
    // reason for the runtime credential to acquire it.
    const refused = await attempt(appUrl, `SELECT * FROM public.backenly_pgrst_schema_registry`)
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('42501')
  }, 300_000)

  it('is a member of nothing, so it inherits no ownership', async () => {
    const memberships = await sql<{ rolname: string }>(
      dbUrl,
      `SELECT g.rolname FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.roleid
         JOIN pg_roles r ON r.oid = m.member
        WHERE r.rolname = $1`,
      [BACKUP_ROLE],
    )
    expect(memberships).toEqual([])
  }, 300_000)

  it('is idempotent, and does not rotate a credential it was not asked to', async () => {
    const before = await sql<{ p: string }>(
      dbUrl,
      `SELECT rolpassword AS p FROM pg_authid WHERE rolname = $1`,
      [BACKUP_ROLE],
    )
    const again = runSetupBackupRole()
    expect(again.code).toBe(0)
    const after = await sql<{ p: string }>(
      dbUrl,
      `SELECT rolpassword AS p FROM pg_authid WHERE rolname = $1`,
      [BACKUP_ROLE],
    )
    expect(after[0].p).toBe(before[0].p)

    // Still usable afterwards, which is the point of leaving it alone.
    expect((await sql(backupUrl, 'SELECT 1 AS ok'))[0].ok).toBe(1)
  }, 600_000)
})

describe('what the backup role may read', () => {
  it('reads the registry the application role is refused', async () => {
    const rows = await sql<{ schema_name: string }>(
      backupUrl,
      `SELECT schema_name FROM public.backenly_pgrst_schema_registry`,
    )
    expect(rows.map(r => r.schema_name)).toContain(REGISTRY_ROW)
  }, 300_000)

  it('reads THROUGH FORCE RLS, which is the whole reason for BYPASSRLS', async () => {
    const rows = await sql<{ body: string }>(backupUrl, `SELECT body FROM "${WORKSPACE}".secrets`)
    expect(rows.map(r => r.body)).toContain(SECRET_ROW)
  }, 300_000)
})

describe('what the backup role may NOT do', () => {
  it('cannot write a platform row', async () => {
    const refused = await attempt(
      backupUrl,
      `INSERT INTO public.backenly_pgrst_schema_registry (schema_name) VALUES ('nope')`,
    )
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('42501')
  }, 300_000)

  it('cannot write a workspace row', async () => {
    const refused = await attempt(
      backupUrl,
      `INSERT INTO "${WORKSPACE}".secrets (owner_id, body) VALUES ('x', 'nope')`,
    )
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('42501')
  }, 300_000)

  it('cannot delete, update or truncate', async () => {
    for (const statement of [
      `UPDATE "${WORKSPACE}".secrets SET body = 'nope'`,
      `DELETE FROM "${WORKSPACE}".secrets`,
      `TRUNCATE "${WORKSPACE}".secrets`,
    ]) {
      const refused = await attempt(backupUrl, statement)
      expect(refused.ok).toBe(false)
      expect(refused.code).toBe('42501')
    }
  }, 300_000)

  it('cannot create anything', async () => {
    const refused = await attempt(backupUrl, `CREATE TABLE public.should_not_exist (id int)`)
    expect(refused.ok).toBe(false)
  }, 300_000)
})

describe('pg_dump, which is the only thing this credential is for', () => {
  if (!havePgDump) {
    it('cannot be tested without pg_dump on PATH', () => {
      // Stated, not skipped: a tick beside an unrun dump is exactly the
      // reporting that let this defect ship.
      throw new Error('pg_dump is not on PATH, so the dump claims in this file are unproven')
    })
    return
  }

  it('DUMPS public, where the application credential is refused', () => {
    // The precise failure the final qualification hit, from the other side.
    const withApp = pgDump(appUrl, 'public')
    expect(withApp.ok).toBe(false)
    expect(withApp.out).toMatch(/permission denied/i)

    const withBackup = pgDump(backupUrl, 'public')
    expect(withBackup.ok).toBe(true)
    expect(withBackup.out).toContain('backenly_pgrst_schema_registry')
  }, 600_000)

  it('DUMPS a FORCE RLS workspace WITH ITS ROWS', () => {
    // The second failure granting the registry to the app role would have hit.
    // A dump subject to policies succeeds and writes an empty table, which is
    // worse than failing, so the ROW is what is asserted.
    const withApp = pgDump(appUrl, WORKSPACE)
    const appHasRow = withApp.ok && withApp.out.includes(SECRET_ROW)
    expect(appHasRow).toBe(false)

    const withBackup = pgDump(backupUrl, WORKSPACE)
    expect(withBackup.ok).toBe(true)
    expect(withBackup.out).toContain(SECRET_ROW)
  }, 600_000)
})

describe('restore still writes over the application connection', () => {
  it('resolves read to the backup role and write to the application', async () => {
    // pg_dump runs with --no-owner, so psql recreates whatever it replays as
    // the role it connected with. Restoring over the backup credential would
    // make it OWN the restored schema, and FORCE RLS keys on the owner - so a
    // "successful" restore would silently rewrite who every policy binds.
    const { buildConnection } = await import('@/lib/services/workspace-backup')

    const previousBackup = process.env.BACKUP_DATABASE_URL
    const previousDatabase = process.env.DATABASE_URL
    process.env.BACKUP_DATABASE_URL = backupUrl
    process.env.DATABASE_URL = appUrl
    try {
      const read = buildConnection('read')
      const write = buildConnection('write')

      expect(read.args).toContain(BACKUP_ROLE)
      expect(write.args).toContain(APP_ROLE)
      expect(write.args).not.toContain(BACKUP_ROLE)
    } finally {
      if (previousBackup === undefined) delete process.env.BACKUP_DATABASE_URL
      else process.env.BACKUP_DATABASE_URL = previousBackup
      if (previousDatabase === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDatabase
    }
  }, 300_000)
})
