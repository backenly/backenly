/**
 * External purge — the half of project deletion that cannot be transactional.
 *
 * The database phase (lib/projects/delete.ts) drops every schema and deletes
 * every relational row in ONE PostgreSQL transaction, so it is atomic. Files
 * cannot join that transaction: a filesystem unlink and an S3 DeleteObjects do
 * not roll back. This module is what finishes the job afterwards, and it is
 * written to be run more than once.
 *
 * WHAT IS OUT HERE
 *
 *   1. Backup dumps  — `<BACKUP_DIR>/<projectId>/*.sql.gz`, one full pg_dump of
 *                      the workspace per day (lib/services/workspace-backup.ts).
 *                      The densest copy of a customer's data on the box.
 *   2. Storage objects — local `<STORAGE_DIR>/<projectId>/<bucket>/…`, or S3
 *                      keys under the `<projectId>/` prefix
 *                      (generateUniqueStoragePath in lib/storage/storage-lifecycle.ts).
 *
 * IDEMPOTENCE IS THE WHOLE DESIGN
 *
 * This runs immediately after the database commits, and again from the retry
 * worker if that attempt failed or the process died. So every operation treats
 * "already gone" as success: a missing directory, a missing key, an empty
 * prefix listing. The only failures that count are the ones that mean data is
 * still there — a permission error, an I/O error, an unreachable bucket.
 *
 * SCOPING IS ENFORCED, NOT ASSUMED
 *
 * Both targets are derived from the project id alone and validated before any
 * recursive delete. A bug that widened a prefix here would delete other
 * customers' files, so the guards below refuse rather than trust: the resolved
 * path must sit strictly inside its configured root, and the S3 prefix must be
 * a validated UUID followed by a slash. Nothing accepts a caller-supplied path.
 */

import { promises as fs } from 'fs'
import * as path from 'path'
import { assertValidProjectId } from '@/lib/security/workspace-schema'

/** Per-resource outcome. `alreadyAbsent` is a success, not a failure. */
export type PurgeResourceStatus = 'purged' | 'alreadyAbsent' | 'skipped'

export interface PurgeReport {
  projectId: string
  backups: PurgeResourceStatus
  storage: PurgeResourceStatus
  /** Objects removed from S3. Always 0 for the local driver. */
  objectsDeleted: number
}

/** Thrown when a computed target fails its safety check. Never retried blindly. */
export class UnsafePurgeTargetError extends Error {
  constructor(reason: string) {
    super(`Refusing to purge: ${reason}`)
    this.name = 'UnsafePurgeTargetError'
  }
}

// ─── Roots ───────────────────────────────────────────────────────────────────
//
// Read at call time, not module load, so tests can point them at a temp dir and
// so a self-hosted deployment can configure them. Defaults match the modules
// that write the data: workspace-backup.ts and services/storage.ts.

function backupRoot(): string {
  return process.env.BACKUP_DIR || path.join(process.cwd(), 'backups')
}

function storageRoot(): string {
  return process.env.STORAGE_DIR || path.join(process.cwd(), 'storage')
}

function storageDriver(): string {
  return process.env.STORAGE_DRIVER || 'local'
}

export interface PurgeOptions {
  /**
   * Which storage backend the project's files were written to, captured when
   * the purge was enqueued.
   *
   * The roots (BACKUP_DIR, STORAGE_DIR) are resolved at execution time on
   * purpose: they are process configuration, and writing absolute paths into a
   * database row would put the deployment's filesystem layout somewhere it
   * outlives the deployment. The DRIVER is different. It selects which backend
   * is searched at all, so if an operator flips STORAGE_DRIVER between the
   * deletion and a retry, a retry resolving it live would look in the new
   * backend, find nothing, and report success while the files sit untouched in
   * the old one. Recording the kind — a two-value enum, not a secret — makes
   * the retry target what the deletion targeted.
   */
  storageDriver?: string
}

// ─── Safety ──────────────────────────────────────────────────────────────────

/**
 * Assert that `target` is a real child of `root`, so a recursive delete cannot
 * escape the configured directory.
 *
 * Checks, in order, the four ways this goes wrong in practice: an empty root
 * (unset env collapsing to ''), a target equal to the root (which would delete
 * every project's data at once), a filesystem root, and traversal out of the
 * tree. `path.relative` is the load-bearing one — it normalises `..` segments
 * and symlink-free lexical escapes that a `startsWith` check alone misses.
 */
