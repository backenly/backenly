/**
 * RESTARTS, AND WHAT MUST STILL BE TRUE AFTERWARDS
 * ===============================================
 *
 * The question is not whether a process comes back. It is whether the invariants
 * come back with it: a pool recovers without the application being restarted,
 * durable work resumes exactly once, and a security control that depends on a
 * backing store behaves according to that store's real contract rather than an
 * assumed one.
 *
 * ── What is real here, and what is CI's job ─────────────────────────────────
 *
 * Redis is genuinely stopped and started: `redis-cli shutdown` then
 * `redis-server`. That is a real process restart, and it is what the limiter
 * tests below exercise.
 *
 * PostgreSQL is interrupted at the TRANSPORT, through a proxy this suite opens
 * and closes, rather than by stopping the server. Two reasons, and the second is
 * the important one:
 *
 *   - the only PostgreSQL on a developer's machine is the one their work depends
 *     on, and a suite that stops it to prove a point is a worse bug than the one
 *     it is testing;
 *   - what the pool experiences is identical either way. Its sockets die, its
 *     checked-out clients error, and it must re-establish. A restarted server and
 *     a severed connection are the same event from inside the pool.
 *
 * What a proxy CANNOT show is the server losing its own state — so
 * `docker compose restart postgres`, the whole stack coming back from persisted
 * state, and the invariants that need a running deployment (operator login,
 * /db/*, PostgREST serving, storage bytes) belong to the self-host CI job, where
 * a real installed deployment exists. This file does not pretend to cover them.
 *
 * ── Durable work is the other half ──────────────────────────────────────────
 *
 * A restart must not lose an item that was pending, and must not re-deliver one
 * that was already acknowledged. The webhook outbox is the durable queue in this
 * product, so that is what is put into a pending state and drained across a
 * simulated process boundary.
 */

import crypto from 'crypto'
import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'

import { RedisRateLimitBackend, createRateLimitRedis } from '@/lib/security/rate-limit-backend'
import { redisProcessControl, waitForRedis } from '../helpers/redis-process'
import { severableProxy, throughProxy } from '../helpers/severable-proxy'

const REDIS_URL = process.env.REDIS_URL?.trim()
const prisma = new PrismaClient()

describe('a connection pool survives losing PostgreSQL under it', () => {
  it('recovers without the application being restarted', async () => {
    const target = new URL(process.env.TEST_DATABASE_URL!)
    const proxy = await severableProxy(target.hostname, Number(target.port || 5432))

    const pool = new Pool({
      connectionString: throughProxy(process.env.TEST_DATABASE_URL!, proxy.port),
      max: 3,
    })
    // A pooled client whose server went away emits this. Unhandled, it takes the
    // process down, which is itself a restart-survival property.
    pool.on('error', () => {})

    try {
      // CONTROL: established and serving, so the failure below is the outage.
      expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1)

      await proxy.sever()
      await expect(pool.query('SELECT 1')).rejects.toBeTruthy()

      await proxy.restore()

      // The claim: the SAME pool, in the SAME process, serves again. No restart
      // of the application and no new pool object.
      const deadline = Date.now() + 30_000
      let recovered = false
      let lastError = ''
      while (Date.now() < deadline) {
        try {
          if ((await pool.query('SELECT 1 AS ok')).rows[0].ok === 1) {
            recovered = true
            break
          }
        } catch (err: any) {
          lastError = String(err?.message ?? err)
          await new Promise(r => setTimeout(r, 200))
        }
      }
      if (!recovered) {
        throw new Error(`the pool never recovered after the database returned; last error: ${lastError}`)
      }
    } finally {
      await pool.end().catch(() => {})
      await proxy.close()
    }
  }, 180_000)
})

