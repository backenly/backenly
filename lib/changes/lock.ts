/**
 * One schema change per project at a time.
 *
 * A change is recorded as the difference between the catalog before it and the
 * catalog after it (lib/changes/ledger.ts). That is only true if nothing else
 * changed the schema in between: two agents migrating one project at once would
 * each record the other's tables as their own, and restoring one would undo
 * both. So every governed change, every recovery and every recovery preview
 * holds this lock for as long as it runs.
 *
 * Same construction as lib/autonomy/maintenance/single-flight.ts, for the same
 * reasons: a PostgreSQL advisory lock, because the database decides it
 * atomically across every instance; session-scoped, on a connection that stays
 * checked out until release, because an unlock on a different pooled
 * connection silently does nothing; the two-integer keyspace with a namespace
 * of its own, so it never collides with the build lock or the maintenance lock.
 *
 * Unlike the maintenance sweep it WAITS, up to a bound. A change is a person or
 * an agent waiting on an answer, and a migration that arrives while another is
 * applying should run after it, not fail. Past the bound it is refused with
 * CHANGE_IN_PROGRESS rather than queued indefinitely.
 *
 * Re-entrant within one async context: a rollback started while a change holds
 * the lock (the automatic rollback of a migration that failed part-way) runs on
 * the same connection instead of deadlocking against itself.
 *
 * ── On the database holding the project's data ─────────────────────────────
 *
 * The connection holding the lock is also the one the change reads its
 * catalog on, keeps data in its vault with and restores on, so it is opened on
 * the database holding the project's data (lib/data-plane/regional.ts): its
 * region's own database for a shared project, exactly as always, and the
 * project's own database for a project that has one. An advisory lock belongs
 * to one database, so the lock is then decided where the schema is, by every
 * process changing that project, and the catalog read before and after a
 * change is that database's. A region or data instance this process has no
 * connection to is refused with RegionNotConfiguredError, never served from
 * another database, where the project's schema is not.
 *
 * The session must be kept: the connection is a direct one, never through a
 * transaction pooler. A shared project's is its region's DATABASE_URL, as it
 * always was. A project database's is the data instance's direct connection
 * (DATA_DIRECT_URL, with the region appended outside the home region) when one
 * is set, else its application connection; like DIRECT_URL, it connects as the
 * application role, which owns what a change creates.
 *
 * Connections to projects' own databases are pools of their own, one per
 * database, CHANGE_LOCK_POOL_MAX connections each (one holding the lock, the
 * rest waiting for it or asking whether it is held), and at most
 * CHANGE_LOCK_POOLS_MAX of them per process, one closed to make room only when
 * nothing is checked out of it. When every one is busy a change waits a few
 * seconds for room, then is refused with DatabaseBusyError (503, retryable).
 *
 * ── Two databases at once ───────────────────────────────────────────────────
 *
 * withChangeLockOn holds the lock on several databases at once: for moving a
 * project's data from its region's shared database to a database of its own,
 * no process may start a change on either, whichever of the two it believes
 * holds the project. Nothing calls it yet.
 */

import { Pool, type PoolClient } from 'pg'
import { projectToLockKey } from '@/lib/autonomy/maintenance/single-flight'
import { DatabaseRegistry, ROOM_WAIT_MS, whenRoom } from '@/lib/data-plane/database-registry'
import {
  projectDatabase,
  regionDataInstanceUrl,
  requireRegionDataInstanceUrl,
  requireRegionDatabaseUrl,
  withDatabase,
} from '@/lib/data-plane/regional'
import type { CloudRegionId } from '@/lib/regions'
import { readCatalog, type CatalogSnapshot } from './catalog'
import { heldChangeLock, openChangeContext, type HeldChangeLock } from './context'

/** 'chng'. Fixed: changing it would let an old and a new instance both hold a project. */
const CHANGE_LOCK_NAMESPACE = 0x63686e67

const DEFAULT_WAIT_MS = 30_000

export class ChangeInProgressError extends Error {
  readonly code = 'CHANGE_IN_PROGRESS'
  constructor() {
    super('Another schema change is being applied to this project right now. Try again in a moment.')
    this.name = 'ChangeInProgressError'
  }
}

/** The database a project's change lock is decided in. */
export interface ChangeLockDatabase {
  region: CloudRegionId
  /** The project's own database; null for its region's own (shared) database. */
  database: string | null
}

/** Where this project's lock is decided now: the database holding its data. */
export async function changeLockDatabase(projectId: string): Promise<ChangeLockDatabase> {
  const placement = await projectDatabase(projectId)
  return { region: placement.region, database: placement.tenancy === 'dedicated' ? placement.database : null }
}

function databaseKey(target: ChangeLockDatabase): string {
  return `${target.region}:${target.database ?? 'control'}`
}

// ── Region databases: one pool per region, exactly as before ────────────────

const pools = new Map<CloudRegionId, Pool>()

/**
 * The pool on a region's own database. One per region, created on first use,
 * so the region's connection string is read when a change runs rather than
 * whenever this module happens to be imported; and checked on every call, so a
 * region whose connection goes away is refused rather than served from a pool
 * made earlier.
 */
