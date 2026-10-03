/**
 * A REDIS OUTAGE IS AN AUTH-ABUSE-CONTROL OUTAGE, NOT A BACKENLY OUTAGE
 * ====================================================================
 *
 * rate-limit-shared-store.spec.ts already proves what the LIMITER does when its
 * store is unreachable: it denies, it reports `store_unavailable` rather than a
 * limit, it does not switch stores, and it recovers on its own. Those are
 * claims about one component, and they are not repeated here.
 *
 * This file asks the question that only makes sense one level up: how far does
 * the damage spread. A deployment where losing Redis also loses storage, or the
 * database, or every read path, has turned a defence-in-depth component into a
 * single point of failure — and it would pass every existing limiter test while
 * doing so, because none of them ever look outside the limiter.
 *
 * ── Why the server is genuinely stopped ─────────────────────────────────────
 *
 * The existing suite reaches an outage through a port nothing listens on and
 * through a severable proxy. Both are sound, and neither can show what happens
 * when the SERVER goes away and comes back: a proxy's upstream keeps its state,
 * so a counter observed after "recovery" may have survived for a reason the
 * product does not control. Here `redis-server` is stopped and started, so the
 * post-recovery shared-counter claim is made against a store that genuinely
 * restarted. See tests/helpers/redis-process.ts.
 */

import crypto from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PrismaClient } from '@prisma/client'

import { RedisRateLimitBackend, createRateLimitRedis } from '@/lib/security/rate-limit-backend'
import { throttleDecision } from '@/lib/security/rate-limit-response'
import { redisProcessControl, waitForRedis } from '../helpers/redis-process'

// Set before the storage singleton is imported. See dependency-failure-storage.
const ROOT = mkdtempSync(join(tmpdir(), 'redis-outage-storage-'))
process.env.STORAGE_DRIVER = 'local'
process.env.STORAGE_DIR = ROOT
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || 'redis-outage-suite-secret'

const REDIS_URL = process.env.REDIS_URL?.trim()
const prisma = new PrismaClient()

type DownloadHandler = (
  request: unknown,
  ctx: { params: Promise<{ fileId: string }> },
) => Promise<any>

let download: DownloadHandler
let storageService: (typeof import('@/lib/services/storage'))['storageService']

let ownerId: string
let projectId: string
let bucketId: string

function request() {
  return {
    nextUrl: { searchParams: new URLSearchParams() },
    headers: { get: () => null },
    cookies: { get: () => undefined },
  } as any
}

async function readBody(res: any): Promise<Buffer> {
  if (typeof res.arrayBuffer === 'function') return Buffer.from(await res.arrayBuffer())
  const body = res.body
  if (body == null) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  return Buffer.from(String(body), 'utf8')
}

