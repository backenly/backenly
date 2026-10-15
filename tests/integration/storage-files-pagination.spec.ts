/**
 * The storage console stops presenting one page as the whole project
 * (medium finding STO-09).
 *
 * The files route dropped the client's limit/offset/search and the service
 * silently took its first 100 rows, so the console's bucket counts, the
 * "Select all" toolbar and the delete-bucket confirmation ("This bucket
 * contains N files. All of them will be permanently deleted") were all
 * computed from a truncated array on any project past 100 files.
 *
 * The service-level behavior runs against the real test database; the route,
 * client and workbench wiring are pinned at source.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { storageService } from '@/lib/services/storage'

// The local driver signs an access token for every file it lists, and CI's
// integration job sets no STORAGE_SECRET. Read at call time, so this holds.
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || crypto.randomBytes(32).toString('hex')

const ROOT = process.cwd()
const FILES = 120 // past the service's silent first page of 100

let ownerId: string
let projectId: string
let bucketId: string

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `sto-pagination-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Storage Pagination Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'storage-pagination', userId: ownerId },
      select: { id: true },
    })
  ).id
  bucketId = (
    await prisma.storageBucket.create({
      data: { name: 'uploads', projectId },
      select: { id: true },
    })
  ).id
  await prisma.storageFile.createMany({
    data: Array.from({ length: FILES }, (_, i) => ({
      bucketId,
      projectId,
      name: `object-${String(i).padStart(3, '0')}.txt`,
      path: `uploads/object-${i}.txt`,
      size: BigInt(10),
      mimeType: 'text/plain',
    })),
  })
}, 120_000)

afterAll(async () => {
  await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('STO-09: the service pages and counts honestly', () => {
  it('one page is one page, and the count is the whole project', async () => {
    const firstPage = await storageService.listFiles(undefined, projectId, { limit: 100 })
    expect(firstPage).toHaveLength(100)
    await expect(storageService.countFiles(undefined, projectId)).resolves.toBe(FILES)
  }, 60_000)

  it('offset reaches the rows past the first page', async () => {
    const rest = await storageService.listFiles(undefined, projectId, { limit: 100, offset: 100 })
    expect(rest).toHaveLength(FILES - 100)
    const firstPage = await storageService.listFiles(undefined, projectId, { limit: 100 })
    const seen = new Set(firstPage.map((f) => f.id))
    for (const f of rest) expect(seen.has(f.id)).toBe(false)
  }, 60_000)

  it('search narrows both the page and the count identically', async () => {
    const hits = await storageService.listFiles(undefined, projectId, { limit: 500, search: 'object-11' })
    const count = await storageService.countFiles(undefined, projectId, 'object-11')
    expect(hits.length).toBe(count)
    expect(count).toBe(10) // object-110 … object-119
  }, 60_000)
})

describe('STO-09: the route and console carry the truth through', () => {
  it('the files route forwards limit/offset/search and returns the total', () => {
    const route = fs.readFileSync(path.join(ROOT, 'app', 'api', 'storage', 'files', 'route.ts'), 'utf8')
    expect(route).toContain('{ limit, offset, search }')
    expect(route).toContain('storageService.countFiles')
    expect(route).toContain('total,')
  })

  it('the workbench counts buckets from server stats and says what is loaded', () => {
    const wb = fs.readFileSync(path.join(ROOT, 'components', 'storage', 'StorageWorkbench.tsx'), 'utf8')
    expect(wb).toContain('b.name === bucketName)?.fileCount')
    expect(wb).toContain('loaded')
    expect(wb).toContain('loadMoreFiles')
  })
})