export function assertSafeChildPath(root: string, target: string): void {
  if (!root || !root.trim()) throw new UnsafePurgeTargetError('root directory is empty')
  if (!target || !target.trim()) throw new UnsafePurgeTargetError('target path is empty')

  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)

  if (resolvedTarget === resolvedRoot) {
    throw new UnsafePurgeTargetError('target is the root itself')
  }
  if (resolvedTarget === path.parse(resolvedTarget).root) {
    throw new UnsafePurgeTargetError('target is a filesystem root')
  }

  const rel = path.relative(resolvedRoot, resolvedTarget)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UnsafePurgeTargetError('target escapes its configured root')
  }
}

/**
 * The S3 key prefix for one project: `<uuid>/`.
 *
 * The trailing slash is not cosmetic. Without it, prefix `abc` would also match
 * a project whose id merely starts with those characters. With a validated UUID
 * and a slash, the prefix matches exactly one project's keys.
 */
export function projectStoragePrefix(projectId: string): string {
  assertValidProjectId(projectId)
  return `${projectId}/`
}

// ─── Filesystem ──────────────────────────────────────────────────────────────

/**
 * Recursively remove a directory that has already passed assertSafeChildPath.
 * A missing directory counts as already purged.
 */
async function removeDirectory(root: string, target: string): Promise<PurgeResourceStatus> {
  assertSafeChildPath(root, target)

  try {
    await fs.stat(target)
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 'alreadyAbsent'
    throw err
  }

  // `force` swallows ENOENT on entries that vanish mid-walk, which is exactly
  // the race a concurrent retry creates. It does NOT swallow permission or I/O
  // errors, so a genuine failure still surfaces and the job stays retryable.
  await fs.rm(target, { recursive: true, force: true })
  return 'purged'
}

// ─── S3 ──────────────────────────────────────────────────────────────────────

/**
 * Delete every object under `<projectId>/`, paging until the prefix is empty.
 *
 * Imported lazily so the local driver never loads the AWS SDK, and so a
 * deployment without S3 configured does not pay for it.
 */
async function purgeS3Prefix(projectId: string): Promise<{ status: PurgeResourceStatus; deleted: number }> {
  const prefix = projectStoragePrefix(projectId)
  if (!prefix || prefix === '/' || prefix.length < 2) {
    throw new UnsafePurgeTargetError('computed storage prefix is too broad')
  }

  const { isS3Configured, getS3Client, getS3Config } = await import('@/lib/services/s3-config')
  if (!isS3Configured()) return { status: 'skipped', deleted: 0 }

  const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3')
  const client = getS3Client()
  const { bucket } = getS3Config()

  let deleted = 0
  let continuationToken: string | undefined

  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )

    const keys = (listed.Contents ?? [])
      .map((o) => o.Key)
      .filter((k): k is string => typeof k === 'string' && k.startsWith(prefix))

    if (keys.length > 0) {
      // DeleteObjects caps at 1000 keys per call, which is also ListObjectsV2's
      // default page size — so one page maps to at most one delete call.
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
        }),
      )
      deleted += keys.length
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined
  } while (continuationToken)

  return { status: deleted > 0 ? 'purged' : 'alreadyAbsent', deleted }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Remove everything a project owns outside PostgreSQL.
 *
 * Safe to call repeatedly. Throws only when something is still present and
 * could not be removed — the caller (immediate attempt or retry worker) treats
 * a throw as "leave the job queued".
 */
export async function purgeProjectExternals(
  projectId: string,
  options: PurgeOptions = {},
): Promise<PurgeReport> {
  assertValidProjectId(projectId)

  const backups = await removeDirectory(backupRoot(), path.join(backupRoot(), projectId))

  let storage: PurgeResourceStatus
  let objectsDeleted = 0

  // Snapshot wins; live config is the fallback for a job written before the
  // field existed.
  const driver = options.storageDriver || storageDriver()

  if (driver === 's3') {
    const result = await purgeS3Prefix(projectId)
    storage = result.status
    objectsDeleted = result.deleted
  } else {
    storage = await removeDirectory(storageRoot(), path.join(storageRoot(), projectId))
  }

  return { projectId, backups, storage, objectsDeleted }
}
