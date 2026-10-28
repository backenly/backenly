/**
 * THE REGIONAL DATABASE PROCEDURE, REHEARSED ON A FRESH POSTGRESQL 16
 * ===================================================================
 * tools/managed-db/regional/bootstrap.sh, run for real, from a copy of exactly
 * the files its image carries (image-files.txt), against a PostgreSQL 16
 * cluster this suite creates with initdb and throws away. A cluster of its own
 * because roles are CLUSTER-WIDE: the procedure creates backenly_app,
 * backenly_authenticator, anon and the rest by their real names, and in the
 * shared test cluster it would collide with, and alter, roles other suites use.
 *
 * Production-equivalent wherever stock PostgreSQL allows it:
 *
 *   - scram-sha-256 password authentication for every role, so the verifiers
 *     the procedure sets are proven by logging in with the passwords;
 *   - pg_stat_statements preloaded, as the instance's parameter group does;
 *   - pgvector where the machine has it. CI installs it and requires it; a
 *     laptop without it runs with BOOTSTRAP_REHEARSAL and the notice is asserted;
 *   - an administrator that is NOT a superuser, like the RDS master: CREATEROLE
 *     CREATEDB, owner of the database, a member of pg_monitor (RDS makes its
 *     master one through rds_superuser), and BYPASSRLS, because stock
 *     PostgreSQL 16 lets a CREATEROLE role grant only attributes it holds and
 *     the backup role needs that one.
 *
 * That administrator runs the first apply, which creates the roles and stops
 * exactly where stock PostgreSQL needs a superuser: the first event trigger
 * (RDS lets its master create them). A superuser finishes the install, and then
 * every object it created is handed to the administrator, which is how RDS
 * leaves them: the master installs, and so owns, everything. Event triggers stay
 * with the superuser, as stock PostgreSQL requires; their functions are SECURITY
 * DEFINER, so they too run as the administrator. The application's own paths
 * are then exercised against that database, as the application.
 *
 * Measured this way, two things a superuser install hides were found and are
 * now part of the procedure (sql/roles.sql): the definers need the privileges of
 * the application role, and must be able to become the roles they create for it.
 * A third is in the definers themselves: dropping a login needs its privileges,
 * which its creator does not hold (see the block on logins below).
 *
 * What only a throwaway RDS instance can add is RDS's own role patches; that
 * rehearsal needs AWS and is not this suite.
 *
 * The tests run in order and depend on each other: this is the procedure's
 * life in one region, not a set of unrelated facts.
 */

import { execFileSync, spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { Client } from 'pg'

import { disconnectRegionalClients } from '@/lib/data-plane/regional'
import { prisma } from '@/lib/db/prisma'
import { driftCaptureHealth, driftEventBacklog } from '@/lib/autonomy/drift-event-upkeep'
import { hasCapability, resetCapabilityCache } from '@/lib/autonomy/platform-capabilities'
import { createProvisionedProject } from '@/lib/projects/provision'
import { directAccessRoleNames, revokeDirectAccess, syncDirectAccessGrants } from '@/lib/services/direct-access'
import { generatePassword, scramSha256Verifier } from '@/tools/managed-db/regional/scram'

jest.setTimeout(300_000)

const ROOT = process.cwd()
const DB = 'backenly_regional'
const ADMIN = 'regional_admin'
const STEPS = ['roles', 'postgrest', 'drift-events', 'regional-bodies', 'auth-projection', 'direct-access', 'extensions']
const LOGINS = ['backenly_app', 'backenly_backup', 'backenly_authenticator'] as const
type Login = (typeof LOGINS)[number]
const VERIFIER_VARIABLE: Record<Login, string> = {
  backenly_app: 'BACKENLY_APP_VERIFIER',
  backenly_backup: 'BACKENLY_BACKUP_VERIFIER',
  backenly_authenticator: 'BACKENLY_AUTHENTICATOR_VERIFIER',
}

const SUPER_PW = generatePassword()
const ADMIN_PW = generatePassword()
const passwords: Record<Login, string> = {
  backenly_app: generatePassword(),
  backenly_backup: generatePassword(),
  backenly_authenticator: generatePassword(),
}

let bin = ''
let work = ''
let data = ''
let script = ''
let port = 0
let vectorAvailable = false

const exe = (name: string) => path.join(bin, process.platform === 'win32' ? `${name}.exe` : name)

function url(user: string, password: string, database = DB): string {
  return `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`
}
const superUrl = (database = DB) => url('postgres', SUPER_PW, database)
const adminUrl = (database = DB) => url(ADMIN, ADMIN_PW, database)
const loginUrl = (role: Login) => url(role, passwords[role])

async function rows<T = Record<string, unknown>>(connection: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: connection })
  client.on('error', () => {})
  await client.connect()
  try {
    return (await client.query(sql, params)).rows as T[]
  } finally {
    await client.end().catch(() => {})
  }
}

