/**
 * Where database snapshots live (lib/services/workspace-backup.ts).
 *
 * Two stores:
 *   - the backup directory on local or network disk (BACKUP_DIR), what every
 *     snapshot used until now;
 *   - an S3 bucket (BACKUP_S3_BUCKET), on the platform's one S3 client, so the
 *     region, endpoint and credentials are the storage layer's own.
 *
 * A snapshot's row records its LOCATION (a path, or s3://bucket/key), and the
 * store is chosen from that, per snapshot, never per deployment. So a
 * deployment that switches to S3 leaves every earlier snapshot restorable,
 * downloadable and prunable where it already is. New snapshots go to S3 when
 * BACKUP_S3_BUCKET is set.
 *
 * Why S3 on Backenly Cloud: seven daily dumps per project on EFS Standard cost
 * $0.33 per GB-month in Mumbai, which by itself put the cost of a database GB
 * above any sustainable overage rate. S3 Standard is $0.025.
 *
 * Integrity is end to end: the SHA-256 of the compressed dump is taken from the
 * file on disk, sent to S3 as the object's checksum (S3 refuses a body that
 * does not match) and stored as object metadata. A restore hashes its copy
 * against that before anything touches the schema. A download is streamed, so
 * it cannot be checked first; it is read with checksum validation on, and a
 * body that does not match fails the stream instead of completing.
 *
 * Deletes are real. The bucket keeps no versions, so pruning a snapshot or
 * deleting its project removes the bytes rather than hiding them.
 */

import { createHash } from 'crypto'
import { createReadStream, createWriteStream, promises as fsp } from 'fs'
import type { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import type { S3Client } from '@aws-sdk/client-s3'
import { getS3Client } from '@/lib/services/s3-config'
import { assertValidProjectId } from '@/lib/security/workspace-schema'

const S3_SCHEME = 's3://'

/**
 * The client, built only when a snapshot actually touches S3: a disk-only
 * install never configures S3, and deleting or reading a snapshot on disk must
 * not depend on it.
 */
function client(s3?: S3Client): S3Client {
  return s3 ?? getS3Client()
}
const SHA_META = 'sha256'

/** The bucket new snapshots go to, or null to keep them on disk. */
export function snapshotBucket(): string | null {
  const bucket = process.env.BACKUP_S3_BUCKET?.trim()
  return bucket ? bucket : null
}

export function snapshotPrefix(): string {
  return (process.env.BACKUP_S3_PREFIX?.trim() || 'workspace-snapshots').replace(/^\/+|\/+$/g, '')
}

export function isS3Location(location: string): boolean {
  return location.startsWith(S3_SCHEME)
}

export function s3Location(bucket: string, key: string): string {
  return `${S3_SCHEME}${bucket}/${key}`
}

export function parseS3Location(location: string): { bucket: string; key: string } {
  if (!isS3Location(location)) throw new Error('not an s3:// snapshot location')
  const rest = location.slice(S3_SCHEME.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) throw new Error('malformed s3:// snapshot location')
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) }
}

/** The key a project's snapshot is stored under. */
export function snapshotKey(projectId: string, filename: string): string {
  return `${snapshotPrefix()}/${projectId}/${filename}`
}

/**
 * Whether an s3:// location may be read on behalf of this project: the
 * configured bucket, under this project's own prefix, one level deep. The
 * location comes from the database, and a row that pointed anywhere else must
 * not become a way to read another project's snapshot or another bucket.
 */
export function s3LocationBelongsTo(location: string, projectId: string): boolean {
  let parsed: { bucket: string; key: string }
  try {
    parsed = parseS3Location(location)
  } catch {
    return false
  }
  const bucket = snapshotBucket()
  if (!bucket || parsed.bucket !== bucket) return false
  const dir = `${snapshotPrefix()}/${projectId}/`
  if (!parsed.key.startsWith(dir)) return false
  const name = parsed.key.slice(dir.length)
  return name.length > 0 && !name.includes('/') && !name.includes('..')
}

/** Base64 SHA-256 of a file, the form S3's checksum header takes. */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(/*turbopackIgnore: true*/ path)) hash.update(chunk as Buffer)
  return hash.digest('base64')
}

/**
 * Upload a finished snapshot and prove it arrived whole before returning. Any
 * failure throws, so the caller records the snapshot as failed and never as
 * completed.
 */
