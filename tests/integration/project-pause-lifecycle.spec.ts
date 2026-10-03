/**
 * PAUSING AND RESUMING A PROJECT, AGAINST A REAL DATABASE
 * =======================================================
 *
 * The public half of the inactivity pause: the lifecycle lock, the race-safe
 * transitions, what a pause does to undelivered webhooks, and what it stops in
 * the background. The private half (who gets paused, whether resuming is free)
 * is Backenly Cloud's and is tested in the overlay.
 *
 * Real PostgreSQL throughout. The properties here are about what the database
 * does under a conditional write, a transaction-scoped advisory lock and a
 * relation filter, which a mock would only restate.
 */
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import {
  LifecycleBusyError,
  afterPauseCommitted,
  afterResumeCommitted,
  applyPauseTransition,
  applyResumeTransition,
  withProjectLifecycleLock,
} from '@/lib/projects/pause-lifecycle'
import { OUTBOX_TABLE, syncWebhookCapture } from '@/lib/webhooks/capture'
import { claimNextJobs } from '@/lib/queue'
import { runMutation } from '@/lib/ai/build-runtime/mutate'
import { invalidateProjectServingState } from '@/lib/projects/serving-state'

const SYSTEM = { kind: 'system', label: 'pause-lifecycle-spec' } as const
let ownerId: string
const schemas: string[] = []

async function project(data: Record<string, unknown> = {}): Promise<string> {
  const p = await prisma.project.create({
    data: { name: `pause-${crypto.randomBytes(4).toString('hex')}`, userId: ownerId, ...data },
    select: { id: true },
  })
  return p.id
}

async function row(id: string) {
  return prisma.project.findUniqueOrThrow({
    where: { id },
    select: { pausedAt: true, pauseReason: true, pauseWarnedAt: true, lastActivityAt: true },
  })
}

/** The whole pause as Cloud's sweep performs it, minus the private policy check. */
async function pause(id: string, observedLastActivityAt: Date | null) {
  const result = await withProjectLifecycleLock(id, tx =>
    applyPauseTransition(tx, id, { observedLastActivityAt, reason: 'inactivity' }),
  )
  if (result.paused) {
    return {
      ...result,
      after: await afterPauseCommitted(id, {
        reason: 'inactivity',
        actor: SYSTEM,
        cancelledDeliveries: result.cancelledDeliveries,
      }),
    }
  }
  return { ...result, after: null }
}

beforeAll(async () => {
  const owner = await prisma.user.create({
    data: { email: `pause-${crypto.randomBytes(6).toString('hex')}@example.test` },
    select: { id: true },
  })
  ownerId = owner.id
}, 120_000)

