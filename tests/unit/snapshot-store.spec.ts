/**
 * Database snapshots in an S3 bucket (lib/services/snapshot-store.ts).
 *
 * The round trip runs against a small in-process S3-compatible server, path
 * style, so the real SDK does the real requests: the property is what the store
 * does with what S3 answers (stores whole, refuses a damaged object, never
 * counts an incomplete upload), which a stub of the store itself could not show.
 * The real bucket is exercised by the release qualification.
 */
import type { IncomingMessage, Server, ServerResponse } from 'http'
import { Agent, createServer } from 'https'
import { S3Client } from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { AddressInfo } from 'net'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'

type Stored = { body: Buffer; headers: Record<string, string> }
const objects = new Map<string, Stored>()
let server: Server
let truncateNextPut = false

/** Decode an aws-chunked body, in case the SDK streams one. */
function dechunk(raw: Buffer): Buffer {
  const out: Buffer[] = []
  let i = 0
  while (i < raw.length) {
    const eol = raw.indexOf('\r\n', i)
    if (eol < 0) break
    const size = parseInt(raw.slice(i, eol).toString().split(';')[0], 16)
    if (!size) break
    out.push(raw.slice(eol + 2, eol + 2 + size))
    i = eol + 2 + size + 2
  }
  return Buffer.concat(out)
}

function handle(req: IncomingMessage, res: ServerResponse, body: Buffer) {
  const [rawPath, query = ''] = (req.url ?? '').split('?')
  const key = decodeURIComponent(rawPath)
  const params = new URLSearchParams(query)
  const bucketPath = `/${key.split('/')[1]}/`
  if (req.method === 'GET' && params.get('list-type') === '2') {
    const prefix = params.get('prefix') ?? ''
    const keys = [...objects.keys()].filter((k) => k.startsWith(bucketPath + prefix)).map((k) => k.slice(bucketPath.length))
    res.writeHead(200, { 'Content-Type': 'application/xml' })
    res.end(`<ListBucketResult><Name>x</Name><Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount>` +
      `<IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`)
    return
  }
  if (req.method === 'POST' && params.has('delete')) {
    for (const m of body.toString().matchAll(/<Key>([^<]+)<\/Key>/g)) objects.delete(bucketPath + m[1])
    res.writeHead(200, { 'Content-Type': 'application/xml' }).end('<DeleteResult></DeleteResult>')
    return
  }
  if (req.method === 'PUT') {
    const chunked = String(req.headers['content-encoding'] ?? '').includes('aws-chunked') ||
      String(req.headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING')
    let data = chunked ? dechunk(body) : body
    if (truncateNextPut) { data = data.slice(0, Math.floor(data.length / 2)); truncateNextPut = false }
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.startsWith('x-amz-meta-') || k === 'x-amz-checksum-sha256' || k === 'content-type') headers[k] = String(v)
    }
    objects.set(key, { body: data, headers })
    res.writeHead(200, { ETag: '"x"' }).end()
    return
  }
  const obj = objects.get(key)
  if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); return }
  if (!obj) {
    res.writeHead(404, { 'Content-Type': 'application/xml' })
    res.end(req.method === 'HEAD' ? undefined : '<Error><Code>NoSuchKey</Code><Message>no</Message></Error>')
    return
  }
  const headers: Record<string, string> = { 'Content-Length': String(obj.body.length), ETag: '"x"', ...obj.headers }
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : obj.body)
}

let store: typeof import('@/lib/services/snapshot-store')
const dir = mkdtempSync(join(tmpdir(), 'snapstore-'))
const PROJECT = '11111111-2222-3333-4444-555555555555'

let s3: S3Client

beforeAll(async () => {
  // HTTPS, not HTTP: for an http: endpoint the SDK's handler loads node:http with
  // a dynamic import(), which Jest's CommonJS runtime cannot perform. A throwaway
  // certificate for 127.0.0.1, trusted by this file's client alone (verified, not
  // disabled), keeps the SDK on the same https path it takes against a bucket.
  const key = join(dir, 'k.pem')
  const cert = join(dir, 'c.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
  server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => handle(req, res, Buffer.concat(chunks)))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  s3 = new S3Client({
    endpoint: `https://127.0.0.1:${port}`,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test-secret' },
    requestHandler: new NodeHttpHandler({ httpsAgent: new Agent({ ca: readFileSync(cert) }) }),
  })
  process.env.BACKUP_S3_BUCKET = 'snapshots-test'
  delete process.env.BACKUP_S3_PREFIX
  store = require('@/lib/services/snapshot-store')
})

afterAll(async () => {
  s3?.destroy()
  await new Promise<void>((r) => server.close(() => r()))
})

