/**
 * THE CLEANUP SWEEP MUST NEVER DELETE A LIVE FILE
 * ===============================================
 * `runLifecycleCleanup` is the nightly storage janitor. As shipped it destroyed
 * live data two ways:
 *
 *   1. A "clean incomplete uploads" step whose query was every non-deleted row
 *      older than one hour, `take: 100`, soft-deleted unconditionally — one
 *      hundred arbitrary ACTIVE files per run, fleet-wide, never checking
 *      storage at all.
 *
 *   2. The orphan sweep's known-paths set was `deletedAt: null` rows only, so a
 *      file a user deleted YESTERDAY — six days inside the advertised seven-day
 *      recovery window — stopped being "known", and its object was physically
 *      destroyed as an orphan on the next run. Restore then resurrected a row
 *      whose object was gone.
 *
 * What this suite pins, against a real database and an in-memory S3 double
 * (the database is never mocked; S3 is an external service the function takes
 * as an argument):
 *
 *   - an active file, hours old, object present → untouched by a full run
 *   - a soft-deleted file INSIDE retention → row kept, object kept
 *   - a soft-deleted file PAST retention → row and object both removed
 *   - a true orphan object, old → removed; a FRESH object (upload in flight,
 *     row not committed yet) → kept
 *   - a live row whose object never arrived → soft-deleted once it is old
 *     enough (this is the honest version of "incomplete upload"); a FRESH row
 *     (object still uploading) → kept
 *   - dryRun touches nothing
 */

import { randomUUID } from 'crypto'
import type { S3Client } from '@aws-sdk/client-s3'
import { prisma } from '@/lib/db/prisma'
import { runLifecycleCleanup } from '@/lib/storage/storage-lifecycle'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

/**
 * In-memory stand-in for the three S3 calls the sweep makes. The sweep takes
 * the client as an argument, so no module mocking is involved — this is the
 * same seam the cron route injects through.
 */
class FakeS3 {
  objects = new Map<string, { size: number; lastModified: Date }>()
  deleted: string[] = []

  put(key: string, ageMs: number, size = 10) {
    this.objects.set(key, { size, lastModified: new Date(Date.now() - ageMs) })
  }

  async send(cmd: any): Promise<any> {
    const kind = cmd?.constructor?.name
    if (kind === 'ListObjectsV2Command') {
      return {
        Contents: Array.from(this.objects.entries()).map(([Key, v]) => ({
          Key,
          Size: v.size,
          LastModified: v.lastModified,
        })),
        NextContinuationToken: undefined,
      }
    }
    if (kind === 'HeadObjectCommand') {
      const o = this.objects.get(cmd.input.Key)
      if (!o) {
        const err: any = new Error('NotFound')
        err.name = 'NotFound'
        throw err
      }
      return { ContentLength: o.size }
    }
    if (kind === 'DeleteObjectCommand') {
      this.objects.delete(cmd.input.Key)
      this.deleted.push(cmd.input.Key)
      return {}
    }
    throw new Error(`FakeS3: unexpected command ${kind}`)
  }

