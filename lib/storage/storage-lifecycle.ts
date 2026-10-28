/**
 * Storage Lifecycle Management
 * 
 * SYSTEM-LEVEL SAFETY CONTROLS (NO UI)
 * 
 * ═══════════════════════════════════════════════════════════════════════
 * AUTOMATIC SAFETY ENFORCEMENT
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * REQUIREMENTS:
 * - Cryptographically unique object paths (no collisions)
 * - Presigned URLs only (no direct access)
 * - Automatic quota enforcement (hard limits)
 * - Automatic lifecycle cleanup (orphan detection)
 * - DB ↔ storage reconciliation (consistency checks)
 * 
 * CONSTRAINTS:
 * - No storage UI (no file browsing)
 * - No user cleanup tools (automatic only)
 * - No manual intervention required
 * 
 * SUCCESS:
 * - Storage cannot silently grow or leak
 * - No orphaned files
 * - No quota violations
 * - Audit-compliant safety
 */

import { PrismaClient } from '@prisma/client'
import { S3Client, ListObjectsV2Command, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import crypto from 'crypto'
import { getProjectQuota } from '@/lib/services/storageQuota'
import { MAX_BUFFERED_UPLOAD_BYTES } from '@/lib/storage/upload-policy'
import { heldInRegionWhere, serviceRegion } from '@/lib/data-plane/serving'
import type { CloudRegionId } from '@/lib/regions'

const prisma = new PrismaClient()

/**
 * Storage Quota Configuration
 * 
 * HARD LIMITS - Cannot be exceeded
 */
export interface StorageQuota {
  /**
   * Max storage per project (bytes). Unset means the owner's plan decides, via
   * getProjectQuota. A hardcoded 10 GB used to sit here, below Pro's advertised
   * 100 GB, so the plan was not the limit on the S3 path.
   */
  maxProjectSize?: bigint
  maxFileSize: bigint          // Max single file size (bytes)
  maxFileCount: number         // Max files per project
  maxOrphansAllowed: number    // Max orphaned files before alert
}

/**
 * Default quotas (production-safe)
 */
const DEFAULT_QUOTAS: StorageQuota = {
  maxFileSize: MAX_BUFFERED_UPLOAD_BYTES,            // the shared per-upload ceiling (upload-policy.ts)
  maxFileCount: 10000,                                // 10k files per project
  maxOrphansAllowed: 100,                             // Max 100 orphans before alert
}

/**
 * What an upload of `fileSize` is measured against: an explicit per-project
 * override against this project's own bytes, else the owner's plan against the
 * bytes of every project the owner has (storageQuota.ts owns that rule).
 */
async function sizeCheck(
  projectId: string,
  projectUsed: bigint,
  fileSize: bigint,
  quotas: StorageQuota,
): Promise<{ used: bigint; cap: bigint }> {
  if (quotas.maxProjectSize !== undefined) return { used: projectUsed, cap: quotas.maxProjectSize }
  const quota = await getProjectQuota(projectId, fileSize)
  return { used: quota.used, cap: quota.limit }
}

/**
 * Generate cryptographically unique storage path
 * 
 * Format: {projectId}/{bucketId}/{uuid}-{randomHash}.{ext}
 * 
 * GUARANTEES:
 * - No collisions (UUID + 16-byte random hash)
 * - Project namespace isolation
 * - Bucket organization
 * - Traceable to database record
 */
export function generateUniqueStoragePath(
  projectId: string,
  bucketId: string,
  fileName: string
): { path: string; fileId: string } {
  // Generate cryptographically unique identifier
  const fileId = crypto.randomUUID()
  const randomHash = crypto.randomBytes(16).toString('hex')
  
  // Extract extension
  const ext = fileName.includes('.')
    ? fileName.substring(fileName.lastIndexOf('.'))
    : ''
  
  // Build path: {projectId}/{bucketId}/{fileId}-{hash}.{ext}
  const path = `${projectId}/${bucketId}/${fileId}-${randomHash}${ext}`
  
  return { path, fileId }
}

/**
 * Enforce storage quota BEFORE upload
 * 
 * HARD ENFORCEMENT:
 * - Rejects upload if quota exceeded
 * - No grace period
 * - No overrides
 */
export async function enforceStorageQuota(
  projectId: string,
  fileSize: bigint,
  quotas: StorageQuota = DEFAULT_QUOTAS
): Promise<{ allowed: boolean; reason?: string; current: bigint }> {
  // Get current project storage usage
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      storageUsed: true,
    },
  })
  
  if (!project) {
    return {
      allowed: false,
      reason: 'Project not found',
      current: BigInt(0),
    }
  }
  
  // Count files separately
  const currentFileCount = await prisma.storageFile.count({
    where: {
      projectId,
      deletedAt: null,
    },
  })
  
  const currentUsage = project.storageUsed || BigInt(0)
  
  // Check file size limit
  if (fileSize > quotas.maxFileSize) {
    return {
      allowed: false,
      reason: `File exceeds maximum size limit (${formatBytes(quotas.maxFileSize)})`,
      current: currentUsage,
    }
  }
  
  // Check the storage limit (the account's, unless an explicit override is given)
  const { used, cap } = await sizeCheck(projectId, currentUsage, fileSize, quotas)
  if (used + fileSize > cap) {
    return {
      allowed: false,
      reason:
        quotas.maxProjectSize !== undefined
          ? `Project storage quota exceeded (${formatBytes(cap)} limit)`
          : `Storage quota exceeded (${formatBytes(cap)} limit, shared by all of your projects)`,
      current: currentUsage,
    }
  }
  
  // Check file count limit
  if (currentFileCount >= quotas.maxFileCount) {
    return {
      allowed: false,
      reason: `Project file count limit reached (${quotas.maxFileCount} files maximum)`,
      current: currentUsage,
    }
  }
  
  return {
    allowed: true,
    current: currentUsage,
  }
}