/** The error a statement fails with, or null. */
async function refusal(connection: string, sql: string): Promise<string | null> {
  try {
    await rows(connection, sql)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** PostgreSQL 16 server binaries: PG_BINDIR, else the pg_config on PATH. */
function postgresBinaries(): string {
  let dir = process.env.PG_BINDIR ?? ''
  if (!dir) {
    try {
      dir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()
    } catch {
      throw new Error('Set PG_BINDIR to a PostgreSQL 16 bin directory (initdb, pg_ctl, psql); pg_config is not on PATH')
    }
  }
  const initdb = path.join(dir, process.platform === 'win32' ? 'initdb.exe' : 'initdb')
  if (!fs.existsSync(initdb)) throw new Error(`No initdb in ${dir}; set PG_BINDIR to a PostgreSQL 16 bin directory`)
  const version = execFileSync(initdb, ['--version'], { encoding: 'utf8' })
  if (!/\(PostgreSQL\) 16\./.test(version)) throw new Error(`The rehearsal needs PostgreSQL 16; ${initdb} is ${version.trim()}`)
  return dir
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}

function configure(lines: string[]): void {
  fs.appendFileSync(path.join(data, 'postgresql.conf'), `\n${lines.join('\n')}\n`)
}

function pgCtl(args: string[]): void {
  // stdio ignored: on Windows the server inherits pg_ctl's handles, and a pipe
  // it holds open would keep this call waiting for as long as the server runs.
  execFileSync(exe('pg_ctl'), ['-D', data, ...args], { stdio: 'ignore', timeout: 120_000 })
}

/** The image's files, at their repository paths, and nothing else. */
function assembleImageTree(): string {
  const tree = path.join(work, 'tree')
  const listed = fs
    .readFileSync(path.join(ROOT, 'tools/managed-db/regional/image-files.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  for (const file of listed) {
    fs.mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
    fs.copyFileSync(path.join(ROOT, file), path.join(tree, file))
  }
  return path.join(tree, 'tools/managed-db/regional/bootstrap.sh').replace(/\\/g, '/')
}

/** Runs the procedure as its image would: these variables and no others of ours. */
function bootstrap(env: Record<string, string>): { status: number; output: string } {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(PG|BACKENLY_|BOOTSTRAP_|DATABASE_URL|DIRECT_URL)/i.test(key)),
  ) as Record<string, string>
  // This cluster's psql first, so the client is PostgreSQL 16 like the image's.
  const pathKey = Object.keys(inherited).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  inherited[pathKey] = `${bin}${path.delimiter}${inherited[pathKey] ?? ''}`
  const rehearsal: Record<string, string> = vectorAvailable ? {} : { BOOTSTRAP_REHEARSAL: 'true' }
  const result = spawnSync('bash', ['-c', 'exec bash "$0" 2>&1', script], {
    encoding: 'utf8',
    env: { ...inherited, ...rehearsal, ...env } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 240_000,
  })
  return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function verifiers(roles: Login[] = [...LOGINS]): Record<string, string> {
  return Object.fromEntries(roles.map((role) => [VERIFIER_VARIABLE[role], scramSha256Verifier(passwords[role])]))
}

/**
 * Everything the procedure could change, without timestamps of runs: roles and
 * their stored passwords, memberships, role settings, functions, event
 * triggers, extensions, relations, schemas, the database ACL and the ledgers.
 */
async function catalog(database = DB): Promise<unknown> {
  const [row] = await rows<{ catalog: unknown }>(
    superUrl(database),
    `SELECT json_build_object(
       'roles', (SELECT json_agg(json_build_object('n', rolname, 'super', rolsuper, 'inherit', rolinherit,
                   'createrole', rolcreaterole, 'createdb', rolcreatedb, 'login', rolcanlogin,
                   'replication', rolreplication, 'bypassrls', rolbypassrls, 'password', rolpassword)
                   ORDER BY rolname)
                   FROM pg_authid WHERE rolname NOT LIKE 'pg\\_%'),
       'members', (SELECT json_agg(json_build_object('role', roleid::regrole::text, 'member', member::regrole::text,
                   'grantor', grantor::regrole::text, 'admin', admin_option, 'inherit', inherit_option,
                   'set', set_option) ORDER BY roleid::regrole::text, member::regrole::text, grantor::regrole::text)
                   FROM pg_auth_members),
       'settings', (SELECT json_agg(json_build_object('database', setdatabase, 'role', setrole, 'config', setconfig)
                   ORDER BY setdatabase, setrole) FROM pg_db_role_setting),
       'functions', (SELECT json_agg(json_build_object('f', p.oid::regprocedure::text, 'src', md5(p.prosrc),
                   'owner', pg_get_userbyid(p.proowner), 'acl', p.proacl::text, 'definer', p.prosecdef,
                   'config', p.proconfig) ORDER BY p.oid::regprocedure::text)
                   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'postgrest')),
       'triggers', (SELECT json_agg(json_build_object('t', evtname, 'event', evtevent, 'fn', evtfoid::regproc::text,
                   'enabled', evtenabled, 'tags', evttags) ORDER BY evtname) FROM pg_event_trigger),
       'extensions', (SELECT json_agg(json_build_object('e', extname, 'version', extversion,
                   'schema', extnamespace::regnamespace::text) ORDER BY extname) FROM pg_extension),
       'relations', (SELECT json_agg(json_build_object('r', c.oid::regclass::text, 'owner', pg_get_userbyid(c.relowner),
                   'acl', c.relacl::text) ORDER BY c.oid::regclass::text)
                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname IN ('public', 'postgrest', 'backenly_meta') AND c.relkind IN ('r', 'p', 'v', 'S')),
       'schemas', (SELECT json_agg(json_build_object('s', nspname, 'owner', pg_get_userbyid(nspowner), 'acl', nspacl::text)
                   ORDER BY nspname) FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'),
       'database', (SELECT datacl::text FROM pg_database WHERE datname = current_database()),
       'steps', (SELECT json_agg(json_build_object('step', step, 'checksum', checksum) ORDER BY step)
                   FROM backenly_meta.bootstrap_steps),
       'credentials', (SELECT json_agg(json_build_object('role', role_name, 'set_at', set_at, 'rotations', rotations)
                   ORDER BY role_name) FROM backenly_meta.bootstrap_credentials)
     ) AS catalog`,
  )
  return row.catalog
}

/** As RDS leaves it: the administrator owns what was installed. Event triggers excepted. */
async function handToAdministrator(): Promise<void> {
  await rows(
    superUrl(),
    `DO $$
     DECLARE r record;
     BEGIN
       FOR r IN SELECT nspname FROM pg_namespace
                 WHERE nspowner = 'postgres'::regrole AND nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
       LOOP EXECUTE format('ALTER SCHEMA %I OWNER TO ${ADMIN}', r.nspname); END LOOP;
       FOR r IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE p.proowner = 'postgres'::regrole AND n.nspname IN ('public', 'postgrest')
                   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
       LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO ${ADMIN}', r.sig); END LOOP;
       FOR r IN SELECT c.oid::regclass AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE c.relowner = 'postgres'::regrole AND n.nspname IN ('public', 'postgrest', 'backenly_meta')
                   AND c.relkind IN ('r', 'p', 'v', 'm')
                   AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
       LOOP EXECUTE format('ALTER TABLE %s OWNER TO ${ADMIN}', r.rel); END LOOP;
     END $$`,
  )
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  bin = postgresBinaries()
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'regional-bootstrap-'))
  data = path.join(work, 'data')
  const pwfile = path.join(work, 'superuser-password')
  fs.writeFileSync(pwfile, SUPER_PW)
  execFileSync(
    exe('initdb'),
    ['-D', data, '-U', 'postgres', `--pwfile=${pwfile}`, '--auth=scram-sha-256', '-E', 'UTF8', '--locale=C', '--no-sync'],
    { stdio: 'ignore', timeout: 120_000 },
  )
  port = await freePort()
  configure([
    `port = ${port}`,
    `listen_addresses = '127.0.0.1'`,
    `unix_socket_directories = ''`,
    `shared_preload_libraries = 'pg_stat_statements'`,
    'fsync = off',
    'synchronous_commit = off',
    'full_page_writes = off',
  ])
  pgCtl(['-l', path.join(work, 'server.log'), '-w', '-t', '60', 'start'])

  await rows(superUrl('postgres'), `CREATE ROLE ${ADMIN} LOGIN CREATEROLE CREATEDB BYPASSRLS PASSWORD '${ADMIN_PW}'`)
  await rows(superUrl('postgres'), `GRANT pg_monitor TO ${ADMIN}`)
  await rows(superUrl('postgres'), `CREATE DATABASE ${DB} OWNER ${ADMIN}`)

  vectorAvailable = (await rows(superUrl(), `SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)).length > 0
  if (process.env.CI && !vectorAvailable) {
    throw new Error('CI rehearses the full extension set: install pgvector for PostgreSQL 16 on the runner')
  }
  script = assembleImageTree()
})

afterAll(async () => {
  await disconnectRegionalClients()
  delete process.env.DATABASE_URL_US_EAST_1
  try {
    if (data) pgCtl(['-m', 'fast', '-w', 'stop'])
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true })
  }
})

describe('a region’s first database', () => {
  it('is checked before anything is written, and the check lists every step and credential', async () => {
    const result = bootstrap({ DATABASE_URL: adminUrl(), BOOTSTRAP_MODE: 'check', EXPECT_DATABASE: DB })
    expect(result.status).toBe(0)
    for (const step of STEPS) expect(result.output).toContain(`step ${step}: pending`)
    for (const role of LOGINS) expect(result.output).toContain(`credential ${role}: missing (the first apply must supply ${VERIFIER_VARIABLE[role]})`)
    expect(result.output).toContain(`Check only: nothing was written. ${STEPS.length} step(s) not applied yet.`)
    expect(await rows(superUrl(), `SELECT 1 FROM pg_namespace WHERE nspname = 'backenly_meta'`)).toEqual([])
    expect(await rows(superUrl(), `SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`, [[...LOGINS]])).toEqual([])
  })

  it('gets its roles and credentials from an administrator that is not a superuser, which stops where stock PostgreSQL needs one', async () => {
    const result = bootstrap({ DATABASE_URL: adminUrl(), BOOTSTRAP_MODE: 'apply', EXPECT_DATABASE: DB, ...verifiers() })
    expect(result.output).toContain('step roles: applied')
    expect(result.output).toContain('Must be superuser to create an event trigger')
    expect(result.status).not.toBe(0)
    expect(result.output).not.toContain('step postgrest: applied')

    const steps = await rows<{ step: string }>(superUrl(), `SELECT step FROM backenly_meta.bootstrap_steps ORDER BY step`)
    expect(steps.map((s) => s.step)).toEqual(['roles'])
    const credentials = await rows<{ role_name: string; set_by: string; rotations: number }>(
      superUrl(),
      `SELECT role_name, set_by, rotations FROM backenly_meta.bootstrap_credentials ORDER BY role_name`,
    )
    expect(credentials).toEqual([...LOGINS].sort().map((role_name) => ({ role_name, set_by: ADMIN, rotations: 0 })))

    const attributes = await rows(
      superUrl(),
      `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolbypassrls
         FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [[...LOGINS, 'anon', 'authenticated', 'service_role', 'backenly_external']],
    )
    const no = { rolsuper: false, rolcreaterole: false, rolcreatedb: false }
    expect(attributes).toEqual([
      { rolname: 'anon', ...no, rolinherit: true, rolcanlogin: false, rolbypassrls: false },
      { rolname: 'authenticated', ...no, rolinherit: true, rolcanlogin: false, rolbypassrls: false },
      { rolname: 'backenly_app', ...no, rolinherit: true, rolcanlogin: true, rolbypassrls: false },
      { rolname: 'backenly_authenticator', ...no, rolinherit: false, rolcanlogin: true, rolbypassrls: false },
      { rolname: 'backenly_backup', ...no, rolinherit: false, rolcanlogin: true, rolbypassrls: true },
      { rolname: 'backenly_external', ...no, rolinherit: true, rolcanlogin: false, rolbypassrls: false },
      { rolname: 'service_role', ...no, rolinherit: true, rolcanlogin: false, rolbypassrls: false },
    ])

    // The verifiers are the passwords: each role logs in with its own, and not with another's.
    for (const role of LOGINS) {
      expect(await rows(loginUrl(role), 'SELECT current_user AS me')).toEqual([{ me: role }])
      expect(await refusal(url(role, generatePassword()), 'SELECT 1')).toMatch(/password authentication failed/)
    }
  })

  it('is finished by a superuser, and verifies', async () => {
    const result = bootstrap({ DATABASE_URL: superUrl(), BOOTSTRAP_MODE: 'apply', EXPECT_DATABASE: DB })
    expect(result.output).toContain('Regional database initialised and verified.')
    expect(result.status).toBe(0)
    expect(result.output).toContain('step roles: re-applied (files unchanged)')
    for (const step of STEPS.slice(1)) expect(result.output).toContain(`step ${step}: applied`)
    for (const role of LOGINS) expect(result.output).toMatch(new RegExp(`credential ${role}: recorded \\d{4}-`))
    if (!vectorAvailable) {
      expect(result.output).toContain('rehearsal: extension vector is not available on this server')
    }
    const extensions = await rows<{ extname: string; schema: string }>(
      superUrl(),
      `SELECT extname, extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname`,
    )
    expect(extensions).toEqual(
      ['pg_stat_statements', 'pgstattuple', ...(vectorAvailable ? ['vector'] : [])].map((extname) => ({ extname, schema: 'public' })),
    )
  })

  it('is re-applied without changing anything', async () => {
    const before = await catalog()
    const result = bootstrap({ DATABASE_URL: superUrl(), BOOTSTRAP_MODE: 'apply', EXPECT_DATABASE: DB })
    expect(result.output).toContain('Regional database initialised and verified.')
    expect(result.status).toBe(0)
    for (const step of STEPS) expect(result.output).toContain(`step ${step}: re-applied (files unchanged)`)
    expect(await catalog()).toEqual(before)
  })

  it('is handed to the administrator, as RDS leaves it, and a check audits it, writing nothing', async () => {
    // After this nothing re-applies until the application has run against it:
    // setup-direct-access.sql drops and recreates its role functions on every
    // run, so a superuser re-apply would take them back, a mix RDS never has.
    await handToAdministrator()
    const owners = await rows<{ owner: string }>(
      superUrl(),
      `SELECT DISTINCT pg_get_userbyid(p.proowner) AS owner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname LIKE 'backenly\\_%'`,
    )
    expect(owners).toEqual([{ owner: ADMIN }])

    const before = await rows(superUrl(), `SELECT step, checksum, applied_at, applied_by FROM backenly_meta.bootstrap_steps ORDER BY step`)
    const result = bootstrap({ DATABASE_URL: adminUrl(), BOOTSTRAP_MODE: 'check', EXPECT_DATABASE: DB })
    expect(result.output).toContain('Check only: nothing was written. Every step is recorded, and the database verifies.')
    expect(result.status).toBe(0)
    for (const step of STEPS) expect(result.output).toContain(`step ${step}: current`)
    for (const role of LOGINS) expect(result.output).toContain(`credential ${role}: recorded`)
    expect(await rows(superUrl(), `SELECT step, checksum, applied_at, applied_by FROM backenly_meta.bootstrap_steps ORDER BY step`)).toEqual(before)
  })
})