afterAll(async () => {
  for (const s of schemas) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
  }
  // Project.user cascades, which takes projects, webhooks, logs and audits with it.
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe('the lifecycle lock', () => {
  it('refuses a second holder rather than waiting behind the first', async () => {
    const id = await project()
    let release!: () => void
    let taken!: () => void
    const isTaken = new Promise<void>(r => (taken = r))

    const first = withProjectLifecycleLock(id, async () => {
      taken()
      await new Promise<void>(r => (release = r))
    })
    await isTaken

    await expect(withProjectLifecycleLock(id, async () => 'second')).rejects.toBeInstanceOf(
      LifecycleBusyError,
    )

    release()
    await first
    // Transaction-scoped: gone with the transaction, nothing to release by hand.
    await expect(withProjectLifecycleLock(id, async () => 'after')).resolves.toBe('after')
  }, 60_000)

  it('does not serialise different projects against each other', async () => {
    const a = await project()
    const b = await project()
    let release!: () => void
    let taken!: () => void
    const isTaken = new Promise<void>(r => (taken = r))

    const holdingA = withProjectLifecycleLock(a, async () => {
      taken()
      await new Promise<void>(r => (release = r))
    })
    await isTaken
    await expect(withProjectLifecycleLock(b, async () => 'b')).resolves.toBe('b')
    release()
    await holdingA
  }, 60_000)
})

describe('pausing', () => {
  it('pauses a project whose activity has not moved since the decision', async () => {
    const seen = new Date('2026-09-01T10:00:00.000Z')
    const id = await project({ lastActivityAt: seen })

    const result = await pause(id, seen)

    expect(result.paused).toBe(true)
    const after = await row(id)
    expect(after.pausedAt).toBeInstanceOf(Date)
    expect(after.pauseReason).toBe('inactivity')
  }, 60_000)

  it('does NOT pause a project that was used while the snapshot ran', async () => {
    // The race the conditional write exists for: decided idle, then real use
    // lands before the commit. The stale decision must lose.
    const seen = new Date('2026-09-01T10:00:00.000Z')
    const id = await project({ lastActivityAt: seen })
    await prisma.project.update({ where: { id }, data: { lastActivityAt: new Date() } })

    const result = await pause(id, seen)

    expect(result.paused).toBe(false)
    expect((await row(id)).pausedAt).toBeNull()
  }, 60_000)

  it('treats a first-ever use as activity when the decision saw none', async () => {
    const id = await project({ lastActivityAt: null })
    await prisma.project.update({ where: { id }, data: { lastActivityAt: new Date() } })

    expect((await pause(id, null)).paused).toBe(false)
  }, 60_000)

  it('pauses a never-used project when it is still never-used', async () => {
    const id = await project({ lastActivityAt: null })
    expect((await pause(id, null)).paused).toBe(true)
  }, 60_000)

  it.each([
    ['deleted', { deletedAt: new Date() }],
    ['locked down', { lockedDownAt: new Date() }],
    ['already paused', { pausedAt: new Date('2026-09-02T00:00:00Z'), pauseReason: 'inactivity' }],
  ])('leaves a %s project alone', async (_label, data) => {
    const id = await project({ lastActivityAt: null, ...data })
    const before = await row(id)

    expect((await pause(id, null)).paused).toBe(false)
    expect((await row(id)).pausedAt).toEqual(before.pausedAt)
  }, 60_000)

  it('refuses an undefined observation instead of silently dropping the guard', async () => {
    const id = await project()
    await expect(
      withProjectLifecycleLock(id, tx =>
        applyPauseTransition(tx, id, { observedLastActivityAt: undefined as any, reason: 'inactivity' }),
      ),
    ).rejects.toThrow(/observedLastActivityAt is required/)
    expect((await row(id)).pausedAt).toBeNull()
  }, 60_000)
})

describe('what a pause does to undelivered webhooks', () => {
  it('cancels pending and retrying deliveries, and leaves finished ones alone', async () => {
    const id = await project({ lastActivityAt: null })
    const hook = await prisma.webhook.create({
      data: { projectId: id, eventType: 'row.inserted', targetUrl: 'https://receiver.example.test/h', secret: 's' },
    })
    const log = (status: 'PENDING' | 'RETRYING' | 'SUCCESS' | 'DEAD_LETTER') =>
      prisma.webhookLog.create({
        data: {
          webhookId: hook.id,
          eventType: 'row.inserted',
          payload: {},
          signature: 'sig',
          status,
          nextRetryAt: status === 'RETRYING' ? new Date(Date.now() - 1000) : null,
        },
      })
    const [pending, retrying, success, dead] = await Promise.all([
      log('PENDING'), log('RETRYING'), log('SUCCESS'), log('DEAD_LETTER'),
    ])

    const result = await pause(id, null)
    expect(result.paused).toBe(true)
    expect(result.cancelledDeliveries).toBe(2)

    const byId = async (logId: string) =>
      prisma.webhookLog.findUniqueOrThrow({ where: { id: logId }, select: { status: true, error: true, nextRetryAt: true } })

    for (const cancelled of [pending, retrying]) {
      expect(await byId(cancelled.id)).toEqual({ status: 'CANCELLED', error: 'project_paused', nextRetryAt: null })
    }
    expect((await byId(success.id)).status).toBe('SUCCESS')
    expect((await byId(dead.id)).status).toBe('DEAD_LETTER')
  }, 60_000)

  it('discards captured events that never became deliveries, and says how many', async () => {
    const id = await project({ lastActivityAt: null })
    const schema = `workspace_${id}`
    schemas.push(schema)
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${schema}"."orders" (id serial PRIMARY KEY, label text NOT NULL)`,
    )
    await prisma.webhook.create({
      data: { projectId: id, eventType: 'row.inserted', targetUrl: 'https://receiver.example.test/h', secret: 's' },
    })
    await syncWebhookCapture(id)
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}"."orders" (label) VALUES ('a'), ('b'), ('c')`)

    const count = async () =>
      Number(
        ((await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${schema}"."${OUTBOX_TABLE}"`)) as Array<{ n: number }>)[0].n,
      )
    expect(await count()).toBe(3)

    const result = await pause(id, null)

    expect(result.after?.discardedOutboxEvents).toBe(3)
    expect(await count()).toBe(0)

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { projectId: id, action: 'PROJECT_PAUSED' },
      select: { metadata: true, userId: true },
    })
    expect(audit.userId).toBeNull()
    expect(audit.metadata).toMatchObject({
      reason: 'inactivity',
      discardedOutboxEvents: 3,
      cancelledDeliveries: 0,
      actor: 'system:pause-lifecycle-spec',
    })
  }, 60_000)

  it('reports zero, not an error, for a project that never captured anything', async () => {
    const id = await project({ lastActivityAt: null })
    const schema = `workspace_${id}`
    schemas.push(schema)
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)

    const result = await pause(id, null)
    expect(result.after?.discardedOutboxEvents).toBe(0)
  }, 60_000)
})

