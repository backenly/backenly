/**
 * `--apply` CONVERGES INFRASTRUCTURE. IT DOES NOT ROTATE LIVE CREDENTIALS.
 * =======================================================================
 * setup-postgrest-roles.ts used to run, unconditionally under --apply:
 *
 *   ALTER ROLE backenly_authenticator PASSWORD '<fresh random every run>'
 *
 * The script is documented as idempotent and operators are told to re-run it,
 * so re-running it on any cluster with a live PostgREST silently rotated the
 * credential PostgREST authenticates with. Nothing appears to break at first —
 * existing connections survive on cached auth — until the next reconnect or
 * restart takes the entire /db/* data plane down, with no way back, because the
 * password is printed once and called unrecoverable.
 *
 * It was found by preparing an acceptance install on a host that shares a
 * PostgreSQL cluster with production. Roles are CLUSTER-WIDE, so a separate
 * database does not isolate them: the "safe" test would have rotated
 * production's credential.
 *
 * These assert the three states directly against pg_authid, because the whole
 * property is whether a specific hash on disk changed.
 *
 *   no password + --apply                     password is SET
 *   password    + --apply                     password is UNTOUCHED
 *   password    + --apply --rotate-password   password CHANGES
 *
 * Keyed on the PASSWORD, not on whether the role exists. The prerequisite SQL
 * has to create the role itself — its event triggers grant to it — so existence
 * stopped being able to tell a first install from a live one.
 *
 * The first test covers that install order rather than rotation: a fresh
 * cluster could not create a workspace schema at all, because the trigger
 * granted to roles nothing had created yet. It sits here because it is the same
 * dependency seen from the other side.
 *
 * The role is cluster-wide here too, so these use a throwaway role name rather
 * than the real authenticator, and drop it afterwards.
 */

import { execFileSync, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import { Client } from 'pg'
import * as fs from 'fs'
import * as path from 'path'

const ADMIN_URL = process.env.TEST_DATABASE_URL
const DB_NAME = `backenly_roles_jest_${randomBytes(3).toString('hex')}`
const SCRIPT = path.join(process.cwd(), 'scripts', 'setup-postgrest-roles.ts')

/**
 * Its own database, for the same reason the bootstrap suite has one: the script
 * ends by calling backenly_pgrst_revoke_internal, so the registry SQL must be
 * installed, and installing it into the shared test database would leave
 * functions behind for every other suite.
 *
 * The ROLE is still cluster-wide — a separate database does not isolate that,
 * which is the hazard this file exists to pin — hence the throwaway role name.
 */
let DB_URL = ''

function urlForDatabase(base: string, name: string): string {
  const u = new URL(base)
  u.pathname = `/${name}`
  return u.toString()
}

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!ADMIN_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = ADMIN_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
}

async function adminExec(query: string): Promise<void> {
  const client = new Client({ connectionString: urlForDatabase(ADMIN_URL!, 'postgres') })
  await client.connect()
  try {
    await client.query(query)
  } finally {
    await client.end()
  }
}

/** A throwaway authenticator so the real one is never touched by a test. */
const TEST_AUTHENTICATOR = `bkn_auth_test_${randomBytes(4).toString('hex')}`

async function sql<T = any>(query: string, params: any[] = []): Promise<T[]> {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  try {
    const r = await client.query(query, params)
    return r.rows as T[]
  } finally {
    await client.end()
  }
}

/** The stored password verifier. Null when the role has none. */
async function passwordHash(role: string): Promise<string | null> {
  const rows = await sql<{ rolpassword: string | null }>(
    `SELECT rolpassword FROM pg_authid WHERE rolname = $1`,
    [role],
  )
  return rows[0]?.rolpassword ?? null
}

async function roleExists(role: string): Promise<boolean> {
  const rows = await sql<{ n: string }>(`SELECT count(*) AS n FROM pg_roles WHERE rolname = $1`, [role])
  return Number(rows[0]?.n ?? 0) > 0
}

/**
 * Run the real script against a copy that targets the throwaway role.
 *
 * The authenticator name is a module constant, so the copy is the only way to
 * exercise the genuine code path without mutating the cluster's real
 * authenticator — which is exactly the hazard under test.
 */
const TEMP_SCRIPT = path.join(process.cwd(), 'scripts', `.setup-roles-under-test-${randomBytes(3).toString('hex')}.ts`)