  asClient(): S3Client {
    return this as unknown as S3Client
  }
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const createdUserIds: string[] = []
const createdProjectIds: string[] = []

async function fixtureProject() {
  const u = await prisma.user.create({
    data: { email: `lc-${randomUUID()}@test.invalid`, name: 'Lifecycle Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  const p = await prisma.project.create({
    data: { name: `lc-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  const b = await prisma.storageBucket.create({
    data: { name: 'files', projectId: p.id },
    select: { id: true },
  })
  return { projectId: p.id, bucketId: b.id }
}

async function fileRow(opts: {
  projectId: string
  bucketId: string
  path: string
  ageMs: number
  deletedAgoMs?: number
}) {
  return prisma.storageFile.create({
    data: {
      bucketId: opts.bucketId,
      projectId: opts.projectId,
      name: opts.path.split('/').pop()!,
      path: opts.path,
      size: BigInt(10),
      createdAt: new Date(Date.now() - opts.ageMs),
      deletedAt: opts.deletedAgoMs !== undefined ? new Date(Date.now() - opts.deletedAgoMs) : null,
    },
    select: { id: true, path: true },
  })
}

const rowById = (id: string) =>
  prisma.storageFile.findUnique({ where: { id }, select: { id: true, deletedAt: true } })

beforeAll(() => {
  assertSafeTestDatabase()
})

afterAll(async () => {
  if (createdProjectIds.length) {
    await prisma.storageFile.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.storageBucket.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

describe('runLifecycleCleanup', () => {
  it('leaves an active, hours-old file completely alone', async () => {
    const f = await fixtureProject()
    const s3 = new FakeS3()
    const key = `${f.projectId}/active-${randomUUID()}.png`
    const row = await fileRow({ ...f, path: key, ageMs: 2 * HOUR })
    s3.put(key, 2 * HOUR)

    const result = await runLifecycleCleanup(s3.asClient(), 'test-bucket', {})

    expect((await rowById(row.id))?.deletedAt).toBeNull()
    expect(s3.objects.has(key)).toBe(true)
    expect(s3.deleted).toHaveLength(0)
    expect(result.deletedIncomplete).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('keeps a soft-deleted file and its object while the retention window runs', async () => {
    const f = await fixtureProject()
    const s3 = new FakeS3()
    const key = `${f.projectId}/recoverable-${randomUUID()}.png`
    const row = await fileRow({ ...f, path: key, ageMs: 3 * DAY, deletedAgoMs: 2 * DAY })
    s3.put(key, 3 * DAY)

    await runLifecycleCleanup(s3.asClient(), 'test-bucket', {})

    // Inside the 7-day window the row must survive for restore, and the object
    // must survive for the restore to mean anything.
    const after = await rowById(row.id)
    expect(after).not.toBeNull()
    expect(after?.deletedAt).not.toBeNull()
    expect(s3.objects.has(key)).toBe(true)
  })

  it('removes a soft-deleted file and its object once retention has passed', async () => {
    const f = await fixtureProject()
    const s3 = new FakeS3()
    const key = `${f.projectId}/expired-${randomUUID()}.png`
    const row = await fileRow({ ...f, path: key, ageMs: 10 * DAY, deletedAgoMs: 8 * DAY })
    s3.put(key, 10 * DAY)

    const result = await runLifecycleCleanup(s3.asClient(), 'test-bucket', {})

    expect(await rowById(row.id)).toBeNull()
    expect(s3.objects.has(key)).toBe(false)
    expect(result.deletedSoftDeletes).toBe(1)
  })

  it('deletes an old orphan object and keeps a fresh one an upload may still claim', async () => {
    const f = await fixtureProject()
    const s3 = new FakeS3()
    const oldOrphan = `${f.projectId}/orphan-${randomUUID()}.bin`
    const freshObject = `${f.projectId}/arriving-${randomUUID()}.bin`
    s3.put(oldOrphan, 2 * DAY)
    s3.put(freshObject, 5 * 60 * 1000)

    const result = await runLifecycleCleanup(s3.asClient(), 'test-bucket', {})

    expect(s3.objects.has(oldOrphan)).toBe(false)
    expect(s3.objects.has(freshObject)).toBe(true)
    expect(result.deletedOrphans).toBe(1)
  })

  it('soft-deletes an old row whose object never arrived, and spares a fresh one', async () => {
    const f = await fixtureProject()
    const s3 = new FakeS3()
    const neverArrived = await fileRow({ ...f, path: `${f.projectId}/never-${randomUUID()}.bin`, ageMs: 2 * HOUR })
    const stillUploading = await fileRow({ ...f, path: `${f.projectId}/uploading-${randomUUID()}.bin`, ageMs: 5 * 60 * 1000 })

    await runLifecycleCleanup(s3.asClient(), 'test-bucket', {})

    // The abandoned row enters the ordinary soft-delete lifecycle; the one that
    // is five minutes old is an upload in flight, not a phantom.
    expect((await rowById(neverArrived.id))?.deletedAt).not.toBeNull()
    expect((await rowById(stillUploading.id))?.deletedAt).toBeNull()
  })

  it('dryRun reports and changes nothing', async () => {
    const f = await fixtureProject()
    const s3 = new FakeS3()
    const key = `${f.projectId}/expired-${randomUUID()}.png`
    const row = await fileRow({ ...f, path: key, ageMs: 10 * DAY, deletedAgoMs: 8 * DAY })
    s3.put(key, 10 * DAY)
    const orphan = `${f.projectId}/orphan-${randomUUID()}.bin`
    s3.put(orphan, 2 * DAY)

    await runLifecycleCleanup(s3.asClient(), 'test-bucket', { dryRun: true })

    expect(await rowById(row.id)).not.toBeNull()
    expect(s3.objects.has(key)).toBe(true)
    expect(s3.objects.has(orphan)).toBe(true)
    expect(s3.deleted).toHaveLength(0)
  })
})
