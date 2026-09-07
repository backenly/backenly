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
/** How the S3 client will obtain credentials. */
export type S3CredentialMode = 'static' | 'default-chain'

export type S3ConfigCheck =
  | { ok: true; credentials: S3CredentialMode }
  | { ok: false; reason: string }

/**
 * Is object storage configured well enough to talk to?
 *
 * This used to require `endpoint && accessKeyId && secretAccessKey && bucket`,
 * which encoded one deployment shape — Backblaze with static keys — as if it
 * were the definition of "S3". Native AWS has NO custom endpoint, and a task
 * running under an ECS Task Role has NO static keys, so that test returned
 * false for a perfectly good AWS deployment. Nothing announced it: the seven
 * call sites simply took their non-S3 branch, so `purgeS3Prefix` reported
 * `skipped` (deleted projects keep their objects forever) and presigned upload
 * and all four multipart branches quietly stopped using S3.
 *
 * The contract is now about whether the configuration is COHERENT, not about
 * which provider it names:
 *
 *   bucket        required
 *   region        required when there is no endpoint — nothing can derive it
 *                 then, and a silent us-east-1 default against an ap-south-1
 *                 bucket fails every request with PermanentRedirect
 *   endpoint      optional (absent = native AWS)
 *   credentials   both set = static; both absent = AWS default provider chain
 *                 (Task Role, instance profile, SSO); exactly one set is a
 *                 half-configured deployment and is refused rather than
 *                 silently falling back to the chain, because that would
 *                 present as mysterious AccessDenied rather than as the typo
 *                 it is
 *
 * Deliberately NOT checked here: STORAGE_DRIVER. Callers gate on the driver
 * themselves, and purge gates on the driver SNAPSHOTTED when the deletion was
 * enqueued — folding a live driver read in here would let an operator flipping
 * STORAGE_DRIVER strand files a retry was supposed to remove.
 */
export function checkS3Configuration(): S3ConfigCheck {
  const bucket = (process.env.STORAGE_S3_BUCKET ?? '').trim()
  const endpoint = (process.env.STORAGE_S3_ENDPOINT ?? '').trim()
  const region = (process.env.STORAGE_S3_REGION ?? '').trim()
  const accessKey = (process.env.STORAGE_S3_ACCESS_KEY ?? '').trim()
  const secretKey = (process.env.STORAGE_S3_SECRET_KEY ?? '').trim()

  if (!bucket) return { ok: false, reason: 'STORAGE_S3_BUCKET is not set' }

  if (!endpoint && (!region || region.toLowerCase() === 'auto')) {
    return {
      ok: false,
      reason:
        'STORAGE_S3_REGION must name a real region when STORAGE_S3_ENDPOINT is unset ' +
        '(native AWS: the region cannot be derived from an endpoint)',
    }
  }

  if (accessKey && !secretKey) {
    return { ok: false, reason: 'STORAGE_S3_ACCESS_KEY is set but STORAGE_S3_SECRET_KEY is not' }
  }
  if (secretKey && !accessKey) {
    return { ok: false, reason: 'STORAGE_S3_SECRET_KEY is set but STORAGE_S3_ACCESS_KEY is not' }
  }

  return { ok: true, credentials: accessKey && secretKey ? 'static' : 'default-chain' }
}

export function isS3Configured(): boolean {
  return checkS3Configuration().ok
}

/** Why storage is unconfigured, for logs and startup errors. Never a secret. */
export function s3ConfigurationProblem(): string | null {
  // `in` rather than narrowing on `ok`: strictNullChecks is off in this
  // tsconfig, which disables discriminated-union narrowing on boolean literals.
  const c = checkS3Configuration()
  return 'reason' in c ? c.reason : null
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
