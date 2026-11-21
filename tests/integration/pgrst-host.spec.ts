/**
 * THE POSTGREST HOST, WITH THE REAL POSTGREST BINARY
 * ==================================================
 * A project can have a database of its own; PostgREST serves one database per
 * process, so services/pgrst-host runs one PostgREST child per project
 * database. This suite runs the host in this process with the official
 * postgrest binary (the release services/pgrst-host/Dockerfile copies; CI
 * extracts it from that image and sets PGRST_HOST_BINARY) against three
 * databases of their own on the test server, each holding the registry and
 * DDL-sync helpers as the installer installs them and one project's
 * workspace schema:
 *
 *   - two projects, two databases, two children, each answering from its own
 *     database, through tokens the runtime's gateway mints
 *   - project A's token is refused on project B's path by the host, and by
 *     B's PostgREST itself (PGRST_JWT_AUD)
 *   - NOTIFY pgrst in one database reloads only that database's child
 *   - a child killed with SIGKILL is started again by the next request
 *   - at the cap with every child busy: 503 DATA_PLANE_BUSY; once one is
 *     idle, the least recently used makes room
 *   - an idle child is stopped and its process is gone
 *
 * Each child's cold start and resident memory are printed: they size the
 * service.
 *
 * Roles are cluster-wide, so the authenticator is a throwaway login of this
 * suite's own (as in postgrest-reload-on-drop.spec.ts); anon, authenticated and
 * service_role are created by the registry SQL only where absent.
 */

import { execFileSync } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { Client } from 'pg'

import { internalClaimsFor, mintInternalToken } from '@/lib/postgrest/gateway'
import { readConfig, type HostConfig } from '@/services/pgrst-host/config'
import { createPgrstHost, type PgrstHost } from '@/services/pgrst-host/server'

jest.setTimeout(180_000)

const BINARY = process.env.PGRST_HOST_BINARY || 'postgrest'