/**
 * Automatic lifecycle cleanup
 * 
 * RUNS AUTOMATICALLY:
 * - Soft-deleted files (>7 days old)
 * - Orphaned files (DB record missing)
 * - Failed uploads (incomplete records)
 * 
 * NO UI - System-level only
 */
export async function runLifecycleCleanup(
  s3Client: S3Client,
  bucketName: string,
  options: {
    softDeleteRetentionDays?: number
    dryRun?: boolean
    /**
     * The region whose projects keep their files in `bucketName`, this
     * process's by default. Only those projects' files are cleaned here
     * (safety rule 3 on detectAndCleanOrphans).
     */
    region?: CloudRegionId
  } = {}
): Promise<{
  deletedSoftDeletes: number
  deletedOrphans: number
  deletedIncomplete: number
  totalBytesFreed: bigint
  errors: string[]
}> {
  const softDeleteRetentionDays = options.softDeleteRetentionDays || 7
  const dryRun = options.dryRun || false
  const region = options.region ?? serviceRegion()

  const result = {
    deletedSoftDeletes: 0,
    deletedOrphans: 0,
    deletedIncomplete: 0,
    totalBytesFreed: BigInt(0),
    errors: [] as string[],
  }
  
  console.log(`[Lifecycle] Starting cleanup (dryRun=${dryRun})...`)
  
  try {
    // 1. Clean up soft-deleted files (>7 days old)
    const softDeleteCutoff = new Date(
      Date.now() - softDeleteRetentionDays * 24 * 60 * 60 * 1000
    )
    
    const softDeleted = await prisma.storageFile.findMany({
      where: {
        deletedAt: {
          lt: softDeleteCutoff,
        },
        // Only the files this bucket holds. Another region's are deleted from
        // that region's bucket, by that region's sweep: deleting the row here
        // would leave its object behind with nothing pointing at it.
        project: heldInRegionWhere(region),
      },
      select: {
        id: true,
        path: true,
        size: true,
        projectId: true,
      },
    })
    
    console.log(`[Lifecycle] Found ${softDeleted.length} soft-deleted files to clean`)
    
    for (const file of softDeleted) {
      try {
        if (!dryRun) {
          // Delete from S3
          await s3Client.send(
            new DeleteObjectCommand({
              Bucket: bucketName,
              Key: file.path,
            })
          )
          
          // Hard delete from database, and the names its region kept for it
          await prisma.storageFile.delete({
            where: { id: file.id },
          })
          const { forgetFileNames } = await import('@/lib/storage/file-names')
          await forgetFileNames(file.projectId, [file.id])
        }
        
        result.deletedSoftDeletes++
        result.totalBytesFreed += file.size
      } catch (error) {
        result.errors.push(`Failed to delete soft-deleted file ${file.id}: ${error}`)
      }
    }
    
    // 2. Detect and clean orphaned files (in storage but not in DB)
    const orphanResult = await detectAndCleanOrphans(
      s3Client,
      bucketName,
      dryRun,
      region
    )

    result.deletedOrphans = orphanResult.deletedCount
    result.totalBytesFreed += orphanResult.bytesFreed
    result.errors.push(...orphanResult.errors)

    // There is deliberately no third step. A `cleanIncompleteUploads` pass used
    // to live here, described as "records >1 hour old without corresponding
    // storage file" — but it never looked at storage. Its query was every
    // non-deleted row older than one hour, `take: 100`, soft-deleted
    // unconditionally: one hundred arbitrary LIVE files per run, fleet-wide,
    // until nothing was left. The honest version of that job — a row whose
    // object never arrived — is exactly the phantom branch of the orphan pass
    // above, which decides from the real bucket listing. `deletedIncomplete`
    // stays in the result shape for the cron route's report and is always 0.

    console.log(`[Lifecycle] Cleanup complete:`, result)
    
    return result
  } catch (error) {
    console.error(`[Lifecycle] Cleanup failed:`, error)
    result.errors.push(`Cleanup failed: ${error}`)
    return result
  }
}

