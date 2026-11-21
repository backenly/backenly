/**
 * A PROJECT WITH A DATABASE OF ITS OWN HOLDS ITS SESSIONS THERE
 * =============================================================
 * Advisory locks, LISTEN/NOTIFY and a connection's settings all belong to one
 * database, so each of them has to be opened on the database holding the
 * project's data (lib/data-plane/regional.ts): for a project with a database of
 * its own, that database, never its region's.
 *
 * This suite creates two real databases on the CI server named as projects'
 * own (p_ and 32 hex digits) and puts a decoy schema with a project's name on
 * the platform database, where every lookup would land if it went to the
 * region's database instead. It pins:
 *
 *   change lock     taken in the project's own database: another process
 *                   holding a connection there waits for it, the platform
 *                   database's same key stays free; a second change waits and,
 *                   past its bound, is refused; shared projects keep theirs on
 *                   the region's database
 *   catalog         the catalog a change reads before and after is the
 *                   project's own database's, so a governed change records what
 *                   it did there
 *   two at once     the lock held on a region's database and a project's own
 *                   together, as moving a project between them will
 *   realtime        a NOTIFY in each project's database reaches only that
 *                   project's subscribers; a project database's listener closes
 *                   after its last stream, the region's stays; past the cap a
 *                   stream is refused in so many words
 *   pooled queries  search_path and the statement timeout end with the query's
 *                   transaction, so the next borrower of the same connection
 *                   sees none of them; a session of its own is closed after use
 *   the cap         at DATA_POOL_PROCESS_CAP a new pool waits, then is refused
 *                   with a retryable 503, and is let in once an idle pool can
 *                   be let go
 *
 * Real databases throughout: nothing that carries the property is mocked.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { Client, Pool } from 'pg'

import { prisma } from '@/lib/db/prisma'
import { projectToLockKey } from '@/lib/autonomy/maintenance/single-flight'
import { withChangeAttribution, withGovernedChange } from '@/lib/changes/ledger'
import {
  ChangeInProgressError,
  changeLockHeld,
  closeChangeLockPool,
  readCatalogOn,
  withChangeLock,
  withChangeLockOn,
} from '@/lib/changes/lock'
import { DatabaseBusyError, disconnectRegionalClients, projectPool, workspaceRawClient } from '@/lib/data-plane/regional'
import { notifyProjectChannel } from '@/lib/realtime/channels'
import { REALTIME_BUSY_MESSAGE, listenerHub } from '@/lib/realtime/listener-hub'
import { HOME_REGION } from '@/lib/regions'
import { getWorkspaceDatabaseNames } from '@/lib/services/databaseProvisioning'
import { closeAllWorkspacePools, queryWorkspace, withWorkspaceSession } from '@/lib/services/workspace-pool'
import { installChangeLedgerGuard } from '../helpers/change-ledger-guard'

jest.setTimeout(180_000)

/** 'chng': the change lock's namespace (lib/changes/lock.ts). */
const CHANGE_LOCK_NAMESPACE = 0x63686e67
const DB_A = `p_${randomBytes(16).toString('hex')}`
const DB_B = `p_${randomBytes(16).toString('hex')}`

const homeUrl = () => process.env.DATABASE_URL as string
function urlFor(database: string): string {
  const url = new URL(homeUrl())
  url.pathname = `/${database}`
  return url.toString()
}

async function rowsIn<T>(connectionString: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    return (await client.query(sql, params)).rows as T[]
  } finally {
    await client.end().catch(() => {})
  }
}
const run = async (connectionString: string, sql: string, params: unknown[] = []) => {
  await rowsIn(connectionString, sql, params)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await sleep(50)
  }
}

const ENV_NAMES = [
  'DATA_DATABASE_URL',
  'DATA_DIRECT_URL',
  'DATA_POOL_PROCESS_CAP',
  'REALTIME_LISTENER_IDLE_CLOSE_MS',
  'REALTIME_DATABASE_LISTENERS_MAX',
  'ENGINE_MODE',
] as const
const savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))

let platformDb = ''
let ownerId = ''
let ownA = ''
let ownB = ''
let shared = ''
const created: string[] = []
const schemaOf = (projectId: string) => getWorkspaceDatabaseNames(projectId).postgresSchema

/** The database a connection is on. */
async function databaseOf(client: { query: (sql: string) => Promise<any> }): Promise<string> {
  return (await client.query('SELECT current_database()::text AS db')).rows[0].db
}

