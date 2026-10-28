/**
 * The repair loop waits for a change on the project to settle
 * (lib/autonomy/reconciler.ts, lib/changes/lock.ts).
 *
 * A governed change holds the project's change lock from its checkpoint until
 * it has settled, its automatic recovery included. A loop pass that read the
 * project in between saw that change's half-done state as drift: a table a
 * failing migration had created looked like a shadow mutation, and the repair
 * wrote generated endpoints for it while the recovery was removing the table,
 * leaving them behind for a table that no longer existed.
 *
 * Real PostgreSQL: the lock is a session advisory lock, read from pg_locks.
 */
import crypto from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { changeLockHeld, closeChangeLockPool, withChangeLock } from '@/lib/changes/lock'
import { outsideAnyChange } from '@/lib/changes/context'
import { runReconciler } from '@/lib/autonomy/reconciler'

let ownerId: string
const projects: Array<{ id: string; schema: string }> = []
const saved = {
  engine: process.env.ENGINE_MODE,
  edition: process.env.BACKENLY_EDITION,
  loop: process.env.ENABLE_AUTONOMY_RECONCILER,
  live: process.env.ENABLE_AUTONOMY_LIVE_EXECUTION,
}
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
const ticks = (projectId: string) => prisma.auditLog.count({ where: { projectId, action: 'AUTONOMY_TICK' } })

beforeAll(async () => {
  // Projects of their own, as Backenly Cloud provisions them (a self-hosted
  // deployment is one project and refuses a second). The loop is on, and only
  // observes: with live execution off, a pass that runs records and repairs nothing.
  process.env.ENGINE_MODE = 'runtime'
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENABLE_AUTONOMY_RECONCILER = 'true'
  delete process.env.ENABLE_AUTONOMY_LIVE_EXECUTION
  ownerId = (await prisma.user.create({
    data: { email: `loop-settled-${crypto.randomUUID()}@example.test`, password: 'test-only-hash', name: 'loop waits for a settled change' },
  })).id
  for (const name of ['loop-waits-a', 'loop-waits-b']) {
    const project = await createProvisionedProject({ name, userId: ownerId })
    projects.push({ id: project.id, schema: project.postgresSchema })
    // Something built, so the loop watches the project (lib/projects/backend-presence.ts).
    await prisma.table.create({ data: { name: 'notes', projectId: project.id } })
  }
}, 180_000)

afterAll(async () => {
  await closeChangeLockPool()
  for (const p of projects) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${p.schema}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  restore('ENGINE_MODE', saved.engine)
  restore('BACKENLY_EDITION', saved.edition)
  restore('ENABLE_AUTONOMY_RECONCILER', saved.loop)
  restore('ENABLE_AUTONOMY_LIVE_EXECUTION', saved.live)
}, 60_000)

describe('whether a change holds the project\'s lock', () => {
  it('reads it from pg_locks: free, held while a change holds it, free again after', async () => {
    const [a] = projects
    expect(await changeLockHeld(a.id)).toBe(false)
    await withChangeLock(a.id, async () => {
      // Asked as anyone else asks: from outside the holder's own context.
      expect(await outsideAnyChange(() => changeLockHeld(a.id))).toBe(true)
    })
    expect(await changeLockHeld(a.id)).toBe(false)
  })

  it('another project\'s change does not count', async () => {
    const [a, b] = projects
    await withChangeLock(b.id, async () => {
      expect(await outsideAnyChange(() => changeLockHeld(a.id))).toBe(false)
      expect(await outsideAnyChange(() => changeLockHeld(b.id))).toBe(true)
    })
  })
})

describe('the loop and a change in progress', () => {
  it('skips the project while a change holds its lock, without counting a pass', async () => {
    const [a] = projects
    const before = await ticks(a.id)
    await withChangeLock(a.id, async () => {
      expect(await runReconciler(a.id)).toBeNull()
    })
    expect(await ticks(a.id)).toBe(before)
  })

  it('runs once the change has settled', async () => {
    const [a] = projects
    const before = await ticks(a.id)
    await runReconciler(a.id)
    expect(await ticks(a.id)).toBe(before + 1)
  }, 60_000)
})