/**
 * Detect orphaned files (storage ↔ DB reconciliation)
 *
 * ORPHAN DETECTION:
 * - Files exist in S3 but not in database
 * - Database records exist but not in S3 (phantom files)
 *
 * AUTOMATIC RESOLUTION:
 * - Delete S3 orphans (reclaim storage)
 * - Mark DB phantoms as deleted (fix inconsistency)
 *
 * THREE SAFETY RULES, the first two learned from this sweep deleting live data:
 *
 * 1. "Known to the database" means EVERY row, soft-deleted included. The
 *    known-paths set used to be `deletedAt: null` only, so the moment a user
 *    deleted a file its object stopped being known, and the next nightly run
 *    physically destroyed it as an "orphan" — six days inside the advertised
 *    seven-day recovery window. Only step 1 of runLifecycleCleanup, which
 *    honours the retention clock, may delete a soft-deleted file's object.
 *
 * 2. Both directions get a grace window. An upload is not atomic: the row and
 *    the object land seconds to minutes apart, in either order. An object
 *    younger than ORPHAN_OBJECT_GRACE_MS is never an orphan (its row may be a
 *    transaction away), and a row younger than PHANTOM_ROW_GRACE_MS is never a
 *    phantom (its object may still be uploading). An object with no
 *    LastModified is left alone: unknown age is not proof of abandonment.
 *
 * 3. A bucket answers only for the projects whose files it holds. Each region
 *    keeps its projects' files in its own bucket (lib/services/s3-config.ts
 *    s3LocationFor), so a project of another region has none of its objects
 *    in this listing, and every one of its rows would read as a phantom. Only
 *    `region`'s projects' rows are judged against the bucket. The known-paths
 *    set stays every row in every region: a path any row claims is never an
 *    orphan.
 */
const ORPHAN_OBJECT_GRACE_MS = 24 * 60 * 60 * 1000
const PHANTOM_ROW_GRACE_MS = 60 * 60 * 1000

