/**
 * BUCKET VISIBILITY: WHAT THE AGENT IS TOLD IS WHAT IS ENFORCED
 * =============================================================
 * Two fields describe a bucket's visibility. `isPublic` is a label; nothing on
 * the serving path reads it. `accessPolicy` is what `mayRead`, the upload
 * clamp and the console enforce and display. The agent's `create_bucket
 * isPublic` and `set_public` wrote ONLY the label, so:
 *
 *   (a) "created avatars, Visibility: public" — anonymous reads still 401,
 *       the console shows Private, uploads are clamped private; and worse
 *   (b) after a leak, "bucket is now private" — while every object in a
 *       public_read bucket KEEPS SERVING to anonymous callers.
 *
 * Pinned here through the real executor door, the real bucket service and the
 * real access-policy decision function:
 *
 *   - create with isPublic:true  → accessPolicy public_read, anonymous may read
 *   - create default             → private, anonymous may not
 *   - set_public false           → BOTH fields flip and anonymous is refused,
 *                                  including on a diverged legacy bucket whose
 *                                  label said private while the policy served
 *   - list reports the enforced policy, so the agent's read-back is true
 */

import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { mayRead } from '@/lib/storage/access-policy'

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const createdUserIds: string[] = []
const createdProjectIds: string[] = []
let projectId = ''

/** How an anonymous caller fares against a bucket in its current stored state. */
async function anonymousMayRead(bucketName: string): Promise<boolean> {
  const bucket = await prisma.storageBucket.findFirst({
    where: { name: bucketName, projectId },
    select: { accessPolicy: true },
  })
  if (!bucket) throw new Error(`bucket ${bucketName} missing`)
  return mayRead(
    { bucketPolicy: bucket.accessPolicy, fileIsPublic: true, uploadedBy: null },
    { kind: 'anonymous' },
  ).allowed
}

async function bucketRow(bucketName: string) {
  return prisma.storageBucket.findFirst({
    where: { name: bucketName, projectId },
    select: { isPublic: true, accessPolicy: true },
  })
}

beforeAll(async () => {
  assertSafeTestDatabase()
  const u = await prisma.user.create({
    data: { email: `bvt-${randomUUID()}@test.invalid`, name: 'Bucket Truth Test' },
    select: { id: true },
  })
  createdUserIds.push(u.id)
  const p = await prisma.project.create({
    data: { name: `bvt-${randomUUID().slice(0, 8)}`, userId: u.id },
    select: { id: true },
  })
  createdProjectIds.push(p.id)
  projectId = p.id
})

afterAll(async () => {
  if (createdProjectIds.length) {
    await prisma.storageFile.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.storageBucket.deleteMany({ where: { projectId: { in: createdProjectIds } } })
    await prisma.backendEvent.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { projectId: { in: createdProjectIds } } }).catch(() => {})
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } })
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
  }
})

describe('create_bucket', () => {
  it('isPublic: true creates a bucket anonymous callers can actually read', async () => {
    const result = await executeAction(
      { action: 'CREATE_BUCKET', params: { bucketName: 'avatars', isPublic: true, confirmed: true } } as any,
      projectId
    )

    expect(result.success).toBe(true)
    expect((result.data as any)?.accessPolicy).toBe('public_read')
    expect(await bucketRow('avatars')).toEqual({ isPublic: true, accessPolicy: 'public_read' })
    expect(await anonymousMayRead('avatars')).toBe(true)
  })

  it('defaults to a bucket anonymous callers cannot read', async () => {
    const result = await executeAction(
      { action: 'CREATE_BUCKET', params: { bucketName: 'invoices', confirmed: true } } as any,
      projectId
    )

    expect(result.success).toBe(true)
    expect(await bucketRow('invoices')).toEqual({ isPublic: false, accessPolicy: 'private' })
    expect(await anonymousMayRead('invoices')).toBe(false)
  })
})

describe('set_public', () => {
  it('locking a bucket down actually stops anonymous reads', async () => {
    expect(await anonymousMayRead('avatars')).toBe(true)

    const result = await executeAction(
      { action: 'SET_BUCKET_PUBLIC', params: { bucketName: 'avatars', isPublic: false, confirmed: true } } as any,
      projectId
    )

    expect(result.success).toBe(true)
    expect(result.message).toContain('private')
    expect(await bucketRow('avatars')).toEqual({ isPublic: false, accessPolicy: 'private' })
    expect(await anonymousMayRead('avatars')).toBe(false)
  })

  it('locks down a diverged legacy bucket whose label already said private', async () => {
    // The dangerous shape from the audit: the label says private, the ENFORCED
    // policy still serves. The old set_public(false) rewrote the label and
    // reported success while anonymous reads kept working.
    await prisma.storageBucket.create({
      data: { name: 'leaky', projectId, isPublic: false, accessPolicy: 'public_read' },
    })
    expect(await anonymousMayRead('leaky')).toBe(true)

    const result = await executeAction(
      { action: 'SET_BUCKET_PUBLIC', params: { bucketName: 'leaky', isPublic: false, confirmed: true } } as any,
      projectId
    )

    expect(result.success).toBe(true)
    expect(await anonymousMayRead('leaky')).toBe(false)
  })

  it('opening a bucket up is reported from the read-back enforced state', async () => {
    const result = await executeAction(
      { action: 'SET_BUCKET_PUBLIC', params: { bucketName: 'invoices', isPublic: true, confirmed: true } } as any,
      projectId
    )

    expect(result.success).toBe(true)
    expect((result.data as any)?.accessPolicy).toBe('public_read')
    expect(await anonymousMayRead('invoices')).toBe(true)
  })
})

describe('list_buckets', () => {
  it('reports the enforced policy, so the read-back is true', async () => {
    const result = await executeAction({ action: 'LIST_BUCKETS', params: {} } as any, projectId)

    expect(result.success).toBe(true)
    expect(result.message).toContain('(private)')
    expect(result.message).toContain('(public_read)')
    const buckets = (result.data as any)?.buckets as Array<{ name: string; accessPolicy: string }>
    expect(buckets.find((b) => b.name === 'avatars')?.accessPolicy).toBe('private')
    expect(buckets.find((b) => b.name === 'invoices')?.accessPolicy).toBe('public_read')
  })
})