function runSetup(args: string[]): { out: string; code: number } {
  // spawnSync, not execFileSync: execFileSync returns STDOUT only, so the
  // rotation warning — written with console.warn, hence stderr — was invisible
  // to the assertion that checks for it.
  const r = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', TEMP_SCRIPT, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: DB_URL, DIRECT_URL: DB_URL },
  })
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? 1 }
}

let projectId = ''
let schema = ''

beforeAll(async () => {
  assertSafeTestDatabase()
  DB_URL = urlForDatabase(ADMIN_URL!, DB_NAME)

  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME}`)
  await adminExec(`CREATE DATABASE ${DB_NAME}`)
  await adminExec(`DROP ROLE IF EXISTS ${TEST_AUTHENTICATOR}`)

  // Step 0 of the prerequisite chain scripts/bootstrap.ts prints. A database
  // whose application role is not literally `backenly_user` has to say so, or
  // backenly_pgrst_prepare_schema aborts on ALTER DEFAULT PRIVILEGES FOR ROLE.
  // CI connects as `postgres`. Done through the documented setting rather than
  // by creating a `backenly_user` here, so a break in the documented path
  // surfaces as a failure instead of being arranged around.
  const appRole = new URL(ADMIN_URL!).username
  await adminExec(`ALTER DATABASE ${DB_NAME} SET backenly.app_role = '${appRole}'`)

  // The two SQL files are MUTUALLY dependent: the registry calls
  // backenly_pgrst_prepare_schema (defined in ddl-sync) and ddl-sync calls
  // backenly_pgrst_current_schemas (defined in the registry). Function bodies
  // are not resolved at CREATE time, so either order installs successfully, but
  // only registry-first survives this client's stricter validation.
  //
  // Installed with the authenticator RETARGETED, for the same cluster-wide
  // reason the script is. backenly_pgrst_register_schema stores the served
  // schema list in `ALTER ROLE backenly_authenticator SET pgrst.db_schemas`,
  // with no IN DATABASE clause, so creating a canonical workspace schema here
  // would overwrite the REAL authenticator's list for every database on the
  // cluster. A separate test database does not isolate a role setting.
  for (const f of ['postgrest-schema-registry.sql', 'postgrest-ddl-sync.sql']) {
    const text = fs
      .readFileSync(path.join(process.cwd(), 'scripts', 'sql', f), 'utf8')
      .replace(/backenly_authenticator/g, TEST_AUTHENTICATOR)
    const client = new Client({ connectionString: DB_URL })
    await client.connect()
    try {
      await client.query(text)
    } finally {
      await client.end()
    }
  }

  const src = fs.readFileSync(SCRIPT, 'utf8').replace(
    "const AUTHENTICATOR = 'backenly_authenticator'",
    `const AUTHENTICATOR = '${TEST_AUTHENTICATOR}'`,
  )
  if (!src.includes(TEST_AUTHENTICATOR)) throw new Error('could not retarget the authenticator constant')
  fs.writeFileSync(TEMP_SCRIPT, src, 'utf8')

  // The script requires the workspace schema to exist before it will grant on it.
  //
  // This statement is also the regression test for an install-order deadlock,
  // so it is deliberately a CANONICAL workspace name that fires the CREATE
  // SCHEMA event trigger, rather than a cheaper name that would slip past it.
  // See the first test below.
  projectId = require('crypto').randomUUID()
  schema = `workspace_${projectId}`
  await sql(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
}, 120_000)

afterAll(async () => {
  // Ownership is per-database, so drop what the role owns HERE before the role
  // itself, then the database.
  await sql(`DROP OWNED BY ${TEST_AUTHENTICATOR} CASCADE`).catch(() => {})
  await adminExec(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {})
  await adminExec(`DROP ROLE IF EXISTS ${TEST_AUTHENTICATOR}`).catch(() => {})
  fs.rmSync(TEMP_SCRIPT, { force: true })
}, 120_000)

describe('setup-postgrest-roles', () => {
  it('installs the roles its own event triggers grant to', async () => {
    // The documented install order deadlocked on a fresh cluster:
    //
    //   1. install the prerequisite SQL   the CREATE SCHEMA trigger is now live
    //   2. npm run bootstrap              CREATE SCHEMA workspace_<uuid> fires it,
    //                                     reaching GRANT USAGE ON SCHEMA ... TO anon
    //                                     ERROR: role "anon" does not exist
    //   3. setup-postgrest-roles.ts       would create the roles, but it grants
    //                                     per workspace schema, so it refuses to
    //                                     run until step 2's schema exists
    //
    // Step 2 was unreachable and step 3 could not precede it. Found on CI, the
    // only environment here whose cluster has none of these roles already.
    for (const role of ['anon', 'authenticated', 'service_role', TEST_AUTHENTICATOR]) {
      expect(await roleExists(role)).toBe(true)
    }

    // beforeAll created a canonical workspace schema immediately after the
    // install and before ever running the script. That statement succeeding is
    // the proof; this asserts it landed rather than being silently skipped.
    const rows = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM information_schema.schemata WHERE schema_name = $1`,
      [schema],
    )
    expect(Number(rows[0]?.n ?? 0)).toBe(1)
  }, 120_000)

  it('sets the password on an authenticator that has none', async () => {
    // The prerequisite SQL created this role, WITHOUT a password. That is the
    // state a first install is genuinely in now, and it is why the script asks
    // whether a password exists rather than whether the role does: keyed on
    // existence, a first install would print no connection string at all.
    expect(await roleExists(TEST_AUTHENTICATOR)).toBe(true)
    expect(await passwordHash(TEST_AUTHENTICATOR)).toBeNull()

    const r = runSetup(['--project', projectId, '--apply'])
    expect(r.code).toBe(0)

    expect(await passwordHash(TEST_AUTHENTICATOR)).not.toBeNull()
    // A first run must hand the operator the credential; there is no other copy.
    expect(r.out).toContain('Connection string for postgrest.conf')
  }, 120_000)

  it('leaves the password untouched when re-run, and still converges the grants', async () => {
    const before = await passwordHash(TEST_AUTHENTICATOR)
    expect(before).not.toBeNull()

    const r = runSetup(['--project', projectId, '--apply'])
    expect(r.code).toBe(0)

    // THE assertion this file exists for. A live PostgREST keeps working.
    expect(await passwordHash(TEST_AUTHENTICATOR)).toBe(before)
    // The exact branch matters: "left alone because I could not read pg_authid"
    // prints a similar sentence and is a DIFFERENT outcome.
    expect(r.out).toContain('already had a password, so it was left ALONE')
    expect(r.out).not.toContain('Connection string for postgrest.conf')

    // Convergence still happened: the grants are re-asserted every run, which
    // is the actual point of a repeatable setup command. has_schema_privilege
    // asks the catalog directly rather than going through an information_schema
    // view that only lists grants the CURRENT user made.
    const usage = await sql<{ ok: boolean }>(
      `SELECT has_schema_privilege('anon', $1, 'USAGE') AS ok`,
      [schema],
    )
    expect(usage[0]?.ok).toBe(true)
  }, 120_000)

  it('rotates only when asked, and warns that the role is cluster-wide', async () => {
    const before = await passwordHash(TEST_AUTHENTICATOR)

    const r = runSetup(['--project', projectId, '--apply', '--rotate-password'])
    expect(r.code).toBe(0)

    expect(await passwordHash(TEST_AUTHENTICATOR)).not.toBe(before)
    expect(r.out).toContain('ROTATING')
    expect(r.out).toContain('CLUSTER-WIDE')
    // Rotation is useless without the new credential.
    expect(r.out).toContain('Connection string for postgrest.conf')
  }, 120_000)

  it('would fail if the unconditional rotation were reintroduced', async () => {
    // Mutation test. Restores the original defect in a copy and proves the
    // re-run assertion above actually catches it, rather than passing because
    // the password happened not to change.
    const broken = fs
      .readFileSync(TEMP_SCRIPT, 'utf8')
      .replace(
        "const willSetPassword = credential === 'absent' || rotatePassword",
        'const willSetPassword = true',
      )
    expect(broken).toContain('const willSetPassword = true')
    fs.writeFileSync(TEMP_SCRIPT, broken, 'utf8')

    const before = await passwordHash(TEST_AUTHENTICATOR)
    const r = runSetup(['--project', projectId, '--apply'])
    expect(r.code).toBe(0)

    expect(await passwordHash(TEST_AUTHENTICATOR)).not.toBe(before)
  }, 120_000)
})