describe('resuming', () => {
  it('clears the pause and restarts the inactivity clock', async () => {
    const id = await project({
      pausedAt: new Date('2026-09-02T00:00:00Z'),
      pauseReason: 'inactivity',
      pauseWarnedAt: new Date('2026-08-30T00:00:00Z'),
      lastActivityAt: new Date('2026-08-01T00:00:00Z'),
    })
    const before = Date.now()

    const result = await withProjectLifecycleLock(id, tx => applyResumeTransition(tx, id))
    await afterResumeCommitted(id, { kind: 'user', userId: ownerId })

    expect(result.resumed).toBe(true)
    const after = await row(id)
    expect(after.pausedAt).toBeNull()
    expect(after.pauseReason).toBeNull()
    expect(after.pauseWarnedAt).toBeNull()
    expect(after.lastActivityAt!.getTime()).toBeGreaterThanOrEqual(before - 1000)

    const audit = await prisma.auditLog.findFirst({ where: { projectId: id, action: 'PROJECT_RESUMED' } })
    expect(audit?.userId).toBe(ownerId)
  }, 60_000)

  it('is idempotent: a second resume matches nothing and changes nothing', async () => {
    const id = await project({ pausedAt: new Date(), pauseReason: 'inactivity' })

    const first = await withProjectLifecycleLock(id, tx => applyResumeTransition(tx, id))
    const clock = (await row(id)).lastActivityAt
    const second = await withProjectLifecycleLock(id, tx => applyResumeTransition(tx, id))

    expect(first.resumed).toBe(true)
    expect(second.resumed).toBe(false)
    expect((await row(id)).lastActivityAt).toEqual(clock)
  }, 60_000)
})

describe('what a pause stops', () => {
  it('leaves a paused project’s jobs queued and unspent, and still runs everything else', async () => {
    const paused = await project({ pausedAt: new Date(), pauseReason: 'inactivity' })
    const live = await project()
    // Older than anything else in the queue, so claimNextJobs reaches these first.
    const runAt = new Date('2001-01-01T00:00:00Z')
    const job = (type: string, projectId: string | null) =>
      prisma.backgroundJob.create({ data: { type, status: 'queued', payload: {}, runAt, projectId } })

    const pausedEmail = await job('email', paused)
    const pausedCleanup = await job('cleanup', paused)
    const liveEmail = await job('email', live)
    const systemJob = await job('cleanup', null)
    const ours = [pausedEmail.id, pausedCleanup.id, liveEmail.id, systemJob.id]

    try {
      const claimed = (await claimNextJobs(10)).map(j => j.id).filter(i => ours.includes(i))

      expect(claimed).toEqual(expect.arrayContaining([pausedCleanup.id, liveEmail.id, systemJob.id]))
      expect(claimed).not.toContain(pausedEmail.id)

      const untouched = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: pausedEmail.id } })
      expect(untouched.status).toBe('queued')
      expect(untouched.attempts).toBe(0)
    } finally {
      await prisma.backgroundJob.deleteMany({ where: { id: { in: ours } } })
    }
  }, 60_000)

  it('refuses a governed mutation before it runs', async () => {
    const id = await project({ pausedAt: new Date(), pauseReason: 'inactivity' })
    invalidateProjectServingState(id)
    const fn = jest.fn(async () => 'ran')

    const result = await runMutation({ projectId: id, kind: 'modify', action: 'spec_probe' }, fn)

    expect(result).toMatchObject({ ok: false, paused: true })
    expect(fn).not.toHaveBeenCalled()
  }, 60_000)
})