function regionLockPool(region: CloudRegionId, projectId?: string): Pool {
  const url = requireRegionDatabaseUrl(region, 'app', { projectId })
  let pool = pools.get(region)
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 8 })
    // An idle client's error is emitted on the pool; unhandled, it ends the process.
    pool.on('error', (err) => console.error(`[ChangeLock] pool in ${region}:`, err.message))
    pools.set(region, pool)
  }
  return pool
}

// ── Projects' own databases: a bounded set of small pools ───────────────────

/** Connections per project database: one holding the lock, the others waiting for it or asking. */
const CHANGE_LOCK_POOL_MAX = 4
const CHANGE_LOCK_POOLS_MAX = 16
/** A pool handed out more recently than this is not closed to make room. */
const CHANGE_LOCK_POOL_MIN_IDLE_MS = 1_000

function capFromEnv(variable: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[variable] ?? '', 10)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback
}

const databasePools = new DatabaseRegistry<Pool>({
  max: capFromEnv('CHANGE_LOCK_POOLS_MAX', CHANGE_LOCK_POOLS_MAX),
  minIdleMs: CHANGE_LOCK_POOL_MIN_IDLE_MS,
  // Nothing checked out (a connection holding the lock is) and nobody waiting.
  idle: (pool) => pool.totalCount === pool.idleCount && pool.waitingCount === 0,
  close: (pool) => pool.end(),
  what: 'change lock pools on project databases',
})

/**
 * The connection string the lock is taken on in a project's own database: the
 * data instance's direct connection when one is set, else its application
 * connection, with the project's database. Read on every call, so a data
 * instance whose connection goes away is refused.
 */
function databaseLockUrl(region: CloudRegionId, database: string, projectId?: string): string {
  const instance = regionDataInstanceUrl(region, 'direct') ?? requireRegionDataInstanceUrl(region, 'app', { projectId })
  return withDatabase(instance, database)
}

function databaseLockPool(region: CloudRegionId, database: string, projectId?: string): Promise<Pool> {
  const url = databaseLockUrl(region, database, projectId)
  return whenRoom(
    () =>
      databasePools.get(`${region}/${database}`, () => {
        const pool = new Pool({ connectionString: url, max: CHANGE_LOCK_POOL_MAX })
        // An idle client's error is emitted on the pool; unhandled, it ends the process.
        pool.on('error', (err) => console.error(`[ChangeLock] pool on a project database in ${region}:`, err.message))
        return pool
      }),
    ROOM_WAIT_MS,
  )
}

/** The pool the lock is taken on for `target`. */
async function lockPoolOn(target: ChangeLockDatabase, projectId?: string): Promise<Pool> {
  if (target.database === null) return regionLockPool(target.region, projectId)
  return databaseLockPool(target.region, target.database, projectId)
}

/** The pool on the database holding this project's data. */
async function lockPool(projectId: string): Promise<Pool> {
  return lockPoolOn(await changeLockDatabase(projectId), projectId)
}

// ── Taking and giving back the lock ─────────────────────────────────────────

interface LockSession {
  client: PoolClient
  /** Unlock and return the connection; one that cannot be unlocked is discarded. */
  release(): Promise<void>
}

/**
 * Take the project's lock on a connection of `pool`, waiting up to `waitMs`.
 * The connection stays checked out until release.
 */
async function takeLock(pool: Pool, projectId: string, waitMs: number): Promise<LockSession> {
  const client = await pool.connect()
  const key = projectToLockKey(projectId)
  let broken = false
  // A checked-out client's error (its connection dropped, or the server ended
  // the session) is emitted on the client, not the pool, and unhandled it ends
  // the process. The statement in flight fails with it anyway; the session's
  // lock went with the session, and the connection is discarded on release.
  const lost = (err: Error) => {
    broken = true
    console.error(`[ChangeLock] connection for ${projectId} lost:`, err.message)
  }
  client.on('error', lost)
  const giveBack = () => {
    client.off('error', lost)
    client.release(broken)
  }
  try {
    await client.query(`SET lock_timeout = ${Math.max(1, Math.floor(waitMs))}`)
    try {
      await client.query('SELECT pg_advisory_lock($1::int4, $2::int4)', [CHANGE_LOCK_NAMESPACE, key])
    } catch (err: any) {
      // 55P03 lock_not_available: lock_timeout expired while waiting.
      if (err?.code === '55P03') throw new ChangeInProgressError()
      throw err
    } finally {
      await client.query('RESET lock_timeout').catch(() => { broken = true })
    }
  } catch (err) {
    giveBack()
    throw err
  }

  let released = false
  return {
    client,
    release: async () => {
      if (released) return
      released = true
      const res = await client
        .query<{ released: boolean }>('SELECT pg_advisory_unlock($1::int4, $2::int4) AS released', [CHANGE_LOCK_NAMESPACE, key])
        .catch(() => null)
      if (res?.rows[0]?.released !== true) {
        // Destroy the connection rather than return it to the pool still
        // holding the lock: a session-scoped lock is released when its
        // session ends, and nothing else would end it.
        broken = true
        console.error(`[ChangeLock] could not release the change lock for ${projectId}; discarding the connection`)
      }
      giveBack()
    },
  }
}