/** Whether another session could take this project's change lock in `url`'s database right now. */
async function lockFreeIn(url: string, projectId: string): Promise<boolean> {
  // The session ends as the client does, and any lock it took with it.
  const [row] = await rowsIn<{ ok: boolean }>(url, 'SELECT pg_try_advisory_lock($1::int4, $2::int4) AS ok', [
    CHANGE_LOCK_NAMESPACE,
    projectToLockKey(projectId),
  ])
  return row.ok
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  platformDb = new URL(homeUrl()).pathname.slice(1)
  // The ledger records nothing in integration mode, which runs no DDL.
  process.env.ENGINE_MODE = 'runtime'
  await installChangeLedgerGuard()

  for (const name of [DB_A, DB_B]) {
    await run(homeUrl(), `CREATE DATABASE "${name}"`)
    created.push(name)
  }
  // The home data instance is this server; its database part is replaced by
  // each project's own.
  process.env.DATA_DATABASE_URL = urlFor('postgres')
  delete process.env.DATA_DIRECT_URL
  delete process.env.DATA_POOL_PROCESS_CAP
  delete process.env.REALTIME_DATABASE_LISTENERS_MAX
  process.env.REALTIME_LISTENER_IDLE_CLOSE_MS = '300'

  ownerId = (
    await prisma.user.create({ data: { email: `dbsess-${randomUUID()}@example.test`, name: 'database sessions fixture' }, select: { id: true } })
  ).id
  const project = async (data: Record<string, unknown>) =>
    (await prisma.project.create({ data: { name: `dbsess-${randomUUID()}`, userId: ownerId, ...data } as any, select: { id: true } })).id
  ownA = await project({ databaseTenancy: 'dedicated', databaseName: DB_A })
  ownB = await project({ databaseTenancy: 'dedicated', databaseName: DB_B })
  shared = await project({})

  for (const [projectId, url] of [[ownA, urlFor(DB_A)], [ownB, urlFor(DB_B)], [shared, homeUrl()]] as const) {
    await run(url, `CREATE SCHEMA "${schemaOf(projectId)}"`)
    await prisma.workspace.create({
      data: { name: 'database sessions fixture', projectId, postgresSchema: schemaOf(projectId), databaseProvisioned: true },
    })
  }
  // A decoy: the platform database holding a schema of A's name, which is
  // what a lock or a catalog read sent to the region's database would find.
  await run(homeUrl(), `CREATE SCHEMA "${schemaOf(ownA)}"`)
  await run(homeUrl(), `CREATE TABLE "${schemaOf(ownA)}".decoy (id int)`)
})

afterAll(async () => {
  await closeChangeLockPool().catch(() => {})
  await closeAllWorkspacePools().catch(() => {})
  await disconnectRegionalClients().catch(() => {})
  await run(homeUrl(), `DROP SCHEMA IF EXISTS "${schemaOf(ownA)}" CASCADE`).catch(() => {})
  await run(homeUrl(), `DROP SCHEMA IF EXISTS "${schemaOf(shared)}" CASCADE`).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  for (const name of created) await run(homeUrl(), `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {})
})

describe('the change lock of a project with a database of its own', () => {
  it('is taken in that database, where another process waits for it, and not in the region’s', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const order: string[] = []
    const first = withChangeLock(ownA, async (client) => {
      expect(await databaseOf(client)).toBe(DB_A)
      order.push('first in')
      await gate
      order.push('first out')
    })
    await waitFor(() => changeLockHeld(ownA))

    // The same key on the platform database is free: the lock is not there.
    expect(await lockFreeIn(homeUrl(), ownA)).toBe(true)

    // Another process: a pool of its own on the project's database, as
    // another server's would be. It waits for the lock.
    const other = new Pool({ connectionString: urlFor(DB_A), max: 1 })
    const second = (async () => {
      const client = await other.connect()
      try {
        await client.query('SELECT pg_advisory_lock($1::int4, $2::int4)', [CHANGE_LOCK_NAMESPACE, projectToLockKey(ownA)])
        order.push('second in')
        await client.query('SELECT pg_advisory_unlock($1::int4, $2::int4)', [CHANGE_LOCK_NAMESPACE, projectToLockKey(ownA)])
      } finally {
        client.release()
      }
    })()
    await sleep(500)
    expect(order).toEqual(['first in'])

    // A change in this process waits too, and is refused past its bound.
    await expect(withChangeLock(ownA, async () => 'ran', { waitMs: 200 })).rejects.toBeInstanceOf(ChangeInProgressError)

    release()
    await first
    await second
    await other.end()
    expect(order).toEqual(['first in', 'first out', 'second in'])
    expect(await changeLockHeld(ownA)).toBe(false)
  })

  it('is decided per database: two projects’ own databases never contend', async () => {
    await withChangeLock(ownA, async () => {
      expect(await withChangeLock(ownB, async (client) => databaseOf(client), { waitMs: 200 })).toBe(DB_B)
    })
  })

  it('stays on the region’s database for a shared project, as always', async () => {
    expect(await withChangeLock(shared, (client) => databaseOf(client))).toBe(platformDb)
  })

  it('reads the catalog of the project’s own database, never the region’s', async () => {
    const s = schemaOf(ownA)
    await run(urlFor(DB_A), `CREATE TABLE "${s}".kept_here (id int)`)
    const snapshot = await withChangeLock(ownA, (client) => readCatalogOn(client, s))
    expect(Object.keys(snapshot.tables)).toContain('kept_here')
    expect(Object.keys(snapshot.tables)).not.toContain('decoy')
  })

  it('records a governed change from what it did in the project’s own database', async () => {
    const s = schemaOf(ownA)
    const { change } = await withChangeAttribution({ source: 'dashboard', actorUserId: ownerId }, () =>
      withGovernedChange({ projectId: ownA, title: 'add made_here' }, async () => {
        const db = await workspaceRawClient(ownA)
        await db.$executeRawUnsafe(`CREATE TABLE "${s}".made_here (id int)`)
      }),
    )
    // Read on the region's database, both catalogs would hold only the decoy,
    // the footprint would be empty, and the change would leave no record.
    expect(change).not.toBeNull()
    expect(change!.footprint).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'added', after: 'made_here' })]))
    const [{ n }] = await rowsIn<{ n: number }>(
      homeUrl(),
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relname = 'made_here'`,
      [s],
    )
    expect(n).toBe(0)
  })

  it('can be held on the region’s database and the project’s own at once', async () => {
    await withChangeLockOn(
      ownA,
      [
        { region: HOME_REGION, database: DB_A },
        { region: HOME_REGION, database: null },
      ],
      async ([own, region]) => {
        expect(await databaseOf(own)).toBe(DB_A)
        expect(await databaseOf(region)).toBe(platformDb)
        expect(await lockFreeIn(urlFor(DB_A), ownA)).toBe(false)
        expect(await lockFreeIn(homeUrl(), ownA)).toBe(false)
        await expect(withChangeLock(ownA, async () => 'ran', { waitMs: 200 })).rejects.toBeInstanceOf(ChangeInProgressError)
      },
    )
    expect(await lockFreeIn(urlFor(DB_A), ownA)).toBe(true)
    expect(await lockFreeIn(homeUrl(), ownA)).toBe(true)
  })
})

