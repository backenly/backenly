/**
 * GOOGLE ONE TAP SIGNS IN ONLY WHAT GOOGLE SIGNED, FOR THIS DEPLOYMENT, FROM THIS SITE
 * ====================================================================================
 * POST /api/auth/platform-google/one-tap takes the ID token Google One Tap
 * gave the browser and issues a platform session for it. The token arrives
 * from the open internet, so the route believes it only when Google's key
 * signed it, it names this deployment's client id as its audience, and it has
 * not expired; and it sets its cookie only for a JSON POST from this site.
 *
 * Past that gate it takes the same path as the redirect callback
 * (lib/auth/oauth/google-sign-in.ts): a verified address only, and no session
 * for an account with two-factor authentication.
 *
 * Database-free, like tests/unit/oauth-second-factor.spec.ts: the platform
 * client and the session issuer are recorders. The token verification is the
 * real one. Tokens are signed here with an RSA key made for the suite, and a
 * stub `fetch` publishes its public half where Google publishes its keys, so
 * nothing reaches Google.
 *
 * Two-sided throughout: every refusal sits beside a token that signs in, so
 * the suite cannot pass by refusing everything.
 */

import '@/tests/helpers/real-web-standard'

type Row = Record<string, any>
type Write = { op: string; where?: Row; data: Row }

const mockAccounts = new Map<string, Row>()
const mockWrites: Write[] = []

const mockPrisma = {
  user: {
    findUnique: jest.fn(async ({ where }: any) => {
      const row = mockAccounts.get(where.email)
      return row ? { ...row, role: null } : null
    }),
    update: jest.fn(async ({ where, data }: any) => {
      mockWrites.push({ op: 'user.update', where, data })
      const row = [...mockAccounts.values()].find((a) => a.id === where.id)
      return { ...row, ...data, role: null }
    }),
    create: jest.fn(async ({ data }: any) => {
      mockWrites.push({ op: 'user.create', data })
      return { id: 'created-account', twoFactorEnabled: false, ...data, role: null }
    }),
  },
}

jest.mock('@/lib/db', () => ({ get prisma() { return mockPrisma } }))
jest.mock('@/lib/auth/session', () => ({
  createSession: jest.fn(async (userId: string, email: string) => {
    mockWrites.push({ op: 'session.create', data: { userId, email } })
    return { token: 'not-a-real-session-token', sessionId: 'session-1', refreshToken: 'not-a-real-refresh-token' }
  }),
}))

const mockMayCreate = jest.fn(async () => true)
const mockSignupReported = jest.fn(async (_signup: Row) => undefined)
jest.mock('@/lib/platform-controls', () => ({
  isBlocked: jest.fn(async () => null),
  assertSignupAllowed: jest.fn(async () => ({ ok: true, score: null, signals: [] })),
}))
jest.mock('@/lib/platform-signals', () => ({ onSignupCompleted: (signup: Row) => mockSignupReported(signup) }))
jest.mock('@/lib/auth/setup-token', () => ({ oauthMayCreateAccount: () => mockMayCreate() }))
jest.mock('@/lib/security/auth-rate-limit', () => ({
  consume: jest.fn(async () => ({ allowed: true })),
  clientIp: () => '203.0.113.7',
  AUTH_LIMITS: { oauthCallback: { ip: { limit: 20, windowMs: 15 * 60_000 } } },
}))

import { NextRequest } from 'next/server'
import { generateKeyPairSync } from 'crypto'
import { sign } from 'jsonwebtoken'

import { POST as oneTap } from '@/app/api/auth/platform-google/one-tap/route'
import { forgetGoogleSigningKeys } from '@/lib/auth/oauth/google-id-token'

const CLIENT_ID = 'not-a-real-client-id.apps.googleusercontent.com'
const EMAIL = 'ada@example.com'
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
const SITE = 'http://localhost:3000'

/** Google's key for this suite, and a stranger's that Google never published. */
const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
const stranger = generateKeyPairSync('rsa', { modulusLength: 2048 })
const GOOGLE_KID = 'suite-google-key'

