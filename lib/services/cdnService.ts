/**
 * CDN Service (#76)
 *
 * Generates CDN and signed URLs for files based on bucket access policy.
 *
 * Access policies:
 *   public_read    — direct CDN URL (no signing), with long-lived cache headers
 *   cdn_cacheable  — CDN URL with SWR cache headers (thumbnails, static assets)
 *   private        — S3 presigned URL (time-limited, no CDN cache)
 *   owner_only     — S3 presigned URL with narrower TTL
 *
 * CDN URL pattern (when STORAGE_CDN_URL is configured):
 *   {STORAGE_CDN_URL}/{projectId}/{filePath}
 *
 * Falls back to S3 presigned URLs when no CDN is configured.
 */

import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getS3Client, isS3Configured } from './s3-config'

export type AccessPolicy = 'public_read' | 'private' | 'owner_only' | 'cdn_cacheable'

const CDN_URL = process.env.STORAGE_CDN_URL // e.g. https://cdn.backenly.com
const S3_BUCKET = process.env.STORAGE_S3_BUCKET || 'backenly-storage'
const S3_PUBLIC_URL = process.env.STORAGE_S3_PUBLIC_URL // e.g. https://s3.backenly.b-cdn.net

// Shared client — region derived from the endpoint (see s3-config.ts) so this
// module (if ever wired in) signs correctly for Backblaze/AWS.
const s3Client = isS3Configured() ? getS3Client() : null

// Cache-control header values per access policy
const CACHE_CONTROL: Record<AccessPolicy, string> = {
  public_read:   'public, max-age=31536000, immutable',       // 1 year
  cdn_cacheable: 'public, max-age=86400, stale-while-revalidate=604800', // 1 day SWR
  private:       'private, no-store',
  owner_only:    'private, no-store',
}

// Presigned URL TTLs
const SIGNED_URL_TTL: Record<AccessPolicy, number> = {
  public_read:   3600,    // 1h (CDN serves; presigned is a fallback)
  cdn_cacheable: 3600,
  private:       3600,
  owner_only:    900,     // 15 min
}

/**
 * Build the S3 object key for a file.
 * Convention: {projectId}/{bucketName}/{fileName}
 */
export function buildS3Key(projectId: string, bucketName: string, fileName: string): string {
  return `${projectId}/${bucketName}/${fileName}`
}

/**
 * Get the public CDN URL for a file (only for public_read / cdn_cacheable policies).
 * Returns null when no CDN is configured or the policy is private.
 */
export function getCdnUrl(
  projectId: string,
  bucketName: string,
  fileName: string,
  policy: AccessPolicy,
): string | null {
  if (policy === 'private' || policy === 'owner_only') return null

  const base = CDN_URL || S3_PUBLIC_URL
  if (!base) return null

  const key = buildS3Key(projectId, bucketName, fileName)
  return `${base.replace(/\/$/, '')}/${key}`
}

/**
 * Get a presigned S3 URL (for private/owner_only, or as CDN fallback).
 */
export async function getPresignedUrl(
  s3Key: string,
  policy: AccessPolicy,
): Promise<string | null> {
  if (!s3Client) return null

  const ttl = SIGNED_URL_TTL[policy]

  try {
    const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key })
    return await getSignedUrl(s3Client, command, { expiresIn: ttl })
  } catch (err) {
    console.error('[CDN] Failed to generate presigned URL:', err)
    return null
  }
}

/**
 * Generate the best URL for a file based on its bucket's access policy.
 *
 * - public_read / cdn_cacheable: returns CDN URL when available, else presigned
 * - private / owner_only: always returns presigned URL
 */
export async function getFileUrl(
  projectId: string,
  bucketName: string,
  fileName: string,
  policy: AccessPolicy,
): Promise<{ url: string; cacheControl: string; isCdn: boolean }> {
  const cacheControl = CACHE_CONTROL[policy]

  // Try CDN first for public policies
  const cdnUrl = getCdnUrl(projectId, bucketName, fileName, policy)
  if (cdnUrl) {
    return { url: cdnUrl, cacheControl, isCdn: true }
  }

  // Presigned URL fallback
  const s3Key = buildS3Key(projectId, bucketName, fileName)
  const presigned = await getPresignedUrl(s3Key, policy)
  if (presigned) {
    return { url: presigned, cacheControl, isCdn: false }
  }

  // Local storage fallback (STORAGE_DRIVER=local)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  return {
    url: `${appUrl}/api/storage/files/${encodeURIComponent(fileName)}/download`,
    cacheControl: 'no-store',
    isCdn: false,
  }
}

/**
 * Determine the access policy from a bucket name (semantic defaults when
 * no explicit policy has been set).
 */
export function inferAccessPolicy(bucketName: string): AccessPolicy {
  const name = bucketName.toLowerCase()
  if (/avatar|profile|user.?pic|photo/.test(name)) return 'public_read'
  if (/thumbnail|cover|banner|hero|logo|brand/.test(name)) return 'cdn_cacheable'
  if (/video|audio|recording/.test(name)) return 'private'
  return 'private'
}