function postgrestVersion(): string | null {
  try {
    return execFileSync(BINARY, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return null
  }
}

/**
 * CI provides the binary and runs every case (a skipped suite fails its run
 * there); a machine without it skips the suite rather than failing each case.
 */
const VERSION = postgrestVersion()
const runnable = Boolean(process.env.CI) || VERSION !== null
const suite = runnable ? describe : describe.skip

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? ''
const AUTH = `bkn_pgrst_host_${randomBytes(4).toString('hex')}`
const AUTH_PASSWORD = randomBytes(16).toString('hex')
const SECRET = randomBytes(32).toString('hex')

interface Tenant {
  name: string
  projectId: string
  database: string
  schema: string
}

const tenant = (name: string): Tenant => {
  const projectId = randomUUID()
  return { name, projectId, database: `p_${randomBytes(16).toString('hex')}`, schema: `workspace_${projectId}` }
}
const A = tenant('A')
const B = tenant('B')
const C = tenant('C')
const TENANTS = [A, B, C]

function urlFor(database: string, user?: string, password?: string): string {
  const url = new URL(ADMIN_URL)
  url.pathname = `/${database}`
  if (user) {
    url.username = user
    url.password = password ?? ''
  }
  return url.toString()
}

async function sql<T = Record<string, unknown>>(database: string, text: string): Promise<T[]> {
  const client = new Client({ connectionString: urlFor(database) })
  client.on('error', () => {})
  await client.connect()
  try {
    const result = await client.query(text)
    const last = Array.isArray(result) ? result[result.length - 1] : result
    return (last?.rows ?? []) as T[]
  } finally {
    await client.end().catch(() => {})
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function eventually(what: string, check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The runtime's internal token for a project with a database of its own. */
function tokenFor(t: Tenant, database = t.database): string {
  return mintInternalToken(internalClaimsFor({ projectId: t.projectId, serviceRole: true, database }), SECRET)
}

interface Answer {
  status: number
  headers: Headers
  json: any
  text: string
}

/** A request as the runtime sends it: profile headers for the project's schema, its token. */
async function rest(
  port: number,
  t: Tenant,
  route: string,
  opts: { method?: string; body?: string; token?: string } = {},
): Promise<Answer> {
  const method = opts.method ?? 'GET'
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.token ?? tokenFor(t)}`,
    'accept-profile': t.schema,
    'content-type': 'application/json',
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['content-profile'] = t.schema
  const res = await fetch(`http://127.0.0.1:${port}/p/${t.projectId}${route}`, { method, headers, body: opts.body })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: res.status, headers: res.headers, json, text }
}

async function stateOf(port: number, t: Tenant): Promise<any> {
  const answer = await rest(port, t, '/__state')
  expect(answer.status).toBe(200)
  return answer.json
}

/** The child's server port, from its own environment (same user, Linux). */
function childPort(pid: number): number {
  const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')
  const entry = environ.find((e) => e.startsWith('PGRST_SERVER_PORT='))
  if (!entry) throw new Error('child has no PGRST_SERVER_PORT')
  return Number(entry.slice('PGRST_SERVER_PORT='.length))
}

const MiB = (bytes: number | null | undefined) => (typeof bytes === 'number' ? (bytes / 1048576).toFixed(1) : 'n/a')

const logs: string[] = []
const measurements: string[] = []

function config(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    ...readConfig({
      PGRST_HOST_JWT_SECRET: SECRET,
      PGRST_HOST_DB_URI: urlFor('postgres', AUTH, AUTH_PASSWORD),
      PGRST_HOST_BINARY: BINARY,
    }),
    maxChildren: 2,
    ...overrides,
  }
}

let host: PgrstHost | null = null
let port = 0
let quick: PgrstHost | null = null

suite('the PostgREST host with the real postgrest binary', () => {
  beforeAll(async () => {
    if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
    if (!ADMIN_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
    if (!VERSION) throw new Error(`postgrest is not runnable at "${BINARY}"; set PGRST_HOST_BINARY`)
    const admin = decodeURIComponent(new URL(ADMIN_URL).username)

    await sql('postgres', `CREATE ROLE ${AUTH} LOGIN NOINHERIT PASSWORD '${AUTH_PASSWORD}'`)
    for (const t of TENANTS) {
      await sql('postgres', `CREATE DATABASE ${t.database}`)
      await sql('postgres', `ALTER DATABASE ${t.database} SET backenly.app_role = '${admin}'`)
      // In the installer's order, with the authenticator renamed to this suite's own.
      for (const file of ['postgrest-schema-registry.sql', 'postgrest-ddl-sync.sql']) {
        const text = fs
          .readFileSync(path.join(process.cwd(), 'scripts', 'sql', file), 'utf8')
          .replace(/backenly_authenticator/g, AUTH)
        await sql(t.database, text)
      }
      // A canonical workspace schema registers itself (backenly_pgrst_on_schema_create).
      await sql(t.database, `CREATE SCHEMA "${t.schema}"`)
      await sql(
        t.database,
        `CREATE TABLE "${t.schema}".items (id integer PRIMARY KEY, label text NOT NULL);
         INSERT INTO "${t.schema}".items VALUES (1, 'from ${t.name}');
         CREATE FUNCTION "${t.schema}".slow() RETURNS integer LANGUAGE sql AS $$ SELECT 1 FROM pg_sleep(2.5) $$;
         GRANT USAGE ON SCHEMA "${t.schema}" TO anon, authenticated, service_role;
         GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${t.schema}" TO service_role;
         GRANT EXECUTE ON FUNCTION "${t.schema}".slow() TO service_role;`,
      )
      const [registered] = await sql<{ s: string }>(t.database, `SELECT public.backenly_pgrst_current_schemas() AS s`)
      expect(registered.s).toBe(t.schema)
    }
    await sql('postgres', `GRANT anon, authenticated, service_role TO ${AUTH}`)

    host = createPgrstHost({ config: config(), log: (line) => logs.push(line) })
    port = (await host.listen(0, '127.0.0.1')).port
  })

  afterAll(async () => {
    await host?.close().catch(() => {})
    await quick?.close().catch(() => {})
    for (const t of TENANTS) {
      await sql('postgres', `DROP DATABASE IF EXISTS ${t.database} WITH (FORCE)`).catch(() => {})
    }
    await sql('postgres', `DROP ROLE IF EXISTS ${AUTH}`).catch(() => {})
    console.log(`[pgrst-host] host log:\n${logs.join('\n')}`)
    console.log(
      `[pgrst-host measurement] ${VERSION ?? 'postgrest'}, child pool ${config().childDbPool}\n${measurements.join('\n')}`,
    )
  })

  it('serves two projects from two databases, each through a PostgREST of its own', async () => {
    const started: Record<string, number> = {}
    for (const t of [A, B]) {
      const t0 = Date.now()
      const answer = await rest(port, t, '/items')
      started[t.name] = Date.now() - t0
      expect(answer.status).toBe(200)
      expect(answer.json).toEqual([{ id: 1, label: `from ${t.name}` }])
    }
    const a = await stateOf(port, A)
    const b = await stateOf(port, B)
    expect(a).toMatchObject({ state: 'ready', database: A.database, ready: true })
    expect(b).toMatchObject({ state: 'ready', database: B.database, ready: true })
    expect(a.pid).not.toBe(b.pid)

    for (let i = 0; i < 20; i++) {
      expect((await rest(port, A, '/items?select=label')).status).toBe(200)
      expect((await rest(port, B, '/items?select=label')).status).toBe(200)
    }
    for (const [t, first] of [[A, a], [B, b]] as const) {
      const after = await stateOf(port, t)
      measurements.push(
        `child=${t.name} cold_start_ms=${first.coldStartMs} first_request_ms=${started[t.name]} ` +
          `rss_at_ready_mib=${MiB(first.rssAtReadyBytes)} rss_after_21_requests_mib=${MiB(after.rssBytes)}`,
      )
    }
  })

  it('refuses project A’s token on project B’s path, at the host and in B’s own PostgREST', async () => {
    const atHost = await rest(port, B, '/items', { token: tokenFor(A) })
    expect(atHost.status).toBe(403)
    expect(atHost.json.code).toBe('TOKEN_AUDIENCE_MISMATCH')

    // B's token naming A's database cannot point B's running child elsewhere.
    const otherDatabase = await rest(port, B, '/items', { token: tokenFor(B, A.database) })
    expect(otherDatabase.status).toBe(409)
    expect(otherDatabase.json.code).toBe('DATABASE_MISMATCH')

    // Straight to B's PostgREST, past the host: its PGRST_JWT_AUD refuses A's token.
    const childB = childPort((await stateOf(port, B)).pid)
    const direct = (token: string) =>
      fetch(`http://127.0.0.1:${childB}/items`, { headers: { authorization: `Bearer ${token}`, 'accept-profile': B.schema } })
    expect((await direct(tokenFor(B))).status).toBe(200)
    expect((await direct(tokenFor(A))).status).toBe(401)
  })

  it('reloads only the child of the database a NOTIFY pgrst was sent in', async () => {
    try {
      for (const t of [A, B]) {
        // Without the DDL trigger, nothing but the NOTIFY below tells a child the table exists.
        await sql(t.database, `ALTER EVENT TRIGGER backenly_pgrst_ddl_sync DISABLE`)
        await sql(
          t.database,
          `CREATE TABLE "${t.schema}".late (id integer PRIMARY KEY);
           INSERT INTO "${t.schema}".late VALUES (7);
           GRANT SELECT ON "${t.schema}".late TO service_role;`,
        )
        const unknown = await rest(port, t, '/late')
        expect(unknown.status).toBe(404)
        expect(unknown.json.code).toBe('PGRST205')
      }

      await sql(A.database, `NOTIFY pgrst, 'reload schema'`)
      await eventually('A to load its new table', async () => (await rest(port, A, '/late')).status === 200)
      await sleep(500)
      const stillUnknown = await rest(port, B, '/late')
      expect(stillUnknown.status).toBe(404)
      expect(stillUnknown.json.code).toBe('PGRST205')

      await sql(B.database, `NOTIFY pgrst, 'reload schema'`)
      await eventually('B to load its new table', async () => (await rest(port, B, '/late')).status === 200)
      expect((await rest(port, B, '/late')).json).toEqual([{ id: 7 }])
    } finally {
      for (const t of [A, B]) await sql(t.database, `ALTER EVENT TRIGGER backenly_pgrst_ddl_sync ENABLE`).catch(() => {})
    }
  })

  it('starts a child killed with SIGKILL again on the next request', async () => {
    const before = await stateOf(port, A)
    process.kill(before.pid, 'SIGKILL')
    await eventually('the host to see the child exit', async () => (await stateOf(port, A)).state === 'stopped')

    const t0 = Date.now()
    const answer = await rest(port, A, '/items')
    const firstRequestMs = Date.now() - t0
    expect(answer.status).toBe(200)
    expect(answer.json).toEqual([{ id: 1, label: 'from A' }])
    const after = await stateOf(port, A)
    expect(after).toMatchObject({ state: 'ready', recentFailures: 1 })
    expect(after.pid).not.toBe(before.pid)
    measurements.push(
      `child=A(respawned) cold_start_ms=${after.coldStartMs} first_request_ms=${firstRequestMs} rss_at_ready_mib=${MiB(after.rssAtReadyBytes)}`,
    )
  })

  it('answers 503 DATA_PLANE_BUSY at the cap while every child is busy, then makes room', async () => {
    const slowA = rest(port, A, '/rpc/slow', { method: 'POST', body: '{}' })
    const slowB = rest(port, B, '/rpc/slow', { method: 'POST', body: '{}' })
    await eventually(
      'both children to be busy',
      async () => (await stateOf(port, A)).inFlight > 0 && (await stateOf(port, B)).inFlight > 0,
    )
    const busy = await rest(port, C, '/items')
    expect(busy.status).toBe(503)
    expect(busy.json.code).toBe('DATA_PLANE_BUSY')
    expect(busy.headers.get('retry-after')).toBe('5')
    expect((await stateOf(port, C)).state).toBe('stopped')

    for (const slow of [slowA, slowB]) {
      const answer = await slow
      expect(answer.status).toBe(200)
      expect(answer.json).toBe(1)
    }
    await sleep(100)

    const t0 = Date.now()
    const c = await rest(port, C, '/items')
    const firstRequestMs = Date.now() - t0
    expect(c.status).toBe(200)
    expect(c.json).toEqual([{ id: 1, label: 'from C' }])
    const states = [await stateOf(port, A), await stateOf(port, B)].map((s) => s.state).sort()
    expect(states).toEqual(['ready', 'stopped'])
    const cState = await stateOf(port, C)
    measurements.push(
      `child=C cold_start_ms=${cState.coldStartMs} first_request_ms=${firstRequestMs} rss_at_ready_mib=${MiB(cState.rssAtReadyBytes)}`,
    )
  })

  it('stops a child left idle, and its process is gone', async () => {
    quick = createPgrstHost({ config: config({ idleMs: 2000 }), log: (line) => logs.push(`(idle host) ${line}`) })
    const quickPort = (await quick.listen(0, '127.0.0.1')).port
    expect((await rest(quickPort, B, '/items')).status).toBe(200)
    const running = await stateOf(quickPort, B)
    expect(running.state).toBe('ready')
    expect(pidAlive(running.pid)).toBe(true)

    await eventually('the idle child to be stopped', async () => (await stateOf(quickPort, B)).state === 'stopped', 20_000)
    await eventually('the idle child’s process to exit', async () => !pidAlive(running.pid))
    expect(logs.some((l) => l.includes(`(idle host) [pgrst-host] ${B.projectId} stopping (idle`))).toBe(true)
    await quick.close()
    quick = null
  })
})
