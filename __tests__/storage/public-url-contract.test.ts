/**
 * A private bucket must never be handed out as a public URL base.
 *
 * `publicCdnBase()` decided whether public files get a direct object URL by
 * comparing the configured public URL's host against the S3 ENDPOINT's host,
 * returning null when they matched — "that's the API host, it can't serve
 * objects". Correct for Backblaze.
 *
 * With no endpoint, that comparison ran against the empty string, so ANY
 * non-empty STORAGE_S3_PUBLIC_URL looked like a real CDN. On native AWS with
 * Block Public Access that would have manufactured direct bucket URLs for every
 * public file, every one of them a 403 — and the misconfiguration needed only a
 * single leftover environment variable.
 *
 * The semantics are now explicit:
 *   STORAGE_CDN_URL        explicit public base, always honoured
 *   STORAGE_S3_PUBLIC_URL  legacy provider host, only meaningful WITH an endpoint
 *   neither                app-mediated delivery (download route + presigned GET)
 */
const KEYS = [
  'STORAGE_S3_ENDPOINT',
  'STORAGE_S3_REGION',
  'STORAGE_S3_BUCKET',
  'STORAGE_S3_ACCESS_KEY',
  'STORAGE_S3_SECRET_KEY',
  'STORAGE_S3_PUBLIC_URL',
  'STORAGE_CDN_URL',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

/** publicCdnBase is private; reach it through the instance under test. */
async function cdnBase(): Promise<string | null> {
  const { S3StorageService } = await import('@/lib/services/s3Storage')
  const svc: any = new S3StorageService()
  return svc.publicCdnBase()
}

describe('Backblaze, as production runs today', () => {
  beforeEach(() => {
    process.env.STORAGE_S3_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com'
    process.env.STORAGE_S3_REGION = 'us-east-005'
    process.env.STORAGE_S3_BUCKET = 'backenly-storage'
    process.env.STORAGE_S3_ACCESS_KEY = 'k'
    process.env.STORAGE_S3_SECRET_KEY = 's'
  })

  it('gives no CDN base when the public URL is the API endpoint itself', async () => {
    process.env.STORAGE_S3_PUBLIC_URL = 'https://s3.us-east-005.backblazeb2.com/backenly-storage'
    await expect(cdnBase()).resolves.toBeNull()
  })

  it('honours a genuinely different public host in front of the provider', async () => {
    process.env.STORAGE_S3_PUBLIC_URL = 'https://files.backenly.com'
    await expect(cdnBase()).resolves.toBe('https://files.backenly.com')
  })

  it('gives no CDN base when neither variable is set', async () => {
    await expect(cdnBase()).resolves.toBeNull()
  })
})

describe('native AWS with Block Public Access', () => {
  beforeEach(() => {
    process.env.STORAGE_S3_REGION = 'ap-south-1'
    process.env.STORAGE_S3_BUCKET = 'backenly-prod-storage'
  })

  it('gives no CDN base with both public variables unset (the v1 target)', async () => {
    await expect(cdnBase()).resolves.toBeNull()
  })

  it('REFUSES to infer a public base from STORAGE_S3_PUBLIC_URL with no endpoint', async () => {
    // The exact regression: one leftover variable used to turn a private bucket
    // into a set of direct, unreachable object URLs.
    process.env.STORAGE_S3_PUBLIC_URL = 'https://s3.ap-south-1.amazonaws.com/backenly-prod-storage'
    await expect(cdnBase()).resolves.toBeNull()
  })

  it('refuses even an arbitrary unrelated public URL with no endpoint', async () => {
    process.env.STORAGE_S3_PUBLIC_URL = 'https://anything.example.com'
    await expect(cdnBase()).resolves.toBeNull()
  })

  it('still honours an EXPLICIT STORAGE_CDN_URL, which is a deliberate choice', async () => {
    process.env.STORAGE_CDN_URL = 'https://cdn.backenly.com'
    await expect(cdnBase()).resolves.toBe('https://cdn.backenly.com')
  })

  it('ignores a malformed CDN URL rather than emitting a broken base', async () => {
    process.env.STORAGE_CDN_URL = 'not-a-url'
    await expect(cdnBase()).resolves.toBeNull()
  })

  it('strips a trailing slash so keys are not double-joined', async () => {
    process.env.STORAGE_CDN_URL = 'https://cdn.backenly.com/'
    await expect(cdnBase()).resolves.toBe('https://cdn.backenly.com')
  })
})

describe('precedence', () => {
  it('an explicit CDN wins over the legacy provider URL', async () => {
    process.env.STORAGE_S3_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com'
    process.env.STORAGE_S3_REGION = 'us-east-005'
    process.env.STORAGE_S3_BUCKET = 'backenly-storage'
    process.env.STORAGE_S3_ACCESS_KEY = 'k'
    process.env.STORAGE_S3_SECRET_KEY = 's'
    process.env.STORAGE_S3_PUBLIC_URL = 'https://files.backenly.com'
    process.env.STORAGE_CDN_URL = 'https://cdn.backenly.com'
    await expect(cdnBase()).resolves.toBe('https://cdn.backenly.com')
  })
})