export async function putSnapshot(
  projectId: string,
  filename: string,
  localPath: string,
  s3?: S3Client,
): Promise<{ location: string; sizeBytes: number; sha256: string }> {
  const bucket = snapshotBucket()
  if (!bucket) throw new Error('BACKUP_S3_BUCKET is not set')
  const key = snapshotKey(projectId, filename)
  const { size } = await fsp.stat(/*turbopackIgnore: true*/ localPath)
  const sha256 = await sha256OfFile(localPath)

  await client(s3).send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(/*turbopackIgnore: true*/ localPath),
      ContentLength: size,
      ContentType: 'application/gzip',
      ChecksumSHA256: sha256,
      ServerSideEncryption: 'AES256',
      Metadata: { [SHA_META]: sha256, project: projectId },
    }),
  )

  // Arrived, and arrived whole: the size and the checksum S3 recorded must be
  // exactly what left the disk.
  const head = await client(s3).send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }))
  if (Number(head.ContentLength) !== size) {
    throw new Error(`snapshot upload incomplete: ${head.ContentLength} of ${size} bytes stored`)
  }
  if (head.Metadata?.[SHA_META] !== sha256) {
    throw new Error('snapshot upload unverified: stored checksum does not match the dump')
  }
  return { location: s3Location(bucket, key), sizeBytes: size, sha256 }
}

/**
 * Copy a snapshot to a local file for restore, and refuse it unless its bytes
 * hash to the checksum recorded when it was taken.
 */
export async function fetchSnapshotToFile(
  location: string,
  destPath: string,
  s3?: S3Client,
): Promise<void> {
  const { bucket, key } = parseS3Location(location)
  try {
    const res = await client(s3).send(new GetObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }))
    if (!res.Body) throw new Error('snapshot object has no body')
    const expected = res.Metadata?.[SHA_META]
    if (!expected) throw new Error('snapshot has no recorded checksum; refusing to trust it')
    await pipeline(res.Body as Readable, createWriteStream(/*turbopackIgnore: true*/ destPath))
    if ((await sha256OfFile(destPath)) !== expected) {
      throw new Error('snapshot checksum mismatch: the stored object is not the dump that was taken')
    }
  } catch (err) {
    // Nothing partial or unverified is left where a restore could pick it up.
    await fsp.unlink(/*turbopackIgnore: true*/ destPath).catch(() => {})
    throw err
  }
}

/** A readable stream of a stored snapshot, for handing it to its owner. */
export async function openS3Snapshot(
  location: string,
  s3?: S3Client,
): Promise<{ stream: Readable; sizeBytes: number }> {
  const { bucket, key } = parseS3Location(location)
  const res = await client(s3).send(new GetObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }))
  if (!res.Body) throw new Error('snapshot object has no body')
  return { stream: res.Body as Readable, sizeBytes: Number(res.ContentLength ?? 0) }
}

/** Delete a snapshot wherever it is. A snapshot already gone is not an error. */
export async function deleteSnapshot(location: string, s3?: S3Client): Promise<void> {
  if (!location) return
  if (isS3Location(location)) {
    const { bucket, key } = parseS3Location(location)
    await client(s3).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    return
  }
  await fsp.unlink(/*turbopackIgnore: true*/ location).catch(() => {})
}

/**
 * Delete every snapshot a project has in the bucket, for project deletion
 * (lib/projects/purge.ts): a deleted project's dumps are the densest copy of
 * its data and must not outlive it. Idempotent. Returns how many objects went,
 * or null when no snapshot bucket is configured. Throws if any object could not
 * be deleted, so the purge job stays queued.
 */
export async function purgeProjectSnapshots(
  projectId: string,
  s3?: S3Client,
): Promise<number | null> {
  assertValidProjectId(projectId)
  const bucket = snapshotBucket()
  if (!bucket) return null
  const prefix = `${snapshotPrefix()}/${projectId}/`

  let deleted = 0
  let token: string | undefined
  do {
    const listed = await client(s3).send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
    const keys = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string' && k.startsWith(prefix))
    if (keys.length > 0) {
      const res = await client(s3).send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }),
      )
      if (res.Errors?.length) {
        throw new Error(`could not delete ${res.Errors.length} snapshot(s) of ${projectId}: ${res.Errors[0].Code}`)
      }
      deleted += keys.length
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined
  } while (token)
  return deleted
}