describe('realtime on projects’ own databases', () => {
  async function collect(projectId: string) {
    const heard: Array<Record<string, unknown>> = []
    const result = await listenerHub.subscribe(projectId, (payload) => {
      heard.push(payload)
    })
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`)
    return { heard, unsubscribe: result.unsubscribe }
  }

  /** Sessions in `database` whose last statement was a LISTEN or an UNLISTEN: the hub's listener. */
  async function listenSessions(database: string): Promise<number> {
    const [{ n }] = await rowsIn<{ n: number }>(
      homeUrl(),
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = $1 AND (query LIKE 'LISTEN %' OR query LIKE 'UNLISTEN %')`,
      [database],
    )
    return n
  }

  it('delivers a NOTIFY in each project’s database to that project’s subscribers only', async () => {
    const a = await collect(ownA)
    const b = await collect(ownB)
    try {
      expect(await notifyProjectChannel(ownA, JSON.stringify({ to: 'a' }))).toBe(true)
      expect(await notifyProjectChannel(ownB, JSON.stringify({ to: 'b' }))).toBe(true)
      await waitFor(() => a.heard.length > 0 && b.heard.length > 0)

      // A's channel, sent on the platform database, reaches nobody: nothing
      // listens for A there.
      const [{ channel }] = await rowsIn<{ channel: string }>(
        urlFor(DB_A),
        'SELECT channel FROM backenly_realtime.channel_secrets WHERE schema_name = $1',
        [schemaOf(ownA)],
      )
      await run(homeUrl(), 'SELECT pg_notify($1, $2)', [channel, JSON.stringify({ to: 'nobody' })])
      await sleep(300)

      expect(a.heard).toEqual([{ to: 'a' }])
      expect(b.heard).toEqual([{ to: 'b' }])
    } finally {
      a.unsubscribe()
      b.unsubscribe()
    }
  })

  it('closes a project database’s listener after its last stream, and keeps the region’s', async () => {
    const key = `${HOME_REGION}:${DB_A}`
    const a = await collect(ownA)
    const s = await collect(shared)
    expect(listenerHub.listenerKeys()).toEqual(expect.arrayContaining([key, `${HOME_REGION}:control`]))
    expect(await listenSessions(DB_A)).toBeGreaterThan(0)

    a.unsubscribe()
    s.unsubscribe()
    await waitFor(async () => !listenerHub.listenerKeys().includes(key) && (await listenSessions(DB_A)) === 0)
    await sleep(500)
    expect(listenerHub.listenerKeys()).toContain(`${HOME_REGION}:control`)
  })

  it('refuses a stream in so many words when this process keeps as many project database listeners as it may', async () => {
    process.env.REALTIME_DATABASE_LISTENERS_MAX = '1'
    process.env.REALTIME_LISTENER_IDLE_CLOSE_MS = '60000'
    try {
      const a = await collect(ownA)
      const refused = await listenerHub.subscribe(ownB, () => {})
      expect(refused).toEqual({ ok: false, code: 'REALTIME_BUSY', message: REALTIME_BUSY_MESSAGE })
      expect(listenerHub.connectionCount(ownB)).toBe(0)
      expect(listenerHub.listenerKeys()).not.toContain(`${HOME_REGION}:${DB_B}`)

      // A listener nobody streams from any more makes room at once.
      a.unsubscribe()
      const b = await collect(ownB)
      expect(listenerHub.listenerKeys()).toContain(`${HOME_REGION}:${DB_B}`)
      expect(listenerHub.listenerKeys()).not.toContain(`${HOME_REGION}:${DB_A}`)
      b.unsubscribe()
    } finally {
      delete process.env.REALTIME_DATABASE_LISTENERS_MAX
      process.env.REALTIME_LISTENER_IDLE_CLOSE_MS = '300'
    }
  })
})

