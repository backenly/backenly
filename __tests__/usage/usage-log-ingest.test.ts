/**
 * ACCESS-LOG EGRESS IS ATTRIBUTED CORRECTLY AND COUNTED ONCE
 * ==========================================================
 * Load balancer, S3 server access and CloudFront standard logs, in the formats
 * AWS documents, parsed into per-project daily egress, and ingested exactly
 * once however often the log bucket is listed.
 */

import { randomUUID } from 'crypto'
import { gzipSync } from 'zlib'
import { prisma } from '@/lib/db/prisma'
import {
  tokenize,
  parseAlbLine,
  parseS3Line,
  parseCloudFront,
  ingestLogs,
  logSourcesFromEnv,
  type LogObjectStore,
} from '@/lib/usage/log-ingest'

const DB_URL = process.env.TEST_DATABASE_URL ?? ''
const users: string[] = []
const projects: string[] = []
const batchIds: string[] = []

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const P = '0f8fad5b-d9cb-469f-a165-70867728950e'
const F = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

function albLine(path: string, sent: number, time = '2026-09-27T10:00:01.123456Z') {
  return `https ${time} app/backenly-production-alb/da629bc4a9f5a43c 203.0.113.9:51234 10.30.31.132:3000 0.001 0.020 0.000 200 200 512 ${sent} "GET https://backenly.com:443${path} HTTP/1.1" "Mozilla/5.0 (X11)" ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2 arn:aws:elasticloadbalancing:ap-south-1:510155707664:targetgroup/backenly-production-web/abc "Root=1-5f84c7a9-1234" "backenly.com" "arn:aws:acm:ap-south-1:510155707664:certificate/afb49dee" 0 2026-09-27T10:00:01.100000Z "forward" "-" "-" "10.30.31.132:3000" "200" "-" "-" TID_abc`
}

function s3Line(key: string, bytes: number, auth: string, op = 'REST.GET.OBJECT') {
  return `79a59df900b949e55d96a1e698fbacedfd6e09d98eacf8f8d5218e7cd47ef2be backenly-app-production-510155707664 [27/Sep/2026:10:15:02 +0000] 198.51.100.7 arn:aws:sts::510155707664:assumed-role/backenly-production-web/abc 3E57427F3EXAMPLE ${op} ${key} "GET /${key}?X-Amz-Signature=abc HTTP/1.1" 200 - ${bytes} ${bytes} 70 10 "-" "Mozilla/5.0" - s9lzHYrFp76ZVxRcpX9+5cjAnEH2ROuNkd2BHfIa6UkFVdtjf5mKR3/eTPFvsiP/XV/VLi31234= SigV4 ECDHE-RSA-AES128-GCM-SHA256 ${auth} backenly-app-production-510155707664.s3.ap-south-1.amazonaws.com TLSv1.2 - -`
}

beforeAll(() => assertSafeTestDatabase())