describe('while Redis is genuinely stopped', () => {
  if (!REDIS_URL) {
    it('cannot be tested without REDIS_URL', () => {
      // Stated, not skipped. A tick beside an unproven blast-radius claim is
      // exactly the reporting this programme exists to remove.
      throw new Error('REDIS_URL is not set, so none of the claims in this file were tested')
    })
    return
  }

  const redis = redisProcessControl(REDIS_URL)

  beforeAll(async () => {
    // eslint-disable-next-line no-console
    console.log(`[redis-outage] controlling Redis via ${redis.kind}`)
    ;({ storageService } = await import('@/lib/services/storage'))
    ;({ GET: download } = (await import(
      '@/app/api/storage/files/[fileId]/download/route'
    )) as unknown as { GET: DownloadHandler })

    ownerId = (
      await prisma.user.create({
        data: {
          email: `redis-outage-${crypto.randomBytes(5).toString('hex')}@example.test`,
          password: 'not-a-real-hash',
          name: 'Redis Outage Suite',
        },
        select: { id: true },
      })
    ).id
    projectId = (
      await prisma.project.create({
        data: { name: 'redis-outage', userId: ownerId },
        select: { id: true },
      })
    ).id

    const bucket = await storageService.createBucket('during-outage', projectId, true)
    bucketId = bucket.id
    await prisma.storageBucket.update({
      where: { id: bucketId },
      data: { accessPolicy: 'public_read' },
    })
  }, 180_000)

  afterAll(async () => {
    if (!(await waitForRedis(REDIS_URL, true, 1_000))) {
      redis.start()
      await waitForRedis(REDIS_URL, true)
    }
    await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
    rmSync(ROOT, { recursive: true, force: true })
    await prisma.$disconnect()
  }, 180_000)

  it('a protected attempt is refused as an OUTAGE and answers 503, never 429', async () => {
    const client = createRateLimitRedis(REDIS_URL)
    const limiter = new RedisRateLimitBackend(client, 1_000)
    const key = `test:blast:${crypto.randomBytes(5).toString('hex')}`

    try {
      // CONTROL: working, and reported as such, before anything is stopped.
      const before = await limiter.consume(key, 5, 60_000)
      expect(before.outcome).toBe('allowed')
      expect(limiter.health()).toMatchObject({ kind: 'redis', ready: true })

      redis.stop()
      expect(await waitForRedis(REDIS_URL, false)).toBe(true)

      const during = await limiter.consume(key, 5, 60_000)
      expect(during.allowed).toBe(false)
      expect(during.outcome).toBe('store_unavailable')

      // Still the shared store. A silent switch to per-process counters would
      // hand out (limit x instances) at precisely the moment the store is most
      // likely to be struggling because an attack is underway.
      expect(limiter.health().kind).toBe('redis')
      expect(limiter.health().ready).toBe(false)

      // And the caller is told it is an outage. 429 would accuse someone of
      // making attempts they never made, and would bury an outage inside a
      // metric operators read as abuse.
      const decision = throttleDecision(during)
      expect(decision.status).toBe(503)
      expect(decision.status).not.toBe(429)
    } finally {
      client.disconnect()
    }
  }, 300_000)

  it('a feature that does not depend on Redis is still fully available', async () => {
    // The blast-radius claim, and the reason this file exists. Storage touches
    // the database and the filesystem and has nothing to do with rate limiting,
    // so it must be completely unaffected: a WRITE and then a READ of the same
    // bytes, through the real service and the real route, while Redis is down.
    expect(await waitForRedis(REDIS_URL, false, 1_000)).toBe(true)

    const bytes = Buffer.from('written-while-redis-was-down')
    const uploaded = await storageService.uploadFile(
      bucketId,
      { name: 'during-redis-outage.txt', buffer: bytes, mimeType: 'text/plain' },
      { projectId, isPublic: true },
    )

    const res = await download(request(), { params: Promise.resolve({ fileId: uploaded.id }) })
    expect(res.status).toBe(200)
    expect((await readBody(res)).equals(bytes)).toBe(true)
  }, 300_000)

  it('two independent instances share one counter again once Redis is back', async () => {
    redis.start()
    expect(await waitForRedis(REDIS_URL, true)).toBe(true)

    // Two clients, two backends: the closest this process can get to two app
    // instances. One counter between them is the entire point of a shared store,
    // and it has to be true AFTER a restart, not only on a store that has been
    // up since boot.
    const clientA = createRateLimitRedis(REDIS_URL)
    const clientB = createRateLimitRedis(REDIS_URL)
    const a = new RedisRateLimitBackend(clientA, 2_000)
    const b = new RedisRateLimitBackend(clientB, 2_000)

    // A fresh key: the counter observably RESETS across a restart on an
    // unconfigured Redis, so reusing the old key would assert a durability
    // contract this repository does not control. See restart-recovery.
    const key = `test:shared-after-recovery:${crypto.randomBytes(5).toString('hex')}`

    try {
      // The backends must actually be ready before the shared claim is made,
      // or a `store_unavailable` would read as "the budget was not spent".
      const deadline = Date.now() + 30_000
      let first = await a.consume(key, 5, 60_000)
      while (Date.now() < deadline && first.outcome === 'store_unavailable') {
        await new Promise(r => setTimeout(r, 250))
        first = await a.consume(key, 5, 60_000)
      }
      expect(first.outcome).toBe('allowed')
      expect(first.remaining).toBe(4)

      // B has never seen this key. If the budgets were per-process it would
      // report 4 remaining, having spent its own first token.
      const second = await b.consume(key, 5, 60_000)
      expect(second.outcome).toBe('allowed')
      expect(second.remaining).toBe(3)

      // Spend the rest from alternating instances and prove the DENIAL is
      // shared too, not merely the counter.
      expect((await a.consume(key, 5, 60_000)).outcome).toBe('allowed')
      expect((await b.consume(key, 5, 60_000)).outcome).toBe('allowed')
      expect((await a.consume(key, 5, 60_000)).outcome).toBe('allowed')

      const overA = await a.consume(key, 5, 60_000)
      const overB = await b.consume(key, 5, 60_000)
      expect(overA.outcome).toBe('limit_exceeded')
      expect(overB.outcome).toBe('limit_exceeded')
      // A real limit, not an outage. The two are different answers and the
      // response layer gives them different status codes.
      expect(throttleDecision(overB).status).toBe(429)
    } finally {
      clientA.disconnect()
      clientB.disconnect()
    }
  }, 300_000)
})
