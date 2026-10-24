/**
 * The project change lock is re-entered only by the work of the change holding
 * it (lib/changes/lock.ts): never once it has been given back, and never from a
 * change whose own work is over, unless the lock was taken there.
 *
 * Work a change leaves running (a timer, an unawaited promise) carries its
 * async context. It used to re-enter the lock on the change's connection after
 * that connection had been unlocked and returned to the pool, so it ran holding
 * no lock: nothing serialised it against the next change on the project, and
 * the pool could hand the same session to another change at the same time.
 *
 * Real PostgreSQL: the lock is a session advisory lock, read from pg_locks.
 */
import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { closeChangeLockPool, withChangeLock } from '@/lib/changes/lock'
import { openChangeContext } from '@/lib/changes/context'

let ownerId: string
let projectId: string
let schema: string
const originalEngineMode = process.env.ENGINE_MODE
const originalEdition = process.env.BACKENLY_EDITION

/** Whether the session on `client` holds an advisory lock right now. */
async function holdsAdvisoryLock(client: PoolClient): Promise<boolean> {
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`)
  return r.rows[0].n > 0
}

beforeAll(async () => {
  // A project of its own, as Backenly Cloud provisions one (a self-hosted
  // deployment is one project and refuses a second).
  process.env.ENGINE_MODE = 'runtime'
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({
    data: { email: `change-lock-${crypto.randomUUID()}@example.test`, password: 'test-only-hash', name: 'change lock after its change' },
  })).id
  const project = await createProvisionedProject({ name: 'change-lock-after-its-change', userId: ownerId })
  projectId = project.id
  schema = project.postgresSchema
}, 120_000)

afterAll(async () => {
  await closeChangeLockPool()
  if (schema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } })
    await prisma.user.delete({ where: { id: ownerId } })
  }
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
}, 60_000)

describe('the change lock, after the change that held it', () => {
  it("is re-entered by the holder's own work, on its connection", async () => {
    await withChangeLock(projectId, async (outer) => {
      await withChangeLock(projectId, async (inner) => {
        expect(inner).toBe(outer)
        expect(await holdsAdvisoryLock(inner)).toBe(true)
      })
    })
  })

  it('is never re-entered once given back: leftover work takes the lock itself', async () => {
    let late: Promise<boolean> | undefined
    await withChangeLock(projectId, async () => {
      // A plain timer: it carries the holder's async context past its release.
      late = new Promise((resolve, reject) => setTimeout(() => {
        withChangeLock(projectId, async (c) => resolve(await holdsAdvisoryLock(c))).catch(reject)
      }, 50))
    })
    // Re-entering the given-back lock would run on a session that no longer
    // holds it. (The pool may hand back the same client object; the lock is
    // what tells them apart.)
    expect(await late!).toBe(true)
  })

  it('leftover work of a finished change waits for the lock instead of joining it', async () => {
    const order: string[] = []
    let late: Promise<void> | undefined
    await withChangeLock(projectId, async () => {
      const change = { projectId, finished: false }
      openChangeContext.run(change, () => {
        late = new Promise((resolve, reject) => setTimeout(() => {
          withChangeLock(projectId, async () => { order.push('leftover work') }).then(() => resolve(), reject)
        }, 10))
      })
      // As the ledger marks it when the change's own work returns, while it still
      // holds the lock to read the catalog after it (lib/changes/ledger.ts).
      change.finished = true
      await new Promise((r) => setTimeout(r, 300))
      order.push('the holder is done')
    })
    await late
    expect(order).toEqual(['the holder is done', 'leftover work'])
  })

  it('a lock taken by leftover work of a finished change is re-entered by its own work', async () => {
    // Leftover work of a finished change opens a change of its own; when that
    // change recovers automatically, its recovery re-enters the lock it took.
    // It must not wait for itself (30 s, then CHANGE_IN_PROGRESS).
    const finished = { projectId, finished: true }
    await openChangeContext.run(finished, () => withChangeLock(projectId, async (outer) => {
      const startedAt = Date.now()
      await withChangeLock(projectId, async (inner) => {
        expect(inner).toBe(outer)
        expect(await holdsAdvisoryLock(inner)).toBe(true)
      })
      expect(Date.now() - startedAt).toBeLessThan(5_000)
    }))
  }, 60_000)
})
