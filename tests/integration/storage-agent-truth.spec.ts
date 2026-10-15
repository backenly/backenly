/**
 * Storage answers an agent with what the runtime will actually do
 * (medium findings STO-05 and STO-06).
 *
 * STO-05: generate_signed_url ignored the bucket's current policy. In an
 * owner_only bucket it minted a link the download route refuses (and on the
 * S3 driver a presigned link that bypasses the policy entirely), and for a
 * file still flagged public in a bucket since tightened to private it said
 * "this file is public, the link does not expire" for a URL the route 401s.
 * getFileUrl now decides public the way the download route does (the bucket
 * policy permits public objects AND the file is marked public), on both
 * drivers, and the tool refuses owner_only.
 *
 * STO-06: create_bucket on an existing bucket answered success whatever
 * visibility was asked for. It now reports the existing visibility and
 * policy, and refuses when the request contradicts them.
 */
import crypto from 'crypto'

import { prisma } from '@/lib/db/prisma'
import { executeAction } from '@/lib/ai/minimal-executor'
import { TOOL_TO_ACTION } from '@/lib/ai/brain/tools'

// The local driver signs a token per private link; CI sets no STORAGE_SECRET.
process.env.STORAGE_SECRET = process.env.STORAGE_SECRET || crypto.randomBytes(32).toString('hex')

let ownerId: string
let projectId: string
const files: Record<string, string> = {}

const act = (action: string, params: Record<string, unknown>) =>
  executeAction({ action, params } as any, projectId, undefined, 0, undefined, false)

async function bucketWithFile(
  bucket: string, policy: string, bucketPublic: boolean, file: string, filePublic: boolean,
): Promise<void> {
  const b = await prisma.storageBucket.create({
    data: { name: bucket, projectId, isPublic: bucketPublic, accessPolicy: policy },
    select: { id: true },
  })
  const f = await prisma.storageFile.create({
    data: {
      bucketId: b.id, projectId, name: file, path: `${bucket}/${file}`,
      size: BigInt(10), mimeType: 'application/octet-stream', isPublic: filePublic,
    },
    select: { id: true },
  })
  files[file] = f.id
}

beforeAll(async () => {
  ownerId = (
    await prisma.user.create({
      data: {
        email: `sto-truth-${crypto.randomBytes(6).toString('hex')}@example.test`,
        password: 'not-a-real-hash',
        name: 'Storage Agent Truth Suite',
      },
      select: { id: true },
    })
  ).id
  projectId = (
    await prisma.project.create({ data: { name: 'storage-agent-truth', userId: ownerId }, select: { id: true } })
  ).id
  await bucketWithFile('scans', 'owner_only', false, 'scan.pdf', false)
  // A bucket tightened from public_read to private keeps isPublic on its files.
  await bucketWithFile('archive', 'private', false, 'report.pdf', true)
  await bucketWithFile('media', 'public_read', true, 'logo.png', true)
}, 60_000)

afterAll(async () => {
  await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('STO-05: a link is what the download route will honour', () => {
  it('refuses a shareable link into an owner_only bucket', async () => {
    const out = await act('GENERATE_SIGNED_URL', { bucketName: 'scans', path: 'scan.pdf' })
    expect(out.success).toBe(false)
    expect(out.error).toBe('OWNER_ONLY_BUCKET')
    expect(out.message).toContain('owner_only')
  }, 60_000)

  it('a file still flagged public in a private bucket gets an expiring signed link', async () => {
    const out = await act('GENERATE_SIGNED_URL', { bucketName: 'archive', path: 'report.pdf' })
    expect(out.success).toBe(true)
    const data = out.data as any
    expect(data.isPublic).toBe(false)
    expect(data.bucketPolicy).toBe('private')
    expect(data.url).toContain('?token=')
    expect(data.expiresInSeconds).toBe(3600)
    expect(out.message).toContain('expires in')
    expect(out.message).not.toContain('does not expire')
  }, 60_000)

  it('a public file in a public_read bucket keeps its permanent link (control)', async () => {
    const out = await act('GENERATE_SIGNED_URL', { bucketName: 'media', path: 'logo.png' })
    expect(out.success).toBe(true)
    const data = out.data as any
    expect(data.isPublic).toBe(true)
    expect(data.url).not.toContain('token=')
    expect(out.message).toContain('does not expire')
  }, 60_000)

  it('the S3 driver presigns a stale-public file instead of handing out a permanent public URL', async () => {
    const saved = { ...process.env }
    process.env.STORAGE_S3_BUCKET = 'test-bucket'
    process.env.STORAGE_S3_REGION = 'ap-south-1'
    process.env.STORAGE_S3_ACCESS_KEY = 'storage-truth-not-a-real-key'
    process.env.STORAGE_S3_SECRET_KEY = 'storage-truth-not-a-real-secret'
    delete process.env.STORAGE_S3_ENDPOINT
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test'
    try {
      const { S3StorageService } = await import('@/lib/services/s3Storage')
      const svc = new S3StorageService()
      const stale = await svc.getFileUrl(files['report.pdf'], projectId, 600)
      expect(stale).toContain('X-Amz-Signature')
      expect(stale).not.toContain('/download')
      const pub = await svc.getFileUrl(files['logo.png'], projectId, 600)
      expect(pub).toBe(`https://app.example.test/api/storage/files/${files['logo.png']}/download`)
    } finally {
      process.env = saved
    }
  }, 60_000)
})

describe('STO-06: create_bucket on an existing bucket says what exists', () => {
  it('refuses when the request contradicts the existing visibility, and changes nothing', async () => {
    const out = await act('CREATE_BUCKET', { bucketName: 'archive', isPublic: true })
    expect(out.success).toBe(false)
    expect(out.error).toBe('BUCKET_VISIBILITY_MISMATCH')
    expect((out.data as any)).toMatchObject({ existed: true, isPublic: false, accessPolicy: 'private' })
    expect(out.message).toContain('set_public')
    const row = await prisma.storageBucket.findFirst({ where: { projectId, name: 'archive' }, select: { accessPolicy: true, isPublic: true } })
    expect(row).toEqual({ accessPolicy: 'private', isPublic: false })
  }, 60_000)

  it('a matching request reports the existing bucket as existing, with its policy', async () => {
    const out = await act('CREATE_BUCKET', { bucketName: 'archive', isPublic: false })
    expect(out.success).toBe(true)
    expect((out.data as any)).toMatchObject({ existed: true, isPublic: false, accessPolicy: 'private' })
    expect(out.message).toContain('already exists')
  }, 60_000)

  it('through the agent tool, "private unless isPublic" against a public bucket is refused', async () => {
    const mapped = TOOL_TO_ACTION.create_bucket({ bucketName: 'media' })
    const out = await executeAction(mapped, projectId, undefined, 0, undefined, false)
    expect(out.success).toBe(false)
    expect(out.error).toBe('BUCKET_VISIBILITY_MISMATCH')
    expect((out.data as any)).toMatchObject({ isPublic: true, accessPolicy: 'public_read' })
  }, 60_000)
})
