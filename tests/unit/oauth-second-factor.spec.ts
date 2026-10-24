/**
 * A GOOGLE OR GITHUB SIGN-IN COMPLETES ONLY FOR AN ACCOUNT WITHOUT A SECOND FACTOR
 * ================================================================================
 * An account with two-factor authentication signs in with its password and an
 * authenticator code (POST /api/auth/login). The provider callbacks have no
 * step that asks for the code, so for such an account they issue no session,
 * set no cookie, write nothing to the account, and send the person to the
 * login page with `second_factor_required` (lib/auth/oauth/second-factor.ts).
 *
 * Database-free: the platform client and the session issuer are recorders, and
 * the providers' token and profile endpoints are answered by a stub `fetch`,
 * so nothing reaches Google or GitHub. The real route handlers and the real
 * OAuth state signing run.
 *
 * Two-sided throughout: each refusal sits beside the same callback signing in
 * an account without two-factor authentication, so the suite cannot pass by
 * refusing everything.
 */

// Before anything imports next/server: NextRequest and NextResponse capture
// the global Request and Response when that module first loads.
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
  session: {
    create: jest.fn(async ({ data }: any) => {
      mockWrites.push({ op: 'session.create', data })
      return { id: `session-${mockWrites.length}`, ...data }
    }),
    update: jest.fn(async ({ where, data }: any) => {
      mockWrites.push({ op: 'session.update', where, data })
      return { ...where, ...data }
    }),
  },
  // The project-scoped callbacks read their OAuth client from here.
  workspaceOAuthConfig: {
    findUnique: jest.fn(async () => ({
      enabled: true,
      clientId: 'not-a-real-project-client-id',
      clientSecret: 'not-a-real-project-client-secret',
      redirectUri: null,
    })),
  },
}

jest.mock('@/lib/db', () => ({ get prisma() { return mockPrisma } }))

// The platform callbacks issue their session here. Recorded as the row it
// writes, the same way the project callbacks' own session.create is.
// The platform Google callback records the account's photo here.
jest.mock('@/lib/auth/avatar', () => ({
  recordAvatar: jest.fn(async (userId: string, url: string | null) => {
    mockWrites.push({ op: 'avatar.record', data: { userId, url } })
    return true
  }),
}))

jest.mock('@/lib/auth/session', () => ({
  createSession: jest.fn(async (userId: string, email: string) => {
    mockWrites.push({ op: 'session.create', data: { userId, email } })
    return {
      token: `not-a-real-session-token-${mockWrites.length}`,
      sessionId: `session-${mockWrites.length}`,
      refreshToken: 'not-a-real-refresh-token',
    }
  }),
}))

// Neighbours of the sign-in that this suite does not exercise.
jest.mock('@/lib/platform-controls', () => ({
  isBlocked: jest.fn(async () => null),
  assertSignupAllowed: jest.fn(async () => ({ ok: true, score: null, signals: [] })),
}))
jest.mock('@/lib/platform-signals', () => ({ onSignupCompleted: jest.fn(async () => undefined) }))
jest.mock('@/lib/auth/setup-token', () => ({ oauthMayCreateAccount: jest.fn(async () => true) }))
jest.mock('@/lib/security/auth-rate-limit', () => ({
  consume: jest.fn(async () => ({ allowed: true })),
  clientIp: () => '203.0.113.7',
  AUTH_LIMITS: { oauthCallback: { ip: { limit: 20, windowMs: 15 * 60_000 } } },
}))
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { sign } from 'jsonwebtoken'
import * as fs from 'fs'
import * as path from 'path'

import { GET as platformGoogleCallback } from '@/app/api/auth/platform-google/callback/route'
import { GET as platformGithubCallback } from '@/app/api/auth/platform-github/callback/route'
import { GET as projectGoogleCallback } from '@/app/api/auth/google/callback/route'
import { GET as projectGithubCallback } from '@/app/api/auth/github/callback/route'
import { generateOAuthState } from '@/lib/auth/oauth-state'
import { SECOND_FACTOR_REQUIRED, providerSignInRefusal } from '@/lib/auth/oauth/second-factor'

const EMAIL = 'ada@example.com'
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
const TARGET = '/app/projects'
const PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocNotARealPhoto=s100'

