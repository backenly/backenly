/**
 * WHAT STORAGE SAYS WHILE IT CANNOT REACH THE BYTES
 * ================================================
 *
 * Restart qualification asked whether the deployment comes back. This asks a
 * different question: what does it SAY while a dependency is actually gone. The
 * two are not the same, and the second is where the dishonest answers live.
 *
 * It found one. Both storage drivers ended `getFile` with `return null`, and
 * both callers render null as `404 File not found`. So with the volume
 * unmounted or the endpoint unreachable, every download answered with a
 * definite statement about the world — this object does not exist — while the
 * metadata row sat there saying it did.
 *
 * That is worse than a 500, because a 404 is ACTIONABLE. A syncing client
 * prunes its local copy. A retry loop stops retrying, because the resource is
 * gone. An operator goes looking for a deletion that never happened. It is the
 * same family as a restore that reports success while doing nothing: a definite
 * claim made by a subsystem in no position to make it.
 *
 * ── How storage is taken away ───────────────────────────────────────────────
 *
 * The storage root is REPLACED WITH A REGULAR FILE. Reads under it fail with
 * ENOTDIR and — this is the part that matters — so does `mkdir -p`, which the
 * upload path calls first. Renaming the directory away would not have worked:
 * `ensureBucketDir` would simply recreate the whole tree and the upload would
 * succeed into a storage root that no longer held any of the objects.
 *
 * It is a real fault of the shape self-hosters actually hit (a volume that did
 * not mount, or mounted somewhere else), it needs no privileges, and it behaves
 * the same on Windows and Linux.
 *
 * ── Every refusal here is paired ────────────────────────────────────────────
 *
 * The bytes are read back and compared BEFORE the outage, a genuinely absent
 * file is asked for DURING it, and both the original object and a new upload
 * are exercised AFTER it. Without the pairing, "storage returns 503" would be
 * equally true of a deployment where storage had never worked at all.
 */

import { PrismaClient } from '@prisma/client'
import crypto from 'crypto'
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Both must be set BEFORE the storage module is imported: `storageService` is a
// module-level singleton, and LocalStorageService captures the directory in its
// constructor. A static import would be hoisted above these assignments and the
// suite would run against this developer's real S3 bucket.
const ROOT = mkdtempSync(join(tmpdir(), 'storage-outage-'))
process.env.STORAGE_DRIVER = 'local'
process.env.STORAGE_DIR = ROOT
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || 'storage-outage-suite-secret'

type DownloadHandler = (
  request: unknown,
  ctx: { params: Promise<{ fileId: string }> },
) => Promise<any>

let download: DownloadHandler
let storageService: (typeof import('@/lib/services/storage'))['storageService']

const prisma = new PrismaClient()

const KNOWN_BYTES = Buffer.from('the-bytes-that-must-not-change-' + 'x'.repeat(64), 'utf8')

let ownerId: string
let projectId: string
let bucketId: string
let knownFileId: string

/** The request envelope the download route reads. See storage-bucket-policy. */
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

async function get(fileId: string) {
  const res = await download(request(), { params: Promise.resolve({ fileId }) })
  return { status: res.status, bytes: res.status === 200 ? await readBody(res) : Buffer.alloc(0) }
}

// ── Taking storage away, and giving it back ──────────────────────────────────

const PARKED = `${ROOT}.parked`

function breakStorage(): void {
  renameSync(ROOT, PARKED)
  // A FILE where the directory should be. `mkdir -p` cannot create under it, so
  // the upload path fails at its first step rather than quietly rebuilding the
  // tree somewhere that holds none of the objects.
  writeFileSync(ROOT, 'this is not a directory')
}

function restoreStorage(): void {
  unlinkSync(ROOT)
  renameSync(PARKED, ROOT)
}