describe('durable work across a restart', () => {
  let ownerId: string
  let projectId: string
  let schema: string

  beforeAll(async () => {
    const owner = await prisma.user.create({
      data: {
        email: `restart-${crypto.randomBytes(5).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Restart Suite',
      },
      select: { id: true },
    })
    ownerId = owner.id
    projectId = (
      await prisma.project.create({ data: { name: 'restart', userId: ownerId }, select: { id: true } })
    ).id
    schema = `workspace_${projectId}`
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  }, 180_000)

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await prisma.webhook.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
    await prisma.$disconnect()
  }, 180_000)

  it('keeps a pending outbox item, and does not re-deliver an acknowledged one', async () => {
    const { syncWebhookCapture, drainWebhookOutbox, OUTBOX_TABLE } = await import('@/lib/webhooks/capture')

    // A webhook whose destination is refused, so delivery never succeeds and the
    // item's fate is decided entirely by the durable queue rather than by luck.
    await prisma.webhook.create({
      data: {
        projectId,
        eventType: 'row.inserted',
        targetUrl: 'https://example.com/restart-hook',
        secret: crypto.randomBytes(32).toString('hex'),
      },
    })
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${schema}".items (id serial PRIMARY KEY, label text)`,
    )
    await syncWebhookCapture(projectId)

    // The work that exists at the moment of the restart.
    await prisma.$executeRawUnsafe(`INSERT INTO "${schema}".items (label) VALUES ('before-restart')`)

    const pending = (await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "${schema}"."${OUTBOX_TABLE}" WHERE claimed_at IS NULL`,
    )) as Array<{ n: number }>
    expect(pending[0].n).toBe(1)

    // ── The restart ──────────────────────────────────────────────────────────
    //
    // The outbox lives in PostgreSQL, so a process restart is the loss of
    // in-memory state and nothing else. jest.resetModules gives the drain a
    // fresh module registry, which is the part of a restart that could plausibly
    // lose the item.
    jest.resetModules()
    const afterRestart = await import('@/lib/webhooks/capture')

    const drained = await afterRestart.drainWebhookOutbox()
    expect(drained).toBeGreaterThanOrEqual(1)

    // The item survived the restart and became a delivery attempt: a WebhookLog
    // row exists for it. Lost work would leave none.
    const logs = await prisma.webhookLog.findMany({ where: { webhook: { projectId } } })
    expect(logs.length).toBe(1)

    // And the outbox row is gone, so a second drain cannot re-deliver it. This
    // is the other half: at-least-once must not become at-least-twice merely
    // because a process restarted.
    const remaining = (await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "${schema}"."${OUTBOX_TABLE}"`,
    )) as Array<{ n: number }>
    expect(remaining[0].n).toBe(0)

    jest.resetModules()
    const again = await import('@/lib/webhooks/capture')
    expect(await again.drainWebhookOutbox()).toBe(0)
    expect(await prisma.webhookLog.count({ where: { webhook: { projectId } } })).toBe(1)
  }, 300_000)
})

describe('the auth limiter across a REAL Redis restart', () => {
  if (!REDIS_URL) {
    it('cannot be tested without REDIS_URL', () => {
      // Stated, not skipped. A green tick over an untested limiter is the
      // reporting this programme keeps replacing.
      throw new Error(
        'REDIS_URL is not set, so the limiter-across-restart claims are unproven in this run',
      )
    })
    return
  }

  // Stopping and starting the REAL server. How that is done depends on where
  // this runs, which is why it is a helper rather than one hard-coded path: the
  // first version knew only about WSL, passed here, and failed in CI with
  // `spawnSync wsl.exe ENOENT`.
  const redis = redisProcessControl(REDIS_URL!)
  // eslint-disable-next-line no-console
  console.log(`[restart] controlling Redis via ${redis.kind}`)

  const waitFor = (up: boolean, timeoutMs = 60_000) => waitForRedis(REDIS_URL!, up, timeoutMs)
  const stopRedis = () => redis.stop()
  const startRedis = () => redis.start()

  afterAll(async () => {
    // Leaving Redis down would fail every later suite for a reason that has
    // nothing to do with what they test.
    if (!(await waitFor(true, 1_000))) {
      startRedis()
      await waitFor(true)
    }
  }, 120_000)

  it('fails closed as an OUTAGE while Redis is down, then recovers on its own', async () => {
    const client = createRateLimitRedis(REDIS_URL!)
    const limiter = new RedisRateLimitBackend(client, 1_000)
    const key = `test:restart:${crypto.randomBytes(5).toString('hex')}`

    try {
      // CONTROL: working before the restart.
      expect((await limiter.consume(key, 5, 60_000)).outcome).toBe('allowed')
      expect(limiter.health().ready).toBe(true)

      stopRedis()
      expect(await waitFor(false)).toBe(true)

      const during = await limiter.consume(key, 5, 60_000)
      expect(during.allowed).toBe(false)
      // An OUTAGE, not a limit. Telling a caller "too many attempts" while the
      // limiter cannot count accuses them of something they did not do, and
      // buries an outage in a metric operators read as abuse.
      expect(during.outcome).toBe('store_unavailable')
      expect(limiter.health().ready).toBe(false)

      startRedis()
      expect(await waitFor(true)).toBe(true)

      // Recovery with no restart of this process and no new client.
      const deadline = Date.now() + 30_000
      let after = during
      while (Date.now() < deadline) {
        after = await limiter.consume(key, 5, 60_000)
        if (after.outcome === 'allowed') break
        await new Promise(r => setTimeout(r, 250))
      }
      if (after.outcome !== 'allowed') {
        throw new Error(
          `the limiter never recovered after Redis returned; last outcome ${after.outcome}, ` +
            `health ${JSON.stringify(limiter.health())}`,
        )
      }
      expect(limiter.health().ready).toBe(true)
    } finally {
      client.disconnect()
    }
  }, 300_000)

  it('matches the durability contract Redis actually has, rather than an assumed one', async () => {
    const client = createRateLimitRedis(REDIS_URL!)
    const limiter = new RedisRateLimitBackend(client, 1_000)
    const key = `test:durability:${crypto.randomBytes(5).toString('hex')}`

    try {
      for (let i = 0; i < 3; i++) {
        expect((await limiter.consume(key, 5, 600_000)).outcome).toBe('allowed')
      }

      stopRedis()
      await waitFor(false)
      startRedis()
      await waitFor(true)

      const deadline = Date.now() + 30_000
      let next = await limiter.consume(key, 5, 600_000)
      while (Date.now() < deadline && next.outcome === 'store_unavailable') {
        await new Promise(r => setTimeout(r, 250))
        next = await limiter.consume(key, 5, 600_000)
      }
      expect(next.outcome).toBe('allowed')

      // Both readings are correct BEHAVIOUR; which applies is a property of the
      // Redis deployment, not of Backenly:
      //
      //   counter survived -> this is the 4th of 5, so 1 remains
      //   counter reset    -> this is the 1st of 5, so 4 remain
      //
      // Asserting one would make this a statement about a Redis configuration
      // this repository does not control. Asserting it is one of the two, and
      // reporting which, keeps it honest.
      const survived = next.remaining === 1
      const reset = next.remaining === 4
      if (!survived && !reset) {
        throw new Error(
          `after a Redis restart the limiter reported ${next.remaining} remaining, which is ` +
            `neither "counter survived" (1) nor "counter reset" (4)`,
        )
      }
      // eslint-disable-next-line no-console
      console.log(
        `[restart] Redis durability observed: the counter ${survived ? 'SURVIVED' : 'RESET'} ` +
          `across a restart (remaining=${next.remaining})`,
      )

      // Whichever happened, the limiter still ENFORCES from where it resumed. A
      // restart must not leave it permanently allowing.
      let denied = false
      for (let i = 0; i < 6; i++) {
        if ((await limiter.consume(key, 5, 600_000)).outcome === 'limit_exceeded') {
          denied = true
          break
        }
      }
      expect(denied).toBe(true)
    } finally {
      client.disconnect()
    }
  }, 300_000)
})