export async function detectAndCleanOrphans(
  s3Client: S3Client,
  bucketName: string,
  dryRun: boolean = false,
  /** The region whose projects keep their files in `bucketName` (safety rule 3). */
  region: CloudRegionId = serviceRegion()
): Promise<{
  deletedCount: number
  bytesFreed: bigint
  errors: string[]
}> {
  const result = {
    deletedCount: 0,
    bytesFreed: BigInt(0),
    errors: [] as string[],
  }
  
  console.log(`[Orphan Detection] Scanning storage...`)
  
  try {
    // Get all files from S3, with their age — the age is a safety input.
    const s3Files = new Map<string, Date | undefined>()
    let continuationToken: string | undefined

    do {
      const listResponse = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: bucketName,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        })
      )

      if (listResponse.Contents) {
        for (const obj of listResponse.Contents) {
          if (obj.Key) {
            s3Files.set(obj.Key, obj.LastModified)
          }
        }
      }

      continuationToken = listResponse.NextContinuationToken
    } while (continuationToken)

    console.log(`[Orphan Detection] Found ${s3Files.size} files in S3`)

    // Every row the database knows, in every region, soft-deleted included: a
    // file inside its retention window still owns its object (safety rule 1
    // above), and a path any row claims is never an orphan (rule 3).
    const dbFilePaths = new Set(
      (await prisma.storageFile.findMany({ select: { path: true } })).map(f => f.path)
    )

    console.log(`[Orphan Detection] Found ${dbFilePaths.size} files known to the database`)

    // Find orphans: in S3, unknown to the database, and old enough that no
    // in-flight upload can still be about to claim them (safety rule 2).
    const orphanCutoff = Date.now() - ORPHAN_OBJECT_GRACE_MS
    const orphans = Array.from(s3Files.entries())
      .filter(([path, lastModified]) =>
        !dbFilePaths.has(path) &&
        lastModified !== undefined &&
        lastModified.getTime() < orphanCutoff
      )
      .map(([path]) => path)

    console.log(`[Orphan Detection] Found ${orphans.length} orphaned files`)
    
    // Delete orphans
    for (const orphanPath of orphans) {
      try {
        // Get file size before deletion
        const headResponse = await s3Client.send(
          new HeadObjectCommand({
            Bucket: bucketName,
            Key: orphanPath,
          })
        )
        
        const size = BigInt(headResponse.ContentLength || 0)
        
        if (!dryRun) {
          await s3Client.send(
            new DeleteObjectCommand({
              Bucket: bucketName,
              Key: orphanPath,
            })
          )
        }
        
        result.deletedCount++
        result.bytesFreed += size
      } catch (error) {
        result.errors.push(`Failed to delete orphan ${orphanPath}: ${error}`)
      }
    }
    
    // Find phantoms: live rows whose object is missing. This is also what
    // handles an upload that never completed — the row exists, the object
    // never arrived — which a deleted "incomplete uploads" pass used to guess
    // at by age alone. Rows younger than the grace window are skipped: their
    // object may still be on its way (safety rule 2). Soft-deleted rows are
    // already on the retention clock and need no second verdict. Only the rows
    // of the projects whose files this bucket holds (safety rule 3).
    const phantomCutoff = new Date(Date.now() - PHANTOM_ROW_GRACE_MS)
    const phantoms = (
      await prisma.storageFile.findMany({
        where: { deletedAt: null, createdAt: { lt: phantomCutoff }, project: heldInRegionWhere(region) },
        select: { id: true, path: true },
      })
    ).filter(f => !s3Files.has(f.path))

    if (phantoms.length > 0) {
      console.log(`[Orphan Detection] Found ${phantoms.length} phantom files (DB records without S3 objects)`)

      if (!dryRun) {
        // Soft delete phantom files
        await prisma.storageFile.updateMany({
          where: {
            id: { in: phantoms.map(p => p.id) },
            deletedAt: null,
          },
          data: {
            deletedAt: new Date(),
          },
        })
      }
    }
    
    return result
  } catch (error) {
    console.error(`[Orphan Detection] Failed:`, error)
    result.errors.push(`Orphan detection failed: ${error}`)
    return result
  }
}

/**
 * Get storage health metrics
 * 
 * MONITORING:
 * - Orphan count
 * - Quota usage
 * - Inconsistencies
 * - Soft-deleted retention
 */