/**
 * Run `fn` holding the project's change lock, with the connection that holds it.
 * Statements run on that connection are inside the lock by construction, and
 * on the database holding the project's data.
 */
export async function withChangeLock<T>(
  projectId: string,
  fn: (client: PoolClient) => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<T> {
  // Re-entered only by the holder's own work (a recovery it starts runs on its
  // connection). Never once the lock is given back, and never from a change
  // whose own work is over, unless the lock was taken in that very context: a
  // timer or promise a finished change left running carries the context of the
  // lock that change's work held, and must wait for the lock like anyone else.
  const current = heldChangeLock.getStore()
  const inChange = openChangeContext.getStore()
  if (current && current.projectId === projectId && !current.released && (!inChange?.finished || inChange === current.openedIn)) {
    return fn(current.client)
  }

  const session = await takeLock(await lockPool(projectId), projectId, opts.waitMs ?? DEFAULT_WAIT_MS)
  const holding: HeldChangeLock = { projectId, client: session.client, released: false, openedIn: openChangeContext.getStore() }
  try {
    return await heldChangeLock.run(holding, () => fn(session.client))
  } finally {
    holding.released = true
    await session.release()
  }
}

/**
 * Run `fn` holding the project's change lock on every one of `databases` at
 * once, with the connection holding each, in the order given.
 *
 * For moving a project's data from one database to another: held on both the
 * database it leaves and the one it moves to, no process can start a change on
 * the project, whichever of the two it resolves the project to. Taken one
 * database after another in a fixed order (whatever order they are given in),
 * so two holders never wait on each other crosswise, and given back in reverse.
 * If any cannot be taken within `waitMs`, those already taken are given back
 * and CHANGE_IN_PROGRESS is thrown.
 *
 * Not re-entrant and not a governed change of its own: it is not called from
 * inside a change, and a change started inside `fn` would wait for the lock
 * like anyone else.
 */
export async function withChangeLockOn<T>(
  projectId: string,
  databases: ChangeLockDatabase[],
  fn: (clients: PoolClient[]) => Promise<T>,
  opts: { waitMs?: number } = {},
): Promise<T> {
  if (databases.length === 0) throw new Error('withChangeLockOn needs at least one database')
  const keys = databases.map(databaseKey)
  if (new Set(keys).size !== keys.length) throw new Error('withChangeLockOn was given the same database twice')
  const order = databases.map((target, index) => ({ target, index, key: keys[index] })).sort((a, b) => (a.key < b.key ? -1 : 1))

  const sessions: Array<{ index: number; session: LockSession }> = []
  try {
    for (const { target, index } of order) {
      sessions.push({ index, session: await takeLock(await lockPoolOn(target, projectId), projectId, opts.waitMs ?? DEFAULT_WAIT_MS) })
    }
    const clients: PoolClient[] = new Array(databases.length)
    for (const { index, session } of sessions) clients[index] = session.client
    return await fn(clients)
  } finally {
    for (const { session } of sessions.reverse()) await session.release()
  }
}

/**
 * Whether a governed change holds this project's change lock right now: an
 * agent's migration, a restore, or the automatic recovery of either, from its
 * checkpoint until it has settled. Read from pg_locks on the database holding
 * the lock, so asking takes no lock and never holds a change up.
 */
export async function changeLockHeld(projectId: string): Promise<boolean> {
  // pg_locks shows a two-key advisory lock's keys as oids: classid the first,
  // objid the second, objsubid 2.
  const res = await (await lockPool(projectId)).query(
    `SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND objsubid = 2
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = $1::oid AND objid = $2::oid
      LIMIT 1`,
    [String(CHANGE_LOCK_NAMESPACE >>> 0), String(projectToLockKey(projectId) >>> 0)],
  )
  return (res.rowCount ?? 0) > 0
}

/**
 * Close this process's lock pool on one project database, connections held or
 * not: for a database about to be dropped (lib/data-plane/project-databases.ts).
 */
export async function closeChangeLockPoolOn(region: CloudRegionId, database: string): Promise<void> {
  await databasePools.closeWhere((key) => key === `${region}/${database}`)
}

/** Close every region's pool and every project database's. Tests only. */
export async function closeChangeLockPool(): Promise<void> {
  const all = [...pools.values()]
  pools.clear()
  await Promise.all([...all.map((p) => p.end().catch(() => {})), databasePools.closeAll()])
}

/**
 * Read the catalog on `client` with search_path pinned to pg_catalog, inside a
 * read-only transaction, so every definition comes back schema-qualified.
 * Must not be called while `client` has a transaction open.
 */
export async function readCatalogOn(client: PoolClient, schema: string): Promise<CatalogSnapshot> {
  await client.query('BEGIN READ ONLY')
  try {
    await client.query('SET LOCAL search_path TO pg_catalog')
    const snapshot = await readCatalog(
      { query: async (sql, params) => (await client.query(sql, params as unknown[])).rows },
      schema,
    )
    await client.query('COMMIT')
    return snapshot
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  }
}
