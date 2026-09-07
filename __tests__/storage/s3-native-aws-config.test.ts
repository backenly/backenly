/**
 * Native AWS S3 must count as configured.
 *
 * `isS3Configured()` used to require `endpoint && accessKeyId && secretAccessKey
 * && bucket`, which encoded one deployment shape — Backblaze with static keys —
 * as the definition of "S3". Native AWS has no custom endpoint, and a task under
 * an ECS Task Role has no static keys, so a perfectly good AWS deployment
 * evaluated as UNCONFIGURED.
 *
 * Nothing announced that. Every guarded call site simply took its non-S3
 * branch: `purgeS3Prefix` returned `skipped`, so a deleted project kept its
 * objects forever, and presigned upload plus all four multipart branches
 * quietly stopped using S3. The `S3StorageService` constructor was worse — it
 * threw outright.
 *
 * These tests pin the coherence contract that replaced it, and pin the
 * behaviour of the sites that depend on it.
 */
import {
  checkS3Configuration,
  isS3Configured,
  s3ConfigurationProblem,
  getS3Config,
} from '@/lib/services/s3-config'

const KEYS = [
  'STORAGE_DRIVER',
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

/** The live Backblaze production shape. */
function b2Mode() {
  process.env.STORAGE_DRIVER = 's3'
  process.env.STORAGE_S3_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com'
  process.env.STORAGE_S3_REGION = 'us-east-005'
  process.env.STORAGE_S3_BUCKET = 'backenly-storage'
  process.env.STORAGE_S3_ACCESS_KEY = 'test-key-id'
  process.env.STORAGE_S3_SECRET_KEY = 'test-secret'
}

/** The AWS ECS target shape: no endpoint, no static credentials. */
function awsEcsMode() {
  process.env.STORAGE_DRIVER = 's3'
  process.env.STORAGE_S3_REGION = 'ap-south-1'
  process.env.STORAGE_S3_BUCKET = 'backenly-prod-storage'
}

describe('the configuration contract', () => {
  it('accepts Backblaze with an endpoint and static credentials', () => {
    b2Mode()
    const c = checkS3Configuration()
    expect(c).toEqual({ ok: true, credentials: 'static' })
    expect(isS3Configured()).toBe(true)
  })

  it('accepts native AWS with no endpoint and no static credentials', () => {
    awsEcsMode()
    const c = checkS3Configuration()
    expect(c).toEqual({ ok: true, credentials: 'default-chain' })
    expect(isS3Configured()).toBe(true)
    expect(s3ConfigurationProblem()).toBeNull()
  })

  it('refuses an access key with no secret', () => {
    awsEcsMode()
    process.env.STORAGE_S3_ACCESS_KEY = 'only-the-key'
    expect(isS3Configured()).toBe(false)
    expect(s3ConfigurationProblem()).toMatch(/ACCESS_KEY is set but .*SECRET_KEY is not/)
  })

  it('refuses a secret with no access key', () => {
    awsEcsMode()
    process.env.STORAGE_S3_SECRET_KEY = 'only-the-secret'
    expect(isS3Configured()).toBe(false)
    expect(s3ConfigurationProblem()).toMatch(/SECRET_KEY is set but .*ACCESS_KEY is not/)
  })

  it('refuses a missing bucket', () => {
    awsEcsMode()
    delete process.env.STORAGE_S3_BUCKET
    expect(isS3Configured()).toBe(false)
    expect(s3ConfigurationProblem()).toMatch(/BUCKET is not set/)
  })

  it('refuses a missing region when there is no endpoint', () => {
    awsEcsMode()
    delete process.env.STORAGE_S3_REGION
    expect(isS3Configured()).toBe(false)
    expect(s3ConfigurationProblem()).toMatch(/REGION must name a real region/)
  })

  it("refuses region 'auto' when there is no endpoint", () => {
    // 'auto' is the value .env.example shipped. Against native AWS it is not a
    // region at all, and silently defaulting would sign for the wrong one.
    awsEcsMode()
    process.env.STORAGE_S3_REGION = 'auto'
    expect(isS3Configured()).toBe(false)
  })

  it('still allows a missing region when an endpoint can supply one', () => {
    b2Mode()
    delete process.env.STORAGE_S3_REGION
    expect(isS3Configured()).toBe(true)
    expect(getS3Config().region).toBe('us-east-005')
  })

  it('treats whitespace-only values as absent', () => {
    awsEcsMode()
    process.env.STORAGE_S3_ACCESS_KEY = '   '
    process.env.STORAGE_S3_SECRET_KEY = '   '
    expect(checkS3Configuration()).toEqual({ ok: true, credentials: 'default-chain' })
  })

  it('does not read STORAGE_DRIVER — callers gate on that themselves', () => {
    // purge gates on the driver SNAPSHOTTED when the deletion was enqueued.
    // Folding a live driver read in here would let an operator flipping
    // STORAGE_DRIVER strand files a retry was supposed to remove.
    awsEcsMode()
    process.env.STORAGE_DRIVER = 'local'
    expect(isS3Configured()).toBe(true)
  })
})

describe('the resolved client config in AWS mode', () => {
  it('has no endpoint and the explicit region', () => {
    awsEcsMode()
    const cfg = getS3Config()
    expect(cfg.endpoint).toBeFalsy()
    expect(cfg.region).toBe('ap-south-1')
    expect(cfg.bucket).toBe('backenly-prod-storage')
    expect(cfg.forcePathStyle).toBe(false)
  })

  it('carries no static credentials, so the SDK uses its provider chain', () => {
    awsEcsMode()
    const cfg = getS3Config()
    expect(cfg.accessKeyId).toBeFalsy()
    expect(cfg.secretAccessKey).toBeFalsy()
  })
})

describe('every site that was silently disabled on AWS', () => {
  // Each of these guarded on isS3Configured(). Under the old contract they all
  // took the non-S3 branch on AWS; the assertion is simply that the gate now
  // opens, since the branch itself is unchanged.
  it('the gate opens in AWS mode', () => {
    awsEcsMode()
    expect(process.env.STORAGE_DRIVER === 's3' && isS3Configured()).toBe(true)
  })

  it('purge would attempt the S3 prefix rather than reporting skipped', async () => {
    awsEcsMode()
    // purgeS3Prefix returns { status: 'skipped' } when !isS3Configured().
    expect(isS3Configured()).toBe(true)
  })

  it('the storage service constructor no longer throws without an endpoint', async () => {
    awsEcsMode()
    const { S3StorageService } = await import('@/lib/services/s3Storage')
    expect(() => new S3StorageService()).not.toThrow()
  })

  it('the constructor still refuses a half-configured deployment', async () => {
    awsEcsMode()
    process.env.STORAGE_S3_ACCESS_KEY = 'only-the-key'
    const { S3StorageService } = await import('@/lib/services/s3Storage')
    expect(() => new S3StorageService()).toThrow(/not configured/i)
  })
})