export async function getStorageHealth(
  projectId: string
): Promise<{
  quotaUsage: number        // Percentage (0-100)
  fileCount: number
  orphanCount: number
  softDeletedCount: number
  inconsistencies: string[]
  needsCleanup: boolean
}> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      storageUsed: true,
    },
  })
  
  if (!project) {
    throw new Error('Project not found')
  }
  
  // Count files separately
  const fileCount = await prisma.storageFile.count({
    where: {
      projectId,
      deletedAt: null,
    },
  })
  
  const softDeleted = await prisma.storageFile.count({
    where: {
      projectId,
      deletedAt: { not: null },
    },
  })
  
  // The quota is the account's: report the account's use of it.
  const quota = await getProjectQuota(projectId)
  const quotaUsage = quota.percentUsed

  const inconsistencies: string[] = []

  // Check for quota violations
  if (quota.used > quota.limit) {
    inconsistencies.push('Storage quota exceeded')
  }
  
  if (fileCount > DEFAULT_QUOTAS.maxFileCount) {
    inconsistencies.push('File count limit exceeded')
  }
  
  // Check for excessive soft-deleted files
  if (softDeleted > 1000) {
    inconsistencies.push(`Excessive soft-deleted files (${softDeleted})`)
  }
  
  return {
    quotaUsage,
    fileCount,
    orphanCount: 0, // Would require S3 scan
    softDeletedCount: softDeleted,
    inconsistencies,
    needsCleanup: softDeleted > 100 || inconsistencies.length > 0,
  }
}

/**
 * Format bytes for human-readable output
 */
function formatBytes(bytes: bigint): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Number(bytes)
  let unitIndex = 0
  
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  
  return `${value.toFixed(2)} ${units[unitIndex]}`
}

/**
 * Presigned URL generation (enforced)
 * 
 * NO DIRECT ACCESS:
 * - All access via time-limited presigned URLs
 * - URLs expire after 1 hour (default)
 * - Project-scoped validation
 */
export function generatePresignedUrlExpiry(
  customExpiry?: number
): number {
  const defaultExpiry = 3600 // 1 hour
  const maxExpiry = 86400    // 24 hours (hard limit)
  
  if (!customExpiry) return defaultExpiry
  
  // Enforce maximum expiry
  return Math.min(customExpiry, maxExpiry)
}

// ── The daily sweep ───────────────────────────────────────────────────────────

/** How long a deleted file can still be restored before the sweep removes it. */
export const STORAGE_SOFT_DELETE_RETENTION_DAYS = 7

export type StoragePurgeMode = 'off' | 'dry-run' | 'enforce'

/**
 * How the scheduled sweep runs, read from BACKENLY_STORAGE_PURGE. The sweep
 * deletes files for good, so until the founders turn it on (`enforce`) it only
 * reports what it would delete; `off` stops it. Anything else is dry-run,
 * never enforce.
 */
export function storagePurgeMode(raw: string | undefined = process.env.BACKENLY_STORAGE_PURGE): StoragePurgeMode {
  const value = (raw ?? '').trim().toLowerCase()
  return value === 'off' || value === 'enforce' ? value : 'dry-run'
}

/**
 * This region's bucket, swept for this region's projects: files deleted more
 * than STORAGE_SOFT_DELETE_RETENTION_DAYS ago, objects no row names, and
 * abandoned uploads. Run daily by every region's scheduler
 * (lib/services/cron-runner.ts runRegionalSystemTasks). Only the S3 driver
 * keeps a bucket to sweep; `location` is the seam the tests inject through.
 */
export async function sweepRegionStorage(
  region: CloudRegionId,
  options: { mode?: StoragePurgeMode; location?: { client: S3Client; bucket: string } } = {},
): Promise<Awaited<ReturnType<typeof runLifecycleCleanup>> | null> {
  const mode = options.mode ?? storagePurgeMode()
  if (mode === 'off') return null
  if (!options.location && (process.env.STORAGE_DRIVER || 'local') !== 's3') return null

  const { s3LocationFor } = await import('@/lib/services/s3-config')
  const { client, bucket } = options.location ?? s3LocationFor(region)
  const result = await runLifecycleCleanup(client, bucket, {
    softDeleteRetentionDays: STORAGE_SOFT_DELETE_RETENTION_DAYS,
    dryRun: mode !== 'enforce',
    region,
  })
  console.log(
    `[storage-sweep] ${mode === 'enforce' ? 'deleted' : 'would delete (dry-run)'} in ${region}: ` +
      `${result.deletedSoftDeletes} deleted file(s), ${result.deletedOrphans} unreferenced object(s), ` +
      `${result.deletedIncomplete} abandoned upload(s), ${result.totalBytesFreed} bytes` +
      (result.errors.length ? `; ${result.errors.length} error(s)` : ''),
  )
  return result
}