describe('the application, against the database the procedure built', () => {
  const id = randomUUID()
  const schema = `workspace_${id}`
  // Named as the platform names them, which is how the capture tells whose they are.
  const { rw, ro, owner } = directAccessRoleNames(id)
  const rwPassword = generatePassword()
  const roPassword = generatePassword()
  const app = () => loginUrl('backenly_app')

  it('creates a workspace, and PostgREST is told to serve it', async () => {
    await rows(app(), `CREATE SCHEMA "${schema}"`)
    const [{ served }] = await rows<{ served: string }>(app(), `SELECT public.backenly_pgrst_current_schemas() AS served`)
    expect(served.split(',')).toContain(schema)
    await rows(app(), `CREATE TABLE "${schema}".notes (id serial PRIMARY KEY, body text)`)
    await rows(app(), `INSERT INTO "${schema}".notes (body) VALUES ('from the app')`)
  })

  it('hands out direct access, and DDL over it is captured as drift in the region', async () => {
    await rows(app(), `SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_WRITE')`, [rw, rwPassword, schema])
    await rows(app(), `SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_ONLY')`, [ro, roPassword, schema])
    await rows(app(), `SELECT public.backenly_direct_sync_schema($1, $2, $3, $4)`, [schema, ro, rw, owner])
    expect(await rows(superUrl(), `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1`, [schema])).toEqual([{ owner }])

    await rows(url(rw, rwPassword), `CREATE TABLE "${schema}".probe (id int)`)
    const events = await rows<{ roleName: string; commandTag: string; status: string; projectId: string }>(
      app(),
      `SELECT "roleName", "commandTag", status, "projectId" FROM public.schema_drift_events ORDER BY "capturedAt"`,
    )
    expect(events.filter((e) => e.commandTag === 'CREATE TABLE')).toEqual([
      { roleName: rw, commandTag: 'CREATE TABLE', status: 'pending', projectId: id },
    ])
    // The PostgREST sync's grants on the new table run inside the same statement
    // and are captured too. A GRANT names no object, and is still the project's.
    expect(events.length).toBeGreaterThan(1)
    expect(events.every((e) => e.roleName === rw && e.projectId === id)).toBe(true)

    expect(await rows(url(ro, roPassword), `SELECT body FROM "${schema}".notes`)).toEqual([{ body: 'from the app' }])
    expect(await refusal(url(ro, roPassword), `INSERT INTO "${schema}".notes (body) VALUES ('x')`)).toMatch(/read-only|permission denied/)
  })

  it('is watched by the platform’s own regional checks, reading as the application', async () => {
    process.env.DATABASE_URL_US_EAST_1 = app()
    expect(await driftCaptureHealth('us-east-1')).toEqual({ status: 'healthy', problems: [] })
    const [{ pending }] = await rows<{ pending: number }>(
      superUrl(),
      `SELECT count(*)::int AS pending FROM public.schema_drift_events WHERE status = 'pending'`,
    )
    expect(pending).toBeGreaterThan(0)
    // This suite made the workspace without a platform project, so no adoption
    // will ever clear its events: they are orphaned, and do not age the backlog.
    expect(await driftEventBacklog('us-east-1')).toEqual({ pending: 0, oldestPendingSeconds: null, orphaned: pending })
    resetCapabilityCache()
    expect(await hasCapability('pg_stat_statements', 'us-east-1')).toMatchObject({ available: true, indeterminate: false })
    expect(await hasCapability('pgstattuple', 'us-east-1')).toMatchObject({ available: true, indeterminate: false })
  })

  it('keeps each role to its job', async () => {
    // The app reads, adopts and prunes drift events; only the capture inserts them.
    expect(await refusal(app(), `INSERT INTO public.schema_drift_events ("id", "roleName", "commandTag") VALUES ('x', 'y', 'z')`)).toMatch(/permission denied/)
    // The app keeps the region's customer data off the platform rows; nobody else reads it.
    expect(await refusal(app(), `INSERT INTO public.regional_bodies ("kind", "id", "projectId") VALUES ('webhook', 'x', 'p'); DELETE FROM public.regional_bodies WHERE "id" = 'x'`)).toBeNull()
    // The app reads the region's authorization copy, and home writes it as the app.
    expect(
      await refusal(
        app(),
        `INSERT INTO public.auth_projection_projects ("id", "version") VALUES ('x', 1); DELETE FROM public.auth_projection_projects WHERE "id" = 'x'; ` +
          `SELECT count(*) FROM public.auth_projection_keys; SELECT count(*) FROM public.auth_projection_branches; SELECT count(*) FROM public.auth_projection_state; ` +
          `INSERT INTO public.auth_rate_windows ("keyId", "windowSeconds", "keyMark", "resetAt", "count", "lastUsedAt") VALUES ('x', 60, 'm', now(), 1, now()); ` +
          `DELETE FROM public.auth_rate_windows WHERE "keyId" = 'x'`,
      ),
    ).toBeNull()
    // The backup role reads every workspace, for pg_dump.
    expect(await rows(loginUrl('backenly_backup'), `SELECT count(*)::int AS n FROM "${schema}".notes`)).toEqual([{ n: 1 }])
    // The authenticator holds nothing itself and can become only the API roles.
    const authenticator = loginUrl('backenly_authenticator')
    expect(await refusal(authenticator, `SELECT count(*) FROM public.schema_drift_events`)).toMatch(/permission denied/)
    expect(await refusal(authenticator, `SELECT count(*) FROM public.regional_bodies`)).toMatch(/permission denied/)
    for (const copy of ['auth_projection_state', 'auth_projection_projects', 'auth_projection_keys', 'auth_projection_branches', 'auth_rate_windows']) {
      expect(await refusal(authenticator, `SELECT count(*) FROM public.${copy}`)).toMatch(/permission denied/)
      // Nor any role it can become: the copy holds key hashes and signing secrets.
      for (const apiRole of ['anon', 'authenticated', 'service_role']) {
        expect(await refusal(authenticator, `SELECT postgrest.pre_config(); SET ROLE ${apiRole}; SELECT count(*) FROM public.${copy}`)).toMatch(/permission denied/)
      }
    }
    expect(await refusal(authenticator, `SET ROLE backenly_app`)).toMatch(/permission denied/)
    expect(await refusal(authenticator, `SET ROLE anon; SELECT postgrest.pre_config()`)).toMatch(/permission denied/)
    expect(await refusal(authenticator, `SELECT postgrest.pre_config(); SET ROLE anon; SET ROLE authenticated; SET ROLE service_role`)).toBeNull()
    // Nobody else may call the definers.
    expect(await refusal(url(ro, roPassword), `SELECT public.backenly_direct_create_role('bkn_rw_000000000000', '${generatePassword()}', '${schema}', 'READ_WRITE')`)).toMatch(/permission denied/)
  })
})

