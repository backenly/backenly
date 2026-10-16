/**
 * ANOTHER REGION'S SNAPSHOT IS DOWNLOADED FROM THAT REGION
 * ========================================================
 * A project kept in another region has its database snapshots in that
 * region's snapshot bucket. The console runs at home, and the dump must not
 * be streamed out through it, so the download route hands the browser a
 * short-lived link to the region's bucket instead
 * (lib/services/workspace-backup.ts regionalSnapshotLink). Pinned here:
 *
 *   - the link is to the region's bucket, signed for that region, short-lived,
 *     and downloads as an attachment;
 *   - another project's snapshot, or none, is missing;
 *   - a snapshot outside the region's configured bucket, outside the project's
 *     own prefix, or on a disk is refused, as is any while the region's bucket
 *     is not configured here.
 *
 * Database-free; presigning is local arithmetic, with credentials from the
 * environment so the SDK asks no metadata service.
 */

const mockRows = new Map<string, { projectId: string; filePath: string; filename: string }>()

jest.mock('@/lib/db/prisma', () => ({
  prisma: {
    project: { findUnique: jest.fn(async () => ({ region: 'eu-central-1' })) },
    workspaceBackup: {
      findFirst: jest.fn(async ({ where }: any) => {
        const row = mockRows.get(where.id)
        return row && row.projectId === where.projectId && where.status === 'completed' ? row : null
      }),
    },
  },
}))

import { SNAPSHOT_LINK_TTL_SECONDS, regionalSnapshotLink } from '@/lib/services/workspace-backup'

const BUCKET = 'example-snapshots-eu-central-1'
const KEYS = ['BACKUP_S3_BUCKET_EU_CENTRAL_1', 'BACKUP_S3_PREFIX', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const k of KEYS) saved[k] = process.env[k]
  delete process.env.BACKUP_S3_PREFIX
  process.env.BACKUP_S3_BUCKET_EU_CENTRAL_1 = BUCKET
  process.env.AWS_ACCESS_KEY_ID = 'test-access-key-id'
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-access-key'
  mockRows.set('snap', { projectId: 'p-frankfurt', filePath: `s3://${BUCKET}/workspace-snapshots/p-frankfurt/snap 1.sql.gz`, filename: 'snap 1.sql.gz' })
  mockRows.set('theirs', { projectId: 'p-other', filePath: `s3://${BUCKET}/workspace-snapshots/p-other/snap.sql.gz`, filename: 'snap.sql.gz' })
  mockRows.set('on-disk', { projectId: 'p-frankfurt', filePath: '/var/backups/p-frankfurt/snap.sql.gz', filename: 'snap.sql.gz' })
  mockRows.set('other-bucket', { projectId: 'p-frankfurt', filePath: 's3://some-other-bucket/workspace-snapshots/p-frankfurt/snap.sql.gz', filename: 'snap.sql.gz' })
  mockRows.set('other-prefix', { projectId: 'p-frankfurt', filePath: `s3://${BUCKET}/workspace-snapshots/p-other/snap.sql.gz`, filename: 'snap.sql.gz' })
})

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('a download link to another region’s snapshot', () => {
  it('points at the region’s bucket, signed for the region, short-lived, as an attachment', async () => {
    const link = await regionalSnapshotLink('p-frankfurt', 'snap')
    expect(link).toMatchObject({ kind: 'link', filename: 'snap 1.sql.gz' })
    const url = new URL(link.kind === 'link' ? link.url : 'about:blank')
    expect(url.hostname.startsWith(`${BUCKET}.s3.`)).toBe(true)
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/eu-central-1/s3/')
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(SNAPSHOT_LINK_TTL_SECONDS))
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="database-snapshot-snap_1.sql.gz"')
  })

  it('is missing for a snapshot that is not this project’s, or none at all', async () => {
    expect(await regionalSnapshotLink('p-frankfurt', 'theirs')).toEqual({ kind: 'missing' })
    expect(await regionalSnapshotLink('p-frankfurt', 'no-such-snapshot')).toEqual({ kind: 'missing' })
  })

  it('is refused for a snapshot on a disk, in another bucket, or under another project’s prefix', async () => {
    expect(await regionalSnapshotLink('p-frankfurt', 'on-disk')).toEqual({ kind: 'unavailable' })
    expect(await regionalSnapshotLink('p-frankfurt', 'other-bucket')).toEqual({ kind: 'unavailable' })
    expect(await regionalSnapshotLink('p-frankfurt', 'other-prefix')).toEqual({ kind: 'unavailable' })
  })

  it('is refused while the region’s snapshot bucket is not configured here', async () => {
    delete process.env.BACKUP_S3_BUCKET_EU_CENTRAL_1
    try {
      expect(await regionalSnapshotLink('p-frankfurt', 'snap')).toEqual({ kind: 'unavailable' })
    } finally {
      process.env.BACKUP_S3_BUCKET_EU_CENTRAL_1 = BUCKET
    }
  })
})
