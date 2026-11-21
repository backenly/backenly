/**
 * A PROJECT MOVED FROM ITS REGION'S SHARED DATABASE INTO A DATABASE OF ITS OWN
 * ===========================================================================
 * lib/data-plane/tenancy-migration.ts, run for real, as the application runs
 * it, against a PostgreSQL 16 cluster this suite creates with initdb and
 * throws away, built as tests/integration/regional-bootstrap.spec.ts builds
 * one: the regional procedure (tools/managed-db/regional/bootstrap.sh, from
 * exactly the files its image carries) applies the region's database as an
 * administrator that is not a superuser, a superuser finishes the event
 * triggers stock PostgreSQL keeps from it, everything is handed to the
 * administrator as Amazon RDS leaves it, and the administrator builds the
 * template project databases are cloned from. A cluster of its own because the
 * procedure makes cluster-wide roles by their real names.
 *
 * The region is ap-southeast-1, where no other suite keeps projects (the last
 * case counts every shared project of the region), and whose own instance is
 * its data instance (no DATA_* variable). The project is made shared, as every
 * project before the move, and
 * given what a real one has: tables with rows, one under FORCE ROW LEVEL
 * SECURITY with a policy, a sequence moved on, a column of an allowlisted
 * extension the project installed (citext), a preview branch PostgREST serves,
 * a change vault, a captured webhook event waiting in its outbox, a realtime
 * channel and its functions' login.
 *
 * Then, in order: a dry run that copies and verifies everything and leaves the
 * project exactly as it was; a run whose verification is made to fail, which
 * stops with nothing lost; the move itself, after which every row, sequence and
 * channel is in the project's own database, the waiting webhook event is
 * delivered from there, and the old schemas are fenced, unreachable to the
 * project's logins; a second run, refused; the project's deletion, which finds
 * what the move left behind; and, once no project of the region is shared,
 * the region's own database closed to PUBLIC.
 *
 * No PostgREST host is configured, so the checks that ask the project's own
 * PostgREST are recorded as skipped, which is what the report must say then.
 */

