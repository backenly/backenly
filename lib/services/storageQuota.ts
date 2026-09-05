/**
 * Storage Quota Enforcement (#75)
 *
 * Per-project storage quota based on subscription plan.
 * Enforced before every file upload.
 *
 * Quota tiers (bytes):
 *   free       — 1 GB
 *   starter    — 10 GB
 *   pro        — 100 GB
 *   enterprise — 1 TB (soft limit)
 */

import { prisma } from '@/lib/db/postgres'
import { getFileStorageLimitBytes } from '@/lib/quota/kernel'

/**
 * @deprecated Hardcoded tier table — NO LONGER the source of truth. The real
 * limit comes from the owner's Plan via getFileStorageLimitBytes(). Kept only
 * so existing importers don't break; do not add new references.
 */
export const TIER_QUOTAS: Record<string, bigint> = {
  free:       BigInt(1   * 1024 * 1024 * 1024),  // 1 GB
  starter:    BigInt(10  * 1024 * 1024 * 1024),  // 10 GB
  pro:        BigInt(100 * 1024 * 1024 * 1024),  // 100 GB
  enterprise: BigInt(1024 * 1024 * 1024 * 1024), // 1 TB
}

export const DEFAULT_QUOTA = TIER_QUOTAS.free

// Effectively "no cap" — used when the Plan grants unlimited file storage
// (e.g. a future unlimited tier) or the plan lookup failed (fail-open).
const UNLIMITED_BYTES = BigInt('9223372036854775807')

export interface QuotaStatus {
  used: bigint
  limit: bigint
  available: bigint
  percentUsed: number
  isExceeded: boolean
}

/**
 * Get the storage quota for a project.
 * The limit comes from Project.storageLimit (set at project creation from the plan tier).
 * If storageLimit is 0, fall back to the user's subscription tier.
 */
export async function getProjectQuota(projectId: string): Promise<QuotaStatus> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      storageUsed: true,
      storageLimit: true,
      userId: true,
      user: { select: { tier: true } },
    },
  })

  if (!project) {
    return { used: BigInt(0), limit: DEFAULT_QUOTA, available: DEFAULT_QUOTA, percentUsed: 0, isExceeded: false }
  }

  // Plan is the single source of truth. Developer-set project override
  // (storageLimit > 0) still wins if present; otherwise the owner's Plan
  // file-storage cap; null from the kernel = unlimited (or fail-open).
  const planLimitBytes = await getFileStorageLimitBytes(projectId)
  const limit =
    project.storageLimit > BigInt(0)
      ? project.storageLimit
      : planLimitBytes !== null
        ? planLimitBytes
        : UNLIMITED_BYTES
  const used = project.storageUsed ?? BigInt(0)
  const available = limit > used ? limit - used : BigInt(0)
  const percentUsed = limit > BigInt(0) ? Number((used * BigInt(100)) / limit) : 0

  return {
    used,
    limit,
    available,
    percentUsed,
    isExceeded: used >= limit,
  }
}

/**
 * Check if a file of `fileSize` bytes can be uploaded to the project.
 * Throws if the upload would exceed the quota.
 */
export async function assertQuotaAvailable(
  projectId: string,
  fileSize: number | bigint,
): Promise<void> {
  const quota = await getProjectQuota(projectId)
  const size = BigInt(fileSize)

  if (quota.used + size > quota.limit) {
    const usedMb = Number(quota.used / BigInt(1024 * 1024))
    const limitMb = Number(quota.limit / BigInt(1024 * 1024))
    throw new QuotaExceededError(
      `Storage quota exceeded. Used: ${usedMb} MB / ${limitMb} MB. ` +
      `File requires ${Math.ceil(Number(size) / (1024 * 1024))} MB. Upgrade your plan to upload more files.`,
      quota,
    )
  }
}

/**
 * Increment the project's stored bytes counter after a successful upload.
 */
export async function incrementStorageUsed(projectId: string, bytes: bigint): Promise<void> {
  await prisma.project.update({
    where: { id: projectId },
    data: { storageUsed: { increment: bytes } },
  })
}

/**
 * Decrement the project's stored bytes counter after a file deletion.
 */
export async function decrementStorageUsed(projectId: string, bytes: bigint): Promise<void> {
  await prisma.project.update({
    where: { id: projectId },
    data: {
      storageUsed: {
        // Never go below zero
        decrement: bytes,
      },
    },
  })

  // Guard against going negative due to data inconsistency
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { storageUsed: true },
  })

  if (project && project.storageUsed < BigInt(0)) {
    await prisma.project.update({
      where: { id: projectId },
      data: { storageUsed: BigInt(0) },
    })
  }
}

export class QuotaExceededError extends Error {
  public quota: QuotaStatus

  constructor(message: string, quota: QuotaStatus) {
    super(message)
    this.name = 'QuotaExceededError'
    this.quota = quota
  }
}