/** What each provider endpoint answers. Anything else is a test failure. */
const PROVIDER_ANSWERS: Record<string, unknown> = {
  'https://oauth2.googleapis.com/token': { access_token: 'not-a-real-google-token' },
  'https://www.googleapis.com/oauth2/v2/userinfo': {
    id: 'google-subject-1',
    email: EMAIL,
    verified_email: true,
    name: 'Ada',
  },
  'https://people.googleapis.com/v1/people/me?personFields=photos': {
    photos: [{ metadata: { primary: true }, url: PHOTO }],
  },
  'https://github.com/login/oauth/access_token': { access_token: 'not-a-real-github-token' },
  'https://api.github.com/user': { id: 4242, login: 'ada', name: 'Ada' },
  'https://api.github.com/user/emails': [{ email: EMAIL, primary: true, verified: true }],
}

const mockFetch = jest.fn(async (input: unknown) => {
  const url = String(input)
  if (!(url in PROVIDER_ANSWERS)) throw new Error(`unexpected network call: ${url}`)
  const body = PROVIDER_ANSWERS[url]
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
})

const ENV_KEYS = [
  'JWT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_REDIRECT_URI',
  'NEXT_PUBLIC_APP_URL',
] as const
const savedEnv: Record<string, string | undefined> = {}
const savedFetch = globalThis.fetch

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  // The GitHub project callback signs with requireJwtSecret, which wants 32+.
  process.env.JWT_SECRET = 'not-a-real-key-for-the-second-factor-suite'
  process.env.GOOGLE_CLIENT_ID = 'not-a-real-google-client-id'
  process.env.GOOGLE_CLIENT_SECRET = 'not-a-real-google-client-secret'
  process.env.GITHUB_CLIENT_ID = 'not-a-real-github-client-id'
  process.env.GITHUB_CLIENT_SECRET = 'not-a-real-github-client-secret'
  delete process.env.GOOGLE_REDIRECT_URI
  delete process.env.GITHUB_REDIRECT_URI
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
  // Calls only; every recorder keeps its implementation.
  jest.clearAllMocks()
})

/** An existing email-and-password account, the shape a provider would link to. */
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

const writes = (op: string) => mockWrites.filter((w) => w.op === op)

function platformState(scope: string): string {
  return sign({ scope, nonce: 'suite-nonce', redirectTo: TARGET }, process.env.JWT_SECRET!, {
    algorithm: 'HS256',
    expiresIn: '5m',
  })
}

function callbackRequest(route: string, state: string): NextRequest {
  const query = new URLSearchParams({ code: 'not-a-real-authorization-code', state })
  return new NextRequest(`http://localhost:3000${route}?${query}`)
}

const CALLBACKS = [
  {
    name: 'platform Google',
    provider: 'google',
    run: () => platformGoogleCallback(callbackRequest('/api/auth/platform-google/callback', platformState('platform-google'))),
  },
  {
    name: 'platform GitHub',
    provider: 'github',
    run: () => platformGithubCallback(callbackRequest('/api/auth/platform-github/callback', platformState('platform-github'))),
  },
  {
    name: 'project Google',
    provider: 'google',
    run: () =>
      projectGoogleCallback(
        callbackRequest('/api/auth/google/callback', generateOAuthState({ projectId: 'project-1', provider: 'google', redirectTo: TARGET })),
      ),
  },
  {
    name: 'project GitHub',
    provider: 'github',
    run: () =>
      projectGithubCallback(
        callbackRequest('/api/auth/github/callback', generateOAuthState({ projectId: 'project-1', provider: 'github', redirectTo: TARGET })),
      ),
  },
]

describe('the decision', () => {
  it('refuses an account with two-factor authentication', () => {
    expect(providerSignInRefusal({ twoFactorEnabled: true })).toBe(SECOND_FACTOR_REQUIRED)
    expect(SECOND_FACTOR_REQUIRED).toBe('second_factor_required')
  })

  it('allows an account without it, and a sign-in that finds no account yet', () => {
    expect(providerSignInRefusal({ twoFactorEnabled: false })).toBeNull()
    expect(providerSignInRefusal(null)).toBeNull()
  })
})