beforeAll(async () => {
  ;({ storageService } = await import('@/lib/services/storage'))
  ;({ GET: download } = (await import(
    '@/app/api/storage/files/[fileId]/download/route'
  )) as unknown as { GET: DownloadHandler })

  ownerId = (
    await prisma.user.create({
      data: {
        email: `storage-outage-${crypto.randomBytes(5).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Storage Outage Suite',
      },
      select: { id: true },
    })
  ).id

  projectId = (
    await prisma.project.create({
      data: { name: 'storage-outage', userId: ownerId },
      select: { id: true },
    })
  ).id

  // The real service, so the bucket, the bytes on disk and the metadata row are
  // all produced by the code under test rather than by the fixture.
  const bucket = await storageService.createBucket('outage', projectId, true)
  bucketId = bucket.id
  await prisma.storageBucket.update({
    where: { id: bucketId },
    data: { accessPolicy: 'public_read' },
  })

  const uploaded = await storageService.uploadFile(
    bucketId,
    { name: 'known.txt', buffer: KNOWN_BYTES, mimeType: 'text/plain' },
    { projectId, isPublic: true },
  )
  knownFileId = uploaded.id
}, 180_000)

afterAll(async () => {
  await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(PARKED, { recursive: true, force: true })
  await prisma.$disconnect()
}, 180_000)

// ─────────────────────────────────────────────────────────────────────────────

describe('storage serves before anything is broken', () => {
  it('returns the exact bytes that were uploaded', async () => {
    const res = await get(knownFileId)
    expect(res.status).toBe(200)
    // Byte-for-byte, not "some bytes". Every later claim about the object being
    // unchanged is measured against this.
    expect(res.bytes.equals(KNOWN_BYTES)).toBe(true)
  }, 120_000)
})

describe('while storage is unavailable', () => {
  beforeAll(() => breakStorage())
  afterAll(() => restoreStorage())

  it('a read fails HONESTLY, and does not claim the object is gone', async () => {
    const res = await get(knownFileId)

    // The defect this suite was written against: 404.
    expect(res.status).not.toBe(404)
    // And it must not serve anything either. A stale or empty 200 would be the
    // worse half of the same problem.
    expect(res.status).not.toBe(200)
    expect(res.status).toBe(503)
  }, 120_000)

  it('still answers 404 for a file that genuinely does not exist', async () => {
    // The control for the assertion above. Without it, "not 404" would be
    // equally true of a deployment that had started answering 503 to
    // everything, and the distinction under test would be untested.
    const res = await get(crypto.randomUUID())
    expect(res.status).toBe(404)
  }, 120_000)

  it('an upload does not report success', async () => {
    await expect(
      storageService.uploadFile(
        bucketId,
        {
          name: 'during-outage.txt',
          buffer: Buffer.from('never-persisted'),
          mimeType: 'text/plain',
        },
        { projectId, isPublic: true },
      ),
    ).rejects.toBeTruthy()
  }, 120_000)

  it('leaves NO metadata row claiming an object that was never written', async () => {
    const orphan = await prisma.storageFile.findFirst({
      where: { projectId, name: 'during-outage.txt' },
    })
    // The row is created after the bytes are on disk, so a failed write can
    // never produce one. Asserted rather than assumed: the reverse order is the
    // more natural way to write this code, and it yields a file listing full of
    // objects that cannot be downloaded.
    expect(orphan).toBeNull()
  }, 120_000)

  it('does not bill the project for bytes it never stored', async () => {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { storageUsed: true },
    })
    expect(project!.storageUsed).toBe(BigInt(KNOWN_BYTES.length))
  }, 120_000)
})

describe('after storage returns', () => {
  it('the original object still has exactly the same bytes', async () => {
    const res = await get(knownFileId)
    expect(res.status).toBe(200)
    expect(res.bytes.equals(KNOWN_BYTES)).toBe(true)
  }, 120_000)

  it('a new upload works, in the same process', async () => {
    // No restart, no new storageService: recovery has to be automatic, because
    // an operator who remounts a volume will not also redeploy the application.
    const after = Buffer.from('written-after-recovery')
    const uploaded = await storageService.uploadFile(
      bucketId,
      { name: 'after-recovery.txt', buffer: after, mimeType: 'text/plain' },
      { projectId, isPublic: true },
    )

    const res = await get(uploaded.id)
    expect(res.status).toBe(200)
    expect(res.bytes.equals(after)).toBe(true)
  }, 120_000)
})
