/**
 * TWO INSTANCES CANNOT RUN ONE LADDER — PROVEN AGAINST A REAL POSTGRES
 * =====================================================================
 *
 * The guarantee is a property of the database, not of the code, so asserting it
 * against a mock would assert nothing. These tests hold the advisory lock on a
 * SEPARATE connection — which is what a second application instance is — and
 * check that the guard declines.
 *
 * Why this matters more than a missing feature: a ladder is a sequence of
 * schema mutations. Two of them interleaved on one table do not produce a slow
 * migration, they produce a half-expanded one. `add_structure` refuses when the
 * column already exists, so the loser of the race halts a ladder the winner is
 * midway through, and the project is left with a new column nothing fills and a
 * dual-write that was never installed, with nobody watching.
 */

import { Client } from 'pg'
import {
  withMaintenanceSingleFlight,
  projectToLockKey,
  closeMaintenanceLockPool,
} from '@/lib/autonomy/maintenance/single-flight'

/** Must match the namespace the module uses, or this test proves nothing. */
const NAMESPACE = 0x6d61696e

const PROJECT = 'single-flight-probe-project'
const KEY = projectToLockKey(PROJECT)

/** A second application instance, as far as Postgres is concerned. */
let other: Client

beforeAll(async () => {
  other = new Client({ connectionString: process.env.DATABASE_URL })
  await other.connect()
})

afterAll(async () => {
  // Release anything this test still holds before dropping the connection, so
  // a failure part-way through cannot stall the next run.
  await other.query('SELECT pg_advisory_unlock_all()').catch(() => {})
  await other.end().catch(() => {})
  // The guard's pool is long-lived by design; close it so the worker exits.
  await closeMaintenanceLockPool()
})

afterEach(async () => {
  await other.query('SELECT pg_advisory_unlock_all()').catch(() => {})
})

async function otherInstanceHoldsIt(): Promise<void> {
  const res = await other.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1::int4, $2::int4) AS acquired',
    [NAMESPACE, KEY],
  )
  expect(res.rows[0]?.acquired).toBe(true)
}

describe('the maintenance single flight is decided by Postgres', () => {
  it('runs the work when nobody else holds the project', async () => {
    // The inverse case first. Without it, every refusal below could be passing
    // because the guard refuses unconditionally.
    const flight = await withMaintenanceSingleFlight(PROJECT, async () => 'did the work')
    expect(flight).toEqual({ ran: true, value: 'did the work' })
  })

  it('declines when another instance already holds the project', async () => {
    await otherInstanceHoldsIt()

    let entered = false
    const flight = await withMaintenanceSingleFlight(PROJECT, async () => {
      entered = true
      return 'should not happen'
    })

    expect(flight.ran).toBe(false)
    // The important half: not merely that it reported contention, but that the
    // ladder body never executed.
    expect(entered).toBe(false)
  })

  it('releases the lock so the next tick can run', async () => {
    await withMaintenanceSingleFlight(PROJECT, async () => 'first')

    // If the release landed on a different pooled connection than the acquire,
    // the lock would still be held here and this would fail. That is the exact
    // pooling bug lib/ai/build-runtime/build-lock.ts documents.
    const res = await other.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::int4, $2::int4) AS acquired',
      [NAMESPACE, KEY],
    )
    expect(res.rows[0]?.acquired).toBe(true)
  })

  it('releases the lock even when the ladder throws', async () => {
    await expect(
      withMaintenanceSingleFlight(PROJECT, async () => {
        throw new Error('a rung blew up')
      }),
    ).rejects.toThrow('a rung blew up')

    // A ladder that throws must not wedge the project until the process
    // restarts, so the release is in a `finally`.
    const res = await other.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::int4, $2::int4) AS acquired',
      [NAMESPACE, KEY],
    )
    expect(res.rows[0]?.acquired).toBe(true)
  })

  it('lets a different project through while one is held', async () => {
    // The scheduler fans out across projects at concurrency 5. A global lock
    // would serialise the whole fleet behind one slow ladder.
    await otherInstanceHoldsIt()

    const flight = await withMaintenanceSingleFlight('a-completely-different-project', async () => 'ran')
    expect(flight).toEqual({ ran: true, value: 'ran' })
  })

  it('does not collide with the build lock keyspace', async () => {
    // The build lock hashes a projectId into the SINGLE-bigint keyspace. This
    // guard uses the two-int4 overload under its own namespace, so a project
    // being built and the same project being swept must not block each other
    // by accident — and `pg_locks` must be able to tell them apart.
    const asBuildLock = await other.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [KEY],
    )
    expect(asBuildLock.rows[0]?.acquired).toBe(true)

    const flight = await withMaintenanceSingleFlight(PROJECT, async () => 'ran anyway')
    expect(flight).toEqual({ ran: true, value: 'ran anyway' })
  })
})