describe('workspace queries on a pooled connection', () => {
  it('leave neither their search_path nor their statement timeout to the next borrower of the connection', async () => {
    const s = schemaOf(ownA)
    await run(urlFor(DB_A), `CREATE TABLE "${s}".pets (name text)`)
    await run(urlFor(DB_A), `INSERT INTO "${s}".pets VALUES ('rex')`)
    const [fresh] = await rowsIn<{ path: string; timeout: string }>(
      urlFor(DB_A),
      `SELECT current_setting('search_path') AS path, current_setting('statement_timeout') AS timeout`,
    )

    // Unqualified: found through the search_path the query's transaction set.
    const [seen] = await queryWorkspace<{ pid: number; path: string; timeout: string; name: string }>(
      ownA,
      `SELECT pg_backend_pid() AS pid, current_setting('search_path') AS path, current_setting('statement_timeout') AS timeout, name FROM pets`,
    )
    expect(seen.name).toBe('rex')
    expect(seen.path).toContain(s)
    expect(seen.timeout).not.toBe(fresh.timeout)

    // The same connection, borrowed next from the same pool, carries none of it.
    const pool = await projectPool(ownA, 'workspace')
    const next = await pool.connect()
    try {
      const { rows } = await next.query<{ pid: number; path: string; timeout: string }>(
        `SELECT pg_backend_pid() AS pid, current_setting('search_path') AS path, current_setting('statement_timeout') AS timeout`,
      )
      expect(rows[0].pid).toBe(seen.pid)
      expect({ path: rows[0].path, timeout: rows[0].timeout }).toEqual(fresh)
    } finally {
      next.release()
    }
  })

  it('give a session of its own back closed, never to the pool', async () => {
    let pid = 0
    await withWorkspaceSession(ownA, async (client) => {
      pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    })
    await waitFor(async () => (await rowsIn<{ n: number }>(homeUrl(), 'SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [pid]))[0].n === 0)
  })
})

describe('the cap on connections to a data instance', () => {
  it('makes a new pool wait, then refuses it with a retryable 503, and lets one in once an idle pool can go', async () => {
    // Nothing the tests above opened is counted.
    await disconnectRegionalClients()
    process.env.DATA_POOL_PROCESS_CAP = '4'
    const held: Array<{ release: (destroy?: boolean) => void }> = []
    try {
      const first = await projectPool(ownA, 'cap-first', { max: 2 })
      held.push(await first.connect(), await first.connect())
      const second = await projectPool(ownB, 'cap-second', { max: 2 })
      const secondClient = await second.connect()

      let started = Date.now()
      const refused = await projectPool(ownA, 'cap-third', { max: 2 }).catch((err: unknown) => err)
      expect(refused).toBeInstanceOf(DatabaseBusyError)
      expect(refused).toMatchObject({ code: 'PROJECT_DATABASE_BUSY', status: 503, retryable: true, max: 4 })
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_500)

      started = Date.now()
      const waiting = projectPool(ownA, 'cap-fourth', { max: 2 })
      await sleep(300)
      // Closed rather than kept idle, so the pool holds nothing and can go at once.
      secondClient.release(true)
      const fourth = await waiting
      expect(Date.now() - started).toBeLessThan(4_500)
      const onFourth = await fourth.connect()
      held.push(onFourth)
      expect(await databaseOf(onFourth)).toBe(DB_A)
    } finally {
      for (const client of held) client.release()
      delete process.env.DATA_POOL_PROCESS_CAP
      await disconnectRegionalClients()
    }
  })
})
