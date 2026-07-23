/**
 * S3 Client — Single Source of Truth
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Before this module there were EIGHT separate `new S3Client({...})` sites
 * (s3Storage, signed-upload ×1, upload-multipart ×3, storage-cleanup cron,
 * plus two dead modules) each with its own, drifting config:
 *   - region: 'auto' in some, 'us-east-1' in others
 *   - forcePathStyle: true in some, localhost-only in others
 *   - some omitted endpoint/credentials entirely
 *
 * That drift is why Backblaze B2 was fragile. B2's S3-compatible API validates
 * the SigV4 region against the endpoint's region and REJECTS a mismatched value
 * (including the literal 'auto', which only Cloudflare R2 accepts). So a
 * `STORAGE_S3_REGION=auto` (the value our own .env.example ships) against a
 * Backblaze endpoint produces `AuthorizationHeaderMalformed` /
 * `SignatureDoesNotMatch` on every PUT, presign, and GET — uploads and
 * downloads silently fail.
 *
 * The fix: derive the region from the endpoint host (which is already required
 * and unambiguous) instead of trusting a hand-set env var, and construct every
 * S3 client through one factory. Set STORAGE_S3_REGION only to override.
 */

import { S3Client } from '@aws-sdk/client-s3'

export interface S3Config {
  endpoint?: string
  region: string
  bucket: string
  publicUrl?: string
  accessKeyId?: string
  secretAccessKey?: string
  forcePathStyle: boolean
}

function safeHost(endpoint?: string): string | null {
  if (!endpoint) return null
  try {
    return new URL(endpoint).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Determine the SigV4 region for an S3-compatible endpoint.
 *
 * Precedence is deliberately provider-aware, NOT "explicit always wins",
 * because the most common misconfiguration is `STORAGE_S3_REGION=auto` (our
 * example default) paired with a Backblaze endpoint — and Backblaze rejects it.
 *
 *   1. Backblaze B2 (`s3.<region>.backblazeb2.com`) → always the host region,
 *      even if the env says something else. B2 will reject anything else.
 *   2. Cloudflare R2 (`*.r2.cloudflarestorage.com`) → always 'auto' (R2 requires
 *      the literal 'auto').
 *   3. A meaningful explicit region (anything other than empty/'auto') → used.
 *   4. AWS (`s3.<region>.amazonaws.com`, `s3-<region>...`, `<b>.s3.<region>...`)
 *      → host region.
 *   5. Explicit 'auto' (MinIO / generic) → 'auto'.
 *   6. Fallback → 'us-east-1'.
 */
export function deriveS3Region(endpoint?: string, explicit?: string): string {
  const ex = (explicit ?? '').trim()
  const host = safeHost(endpoint)

  // 1. Backblaze B2 — host region is authoritative.
  const b2 = host ? /(?:^|\.)s3\.([a-z0-9-]+)\.backblazeb2\.com$/.exec(host) : null
  if (b2) return b2[1]

  // 2. Cloudflare R2 — must be 'auto'.
  if (host && host.endsWith('.r2.cloudflarestorage.com')) return 'auto'

  // 3. Meaningful explicit region wins for everything else.
  if (ex && ex.toLowerCase() !== 'auto') return ex

  // 4. AWS S3 — derive from host when present.
  const aws = host ? /(?:^|\.)s3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(host) : null
  if (aws && aws[1] !== 'dualstack') return aws[1]

  // 5. Explicit 'auto' (MinIO / unknown S3-compatible) — respect it.
  if (ex.toLowerCase() === 'auto') return 'auto'

  // 6. Safe default.
  return 'us-east-1'
}

export function getS3Config(): S3Config {
  const endpoint = process.env.STORAGE_S3_ENDPOINT
  const forcePathStyle =
    process.env.STORAGE_S3_FORCE_PATH_STYLE === 'true' ||
    (!!endpoint && (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')))

  return {
    endpoint,
    region: deriveS3Region(endpoint, process.env.STORAGE_S3_REGION),
    bucket: process.env.STORAGE_S3_BUCKET || 'backenly-storage',
    publicUrl: process.env.STORAGE_S3_PUBLIC_URL,
    accessKeyId: process.env.STORAGE_S3_ACCESS_KEY,
    secretAccessKey: process.env.STORAGE_S3_SECRET_KEY,
    forcePathStyle,
  }
}

/** True when the S3 driver has everything it needs to talk to object storage. */
export function isS3Configured(): boolean {
  const c = getS3Config()
  return Boolean(c.endpoint && c.accessKeyId && c.secretAccessKey && c.bucket)
}

// Cached singleton — rebuilt only if the effective config changes (tests / env
// reloads). Keyed on the fields that affect signing so a stale client is never
// reused after a credential rotation.
let _client: S3Client | null = null
let _clientKey = ''

/**
 * The one and only S3 client. Every storage code path must use this so region,
 * endpoint, path-style, and credentials can never drift again.
 */
export function getS3Client(): S3Client {
  const c = getS3Config()
  const key = `${c.endpoint}|${c.region}|${c.forcePathStyle}|${c.accessKeyId}`
  if (_client && _clientKey === key) return _client

  _client = new S3Client({
    ...(c.endpoint ? { endpoint: c.endpoint } : {}),
    region: c.region,
    forcePathStyle: c.forcePathStyle,
    credentials:
      c.accessKeyId && c.secretAccessKey
        ? { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }
        : undefined,
  })
  _clientKey = key
  return _client
}