describe('locations', () => {
  it('parses and builds s3:// locations under the project prefix', () => {
    const loc = store.s3Location('snapshots-test', store.snapshotKey(PROJECT, 'a.sql.gz'))
    expect(loc).toBe(`s3://snapshots-test/workspace-snapshots/${PROJECT}/a.sql.gz`)
    expect(store.parseS3Location(loc)).toEqual({ bucket: 'snapshots-test', key: `workspace-snapshots/${PROJECT}/a.sql.gz` })
    expect(store.isS3Location('/app/backups/x.sql.gz')).toBe(false)
  })

  it('only lets a project read its own snapshots in the configured bucket', () => {
    const own = `s3://snapshots-test/workspace-snapshots/${PROJECT}/a.sql.gz`
    expect(store.s3LocationBelongsTo(own, PROJECT)).toBe(true)
    expect(store.s3LocationBelongsTo(own, '99999999-2222-3333-4444-555555555555')).toBe(false)
    expect(store.s3LocationBelongsTo(`s3://other-bucket/workspace-snapshots/${PROJECT}/a.sql.gz`, PROJECT)).toBe(false)
    expect(store.s3LocationBelongsTo(`s3://snapshots-test/workspace-snapshots/${PROJECT}/nested/a.sql.gz`, PROJECT)).toBe(false)
    expect(store.s3LocationBelongsTo(`s3://snapshots-test/workspace-snapshots/${PROJECT}/..`, PROJECT)).toBe(false)
    expect(store.s3LocationBelongsTo('s3://snapshots-test', PROJECT)).toBe(false)
  })
})

describe('the round trip', () => {
  it('uploads, verifies, downloads byte-identical, and deletes', async () => {
    const src = join(dir, 'dump.sql.gz')
    const bytes = randomBytes(256 * 1024 + 17)
    writeFileSync(src, bytes)
    const put = await store.putSnapshot(PROJECT, 'dump.sql.gz', src, s3)
    expect(put.sizeBytes).toBe(bytes.length)
    expect(put.location).toBe(`s3://snapshots-test/workspace-snapshots/${PROJECT}/dump.sql.gz`)

    const dest = join(dir, 'back.sql.gz')
    await store.fetchSnapshotToFile(put.location, dest, s3)
    expect(readFileSync(dest).equals(bytes)).toBe(true)

    await store.deleteSnapshot(put.location, s3)
    expect(objects.has(`/snapshots-test/workspace-snapshots/${PROJECT}/dump.sql.gz`)).toBe(false)
  })

  it('refuses to restore an object whose bytes are not the dump that was taken', async () => {
    const src = join(dir, 'dump2.sql.gz')
    writeFileSync(src, randomBytes(4096))
    const put = await store.putSnapshot(PROJECT, 'dump2.sql.gz', src, s3)
    const stored = objects.get(`/snapshots-test/workspace-snapshots/${PROJECT}/dump2.sql.gz`)!
    stored.body = Buffer.concat([stored.body.slice(0, 100), Buffer.from('tampered'), stored.body.slice(108)])
    const dest = join(dir, 'bad.sql.gz')
    await expect(store.fetchSnapshotToFile(put.location, dest, s3)).rejects.toThrow()
    // Nothing is left where a restore could pick it up.
    expect(existsSync(dest)).toBe(false)
  })

  it('never reports an upload that did not arrive whole', async () => {
    const src = join(dir, 'dump3.sql.gz')
    writeFileSync(src, randomBytes(8192))
    truncateNextPut = true
    await expect(store.putSnapshot(PROJECT, 'dump3.sql.gz', src, s3)).rejects.toThrow(/upload incomplete/)
  })
})

describe('project deletion', () => {
  it("removes every snapshot of the deleted project and nothing of another's", async () => {
    // A project of its own: the tests above leave objects under PROJECT.
    const GONE = '22222222-2222-3333-4444-555555555555'
    const OTHER = '99999999-2222-3333-4444-555555555555'
    const src = join(dir, 'p.sql.gz')
    writeFileSync(src, randomBytes(1024))
    await store.putSnapshot(GONE, 'one.sql.gz', src, s3)
    await store.putSnapshot(GONE, 'two.sql.gz', src, s3)
    const kept = await store.putSnapshot(OTHER, 'one.sql.gz', src, s3)

    await expect(store.purgeProjectSnapshots(GONE, s3)).resolves.toBe(2)
    await expect(store.purgeProjectSnapshots(GONE, s3)).resolves.toBe(0) // idempotent

    const left = [...objects.keys()]
    expect(left.some((k) => k.includes(`/${GONE}/`))).toBe(false)
    expect(left).toContain(`/snapshots-test/${store.parseS3Location(kept.location).key}`)
    expect(left.some((k) => k.includes(`/${PROJECT}/`))).toBe(true)
  })

  it('refuses anything that is not a project id, so a prefix can never widen', async () => {
    await expect(store.purgeProjectSnapshots('', s3)).rejects.toThrow()
    await expect(store.purgeProjectSnapshots('../x', s3)).rejects.toThrow()
  })
})