describe.each(CALLBACKS)('the $name callback', ({ run, provider }) => {
  it('issues no session for an account with two-factor authentication, and sends it to the login page', async () => {
    seedAccount(true)

    const res = await run()

    const location = new URL(res.headers.get('location') ?? 'http://missing.invalid/')
    expect(location.pathname).toBe('/auth/login')
    expect(location.searchParams.get('error')).toBe('second_factor_required')
    expect(res.cookies.get('auth-token')).toBeUndefined()
    expect(writes('session.create')).toHaveLength(0)
    // Nothing is written to the account: no provider link, no last-login
    // stamp, no photo.
    expect(writes('user.update')).toHaveLength(0)
    expect(writes('user.create')).toHaveLength(0)
    expect(writes('avatar.record')).toHaveLength(0)
    // It did reach the provider and find the account, so the refusal is the
    // second factor and not an earlier failure.
    expect(mockFetch).toHaveBeenCalled()
    expect(mockPrisma.user.findUnique).toHaveBeenCalled()
  })

  it('still signs in an account without two-factor authentication, linking the provider as before', async () => {
    seedAccount(false)

    const res = await run()

    const location = new URL(res.headers.get('location') ?? 'http://missing.invalid/')
    expect(location.pathname).toBe(TARGET)
    expect(location.searchParams.get('error')).toBeNull()
    expect(res.cookies.get('auth-token')?.value).toBeTruthy()

    const sessions = writes('session.create')
    expect(sessions).toHaveLength(1)
    expect(sessions[0].data.userId).toBe(ACCOUNT_ID)

    const updates = writes('user.update')
    expect(updates).toHaveLength(1)
    expect(updates[0].where).toEqual({ id: ACCOUNT_ID })
    expect(updates[0].data.provider).toBe(provider)
  })
})

describe('a provider sign-in that creates a new account', () => {
  it('is unaffected: a new account has no second factor yet', async () => {
    // No account holds the address, so the platform Google callback creates one.
    const res = await platformGoogleCallback(
      callbackRequest('/api/auth/platform-google/callback', platformState('platform-google')),
    )

    expect(new URL(res.headers.get('location') ?? 'http://missing.invalid/').pathname).toBe(TARGET)
    expect(res.cookies.get('auth-token')?.value).toBeTruthy()
    expect(writes('user.create')).toHaveLength(1)
    expect(writes('session.create')).toHaveLength(1)
  })
})

describe('a platform Google sign-in records the account’s own photo', () => {
  it('for an account it signs in', async () => {
    seedAccount(false)
    await platformGoogleCallback(callbackRequest('/api/auth/platform-google/callback', platformState('platform-google')))

    expect(writes('avatar.record').map((w) => w.data)).toEqual([{ userId: ACCOUNT_ID, url: PHOTO }])
    // With the token Google issued for this sign-in.
    expect(mockFetch).toHaveBeenCalledWith(
      'https://people.googleapis.com/v1/people/me?personFields=photos',
      expect.objectContaining({ headers: { Authorization: 'Bearer not-a-real-google-token' } }),
    )
  })

  it('for an account it creates', async () => {
    await platformGoogleCallback(callbackRequest('/api/auth/platform-google/callback', platformState('platform-google')))

    expect(writes('avatar.record').map((w) => w.data)).toEqual([{ userId: 'created-account', url: PHOTO }])
  })
})

describe('every provider callback that issues a platform session asks first', () => {
  // A source sweep, so a callback added later is held to the same rule without
  // anyone having to remember to list it here.
  const ROOT = process.cwd()
  const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/')

  function routeFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return routeFiles(full)
      return entry.name === 'route.ts' ? [full] : []
    })
  }

  const ISSUES_SESSION_COOKIE = /cookies\.set\(\s*['"]auth-token['"]/
  const callbacks = routeFiles(path.join(ROOT, 'app/api'))
    .filter((file) => /[\\/]callback[\\/]route\.ts$/.test(file))
    .filter((file) => ISSUES_SESSION_COOKIE.test(fs.readFileSync(file, 'utf8')))
    .map((file) => ({ file: rel(file) }))

  it('finds the four that exist today, so the sweep below is not vacuous', () => {
    expect(callbacks.map((c) => c.file)).toEqual(
      expect.arrayContaining([
        'app/api/auth/platform-google/callback/route.ts',
        'app/api/auth/platform-github/callback/route.ts',
        'app/api/auth/google/callback/route.ts',
        'app/api/auth/github/callback/route.ts',
      ]),
    )
  })

  it.each(callbacks)('$file asks before it writes to the account or issues a session', ({ file }) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const asks = src.indexOf('providerSignInRefusal(')
    expect(asks).toBeGreaterThan(-1)
    for (const write of ['prisma.user.update(', 'createSession(', 'prisma.session.create(', 'recordAvatar(']) {
      const at = src.indexOf(write)
      if (at > -1) expect(asks).toBeLessThan(at)
    }
  })
})