const mockFetch = jest.fn(async (input: unknown) => {
  const url = String(input)
  if (url !== 'https://www.googleapis.com/oauth2/v3/certs') throw new Error(`unexpected network call: ${url}`)
  const body = { keys: [{ ...google.publicKey.export({ format: 'jwk' }), kid: GOOGLE_KID, alg: 'RS256', use: 'sig' }] }
  return { ok: true, status: 200, json: async () => body }
})

function idToken(
  claims: Row = {},
  { key = google.privateKey, kid = GOOGLE_KID, expiresIn = '5m' }: { key?: any; kid?: string; expiresIn?: string | number } = {},
): string {
  return sign(
    { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'google-subject-1', email: EMAIL, email_verified: true, name: 'Ada', ...claims },
    key,
    { algorithm: 'RS256', keyid: kid, expiresIn: expiresIn as any },
  )
}

function post(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`${SITE}/api/auth/platform-google/one-tap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE, host: 'localhost:3000', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const writes = (op: string) => mockWrites.filter((w) => w.op === op)
const sessionCookie = (res: Response) => (res.headers.get('set-cookie') || '').includes('auth-token=')

async function expectRefused(res: Response, status: number, error: string) {
  expect(res.status).toBe(status)
  expect(await res.json()).toEqual({ error })
  expect(sessionCookie(res)).toBe(false)
  expect(mockWrites).toEqual([])
}

const ENV_KEYS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'NEXT_PUBLIC_APP_URL'] as const
const savedEnv: Record<string, string | undefined> = {}
const savedFetch = globalThis.fetch

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID
  process.env.GOOGLE_CLIENT_SECRET = 'not-a-real-google-client-secret'
  delete process.env.NEXT_PUBLIC_APP_URL
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  globalThis.fetch = savedFetch
})

beforeEach(() => {
  mockAccounts.clear()
  mockWrites.length = 0
  jest.clearAllMocks()
  mockMayCreate.mockImplementation(async () => true)
  forgetGoogleSigningKeys()
})

function seedAccount(twoFactorEnabled: boolean): void {
  mockAccounts.set(EMAIL, {
    id: ACCOUNT_ID,
    email: EMAIL,
    name: 'Ada',
    password: 'not-a-real-hash',
    provider: 'email',
    providerId: null,
    emailVerified: true,
    twoFactorEnabled,
  })
}

describe('a token Google signed for this deployment', () => {
  it('creates the account, reports the signup, and sets the session cookie and nothing else', async () => {
    const res = await oneTap(post({ credential: idToken() }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true, created: true, redirectTo: '/app' })
    // The session travels in the HttpOnly cookie only.
    expect(JSON.stringify(body)).not.toContain('not-a-real-session-token')
    expect(res.headers.get('set-cookie')).toMatch(/auth-token=not-a-real-session-token;.*HttpOnly/i)

    expect(writes('user.create')).toHaveLength(1)
    expect(writes('user.create')[0].data).toMatchObject({
      email: EMAIL,
      emailVerified: true,
      provider: 'google',
      providerId: 'google-subject-1',
    })
    expect(mockSignupReported).toHaveBeenCalledWith(expect.objectContaining({ email: EMAIL, provider: 'google' }))
    expect(writes('session.create')).toEqual([{ op: 'session.create', data: { userId: 'created-account', email: EMAIL } }])
  })

  it('signs an existing account in without creating another', async () => {
    seedAccount(false)
    const res = await oneTap(post({ credential: idToken() }))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, created: false })
    expect(writes('user.create')).toEqual([])
    expect(writes('session.create')).toEqual([{ op: 'session.create', data: { userId: ACCOUNT_ID, email: EMAIL } }])
    expect(mockSignupReported).not.toHaveBeenCalled()
  })

  it('goes where the page asked, when that is a path on this site, and to the console otherwise', async () => {
    const onSite = await oneTap(post({ credential: idToken(), redirect: '/app/orgs/accept?token=x' }))
    expect((await onSite.json()).redirectTo).toBe('/app/orgs/accept?token=x')

    const offSite = await oneTap(post({ credential: idToken(), redirect: 'https://elsewhere.example/app' }))
    expect((await offSite.json()).redirectTo).toBe('/app')
  })
})

describe('a token that is not Google\'s word, for us, now', () => {
  it('refuses one signed by a key Google never published, even under Google\'s key id', async () => {
    await expectRefused(await oneTap(post({ credential: idToken({}, { key: stranger.privateKey }) })), 401, 'oauth_failed')
  })

  it('refuses one Google issued to another site', async () => {
    const res = await oneTap(post({ credential: idToken({ aud: 'another-site.apps.googleusercontent.com' }) }))
    await expectRefused(res, 401, 'oauth_failed')
  })

  it('refuses one from another issuer', async () => {
    await expectRefused(await oneTap(post({ credential: idToken({ iss: 'https://accounts.elsewhere.example' }) })), 401, 'oauth_failed')
  })

  it('refuses an expired one', async () => {
    await expectRefused(await oneTap(post({ credential: idToken({}, { expiresIn: -60 }) })), 401, 'oauth_failed')
  })

  it('refuses one signed with the shared-secret algorithm, using Google\'s public key as the secret', async () => {
    const pem = google.publicKey.export({ type: 'spki', format: 'pem' }) as string
    const forged = sign(
      { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'google-subject-1', email: EMAIL, email_verified: true },
      pem,
      { algorithm: 'HS256', keyid: GOOGLE_KID, expiresIn: '5m', allowInsecureKeySizes: true } as any,
    )
    await expectRefused(await oneTap(post({ credential: forged })), 401, 'oauth_failed')
  })

  it('refuses a body with no token, and one that is not JSON', async () => {
    await expectRefused(await oneTap(post({})), 401, 'oauth_failed')
    await expectRefused(await oneTap(post('{not json')), 400, 'invalid_request')
  })
})

describe('a request that did not come from this site as JSON', () => {
  it('refuses another site\'s origin, and a request that names none', async () => {
    await expectRefused(await oneTap(post({ credential: idToken() }, { origin: 'https://elsewhere.example' })), 403, 'invalid_request')

    const noOrigin = new NextRequest(`${SITE}/api/auth/platform-google/one-tap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3000' },
      body: JSON.stringify({ credential: idToken() }),
    })
    await expectRefused(await oneTap(noOrigin), 403, 'invalid_request')
  })

  it('refuses a form post, which a page on another site can send without asking', async () => {
    const res = await oneTap(post(JSON.stringify({ credential: idToken() }), { 'content-type': 'text/plain' }))
    await expectRefused(res, 403, 'invalid_request')
  })

  it('accepts the configured address when the Host header is a proxy\'s', async () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://console.example'
    try {
      const res = await oneTap(post({ credential: idToken() }, { origin: 'https://console.example', host: 'internal-lb:3000' }))
      expect(res.status).toBe(200)
    } finally {
      delete process.env.NEXT_PUBLIC_APP_URL
    }
  })
})

describe('the same rules as the redirect callback', () => {
  it('issues no session for an account with two-factor authentication, and writes nothing to it', async () => {
    seedAccount(true)
    await expectRefused(await oneTap(post({ credential: idToken() })), 403, 'second_factor_required')
  })

  it('refuses an address Google has not verified', async () => {
    await expectRefused(await oneTap(post({ credential: idToken({ email_verified: false }) })), 403, 'email_not_verified')
  })

  it('cannot claim a self-hosted deployment that is waiting for its setup token', async () => {
    mockMayCreate.mockImplementation(async () => false)
    await expectRefused(await oneTap(post({ credential: idToken() })), 403, 'claim_requires_setup_token')
  })

  it('says so when Google sign-in is not configured here', async () => {
    const secret = process.env.GOOGLE_CLIENT_SECRET
    delete process.env.GOOGLE_CLIENT_SECRET
    try {
      await expectRefused(await oneTap(post({ credential: idToken() })), 503, 'oauth_not_configured')
    } finally {
      process.env.GOOGLE_CLIENT_SECRET = secret
    }
  })
})