import { execFileSync, spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { Client } from 'pg'

import { disconnectRegionalClients, workspaceRawClient } from '@/lib/data-plane/regional'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { generatePassword, scramSha256Verifier } from '@/tools/managed-db/regional/scram'
import type { MigrationWaits } from '@/lib/data-plane/tenancy-migration-rules'
import type { CloudRegionId } from '@/lib/regions'

jest.setTimeout(300_000)

function missingTools(): string[] {
  let dir = process.env.PG_BINDIR ?? ''
  if (!dir) {
    try {
      dir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()
    } catch {
      return ['PG_BINDIR']
    }
  }
  const suffix = process.platform === 'win32' ? '.exe' : ''
  return ['initdb', 'pg_ctl', 'psql', 'pg_dump'].filter((tool) => !fs.existsSync(path.join(dir, `${tool}${suffix}`)))
}
const runnable = Boolean(process.env.CI) || missingTools().length === 0
const suite = runnable ? describe : describe.skip

const ROOT = process.cwd()
const DB = 'backenly_regional'
/** The second instance's own database, as the home region's data instance has one (DATA_DATABASE_URL names it). */
const DATA_DB = 'backenly_data'
const ADMIN = 'regional_admin'
const TEMPLATE = 'backenly_project_template'
const REGION = 'ap-southeast-1'
const LOGINS = ['backenly_app', 'backenly_backup', 'backenly_authenticator', 'backenly_dbcreator'] as const
type Login = (typeof LOGINS)[number]
const VERIFIER_VARIABLE: Record<Login, string> = {
  backenly_app: 'BACKENLY_APP_VERIFIER',
  backenly_backup: 'BACKENLY_BACKUP_VERIFIER',
  backenly_authenticator: 'BACKENLY_AUTHENTICATOR_VERIFIER',
  backenly_dbcreator: 'BACKENLY_DBCREATOR_VERIFIER',
}

const SUPER_PW = generatePassword()
const ADMIN_PW = generatePassword()
const POOLER_AUTH_PW = generatePassword()
const passwords: Record<Login, string> = {
  backenly_app: generatePassword(),
  backenly_backup: generatePassword(),
  backenly_authenticator: generatePassword(),
  backenly_dbcreator: generatePassword(),
}

/** No wait is needed in a test: nothing else serves the project. */
const FAST: Partial<MigrationWaits> = { freezeMs: 0, flipMs: 0, sessionsMs: 5_000, probeMs: 1_000 }

/** A PostgreSQL 16 cluster of this suite's: an instance, as Amazon RDS gives a region one. */
interface Cluster {
  name: string
  data: string
  port: number
  /** The database the regional procedure is applied to. */
  db: string
}

/** The region's instance, holding its shared database. */
let regionCluster: Cluster = { name: 'region', data: '', port: 0, db: DB }
/** A second instance, as the home region's data instance is: another instance than its shared database's. */
let dataCluster: Cluster = { name: 'data', data: '', port: 0, db: DATA_DB }

let bin = ''
let work = ''
let script = ''
let vectorAvailable = false

const exe = (name: string) => path.join(bin, process.platform === 'win32' ? `${name}.exe` : name)
const urlOn = (c: Cluster, user: string, password: string, database = c.db) => `postgresql://${user}:${password}@127.0.0.1:${c.port}/${database}`
const url = (user: string, password: string, database = DB) => urlOn(regionCluster, user, password, database)
const superUrlOn = (c: Cluster, database = c.db) => urlOn(c, 'postgres', SUPER_PW, database)
const superUrl = (database = DB) => superUrlOn(regionCluster, database)
const adminUrlOn = (c: Cluster, database = c.db) => urlOn(c, ADMIN, ADMIN_PW, database)
const adminUrl = (database = DB) => adminUrlOn(regionCluster, database)
const loginUrlOn = (c: Cluster, role: Login, database = c.db) => urlOn(c, role, passwords[role], database)
const loginUrl = (role: Login, database = DB) => loginUrlOn(regionCluster, role, database)

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

async function refusal(connection: string, sql: string): Promise<string | null> {
  try {
    await rows(connection, sql)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

function postgresBinaries(): string {
  let dir = process.env.PG_BINDIR ?? ''
  if (!dir) dir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim()
  const initdb = path.join(dir, process.platform === 'win32' ? 'initdb.exe' : 'initdb')
  if (!fs.existsSync(initdb)) throw new Error(`No initdb in ${dir}; set PG_BINDIR to a PostgreSQL 16 bin directory`)
  const version = execFileSync(initdb, ['--version'], { encoding: 'utf8' })
  if (!/\(PostgreSQL\) 16\./.test(version)) throw new Error(`This suite needs PostgreSQL 16; ${initdb} is ${version.trim()}`)
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

function pgCtl(c: Cluster, args: string[]): void {
  execFileSync(exe('pg_ctl'), ['-D', c.data, ...args], { stdio: 'ignore', timeout: 120_000 })
}

/** The procedure image's files, at their repository paths, and nothing else. */
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

function bootstrap(env: Record<string, string>): { status: number; output: string } {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(PG|BACKENLY_|BOOTSTRAP_|DATABASE_URL|DIRECT_URL)/i.test(key)),
  ) as Record<string, string>
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

/** As Amazon RDS leaves a database: the administrator owns what was installed (regional-bootstrap.spec.ts). */
async function handToAdministrator(c: Cluster): Promise<void> {
  await rows(
    superUrlOn(c),
    `SET session_replication_role = replica;
     DO $$
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

/**
 * A cluster made with initdb and the regional procedure applied to its
 * database, as a region's instance is: the administrator's apply (which stops
 * at the first event trigger, as stock PostgreSQL keeps those from it), a
 * superuser's to finish, everything handed to the administrator, and the
 * template project databases are cloned from. With `pooler`, the procedure
 * also makes the connection pooler's login and database (sql/pooler.sql).
 */
async function buildCluster(c: Cluster, { pooler }: { pooler: boolean }): Promise<Cluster> {
  c.data = path.join(work, c.name)
  const pwfile = path.join(work, `${c.name}-superuser-password`)
  fs.writeFileSync(pwfile, SUPER_PW)
  execFileSync(
    exe('initdb'),
    ['-D', c.data, '-U', 'postgres', `--pwfile=${pwfile}`, '--auth=scram-sha-256', '-E', 'UTF8', '--locale=C', '--no-sync'],
    { stdio: 'ignore', timeout: 120_000 },
  )
  c.port = await freePort()
  fs.appendFileSync(
    path.join(c.data, 'postgresql.conf'),
    [
      '',
      `port = ${c.port}`,
      `listen_addresses = '127.0.0.1'`,
      `unix_socket_directories = ''`,
      `shared_preload_libraries = 'pg_stat_statements'`,
      'fsync = off',
      'synchronous_commit = off',
      'full_page_writes = off',
      '',
    ].join('\n'),
  )
  pgCtl(c, ['-l', path.join(work, `${c.name}.log`), '-w', '-t', '60', 'start'])

  await rows(superUrlOn(c, 'postgres'), `CREATE ROLE ${ADMIN} LOGIN CREATEROLE CREATEDB BYPASSRLS PASSWORD '${ADMIN_PW}'`)
  await rows(superUrlOn(c, 'postgres'), `GRANT pg_monitor TO ${ADMIN}`)
  await rows(superUrlOn(c, 'postgres'), `GRANT pg_read_all_stats TO ${ADMIN} WITH ADMIN OPTION`)
  await rows(superUrlOn(c, 'postgres'), `CREATE DATABASE ${c.db} OWNER ${ADMIN}`)
  vectorAvailable = (await rows(superUrlOn(c), `SELECT 1 FROM pg_available_extensions WHERE name = 'vector'`)).length > 0

  bootstrap({
    DATABASE_URL: adminUrlOn(c),
    BOOTSTRAP_MODE: 'apply',
    EXPECT_DATABASE: c.db,
    ...Object.fromEntries(LOGINS.map((role) => [VERIFIER_VARIABLE[role], scramSha256Verifier(passwords[role])])),
    ...(pooler ? { BACKENLY_POOLER_AUTH_VERIFIER: scramSha256Verifier(POOLER_AUTH_PW) } : {}),
  })
  const applied = bootstrap({ DATABASE_URL: superUrlOn(c), BOOTSTRAP_MODE: 'apply', EXPECT_DATABASE: c.db })
  if (applied.status !== 0) throw new Error(`The ${c.name} instance's database was not built:\n${applied.output.slice(-3000)}`)
  await handToAdministrator(c)

  // The template, built by the administrator holding SUPERUSER only for the
  // event triggers stock PostgreSQL keeps from it.
  await rows(superUrlOn(c, 'postgres'), `ALTER ROLE ${ADMIN} SUPERUSER`)
  try {
    const template = bootstrap({ DATABASE_URL: adminUrlOn(c), BOOTSTRAP_MODE: 'template', EXPECT_DATABASE: c.db })
    if (template.status !== 0) throw new Error(`The ${c.name} instance's template was not built:\n${template.output.slice(-3000)}`)
  } finally {
    await rows(superUrlOn(c, 'postgres'), `ALTER ROLE ${ADMIN} NOSUPERUSER`)
  }
  if (pooler) {
    const present = await rows(superUrlOn(c, 'postgres'), `SELECT 1 FROM pg_database WHERE datname = 'backenly_pooler'`)
    if (present.length !== 1) throw new Error(`The ${c.name} instance has no backenly_pooler database after the procedure`)
  }
  return c
}

const saved = new Map<string, string | undefined>()
function set(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name])
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeAll(async () => {
  if (!runnable) return
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  bin = postgresBinaries()
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'tenancy-migration-'))
  script = assembleImageTree()
  regionCluster = await buildCluster(regionCluster, { pooler: false })

  set('DATABASE_URL_AP_SOUTHEAST_1', loginUrl('backenly_app'))
  set('BACKUP_DATABASE_URL_AP_SOUTHEAST_1', loginUrl('backenly_backup'))
  set('DBCREATOR_DATABASE_URL_AP_SOUTHEAST_1', url('backenly_dbcreator', passwords.backenly_dbcreator))
  set('BACKENLY_ADMIN_DATABASE_URL_AP_SOUTHEAST_1', adminUrl())
  set('DATA_DATABASE_URL_AP_SOUTHEAST_1', undefined)
  set('DATA_BACKUP_DATABASE_URL_AP_SOUTHEAST_1', undefined)
  set('DATA_DIRECT_URL_AP_SOUTHEAST_1', undefined)
  set('POOLER_HOST_AP_SOUTHEAST_1', undefined)
  set('DIRECT_DB_HOST_AP_SOUTHEAST_1', undefined)
  set('BACKENLY_DEDICATED_DATABASES_AP_SOUTHEAST_1', undefined)
  set('PGRST_HOST_URL_AP_SOUTHEAST_1', undefined)
  set('BACKENLY_EDITION', 'cloud')
  set('BACKENLY_SERVICE_REGION', REGION)
  set('BACKUP_DIR', path.join(work, 'backups'))
  set('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`)
  set('REALTIME_LISTENER_IDLE_CLOSE_MS', '0')
})

/** Close what this process holds on project databases: their listeners, lock pools, clients and pools. */
async function closeProjectConnections(): Promise<void> {
  const { listenerHub } = await import('@/lib/realtime/listener-hub')
  for (const key of listenerHub.listenerKeys()) {
    const [region, database] = key.split(':')
    if (database && database !== 'control') listenerHub.closeDatabase({ region: region as CloudRegionId, database })
  }
  const { closeChangeLockPool } = await import('@/lib/changes/lock')
  await closeChangeLockPool().catch(() => {})
  await disconnectRegionalClients()
}

afterAll(async () => {
  if (!runnable) return
  try {
    await closeProjectConnections()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    try {
      for (const c of [dataCluster, regionCluster]) {
        if (c.data && fs.existsSync(c.data)) {
          try {
            pgCtl(c, ['-m', 'fast', '-w', 'stop'])
          } catch {
            // Never started, or already stopped.
          }
        }
      }
    } finally {
      if (work) fs.rmSync(work, { recursive: true, force: true })
    }
  }
})

suite('a project moved from its region’s shared database into a database of its own', () => {
  let ownerId = ''
  let projectId = ''
  let schema = ''
  let branch = ''
  let vault = ''
  let channel = ''
  let fnRole = ''
  let fnPassword = ''
  let webhookId = ''
  let database = ''
  let otherProjectId = ''

  /** The p_ databases on the cluster. */
  const projectDatabases = async () =>
    (await rows<{ datname: string }>(superUrl(), `SELECT datname::text AS datname FROM pg_database WHERE datname ~ '^p_[0-9a-f]{32}$' ORDER BY 1`)).map(
      (r) => r.datname,
    )

  /** Every table's rows in these schemas of a database, counted and digested as the superuser sees them, all of them. */
  async function digests(connection: string, schemas: string[]): Promise<Record<string, { rows: number; md5: string | null }>> {
    const out: Record<string, { rows: number; md5: string | null }> = {}
    for (const s of schemas) {
      const tables = await rows<{ name: string }>(
        connection,
        `SELECT c.relname::text AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`,
        [s],
      )
      for (const { name } of tables) {
        const [d] = await rows<{ n: number; h: string | null }>(
          connection,
          `SELECT count(*)::int AS n, md5(coalesce(string_agg(md5(t::text), '' ORDER BY md5(t::text)), '')) AS h FROM "${s}"."${name}" t`,
        )
        out[`${s}.${name}`] = { rows: d.n, md5: d.h }
      }
    }
    return out
  }

  const sequences = async (connection: string) =>
    rows<{ v: string; c: boolean }>(connection, `SELECT last_value::text AS v, is_called AS c FROM "${schema}".notes_id_seq`)

  const served = async (connection: string) =>
    (await rows<{ list: string }>(connection, `SELECT public.backenly_pgrst_current_schemas() AS list`))[0].list.split(',').filter(Boolean).sort()

  const channelIn = async (connection: string, schemaName: string) =>
    (await rows<{ channel: string }>(connection, `SELECT channel FROM backenly_realtime.channel_secrets WHERE schema_name = $1`, [schemaName]))[0]?.channel ?? null

  /** Everything a run that did not move the project must leave exactly as it was. */
  async function state() {
    const row = await prisma.project.findUnique({
      where: { id: projectId },
      select: { databaseTenancy: true, databaseName: true, databaseInstance: true, tenancyEpoch: true, pausedAt: true, pauseReason: true, lastActivityAt: true },
    })
    return {
      row,
      digests: await digests(superUrl(), [schema, branch, vault]),
      sequence: await sequences(superUrl()),
      served: await served(superUrl()),
      channel: (await channelIn(superUrl(), schema)) === channel,
      databases: await projectDatabases(),
      schemas: (
        await rows<{ nspname: string }>(superUrl(), `SELECT nspname::text AS nspname FROM pg_namespace WHERE left(nspname, length($1)) = $1 ORDER BY 1`, [
          `workspace_${projectId}`,
        ])
      ).map((r) => r.nspname),
      fnLogin: await refusal(url(fnRole, fnPassword), `SELECT count(*) FROM "${schema}".notes`),
    }
  }

  beforeAll(async () => {
    ownerId = (await prisma.user.create({ data: { email: `moves-${randomUUID()}@example.test`, name: 'tenancy migration fixture' }, select: { id: true } })).id
    const project = await createProvisionedProject({ name: `moving ${randomUUID()}`, userId: ownerId, region: REGION })
    expect(project.databaseTenancy).toBe('shared')
    projectId = project.id
    schema = project.postgresSchema
    branch = `${schema}_br_preview`
    vault = `${schema}_r1`

    // An allowlisted extension the project installed, as the console's Install button does, and a column that uses it.
    const { installExtension } = await import('@/lib/services/extensions')
    expect(await installExtension(projectId, 'citext')).toMatchObject({ ok: true })

    const app = loginUrl('backenly_app')
    await rows(
      app,
      `CREATE TABLE "${schema}".notes (id serial PRIMARY KEY, body text NOT NULL, email citext, score numeric(10,2), tags text[], meta jsonb,
                                         created_at timestamptz NOT NULL DEFAULT now());
       INSERT INTO "${schema}".notes (body, email, score, tags, meta) VALUES
         ('first', 'A@Example.test', 1.5, ARRAY['a','b'], '{"k": 1}'),
         ('second', NULL, NULL, '{}', NULL),
         ('third', 'c@example.test', -2.25, ARRAY['ç'], '{"nested": {"x": [1, 2]}}');
       SELECT setval('"${schema}".notes_id_seq', 41, true);
       INSERT INTO "${schema}".notes (body) VALUES ('after the jump');
       CREATE TABLE "${schema}".secrets (id integer PRIMARY KEY, value text NOT NULL);
       ALTER TABLE "${schema}".secrets ENABLE ROW LEVEL SECURITY;
       ALTER TABLE "${schema}".secrets FORCE ROW LEVEL SECURITY;
       CREATE POLICY service_only ON "${schema}".secrets
         USING (current_setting('app.is_service_role', true) = 'true')
         WITH CHECK (current_setting('app.is_service_role', true) = 'true');
       SELECT set_config('app.is_service_role', 'true', false);
       INSERT INTO "${schema}".secrets VALUES (1, 'kept under row security'), (2, 'and this');

       CREATE SCHEMA "${branch}";
       CREATE TABLE "${branch}".secrets (id integer PRIMARY KEY, value text NOT NULL);
       ALTER TABLE "${branch}".secrets ENABLE ROW LEVEL SECURITY;
       ALTER TABLE "${branch}".secrets FORCE ROW LEVEL SECURITY;
       CREATE POLICY service_only ON "${branch}".secrets USING (current_setting('app.is_service_role', true) = 'true');
       CREATE TABLE "${branch}".drafts (id integer PRIMARY KEY, body text);
       INSERT INTO "${branch}".drafts VALUES (1, 'on the branch');

       CREATE SCHEMA "${vault}";
       CREATE TABLE "${vault}".kept (id integer, note text);
       INSERT INTO "${vault}".kept VALUES (7, 'a column a change removed')`,
    )
    const { registerSchemaByName } = await import('@/lib/postgrest/registration')
    expect(await registerSchemaByName(branch)).toMatchObject({ registered: true })

    // A captured row event, not yet a delivery, for an endpoint that listens.
    const { ensureOutbox } = await import('@/lib/webhooks/capture')
    await ensureOutbox(projectId)
    await rows(app, `INSERT INTO "${schema}"._backenly_webhook_outbox (event_type, table_name, row_data) VALUES ('INSERT', 'notes', '{"id": 1}')`)
    webhookId = (
      await prisma.webhook.create({
        data: { projectId, eventType: 'row.inserted', targetUrl: 'http://127.0.0.1:9/hook', secret: 'tenancy-migration-fixture', active: true },
        select: { id: true },
      })
    ).id

    const { projectChannel } = await import('@/lib/realtime/channels')
    channel = await projectChannel(projectId)
    const { provisionFunctionRole, functionRolePassword } = await import('@/lib/services/ai-functions/function-db-role')
    fnRole = (await provisionFunctionRole(projectId)).role
    fnPassword = functionRolePassword(schema)

    // A move starts only after a recent snapshot.
    const { backupWorkspace } = await import('@/lib/services/workspace-backup')
    expect(await backupWorkspace(projectId)).toMatchObject({ success: true })
  })

  afterAll(async () => {
    const { deleteProjectCompletely } = await import('@/lib/projects/delete')
    for (const id of [projectId, otherProjectId].filter(Boolean)) {
      if (await prisma.project.findUnique({ where: { id }, select: { id: true } })) await deleteProjectCompletely(id).catch(() => {})
    }
    const ids = [projectId, otherProjectId].filter(Boolean)
    await prisma.workspaceBackup.deleteMany({ where: { projectId: { in: ids } } }).catch(() => {})
    await prisma.backgroundJob
      .deleteMany({ where: { OR: ids.flatMap((id) => [{ projectId: id }, { payload: { path: ['projectId'], equals: id } }]) } })
      .catch(() => {})
    await prisma.auditLog
      .deleteMany({ where: { OR: [{ projectId: { in: ids } }, { action: 'PROJECT_DATABASE_CREATED', metadata: { path: ['region'], equals: REGION } }] } })
      .catch(() => {})
    if (ownerId) {
      await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
      await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
    }
  })

  it('copies and verifies everything in a dry run, and leaves the project exactly as it was', async () => {
    const { migrateProjectToOwnDatabase } = await import('@/lib/data-plane/tenancy-migration')
    const before = await state()
    expect(before.fnLogin).toBeNull()

    const report = await migrateProjectToOwnDatabase(projectId, { dryRun: true, waits: FAST })

    expect(report).toMatchObject({ outcome: 'dry_run_ok', region: REGION, extensions: ['citext'] })
    expect(report.verification?.ok).toBe(true)
    const checks = Object.fromEntries((report.verification?.checks ?? []).map((c) => [c.id, c.state]))
    expect(checks).toMatchObject({
      schemas: 'ok',
      catalog: 'ok',
      rows: 'ok',
      sequences: 'ok',
      row_security: 'ok',
      owners: 'ok',
      registry: 'ok',
      extensions: 'ok',
      channels: 'ok',
      backup_read: 'ok',
      // No PostgREST host here: said, never passed off as checked.
      postgrest: 'skipped',
    })
    // Every table compared, the one under FORCE ROW LEVEL SECURITY with all its rows.
    expect(report.verification?.tables).toEqual(
      expect.arrayContaining([
        { schema, table: 'secrets', sourceRows: 2, targetRows: 2, checksumsEqual: true },
        { schema, table: 'notes', sourceRows: 4, targetRows: 4, checksumsEqual: true },
        { schema: branch, table: 'drafts', sourceRows: 1, targetRows: 1, checksumsEqual: true },
        { schema: vault, table: 'kept', sourceRows: 1, targetRows: 1, checksumsEqual: true },
        { schema, table: '_backenly_webhook_outbox', sourceRows: 1, targetRows: 1, checksumsEqual: true },
      ]),
    )
    expect(report.cleanup).toMatchObject({ databaseDropped: true, serving: true })
    expect(report.steps.map((s) => s.step)).toEqual(
      expect.arrayContaining(['preconditions', 'create', 'freeze', 'lock', 'snapshot', 'dump', 'replay', 'verify', 'abort']),
    )
    expect(report.steps.map((s) => s.step)).not.toContain('flip')

    expect(await state()).toEqual(before)
  })

  it('stops when its verification fails, with its database gone and nothing lost', async () => {
    const { migrateProjectToOwnDatabase } = await import('@/lib/data-plane/tenancy-migration')
    const before = await state()

    const report = await migrateProjectToOwnDatabase(projectId, { waits: FAST, failVerification: 'a check this test made fail' })

    expect(report).toMatchObject({ outcome: 'aborted', step: 'verify' })
    expect(report.reason).toContain('a check this test made fail')
    expect(report.cleanup).toMatchObject({ databaseDropped: true, serving: true })
    expect(await state()).toEqual(before)
    // Still served from the shared database, as it was.
    const db = await workspaceRawClient(projectId)
    expect(await db.$queryRawUnsafe(`SELECT current_database()::text AS db`)).toEqual([{ db: DB }])
    expect(await prisma.backendChange.count({ where: { projectId, kind: 'tenancy_migration' } })).toBe(0)
  })

  it('moves every row, sequence and channel into its own database, delivers what waited, and fences what it left', async () => {
    const { migrateProjectToOwnDatabase } = await import('@/lib/data-plane/tenancy-migration')
    const before = await state()
    const startedAt = Date.now()

    const report = await migrateProjectToOwnDatabase(projectId, { waits: FAST })

    expect(report.attention).toEqual([])
    expect(report.outcome).toBe('moved')
    const row = await prisma.project.findUnique({
      where: { id: projectId },
      select: { databaseTenancy: true, databaseName: true, databaseInstance: true, tenancyEpoch: true, pausedAt: true, pauseReason: true },
    })
    expect(row).toMatchObject({ databaseTenancy: 'dedicated', databaseInstance: 'primary', tenancyEpoch: (before.row?.tenancyEpoch ?? 0) + 1, pausedAt: null, pauseReason: null })
    database = row!.databaseName as string
    expect(database).toMatch(/^p_[0-9a-f]{32}$/)
    expect(report).toMatchObject({ database, epoch: row!.tenancyEpoch })

    // Every row of every schema, as the superuser sees them, and the sequence.
    expect(await digests(superUrl(database), [schema, branch, vault])).toEqual(before.digests)
    expect(await sequences(superUrl(database))).toEqual(before.sequence)
    expect(await rows(superUrl(database), `SELECT extname FROM pg_extension WHERE extname = 'citext'`)).toEqual([{ extname: 'citext' }])
    // The same channel name, so every stream label and listener finds it there.
    expect(await channelIn(superUrl(database), schema)).toBe(channel)
    // Served there as it was here: the project and its branch, not the vault.
    expect(await served(superUrl(database))).toEqual([schema, branch].sort())
    // Reached there by the platform, and its functions' login connects there.
    const db = await workspaceRawClient(projectId)
    expect(await db.$queryRawUnsafe(`SELECT current_database()::text AS db`)).toEqual([{ db: database }])
    expect(await rows(url(fnRole, fnPassword, database), `SELECT count(*)::int AS n FROM "${schema}".notes`)).toEqual([{ n: 4 }])

    // The old schemas: renamed, served by nothing, closed to the project's
    // logins and the API roles, still readable by the backup role.
    const left = (
      await rows<{ nspname: string }>(superUrl(), `SELECT nspname::text AS nspname FROM pg_namespace WHERE left(nspname, length($1)) = $1 ORDER BY 1`, [
        `workspace_${projectId}`,
      ])
    ).map((r) => r.nspname)
    expect(left).toEqual([`${schema}_moved1`, `${schema}_moved1_1`, `${schema}_moved1_2`])
    expect(report.schemas).toEqual([
      { name: schema, leftAs: `${schema}_moved1` },
      { name: branch, leftAs: `${schema}_moved1_1` },
      { name: vault, leftAs: `${schema}_moved1_2` },
    ])
    expect(await served(superUrl())).toEqual([])
    const reach = await rows<{ role: string; usable: boolean }>(
      superUrl(),
      `SELECT r AS role, has_schema_privilege(r, $1, 'USAGE') AS usable FROM unnest($2::text[]) AS r ORDER BY 1`,
      [`${schema}_moved1`, [fnRole, 'anon', 'authenticated', 'service_role', 'backenly_external', 'backenly_backup']],
    )
    expect(reach).toEqual(
      [fnRole, 'anon', 'authenticated', 'service_role', 'backenly_external', 'backenly_backup'].sort().map((role) => ({ role, usable: role === 'backenly_backup' })),
    )
    expect(await refusal(url(fnRole, fnPassword), `SELECT count(*) FROM "${schema}_moved1".notes`)).toMatch(/permission denied/)
    expect(await refusal(url(fnRole, fnPassword), `SELECT count(*) FROM "${schema}".notes`)).toMatch(/does not exist/)
    expect(await channelIn(superUrl(), schema)).toBeNull()

    // Dropped by the region's pass after seven days.
    const drop = await prisma.backgroundJob.findFirst({
      where: { type: 'drop_retired_schemas', payload: { path: ['projectId'], equals: projectId } },
      select: { runAt: true, payload: true },
    })
    expect((drop?.payload as { schemas?: string[] }).schemas).toEqual(left)
    expect(drop!.runAt.getTime()).toBeGreaterThan(startedAt + 6 * 24 * 60 * 60 * 1000)

    // On the project's History, and audited.
    expect(await prisma.backendChange.findFirst({ where: { projectId, kind: 'tenancy_migration' }, select: { status: true, source: true, title: true } })).toEqual({
      status: 'healthy',
      source: 'system',
      title: 'Moved to a database of its own',
    })
    expect(await prisma.auditLog.count({ where: { projectId, action: 'PROJECT_DATABASE_MOVED' } })).toBe(1)

    // Smoke: its paths in its own database; the data API needs a host this suite has not.
    expect(Object.fromEntries((report.smoke ?? []).map((c) => [c.id, c.state]))).toEqual({
      workspace: 'ok',
      data_api: 'skipped',
      realtime: 'ok',
      function_login: 'ok',
      snapshot: 'ok',
    })

    // The captured event was kept through the move, and is delivered from there.
    expect(await rows(superUrl(database), `SELECT table_name, claimed_at FROM "${schema}"._backenly_webhook_outbox`)).toEqual([
      { table_name: 'notes', claimed_at: null },
    ])
    const { drainWebhookOutbox } = await import('@/lib/webhooks/capture')
    expect(await drainWebhookOutbox()).toBeGreaterThanOrEqual(1)
    expect(await rows(superUrl(database), `SELECT id FROM "${schema}"._backenly_webhook_outbox`)).toEqual([])
    expect(await prisma.webhookLog.count({ where: { webhookId } })).toBe(1)
  })

  it('refuses a second run on a project that has a database of its own, and changes nothing', async () => {
    const { migrateProjectToOwnDatabase } = await import('@/lib/data-plane/tenancy-migration')
    const databases = await projectDatabases()
    const report = await migrateProjectToOwnDatabase(projectId, { waits: FAST })
    expect(report).toMatchObject({ outcome: 'refused', code: 'already_dedicated' })
    expect(await projectDatabases()).toEqual(databases)
    expect(await prisma.project.findUnique({ where: { id: projectId }, select: { pausedAt: true, tenancyEpoch: true } })).toEqual({
      pausedAt: null,
      tenancyEpoch: 1,
    })
  })

  it('drops what the move left behind when the project is deleted, and then its logins', async () => {
    const { deleteProjectCompletely } = await import('@/lib/projects/delete')
    const result = await deleteProjectCompletely(projectId)
    expect(result.schemasDropped).toEqual(expect.arrayContaining([schema, branch, vault, `${schema}_moved1`, `${schema}_moved1_1`, `${schema}_moved1_2`]))
    expect(result.retiredLogins).toEqual([])
    expect(await projectDatabases()).not.toContain(database)
    expect(await rows(superUrl(), `SELECT nspname FROM pg_namespace WHERE left(nspname, length($1)) = $1`, [`workspace_${projectId}`])).toEqual([])
    expect(await rows(superUrl(), `SELECT rolname FROM pg_roles WHERE rolname = $1`, [fnRole])).toEqual([])
  })

  it('closes the region’s own database to PUBLIC only once no project of the region is shared', async () => {
    const { revokePublicConnect } = await import('@/lib/data-plane/tenancy-migration')
    const other = await createProvisionedProject({ name: `still shared ${randomUUID()}`, userId: ownerId, region: REGION })
    otherProjectId = other.id
    await expect(revokePublicConnect(REGION)).rejects.toThrow(/still keep their data in its shared database/)
    expect(await rows(superUrl(), `SELECT has_database_privilege('public', $1, 'CONNECT') AS open`, [DB])).toEqual([{ open: true }])

    const { deleteProjectCompletely } = await import('@/lib/projects/delete')
    await deleteProjectCompletely(otherProjectId)
    const { dropRetiredSchemas, DROP_AFTER_MS } = await import('@/lib/postgrest/retire-schema')
    await dropRetiredSchemas(REGION, new Date(Date.now() + DROP_AFTER_MS + 1_000))

    const outsider = `outsider_${randomUUID().replace(/-/g, '').slice(0, 8)}`
    const outsiderPassword = generatePassword()
    await rows(superUrl('postgres'), `CREATE ROLE ${outsider} LOGIN PASSWORD '${outsiderPassword}'`)
    expect(await refusal(url(outsider, outsiderPassword), 'SELECT 1')).toBeNull()
    try {
      const done = await revokePublicConnect(REGION)
      expect(done.database).toBe(DB)
      expect(done.granted).toEqual(expect.arrayContaining(['backenly_app', 'backenly_authenticator', 'backenly_backup', 'backenly_dbcreator']))
      expect(await rows(superUrl(), `SELECT has_database_privilege('public', $1, 'CONNECT') AS open`, [DB])).toEqual([{ open: false }])
      expect(await refusal(url(outsider, outsiderPassword), 'SELECT 1')).toMatch(/permission denied for database/)
      for (const role of ['backenly_app', 'backenly_backup', 'backenly_authenticator'] as const) {
        expect(await refusal(loginUrl(role), 'SELECT 1')).toBeNull()
      }
    } finally {
      await rows(superUrl('postgres'), `GRANT CONNECT, TEMPORARY ON DATABASE ${DB} TO PUBLIC`)
      await rows(superUrl('postgres'), `DROP ROLE IF EXISTS ${outsider}`)
    }
  })
})

/**
 * The home region's data instance is another instance than its shared database
 * (the platform's own instance), so a project moved there leaves the instance
 * its logins were made on. Here the region's data instance is a second cluster
 * the regional procedure built, with the connection pooler's database, as the
 * home region's will be: DATA_DATABASE_URL_<REGION> names it. The home region
 * itself is not used, because its shared database is the platform database,
 * which in this suite is the CI service database, not one the procedure built;
 * every path that differs for another instance is the same for any region
 * whose data instance is not its shared database's (sameInstance in
 * lib/data-plane/tenancy-migration.ts).
 */
suite('a project whose data instance is another instance, moved with its logins', () => {
  const POOLER_HOST = 'ap-southeast-1.db.example.test'
  let ownerId = ''
  let projectId = ''
  let schema = ''
  let database = ''
  let ro = ''
  let rw = ''
  let roPassword = ''
  let rwPassword = ''
  let fnRole = ''
  let fnPassword = ''

  const onData = (user: string, password: string, db = database) => urlOn(dataCluster, user, password, db)
  const roles = async (connection: string, names: string[]) =>
    (await rows<{ rolname: string }>(connection, `SELECT rolname::text AS rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY 1`, [names])).map(
      (r) => r.rolname,
    )

  beforeAll(async () => {
    dataCluster = await buildCluster(dataCluster, { pooler: true })
    await closeProjectConnections()
    set('DATA_DATABASE_URL_AP_SOUTHEAST_1', loginUrlOn(dataCluster, 'backenly_app'))
    set('DATA_BACKUP_DATABASE_URL_AP_SOUTHEAST_1', loginUrlOn(dataCluster, 'backenly_backup'))
    set('DBCREATOR_DATABASE_URL_AP_SOUTHEAST_1', urlOn(dataCluster, 'backenly_dbcreator', passwords.backenly_dbcreator))
    set('POOLER_HOST_AP_SOUTHEAST_1', POOLER_HOST)
    // Where a shared project's logins are handed out today: the region's instance.
    set('DIRECT_DB_HOST_AP_SOUTHEAST_1', '127.0.0.1')

    ownerId = (await prisma.user.create({ data: { email: `moves-logins-${randomUUID()}@example.test`, name: 'tenancy migration logins' }, select: { id: true } })).id
    const project = await createProvisionedProject({ name: `moving logins ${randomUUID()}`, userId: ownerId, region: REGION })
    expect(project.databaseTenancy).toBe('shared')
    projectId = project.id
    schema = project.postgresSchema
    await rows(
      loginUrl('backenly_app'),
      `CREATE TABLE "${schema}".notes (id serial PRIMARY KEY, body text NOT NULL);
       INSERT INTO "${schema}".notes (body) VALUES ('one'), ('two');
       CREATE TABLE "${schema}".secrets (id integer PRIMARY KEY, value text NOT NULL);
       ALTER TABLE "${schema}".secrets ENABLE ROW LEVEL SECURITY;
       ALTER TABLE "${schema}".secrets FORCE ROW LEVEL SECURITY;
       CREATE POLICY service_only ON "${schema}".secrets
         USING (current_setting('app.is_service_role', true) = 'true')
         WITH CHECK (current_setting('app.is_service_role', true) = 'true');
       SELECT set_config('app.is_service_role', 'true', false);
       INSERT INTO "${schema}".secrets VALUES (1, 'a'), (2, 'b'), (3, 'c')`,
    )

    // Its logins, as the console makes them on a shared database: the password
    // itself kept. Their sync gives the table under row security the
    // pass-through policies, which name the read-write login, so the copy
    // names it too.
    const { provisionDirectAccess } = await import('@/lib/services/direct-access')
    const readOnly = await provisionDirectAccess(projectId, 'READ_ONLY')
    const readWrite = await provisionDirectAccess(projectId, 'READ_WRITE')
    ro = readOnly.roleName
    rw = readWrite.roleName
    roPassword = readOnly.password as string
    rwPassword = readWrite.password as string
    expect(roPassword).toBeTruthy()
    expect(rwPassword).toBeTruthy()
    const { provisionFunctionRole, functionRolePassword } = await import('@/lib/services/ai-functions/function-db-role')
    fnRole = (await provisionFunctionRole(projectId)).role
    fnPassword = functionRolePassword(schema)

    const { backupWorkspace } = await import('@/lib/services/workspace-backup')
    expect(await backupWorkspace(projectId)).toMatchObject({ success: true })
  })

  afterAll(async () => {
    if (projectId && (await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }))) {
      const { deleteProjectCompletely } = await import('@/lib/projects/delete')
      await deleteProjectCompletely(projectId).catch(() => {})
    }
    if (projectId) {
      await prisma.workspaceBackup.deleteMany({ where: { projectId } }).catch(() => {})
      await prisma.databaseCredential.deleteMany({ where: { projectId } }).catch(() => {})
      await prisma.backgroundJob
        .deleteMany({ where: { OR: [{ projectId }, { payload: { path: ['projectId'], equals: projectId } }] } })
        .catch(() => {})
      await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
    }
    if (ownerId) {
      await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
      await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
    }
  })

  it('signs each login in on the other instance, the read-write one with its old password, and leaves none behind', async () => {
    // Before: on the region's instance, and nowhere on the data instance.
    expect(await roles(superUrl(), [ro, rw, fnRole])).toEqual([ro, rw, fnRole].sort())
    expect(await roles(superUrlOn(dataCluster), [ro, rw, fnRole])).toEqual([])
    expect(await refusal(url(rw, rwPassword), `SELECT count(*) FROM "${schema}".notes`)).toBeNull()

    const { migrateProjectToOwnDatabase } = await import('@/lib/data-plane/tenancy-migration')
    const report = await migrateProjectToOwnDatabase(projectId, { waits: FAST })

    expect(report.attention).toEqual([])
    expect(report.outcome).toBe('moved')
    expect(Object.fromEntries((report.verification?.checks ?? []).map((c) => [c.id, c.state]))).toMatchObject({ rows: 'ok', logins: 'ok' })
    database = report.database as string
    expect(
      await rows(superUrlOn(dataCluster, 'postgres'), `SELECT 1 AS here FROM pg_database WHERE datname = $1`, [database]),
    ).toEqual([{ here: 1 }])
    expect(await rows(superUrl('postgres'), `SELECT 1 FROM pg_database WHERE datname = $1`, [database])).toEqual([])

    // On the data instance, each signs in to the project's own database and reads its rows.
    expect(await rows(onData(rw, rwPassword), `SELECT count(*)::int AS n FROM "${schema}".notes`)).toEqual([{ n: 2 }])
    expect(await rows(onData(fnRole, fnPassword), `SELECT count(*)::int AS n FROM "${schema}".notes`)).toEqual([{ n: 2 }])
    // The read-only login's password is derived again, as on any project's own
    // database, and is the one the platform hands out and signs in with.
    const { readOnlyLogin } = await import('@/lib/services/direct-access')
    const derived = await readOnlyLogin(projectId)
    expect(derived.roleName).toBe(ro)
    expect(await rows(onData(ro, derived.password), `SELECT count(*)::int AS n FROM "${schema}".notes`)).toEqual([{ n: 2 }])
    expect(await refusal(onData(ro, derived.password), `INSERT INTO "${schema}".notes (body) VALUES ('not allowed')`)).toMatch(/permission denied/)

    // Through the pass-through policies the copy carried, both read the table under row security.
    expect(await rows(onData(ro, derived.password), `SELECT count(*)::int AS n FROM "${schema}".secrets`)).toEqual([{ n: 3 }])
    expect(await rows(onData(rw, rwPassword), `SELECT count(*)::int AS n FROM "${schema}".secrets`)).toEqual([{ n: 3 }])
    expect(
      await rows(superUrlOn(dataCluster, database), `SELECT policyname::text AS name FROM pg_policies WHERE schemaname = $1 AND tablename = 'secrets' ORDER BY 1`, [schema]),
    ).toEqual(expect.arrayContaining([{ name: 'bkn_direct_read' }, { name: 'bkn_direct_write' }, { name: 'service_only' }]))

    // The read-write login still may not change the schema, as on the shared database.
    expect(await refusal(onData(rw, rwPassword), `CREATE TABLE "${schema}".made_directly (id int)`)).toMatch(/permission denied/)
    expect(
      await rows(
        superUrlOn(dataCluster),
        `SELECT pg_has_role($1, 'backenly_no_schema_changes', 'MEMBER') AS refused`,
        [rw],
      ),
    ).toEqual([{ refused: true }])

    // Each credential row keeps a verifier, the one the server holds, and the
    // pooler is served exactly that, on, now that the project serves again.
    const { decryptValue } = await import('@/lib/security/projectEnvCrypto')
    const { isScramVerifier } = await import('@/lib/data-plane/scram')
    for (const login of [ro, rw]) {
      const row = await prisma.databaseCredential.findFirst({ where: { projectId, roleName: login } })
      const kept = decryptValue({ valueCipher: row!.passwordCipher, valueIv: row!.passwordIv, valueTag: row!.passwordTag })
      expect(isScramVerifier(kept)).toBe(true)
      expect(await rows(superUrlOn(dataCluster), `SELECT rolpassword, rolcanlogin FROM pg_authid WHERE rolname = $1`, [login])).toEqual([
        { rolpassword: kept, rolcanlogin: true },
      ])
      expect(
        await rows(superUrlOn(dataCluster, 'backenly_pooler'), `SELECT verifier, database, active FROM backenly_pooler.logins WHERE rolname = $1`, [login]),
      ).toEqual([{ verifier: kept, database, active: true }])
    }

    // Gone from the region's instance, where they held nothing any more.
    expect(await roles(superUrl(), [ro, rw, fnRole])).toEqual([])
    expect(await refusal(url(rw, rwPassword), 'SELECT 1')).toMatch(/password authentication failed/)

    expect(Object.fromEntries((report.smoke ?? []).map((c) => [c.id, c.state]))).toMatchObject({
      workspace: 'ok',
      realtime: 'ok',
      function_login: 'ok',
      snapshot: 'ok',
    })
  })

  it('is deleted from the other instance: its database, then its logins and their pooler rows', async () => {
    const { deleteProjectCompletely } = await import('@/lib/projects/delete')
    const result = await deleteProjectCompletely(projectId)
    expect(result.retiredLogins).toEqual([])
    expect(await rows(superUrlOn(dataCluster, 'postgres'), `SELECT 1 FROM pg_database WHERE datname = $1`, [database])).toEqual([])
    expect(await roles(superUrlOn(dataCluster), [ro, rw, fnRole])).toEqual([])
    expect(await rows(superUrlOn(dataCluster, 'backenly_pooler'), `SELECT rolname FROM backenly_pooler.logins WHERE rolname = ANY($1::text[])`, [[ro, rw]])).toEqual([])
  })
})