/** Every table and sequence in `schema` the backup role cannot read: what fails pg_dump. */
async function unreadableByBackup(schema: string): Promise<string[]> {
  const found = await rows<{ relname: string }>(
    superUrl(),
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'S')
        AND NOT has_table_privilege('backenly_backup', c.oid, 'SELECT')
      ORDER BY 1`,
    [schema],
  )
  return found.map((r) => r.relname)
}

async function backupCanUse(schema: string): Promise<boolean> {
  const [{ usable }] = await rows<{ usable: boolean }>(
    superUrl(),
    `SELECT has_schema_privilege('backenly_backup', $1, 'USAGE') AS usable`,
    [schema],
  )
  return usable
}

/** pg_dump of one workspace as the backup login, the way the snapshot job runs it. */
function dumpAsBackup(schema: string): { status: number; stdout: string; stderr: string } {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key))) as NodeJS.ProcessEnv
  const result = spawnSync(
    exe('pg_dump'),
    ['--host', '127.0.0.1', '--port', String(port), '--username', 'backenly_backup', '--dbname', DB,
     '--no-password', '--schema', schema, '--no-privileges', '--no-owner'],
    { encoding: 'utf8', env: { ...env, PGPASSWORD: passwords.backenly_backup }, timeout: 60_000 },
  )
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

describe('a project without direct access, which the application makes in the region', () => {
  // Every snapshot of such a project failed in pg_dump, as backenly_backup, with
  // "permission denied for schema": the backup role was given read on a
  // workspace only by the direct-access sync, and only for a project with a
  // direct-access role.
  const REGION = 'us-east-1'
  const saved = {
    edition: process.env.BACKENLY_EDITION,
    backupDir: process.env.BACKUP_DIR,
    path: process.env.PATH,
  }
  let ownerId = ''
  let projectId = ''
  let schema = ''

  beforeAll(async () => {
    process.env.DATABASE_URL_US_EAST_1 = loginUrl('backenly_app')
    // Project creation is refused on a single-tenant deployment, the default.
    process.env.BACKENLY_EDITION = 'cloud'
    // workspace-backup reads it when it loads, which is lazily, below.
    process.env.BACKUP_DIR = path.join(work, 'backups')
    ownerId = (
      await prisma.user.create({
        data: { email: `regional-backups-${randomUUID()}@example.test`, name: 'regional backups fixture' },
        select: { id: true },
      })
    ).id
  })

  afterAll(async () => {
    for (const [key, value] of [
      ['BACKENLY_EDITION', saved.edition],
      ['BACKUP_DIR', saved.backupDir],
      ['PATH', saved.path],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    delete process.env.BACKUP_DATABASE_URL_US_EAST_1
    delete process.env.BACKENLY_SERVICE_REGION
    if (projectId) await prisma.workspaceBackup.deleteMany({ where: { projectId } }).catch(() => {})
    if (ownerId) {
      await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
      await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
    }
  })

  it('is readable by the backup role from the moment the application creates it', async () => {
    const created = await createProvisionedProject({ name: `regional backups ${randomUUID()}`, userId: ownerId, region: REGION })
    projectId = created.id
    schema = created.postgresSchema
    expect(await backupCanUse(schema)).toBe(true)
    // And nothing else: the schema is still the application's, with no direct-access role.
    expect(await rows(superUrl(), `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1`, [schema])).toEqual([
      { owner: 'backenly_app' },
    ])
  })

  it('stays readable as the application adds tables, with no sync after them', async () => {
    // Over the application's own login, as every platform path runs its DDL
    // (typed actions, migrations, imports, branch merges): its default privilege
    // covers each table from the moment it exists.
    await rows(
      loginUrl('backenly_app'),
      `CREATE TABLE "${schema}".orders (id serial PRIMARY KEY, total integer);
       CREATE TABLE "${schema}".customers (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text)`,
    )
    expect(await unreadableByBackup(schema)).toEqual([])
    const relations = await rows<{ relname: string }>(
      superUrl(),
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 ORDER BY 1`,
      [schema],
    )
    expect(relations.map((r) => r.relname)).toEqual(expect.arrayContaining(['customers', 'customers_id_seq', 'orders', 'orders_id_seq']))
  })

  it('is synced after DDL that no default privilege covers, though it has no direct-access credentials', async () => {
    // A table made by hand as the administrator: neither the application nor a developer.
    await rows(adminUrl(), `CREATE TABLE "${schema}".by_hand (id serial PRIMARY KEY)`)
    expect(await unreadableByBackup(schema)).toEqual(['by_hand', 'by_hand_id_seq'])

    await syncDirectAccessGrants(projectId)

    expect(await unreadableByBackup(schema)).toEqual([])
  })

  it('is dumped by the snapshot job as the backup role, restored, and dumped again', async () => {
    // As us-east-1's own process, with the region's backup credential, and this
    // cluster's own pg_dump and psql.
    process.env.BACKENLY_SERVICE_REGION = REGION
    process.env.BACKUP_DATABASE_URL_US_EAST_1 = loginUrl('backenly_backup')
    process.env.PATH = `${bin}${path.delimiter}${saved.path ?? ''}`
    const backups = await import('@/lib/services/workspace-backup')

    expect(await backups.backupWorkspace(projectId)).toMatchObject({ success: true })
    // The replay makes the schema anew, without the grants the old one held.
    expect(await backups.restoreWorkspace(projectId)).toMatchObject({ success: true })
    expect(await backupCanUse(schema)).toBe(true)
    expect(await unreadableByBackup(schema)).toEqual([])
    expect(await backups.backupWorkspace(projectId)).toMatchObject({ success: true })
    expect(await prisma.workspaceBackup.count({ where: { projectId, status: 'completed' } })).toBe(2)
  })

  it('passes the procedure’s verification', async () => {
    const result = bootstrap({ DATABASE_URL: adminUrl(), BOOTSTRAP_MODE: 'check', EXPECT_DATABASE: DB })
    expect(result.output).toContain('Check only: nothing was written. Every step is recorded, and the database verifies.')
    expect(result.status).toBe(0)
  })
})

