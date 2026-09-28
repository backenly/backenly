/**
 * Signed CDN delivery for stored files.
 *
 * With STORAGE_CDN_URL alone the CDN is PUBLIC: an operator's CDN serves
 * public objects at `${STORAGE_CDN_URL}/${path}` with no signature (the
 * existing self-host shape, lib/services/s3Storage.ts publicCdnBase).
 *
 * With STORAGE_CDN_KEY_PAIR_ID and STORAGE_CDN_PRIVATE_KEY as well, the CDN is
 * SIGNED (Backenly Cloud's CloudFront): it serves nothing without a signature,
 * so every file, public or private, is handed out as a short-lived CloudFront
 * signed URL minted after Backenly's own checks (access policy, pause, usage
 * restriction). Bytes then leave from the edge, not through the app, and are
 * metered from the CDN's standard logs (lib/usage/log-ingest.ts, source
 * `cloudfront`).
 *
 * The signature is CloudFront's canned policy: RSA-SHA1 over
 *   {"Statement":[{"Resource":"<url>","Condition":{"DateLessThan":{"AWS:EpochTime":<t>}}}]}
 * with the URL-safe base64 CloudFront defines (+ -> -, = -> _, / -> ~).
 * Implemented here with node:crypto rather than a dependency: it is the whole
 * algorithm.
 */
import { createSign } from 'crypto'

export interface SignedCdnConfig {
  baseUrl: string
  keyPairId: string
  privateKey: string
}

/** The signed-CDN configuration, or null when files are not served through one. */
export function signedCdnConfig(env: NodeJS.ProcessEnv = process.env): SignedCdnConfig | null {
  const base = (env.STORAGE_CDN_URL ?? '').trim()
  const keyPairId = (env.STORAGE_CDN_KEY_PAIR_ID ?? '').trim()
  // Secrets Manager and .env files both flatten newlines; accept either form.
  const privateKey = (env.STORAGE_CDN_PRIVATE_KEY ?? '').trim().replace(/\\n/g, '\n')
  if (!base || !keyPairId || !privateKey) return null
  try {
    const url = new URL(base)
    if (url.protocol !== 'https:') return null
  } catch {
    return null
  }
  return { baseUrl: base.replace(/\/$/, ''), keyPairId, privateKey }
}

/** Encode an object key for a URL path, segment by segment. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/')
}

function cloudfrontBase64(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~')
}

/** The canned policy CloudFront verifies, byte for byte. */
export function cannedPolicy(resource: string, expiresEpoch: number): string {
  return JSON.stringify({
    Statement: [{ Resource: resource, Condition: { DateLessThan: { 'AWS:EpochTime': expiresEpoch } } }],
  })
}

/**
 * A CloudFront signed URL for one object, valid for `ttlSeconds` (clamped to
 * between one minute and one day).
 */
export function signCdnUrl(
  key: string,
  ttlSeconds: number,
  config: SignedCdnConfig,
  now: Date = new Date(),
): string {
  const ttl = Math.min(Math.max(Math.floor(ttlSeconds), 60), 86_400)
  const expires = Math.floor(now.getTime() / 1000) + ttl
  const resource = `${config.baseUrl}/${encodeKey(key)}`
  const signer = createSign('RSA-SHA1')
  signer.update(cannedPolicy(resource, expires))
  const signature = cloudfrontBase64(signer.sign(config.privateKey))
  return `${resource}?Expires=${expires}&Signature=${signature}&Key-Pair-Id=${encodeURIComponent(config.keyPairId)}`
}

/** How long a download redirect's signed URL lives: long enough to start, short enough to revoke. */
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60