afterAll(async () => {
  await prisma.usageDaily.deleteMany({ where: { projectId: { in: projects } } })
  await prisma.$executeRaw`DELETE FROM "usage_applied_batches" WHERE "id" = ANY(${batchIds}::text[])`
  await prisma.project.deleteMany({ where: { id: { in: projects } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
})

describe('parsing', () => {
  it('tokenizes quoted and bracketed fields whole', () => {
    expect(tokenize('a "b c" [d e] f')).toEqual(['a', 'b c', 'd e', 'f'])
  })

  it('attributes load balancer lines by API path, and skips non-tenant paths', () => {
    expect(parseAlbLine(albLine(`/api/v1/${P}/db/todos?limit=5`, 1234))).toEqual({ day: '2026-09-27', bytes: 1234, projectId: P })
    expect(parseAlbLine(albLine(`/api/v2/${P}/todos`, 99))).toEqual({ day: '2026-09-27', bytes: 99, projectId: P })
    expect(parseAlbLine(albLine(`/api/storage/files/${F}/download`, 5000))).toEqual({ day: '2026-09-27', bytes: 5000, fileId: F })
    expect(parseAlbLine(albLine('/pricing', 90000))).toBeNull()
    expect(parseAlbLine(albLine('/api/projects', 700))).toBeNull()
    expect(parseAlbLine('garbage')).toBeNull()
  })

  it('counts only presigned S3 downloads, by either key layout', () => {
    expect(parseS3Line(s3Line(`${P}/bucket-1/photo.png`, 4096, 'QueryString'))).toEqual({ day: '2026-09-27', bytes: 4096, projectId: P })
    expect(parseS3Line(s3Line(`projects/${P}/exports/db.dump`, 777, 'QueryString'))).toEqual({ day: '2026-09-27', bytes: 777, projectId: P })
    // The app reading an object through the SDK serves it on itself: already counted.
    expect(parseS3Line(s3Line(`${P}/bucket-1/photo.png`, 4096, 'AuthHeader'))).toBeNull()
    expect(parseS3Line(s3Line(`${P}/bucket-1/photo.png`, 0, 'QueryString', 'REST.PUT.OBJECT'))).toBeNull()
    expect(parseS3Line(s3Line(`recovery/hetzner-final/archive.tgz`, 9999, 'QueryString'))).toBeNull()
  })

  it('reads CloudFront standard logs by their #Fields header', () => {
    const log = [
      '#Version: 1.0',
      '#Fields: date time x-edge-location sc-bytes c-ip cs-method cs(Host) cs-uri-stem sc-status',
      `2026-09-27\t10:00:00\tBOM78-P1\t2048\t203.0.113.1\tGET\td111.cloudfront.net\t/${P}/bucket/a.png\t200`,
      `2026-09-27\t10:00:05\tBOM78-P1\t999\t203.0.113.1\tGET\td111.cloudfront.net\t/favicon.ico\t200`,
    ].join('\n')
    expect(parseCloudFront(log)).toEqual([{ day: '2026-09-27', bytes: 2048, projectId: P }])
  })

  it('reads the log source configuration', () => {
    expect(logSourcesFromEnv({ USAGE_LOG_SOURCES: 'alb=s3://logs/alb/,s3=s3://logs/s3,cloudfront=s3://cf' } as any)).toEqual([
      { kind: 'alb', bucket: 'logs', prefix: 'alb/' },
      { kind: 's3', bucket: 'logs', prefix: 's3' },
      { kind: 'cloudfront', bucket: 'cf', prefix: '' },
    ])
    expect(logSourcesFromEnv({} as any)).toEqual([])
    expect(() => logSourcesFromEnv({ USAGE_LOG_SOURCES: 'alb=http://x' } as any)).toThrow(/kind=s3/)
  })
})

describe('ingesting', () => {
  it('attributes by project and file, and applies each log object exactly once', async () => {
    const user = await prisma.user.create({ data: { email: `ingest-${randomUUID()}@test.invalid`, name: 'Ingest' }, select: { id: true } })
    users.push(user.id)
    const project = await prisma.project.create({ data: { name: 'ingest', userId: user.id }, select: { id: true } })
    projects.push(project.id)
    const bucket = await prisma.storageBucket.create({ data: { name: `b-${randomUUID().slice(0, 6)}`, projectId: project.id } })
    const file = await prisma.storageFile.create({
      data: { bucketId: bucket.id, projectId: project.id, name: 'a.png', path: `${project.id}/${bucket.id}/a.png`, size: BigInt(10) },
    })

    const albKey = `alb/AWSLogs/510155707664/elasticloadbalancing/ap-south-1/2026/09/27/log-${randomUUID()}.log.gz`
    const s3Key = `s3/2026-09-27-10-15-02-${randomUUID()}`
    batchIds.push(`log:s3://logs/${albKey}`, `log:s3://logs/${s3Key}`)
    const objects: Record<string, Buffer> = {
      [albKey]: gzipSync(
        [
          albLine(`/api/v1/${project.id}/db/todos`, 1000),
          albLine(`/api/v2/${project.id}/todos`, 500),
          albLine(`/api/storage/files/${file.id}/download`, 10_000),
          albLine('/pricing', 99_999),
        ].join('\n'),
      ),
      [s3Key]: Buffer.from(
        [s3Line(`${project.id}/${bucket.id}/a.png`, 4096, 'QueryString'), s3Line(`${project.id}/${bucket.id}/a.png`, 4096, 'AuthHeader')].join('\n'),
      ),
    }
    const store: LogObjectStore = {
      async list(_b, prefix) {
        return Object.keys(objects).filter((k) => k.startsWith(prefix)).map((key) => ({ key }))
      },
      async get(_b, key) {
        return objects[key]
      },
    }
    const sources = [
      { kind: 'alb' as const, bucket: 'logs', prefix: 'alb/' },
      { kind: 's3' as const, bucket: 'logs', prefix: 's3/' },
    ]

    const first = await ingestLogs(sources, store)
    expect(first.objects).toBe(2)
    const second = await ingestLogs(sources, store)
    expect(second.objects).toBe(0)
    expect(second.alreadyApplied).toBe(2)

    const rows = await prisma.usageDaily.findMany({ where: { projectId: project.id, axis: 'egress_bytes' } })
    const q = (source: string) => rows.find((r) => r.source === source)?.quantity
    expect(q('alb')).toBe(BigInt(11_500)) // 1000 + 500 + the file download; /pricing is not tenant egress
    expect(q('s3')).toBe(BigInt(4096)) // the presigned download only
    expect(rows.every((r) => r.billingAccountId === user.id)).toBe(true)
  })
})