describe('a project’s logins, held by the definer as Amazon RDS holds them', () => {
  // Deleting a project drops its bkn_ro_ / bkn_rw_ / bkn_fn_ logins, and
  // revoking direct access drops one. Both failed on RDS with 42501
  // ("permission denied to reassign objects"; for bkn_fn_, which a deletion
  // dropped as the application, "permission denied to drop objects"): REASSIGN
  // OWNED and DROP OWNED need the login's privileges, and on RDS the master that
  // owns the definers administers every login they make without being a member
  // of any, and createrole_self_grant has no effect (measured on staging).
  // Stock PostgreSQL 16 grants a login back to its creator when that setting
  // asks for it, as this database's sessions of backenly_app do (sql/roles.sql),
  // so the logins here are made in sessions with it unset. The definer then
  // holds ADMIN on each and none of its privileges, as on RDS.
  const REGION = 'us-east-1'
  const saved = { edition: process.env.BACKENLY_EDITION }
  let ownerId = ''
  /** Every project made here, for the audit rows a retirement leaves outside its cascade. */
  const created: string[] = []

  /** As the application, in a session where createrole_self_grant is unset. */
  async function asAppWithoutSelfGrant<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> {
    const client = new Client({ connectionString: loginUrl('backenly_app') })
    client.on('error', () => {})
    await client.connect()
    try {
      await client.query(`SET createrole_self_grant = ''`)
      return (await client.query(sql, params)).rows as T[]
    } finally {
      await client.end().catch(() => {})
    }
  }

  /** A project in the region with every login it can have: read-only, read-write and its functions'. */
  async function projectWithLogins() {
    const project = await createProvisionedProject({ name: `regional logins ${randomUUID()}`, userId: ownerId, region: REGION })
    created.push(project.id)
    const schema = project.postgresSchema
    const { ro, rw, owner } = directAccessRoleNames(project.id)
    const passwords: Record<string, string> = { [ro]: generatePassword(), [rw]: generatePassword() }
    const fnPassword = generatePassword()
    await asAppWithoutSelfGrant(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_ONLY')`, [ro, passwords[ro], schema])
    await asAppWithoutSelfGrant(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_WRITE')`, [rw, passwords[rw], schema])
    const [{ fn }] = await asAppWithoutSelfGrant<{ fn: string }>(`SELECT public.backenly_fn_role_sync($1, $2) AS fn`, [schema, fnPassword])
    passwords[fn] = fnPassword
    // The grants and the owner role, as provisioning syncs them.
    await rows(loginUrl('backenly_app'), `SELECT public.backenly_direct_sync_schema($1, $2, $3, $4)`, [schema, ro, rw, owner])
    for (const [mode, roleName] of [['READ_ONLY', ro], ['READ_WRITE', rw]] as const) {
      await prisma.databaseCredential.create({
        data: { projectId: project.id, mode, roleName, passwordCipher: 'x', passwordIv: 'x', passwordTag: 'x' },
      })
    }
    const logins = [ro, rw, fn].sort()
    const held = await rows(
      superUrl(),
      `SELECT rolname, pg_has_role($1, oid, 'USAGE') AS privileges, pg_has_role($1, oid, 'MEMBER WITH ADMIN OPTION') AS admin
         FROM pg_roles WHERE rolname = ANY($2) ORDER BY rolname`,
      [ADMIN, logins],
    )
    expect(held).toEqual(logins.map((rolname) => ({ rolname, privileges: false, admin: true })))
    return { projectId: project.id, schema, rw, logins, passwords }
  }

  /**
   * A second database on the cluster that still names these logins, as a copy
   * restored there from an older dump does: the project's schema again, with a
   * table granted to each.
   */
  async function anotherDatabaseNaming(schema: string, logins: string[]): Promise<string> {
    const other = `regional_elsewhere_${randomUUID().replace(/-/g, '').slice(0, 8)}`
    await rows(superUrl(), `CREATE DATABASE ${other}`)
    await rows(superUrl(other), `CREATE SCHEMA "${schema}"`)
    await rows(superUrl(other), `CREATE TABLE "${schema}".kept (id int)`)
    await rows(superUrl(other), `INSERT INTO "${schema}".kept VALUES (1), (2)`)
    for (const login of logins) {
      await rows(superUrl(other), `GRANT USAGE ON SCHEMA "${schema}" TO "${login}"`)
      await rows(superUrl(other), `GRANT SELECT ON "${schema}".kept TO "${login}"`)
    }
    return other
  }

  const loginStates = (logins: string[]) =>
    rows(
      superUrl(),
      `SELECT rolname, rolcanlogin AS login, rolpassword IS NULL AS no_password FROM pg_authid WHERE rolname = ANY($1) ORDER BY 1`,
      [logins],
    )
  const REFUSED = /password authentication failed|not permitted to log in/

  beforeAll(async () => {
    process.env.DATABASE_URL_US_EAST_1 = loginUrl('backenly_app')
    process.env.BACKENLY_EDITION = 'cloud'
    ownerId = (
      await prisma.user.create({
        data: { email: `regional-logins-${randomUUID()}@example.test`, name: 'regional logins fixture' },
        select: { id: true },
      })
    ).id
  })

  afterAll(async () => {
    if (saved.edition === undefined) delete process.env.BACKENLY_EDITION
    else process.env.BACKENLY_EDITION = saved.edition
    if (ownerId) {
      const projects = (await prisma.project.findMany({ where: { userId: ownerId }, select: { id: true } })).map((p) => p.id)
      await prisma.databaseCredential.deleteMany({ where: { projectId: { in: projects } } }).catch(() => {})
      await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
      await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
    }
    if (created.length) {
      await prisma.auditLog
        .deleteMany({ where: { action: 'DATABASE_LOGIN_RETIRED', OR: created.map((id) => ({ details: { contains: id } })) } })
        .catch(() => {})
      // The deletions here leave their projects' purge jobs waiting for the
      // region's scheduler, which this process is not. Left in the shared test
      // database, they fill the scheduler's batch for the next suite that runs
      // it (project-region.spec.ts), so they go with the projects.
      await prisma.backgroundJob
        .deleteMany({ where: { type: 'purge_project', OR: created.map((id) => ({ payload: { path: ['projectId'], equals: id } })) } })
        .catch(() => {})
    }
  })

  it('are all dropped with their project, and nothing of them is left', async () => {
    const { deleteProjectCompletely } = await import('@/lib/projects/delete')
    const { projectId, schema, logins } = await projectWithLogins()
    const oids = (await rows<{ oid: string }>(superUrl(), `SELECT oid::text AS oid FROM pg_roles WHERE rolname = ANY($1)`, [logins])).map((r) => r.oid)
    expect(oids).toHaveLength(3)
    const others = `SELECT roleid::regrole::text AS role, admin_option, inherit_option, set_option
                      FROM pg_auth_members WHERE member = $1::regrole AND NOT roleid = ANY($2::oid[]) ORDER BY 1`
    const adminElsewhere = await rows(superUrl(), others, [ADMIN, oids])

    const result = await deleteProjectCompletely(projectId)

    expect(result.schemasDropped).toContain(schema)
    expect(await rows(superUrl(), `SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema])).toEqual([])
    expect(await rows(superUrl(), `SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`, [logins])).toEqual([])
    expect(
      await rows(superUrl(), `SELECT 1 FROM pg_auth_members WHERE roleid = ANY($1::oid[]) OR member = ANY($1::oid[])`, [oids]),
    ).toEqual([])
    // The privileges the definer took for each drop went with the login.
    expect(await rows(superUrl(), others, [ADMIN, oids])).toEqual(adminElsewhere)
    expect(await prisma.project.findUnique({ where: { id: projectId } })).toBeNull()
    expect(await prisma.databaseCredential.count({ where: { projectId } })).toBe(0)
  })

  it('are revoked one at a time, and a table the read-write login owns passes to the application', async () => {
    const { projectId, schema, rw } = await projectWithLogins()
    // Owned by the login, as a table made over direct access is. Made by the
    // administrator and handed over, so that only the revocation is under test
    // here, not the DDL that runs when a developer creates a table.
    await rows(adminUrl(), `CREATE TABLE "${schema}".made_directly (id int)`)
    await rows(superUrl(), `ALTER TABLE "${schema}".made_directly OWNER TO "${rw}"`)

    await revokeDirectAccess(projectId, 'READ_WRITE')

    expect(await rows(superUrl(), `SELECT rolname FROM pg_roles WHERE rolname = $1`, [rw])).toEqual([])
    expect(
      await rows(superUrl(), `SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE oid = to_regclass($1)`, [`"${schema}".made_directly`]),
    ).toEqual([{ owner: 'backenly_app' }])
    expect(await prisma.databaseCredential.findMany({ where: { projectId }, select: { mode: true } })).toEqual([{ mode: 'READ_ONLY' }])
  })

  // DROP OWNED and REASSIGN OWNED reach only the current database, so a login
  // that another database on the cluster still names failed DROP ROLE with
  // 2BP01, and the deletion of its project with it. Such a login is now retired
  // (NOLOGIN, no password) and the other database is left untouched.
  it('that another database still names are retired with their project, unable to log in, and that database is left as it was', async () => {
    const { deleteProjectCompletely } = await import('@/lib/projects/delete')
    const { projectId, schema, logins, passwords } = await projectWithLogins()
    const other = await anotherDatabaseNaming(schema, logins)
    const oids = (await rows<{ oid: string }>(superUrl(), `SELECT oid::text AS oid FROM pg_roles WHERE rolname = ANY($1)`, [logins])).map((r) => r.oid)
    const memberships = `SELECT roleid::regrole::text AS role, admin_option, inherit_option, set_option, grantor::regrole::text AS grantor
                           FROM pg_auth_members WHERE member = $1::regrole ORDER BY 1, 5`
    const membershipsBefore = await rows(superUrl(), memberships, [ADMIN])
    const kept = `SELECT relacl::text AS acl, (SELECT count(*)::int FROM "${schema}".kept) AS n FROM pg_class WHERE oid = to_regclass($1)`
    const keptBefore = await rows(superUrl(other), kept, [`"${schema}".kept`])
    for (const login of logins) expect(await refusal(url(login, passwords[login]), 'SELECT 1')).toBeNull()

    try {
      const result = await deleteProjectCompletely(projectId)

      expect([...result.retiredLogins].sort()).toEqual(logins)
      expect(await rows(superUrl(), `SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema])).toEqual([])
      expect(await prisma.project.findUnique({ where: { id: projectId } })).toBeNull()
      expect(await prisma.databaseCredential.count({ where: { projectId } })).toBe(0)
      expect(await loginStates(logins)).toEqual(logins.map((rolname) => ({ rolname, login: false, no_password: true })))
      for (const login of logins) expect(await refusal(url(login, passwords[login]), 'SELECT 1')).toMatch(REFUSED)
      // Nothing of them is left in this database, and the other is as it was.
      expect(
        await rows(
          superUrl(),
          `SELECT count(*)::int AS n FROM pg_shdepend s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = $1 AND s.refobjid = ANY($2::oid[])`,
          [DB, oids],
        ),
      ).toEqual([{ n: 0 }])
      expect(await rows(superUrl(other), kept, [`"${schema}".kept`])).toEqual(keptBefore)
      // The privileges the definer took to retire them were given back.
      expect(await rows(superUrl(), memberships, [ADMIN])).toEqual(membershipsBefore)
      // The retirement outlives the project's cascade in the audit trail.
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'DATABASE_LOGIN_RETIRED', details: { contains: projectId } },
        select: { projectId: true, details: true },
      })
      expect(audit?.projectId).toBeNull()
      expect(JSON.parse(String(audit?.details))).toMatchObject({ projectId, region: REGION, via: 'project deletion' })
      expect([...JSON.parse(String(audit?.details)).logins].sort()).toEqual(logins)

      // Once nothing else names them, the next drop removes them.
      await rows(superUrl(), `DROP DATABASE ${other} WITH (FORCE)`)
      for (const login of logins) {
        const helper = login.startsWith('bkn_fn_') ? 'backenly_fn_role_drop' : 'backenly_direct_drop_role'
        expect(await rows(loginUrl('backenly_app'), `SELECT public.${helper}($1) AS gone`, [login])).toEqual([{ gone: true }])
      }
      expect(await rows(superUrl(), `SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`, [logins])).toEqual([])
    } finally {
      await rows(superUrl(), `DROP DATABASE IF EXISTS ${other} WITH (FORCE)`)
    }
  })

  it('a revoked login another database still names is retired, and provisioning the mode again gives it back', async () => {
    const { projectId, schema, logins, passwords } = await projectWithLogins()
    const ro = logins.find((login) => login.startsWith('bkn_ro_'))!
    const other = await anotherDatabaseNaming(schema, [ro])
    try {
      await revokeDirectAccess(projectId, 'READ_ONLY')

      expect(await loginStates([ro])).toEqual([{ rolname: ro, login: false, no_password: true }])
      expect(await refusal(url(ro, passwords[ro]), 'SELECT 1')).toMatch(REFUSED)
      expect(await prisma.databaseCredential.findMany({ where: { projectId }, select: { mode: true } })).toEqual([{ mode: 'READ_WRITE' }])
      const audit = await prisma.auditLog.findFirst({
        where: { projectId, action: 'DIRECT_ACCESS_REVOKED' },
        orderBy: { timestamp: 'desc' },
        select: { details: true },
      })
      expect(JSON.parse(String(audit?.details))).toEqual({ mode: 'READ_ONLY', roleName: ro, login: 'retired' })

      // The same name, logging in again with the new password only. It comes
      // back with whatever the other database still grants it, as it had
      // before the revocation: retiring changes nothing outside this database.
      const fresh = generatePassword()
      await asAppWithoutSelfGrant(`SELECT public.backenly_direct_create_role($1, $2, $3, 'READ_ONLY')`, [ro, fresh, schema])
      expect(await refusal(url(ro, fresh), 'SELECT 1')).toBeNull()
      expect(await refusal(url(ro, passwords[ro]), 'SELECT 1')).toMatch(REFUSED)
    } finally {
      await rows(superUrl(), `DROP DATABASE IF EXISTS ${other} WITH (FORCE)`)
    }
  })

  it('a login retired by revocation is dropped with its project, once what named it is gone', async () => {
    // The revocation deleted its credential row, so only the name derived from
    // the project leads the deletion back to it.
    const { deleteProjectCompletely } = await import('@/lib/projects/delete')
    const { projectId, schema, logins } = await projectWithLogins()
    const ro = logins.find((login) => login.startsWith('bkn_ro_'))!
    const other = await anotherDatabaseNaming(schema, [ro])
    try {
      await revokeDirectAccess(projectId, 'READ_ONLY')
      expect(await loginStates([ro])).toEqual([{ rolname: ro, login: false, no_password: true }])
      expect(await prisma.databaseCredential.count({ where: { projectId, roleName: ro } })).toBe(0)
    } finally {
      await rows(superUrl(), `DROP DATABASE IF EXISTS ${other} WITH (FORCE)`)
    }

    const result = await deleteProjectCompletely(projectId)

    expect(result.retiredLogins).toEqual([])
    expect(await rows(superUrl(), `SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`, [logins])).toEqual([])
  })

  it('a function login a failed deletion retired in the region is found and recorded by the retry', async () => {
    // The region's step commits before the platform's (dropRegionalProjectData).
    // When the platform step then fails, the region's schema is already gone, so
    // the retry cannot derive the function login from it: the name comes from
    // the project instead, and the retry records the retirement.
    const { deleteProjectCompletely } = await import('@/lib/projects/delete')
    const { projectId, schema, logins } = await projectWithLogins()
    const fn = logins.find((login) => login.startsWith('bkn_fn_'))!
    const other = await anotherDatabaseNaming(schema, [fn])
    const refuse = `refuse_regional_${randomUUID().replace(/-/g, '').slice(0, 8)}`
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION public."${refuse}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$`,
    )
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${refuse}" BEFORE DELETE ON public.projects FOR EACH ROW WHEN (OLD.id = '${projectId}') EXECUTE FUNCTION public."${refuse}"()`,
    )
    try {
      await expect(deleteProjectCompletely(projectId)).rejects.toThrow(/refused for the test/)
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${refuse}" ON public.projects`)
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."${refuse}"()`)
    }
    try {
      // The region's step stands: its schema is gone and the login retired.
      // The platform's rolled back: the project is still there.
      expect(await rows(superUrl(), `SELECT 1 FROM pg_namespace WHERE nspname = $1`, [schema])).toEqual([])
      expect(await loginStates([fn])).toEqual([{ rolname: fn, login: false, no_password: true }])
      expect(await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } })).toEqual({ id: projectId })

      const result = await deleteProjectCompletely(projectId)

      expect(result.retiredLogins).toEqual([fn])
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'DATABASE_LOGIN_RETIRED', details: { contains: projectId } },
        select: { details: true },
      })
      expect(JSON.parse(String(audit?.details))).toMatchObject({ projectId, region: REGION, logins: [fn] })
    } finally {
      await rows(superUrl(), `DROP DATABASE IF EXISTS ${other} WITH (FORCE)`)
    }
    expect(await rows(loginUrl('backenly_app'), `SELECT public.backenly_fn_role_drop($1) AS gone`, [fn])).toEqual([{ gone: true }])
  })

  it('that only a database-level privilege the definer cannot revoke still names are retired, not left to fail the deletion', async () => {
    // A database privilege granted by another role survives the definer's DROP
    // OWNED: a definer that is not a superuser revokes only what it can, and
    // the grant is recorded server-wide, in no one database. Granted here on a
    // database the superuser owns, so the grant is the superuser's.
    const { deleteProjectCompletely } = await import('@/lib/projects/delete')
    const { projectId, logins, passwords } = await projectWithLogins()
    const ro = logins.find((login) => login.startsWith('bkn_ro_'))!
    await rows(superUrl(), `GRANT TEMPORARY ON DATABASE postgres TO "${ro}"`)
    try {
      const result = await deleteProjectCompletely(projectId)

      expect(result.retiredLogins).toEqual([ro])
      expect(await loginStates(logins)).toEqual([{ rolname: ro, login: false, no_password: true }])
      expect(await refusal(url(ro, passwords[ro]), 'SELECT 1')).toMatch(REFUSED)
    } finally {
      await rows(superUrl(), `REVOKE TEMPORARY ON DATABASE postgres FROM "${ro}"`).catch(() => {})
    }
    expect(await rows(loginUrl('backenly_app'), `SELECT public.backenly_direct_drop_role($1) AS gone`, [ro])).toEqual([{ gone: true }])
    expect(await rows(superUrl(), `SELECT rolname FROM pg_roles WHERE rolname = $1`, [ro])).toEqual([])
  })
})

describe('a workspace made before the backup role was given every one', () => {
  // As the region's existing projects were: a schema the application made, and
  // a table in it, with nothing granted to the backup role.
  const schema = `workspace_${randomUUID()}`

  it('cannot be dumped, and fails the procedure’s verification', async () => {
    await rows(loginUrl('backenly_app'), `CREATE SCHEMA "${schema}"`)
    await rows(loginUrl('backenly_app'), `CREATE TABLE "${schema}".probe (id serial PRIMARY KEY, note text)`)

    const dump = dumpAsBackup(schema)
    expect(dump.stderr).toMatch(/permission denied for schema/)
    expect(dump.status).not.toBe(0)

    const result = bootstrap({ DATABASE_URL: adminUrl(), BOOTSTRAP_MODE: 'check', EXPECT_DATABASE: DB })
    expect(result.output).toContain(`backenly_backup cannot use workspace schema ${schema}, so its snapshots fail`)
    expect(result.status).not.toBe(0)
  })

  it('fails a check on its own of a region whose step files changed, as a release gate reads it', async () => {
    // As a region that applied an earlier setup-direct-access.sql.
    await rows(superUrl(), `UPDATE backenly_meta.bootstrap_steps SET checksum = 'an earlier file' WHERE step = 'direct-access'`)
    const result = bootstrap({ DATABASE_URL: adminUrl(), BOOTSTRAP_MODE: 'check', EXPECT_DATABASE: DB })
    expect(result.output).toContain('step direct-access: changed (applied, but its files have changed since)')
    expect(result.output).toContain(`backenly_backup cannot use workspace schema ${schema}, so its snapshots fail`)
    expect(result.output).toContain('Check only: nothing was written. 1 step(s) changed since applied, and the database does not verify.')
    expect(result.status).not.toBe(0)
  })

  it('is reported, without refusing it, by the check a launcher runs before its own apply', async () => {
    // launch.ts checks before it applies, so failing this check would refuse
    // the very apply that converges the workspace.
    const result = bootstrap({ DATABASE_URL: adminUrl(), BOOTSTRAP_MODE: 'check', BOOTSTRAP_PRE_APPLY: 'true', EXPECT_DATABASE: DB })
    expect(result.output).toContain('step direct-access: changed (applied, but its files have changed since)')
    expect(result.output).toContain(`backenly_backup cannot use workspace schema ${schema}, so its snapshots fail`)
    expect(result.output).toContain('Check only: nothing was written. 1 step(s) changed since applied: the apply that follows converges what does not verify.')
    expect(result.status).toBe(0)
  })

  it('is converged by applying the procedure again, which then verifies', async () => {
    const result = bootstrap({ DATABASE_URL: superUrl(), BOOTSTRAP_MODE: 'apply', EXPECT_DATABASE: DB })
    expect(result.output).toContain('step direct-access: applied')
    expect(result.output).toContain('Regional database initialised and verified.')
    expect(result.status).toBe(0)

    expect(await unreadableByBackup(schema)).toEqual([])
    const dump = dumpAsBackup(schema)
    // The whole result on a failure, so pg_dump's own error is in the report.
    expect(dump).toMatchObject({ status: 0 })
    expect(dump.stdout).toContain(`CREATE TABLE "${schema}".probe`)

    // The launcher's closing check: every step current, and the database verifies.
    const check = bootstrap({ DATABASE_URL: adminUrl(), BOOTSTRAP_MODE: 'check', EXPECT_DATABASE: DB })
    expect(check.output).toContain('Check only: nothing was written. Every step is recorded, and the database verifies.')
    expect(check.status).toBe(0)
  })
})

describe('the procedure refuses', () => {
  it('to replace a live credential it was not asked to, and changes nothing', async () => {
    const before = await catalog()
    const result = bootstrap({ DATABASE_URL: superUrl(), BOOTSTRAP_MODE: 'apply', ...verifiers(['backenly_app']) })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('refusing: backenly_app already has the password this procedure set at')
    expect(await catalog()).toEqual(before)
  })

  it('anything but a verifier, and a rotation it cannot carry out', async () => {
    const plaintext = bootstrap({ DATABASE_URL: superUrl(), BOOTSTRAP_MODE: 'apply', BACKENLY_APP_VERIFIER: passwords.backenly_app })
    expect(plaintext.output).toContain('refusing: the value supplied for backenly_app is not a SCRAM-SHA-256 verifier')
    const unmanaged = bootstrap({ DATABASE_URL: superUrl(), BOOTSTRAP_MODE: 'apply', BOOTSTRAP_ROTATE: 'postgres' })
    expect(unmanaged.output).toContain('refusing: BOOTSTRAP_ROTATE names "postgres", which is not a role this procedure manages')
    const empty = bootstrap({ DATABASE_URL: superUrl(), BOOTSTRAP_MODE: 'apply', BOOTSTRAP_ROTATE: 'backenly_backup' })
    expect(empty.output).toContain('refusing: BOOTSTRAP_ROTATE names backenly_backup but no verifier was supplied for it')
    for (const r of [plaintext, unmanaged, empty]) expect(r.status).not.toBe(0)
    const wrong = bootstrap({ DATABASE_URL: superUrl(), BOOTSTRAP_MODE: 'check', EXPECT_DATABASE: 'backenly' })
    expect(wrong.status).toBe(2)
    expect(wrong.output).toContain(`refusing: connected database is "${DB}", expected "backenly"`)
  })

  it('a pre-apply signal on anything but a check, or one it does not understand', async () => {
    const onApply = bootstrap({ DATABASE_URL: superUrl(), BOOTSTRAP_MODE: 'apply', BOOTSTRAP_PRE_APPLY: 'true' })
    expect(onApply.status).toBe(2)
    expect(onApply.output).toContain('refusing: BOOTSTRAP_PRE_APPLY marks the check a launcher runs before its own apply, never the apply')
    const unknown = bootstrap({ DATABASE_URL: adminUrl(), BOOTSTRAP_MODE: 'check', BOOTSTRAP_PRE_APPLY: 'yes' })
    expect(unknown.status).toBe(2)
    expect(unknown.output).toContain('refusing: BOOTSTRAP_PRE_APPLY must be true or false, not "yes"')
  })

  it('but rotates exactly the credential it is asked to', async () => {
    const old = passwords.backenly_authenticator
    passwords.backenly_authenticator = generatePassword()
    const stored = async () =>
      rows<{ rolname: string; rolpassword: string }>(superUrl(), `SELECT rolname, rolpassword FROM pg_authid WHERE rolname = ANY($1) ORDER BY rolname`, [[...LOGINS]])
    const before = await stored()
    const result = bootstrap({
      DATABASE_URL: superUrl(),
      BOOTSTRAP_MODE: 'apply',
      BOOTSTRAP_ROTATE: 'backenly_authenticator',
      ...verifiers(['backenly_authenticator']),
    })
    expect(result.output).toContain('Regional database initialised and verified.')
    expect(result.status).toBe(0)
    const after = await stored()
    expect(after.filter((r) => r.rolname !== 'backenly_authenticator')).toEqual(before.filter((r) => r.rolname !== 'backenly_authenticator'))
    expect(await rows(loginUrl('backenly_authenticator'), 'SELECT 1 AS ok')).toEqual([{ ok: 1 }])
    expect(await refusal(url('backenly_authenticator', old), 'SELECT 1')).toMatch(/password authentication failed/)
    expect(
      await rows(superUrl(), `SELECT rotations FROM backenly_meta.bootstrap_credentials WHERE role_name = 'backenly_authenticator'`),
    ).toEqual([{ rotations: 1 }])
  })

  it('to pass a database that has drifted from what it promises', async () => {
    await rows(superUrl(), `ALTER ROLE backenly_authenticator INHERIT`)
    await rows(superUrl(), `GRANT EXECUTE ON FUNCTION public.backenly_direct_create_role(text, text, text, text) TO PUBLIC`)
    try {
      const result = bootstrap({ DATABASE_URL: adminUrl(), BOOTSTRAP_MODE: 'check' })
      expect(result.status).not.toBe(0)
      expect(result.output).toContain('role backenly_authenticator must be NOINHERIT')
      expect(result.output).toContain('PUBLIC can execute public.backenly_direct_create_role(text,text,text,text)')
    } finally {
      await rows(superUrl(), `ALTER ROLE backenly_authenticator NOINHERIT`)
      await rows(superUrl(), `REVOKE EXECUTE ON FUNCTION public.backenly_direct_create_role(text, text, text, text) FROM PUBLIC`)
    }
    expect(bootstrap({ DATABASE_URL: adminUrl(), BOOTSTRAP_MODE: 'check' }).status).toBe(0)
  })

  it('a database holding platform tables, before writing anything', async () => {
    await rows(superUrl('postgres'), `CREATE DATABASE backenly_home_like OWNER ${ADMIN}`)
    await rows(adminUrl('backenly_home_like'), `CREATE TABLE public.projects (id text PRIMARY KEY)`)
    const result = bootstrap({ DATABASE_URL: adminUrl('backenly_home_like'), BOOTSTRAP_MODE: 'apply', ...verifiers() })
    expect(result.status).not.toBe(0)
    expect(result.output).toContain('holds platform tables (public.projects or public._prisma_migrations)')
    expect(await rows(superUrl('backenly_home_like'), `SELECT 1 FROM pg_namespace WHERE nspname = 'backenly_meta'`)).toEqual([])
  })

  it('the rehearsal setting on RDS', async () => {
    await rows(superUrl('postgres'), `CREATE ROLE rdsadmin NOLOGIN`)
    try {
      const result = bootstrap({ DATABASE_URL: adminUrl(), BOOTSTRAP_MODE: 'check', BOOTSTRAP_REHEARSAL: 'true' })
      expect(result.status).not.toBe(0)
      expect(result.output).toContain('refusing: BOOTSTRAP_REHEARSAL is for rehearsals on stock PostgreSQL, and this server is Amazon RDS')
    } finally {
      await rows(superUrl('postgres'), `DROP ROLE rdsadmin`)
    }
  })

  it('an extension the server cannot provide, unless rehearsing', async () => {
    // A second region's database on this cluster, with the preload gone.
    configure([`shared_preload_libraries = ''`])
    pgCtl(['-l', path.join(work, 'server.log'), '-w', '-t', '60', 'restart'])
    await rows(superUrl('postgres'), `CREATE DATABASE backenly_regional_2 OWNER ${ADMIN}`)
    const strict = bootstrap({ DATABASE_URL: superUrl('backenly_regional_2'), BOOTSTRAP_MODE: 'apply', BOOTSTRAP_REHEARSAL: 'false' })
    expect(strict.status).not.toBe(0)
    expect(strict.output).toContain('refusing: extension pg_stat_statements needs shared_preload_libraries')
    const steps = await rows<{ step: string }>(superUrl('backenly_regional_2'), `SELECT step FROM backenly_meta.bootstrap_steps ORDER BY step`)
    expect(steps.map((s) => s.step)).not.toContain('extensions')
  })
})
