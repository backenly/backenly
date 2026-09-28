/**
 * Storage Quota Enforcement (#75)
 *
 * File storage is a quota of the billing account (the project owner), pooled
 * across all of its projects, and enforced before every upload: an upload is
 * refused when the account's stored bytes plus the new file would pass the
 * plan's included storage, raised only within the owner's spend limit
 * (lib/usage/overage.ts).
 */

import { prisma } from '@/lib/db/postgres'
import { getFileStorageLimitBytes } from '@/lib/quota/kernel'
import { effectiveCap } from '@/lib/usage/overage'

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
  /** Bytes stored by every project of the owning account. */
  used: bigint
  /** The most the account may store: the plan's included bytes, or more within the spend limit. */
  limit: bigint
  available: bigint
  percentUsed: number
  isExceeded: boolean
  /** Bytes this project alone stores. */
  projectUsed: bigint
  /** The plan's included bytes for the account (UNLIMITED when the plan has no cap). */
  included: bigint
}

/**
 * Get the storage quota for a project, which is its owning account's quota.
 *
 * The limit is the owner's Plan file-storage cap, and nothing else. `null` from
 * the kernel means unlimited (a self-hosted install, or fail-open). `used` is
 * every project of the same owner, because the plan's storage is the
 * account's: counting one project made the real cap N times the plan.
 *
 * `incoming` is the size of an upload about to happen. Only when it would pass
 * the included bytes is the owner's spend limit consulted, so a quota read for
 * display, and every upload well inside the plan, costs no extra query.
 *
 * Project.storageLimit is NOT consulted. It was meant as a per-project override,
 * but nothing ever writes it, so every project carried its column default of
 * 1 GiB, and because it took precedence that default capped every plan: Pro's
 * advertised 100 GB was 1 GiB in practice.
 */
export async function getProjectQuota(projectId: string, incoming: bigint = BigInt(0)): Promise<QuotaStatus> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { storageUsed: true, userId: true },
  })

  if (!project) {
    return {
      used: BigInt(0),
      limit: DEFAULT_QUOTA,
      available: DEFAULT_QUOTA,
      percentUsed: 0,
      isExceeded: false,
      projectUsed: BigInt(0),
      included: DEFAULT_QUOTA,
    }
  }

  const projectUsed = project.storageUsed > BigInt(0) ? project.storageUsed : BigInt(0)
  let used = projectUsed
  if (project.userId) {
    const rows = await prisma.$queryRaw<Array<{ bytes: bigint | null }>>`
      SELECT COALESCE(SUM(GREATEST("storageUsed", 0)), 0)::bigint AS bytes
      FROM "projects" WHERE "userId" = ${project.userId}`
    used = BigInt(rows[0]?.bytes ?? 0)
  }

  const planLimitBytes = await getFileStorageLimitBytes(projectId)
  const included = planLimitBytes !== null ? planLimitBytes : UNLIMITED_BYTES
  let limit = included
  if (planLimitBytes !== null && project.userId && used + incoming > planLimitBytes) {
    const cap = await effectiveCap(project.userId, 'file_bytes', Number(planLimitBytes))
    limit = BigInt(Math.floor(cap))
  }
  const available = limit > used ? limit - used : BigInt(0)
  const percentUsed = limit > BigInt(0) ? Number((used * BigInt(100)) / limit) : 0

  return {
    used,
    limit,
    available,
    percentUsed,
    isExceeded: used >= limit,
    projectUsed,
    included,
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
  const size = BigInt(fileSize)
  const quota = await getProjectQuota(projectId, size)

  if (quota.used + size > quota.limit) {
    const usedMb = Number(quota.used / BigInt(1024 * 1024))
    const limitMb = Number(quota.limit / BigInt(1024 * 1024))
    throw new QuotaExceededError(
      `Storage quota exceeded. Used: ${usedMb} MB / ${limitMb} MB. ` +
      `File requires ${Math.ceil(Number(size) / (1024 * 1024))} MB. Storage is shared by all of your projects; ` +
      `delete files, raise your spend limit or upgrade your plan to upload more.`,
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
