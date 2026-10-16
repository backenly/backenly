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
import { driftCaptureHealth, driftEventBacklog } from '@/lib/autonomy/drift-event-upkeep'
import { hasCapability, resetCapabilityCache } from '@/lib/autonomy/platform-capabilities'
import { directAccessRoleNames } from '@/lib/services/direct-access'
import { generatePassword, scramSha256Verifier } from '@/tools/managed-db/regional/scram'

jest.setTimeout(300_000)

const ROOT = process.cwd()
const DB = 'backenly_regional'
const ADMIN = 'regional_admin'
const STEPS = ['roles', 'postgrest', 'drift-events', 'direct-access', 'extensions']
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
    expect(result.output).toContain('Check only: nothing was written. 5 step(s) not applied yet.')
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
    // The backup role reads every workspace, for pg_dump.
    expect(await rows(loginUrl('backenly_backup'), `SELECT count(*)::int AS n FROM "${schema}".notes`)).toEqual([{ n: 1 }])
    // The authenticator holds nothing itself and can become only the API roles.
    const authenticator = loginUrl('backenly_authenticator')
    expect(await refusal(authenticator, `SELECT count(*) FROM public.schema_drift_events`)).toMatch(/permission denied/)
    expect(await refusal(authenticator, `SET ROLE backenly_app`)).toMatch(/permission denied/)
    expect(await refusal(authenticator, `SET ROLE anon; SELECT postgrest.pre_config()`)).toMatch(/permission denied/)
    expect(await refusal(authenticator, `SELECT postgrest.pre_config(); SET ROLE anon; SET ROLE authenticated; SET ROLE service_role`)).toBeNull()
    // Nobody else may call the definers.
    expect(await refusal(url(ro, roPassword), `SELECT public.backenly_direct_create_role('bkn_rw_000000000000', '${generatePassword()}', '${schema}', 'READ_WRITE')`)).toMatch(/permission denied/)
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
