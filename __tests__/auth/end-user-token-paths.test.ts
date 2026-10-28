/**
 * EVERY PATH THAT TAKES OR ISSUES AN END-USER TOKEN CHECKS IT, UNDER THE APP ROLE
 * ===============================================================================
 * An end user's session is a JWT signed with the project's secret. Logout
 * revokes one (`_token_blacklist`) and blocking a user is meant to stop every
 * one of theirs; the request-time check that makes both true is
 * resolveEndUserFromToken (server/lib/end-user-identity.ts) and the copy of it
 * in v1ApiMiddleware. These paths took or issued a token without it:
 *
 *   A  v1ApiMiddleware read a user token only from X-User-Token; one sent in
 *      Authorization with the key in x-api-key was read as the key itself
 *   B  the storage download checked a Bearer token's signature alone
 *   C  accept-invite checked its token's signature alone, then read the
 *      caller's email with no session claims, which the users table answers
 *      with no row
 *   D  OAuth, magic-link and password-reset sign-in signed a new token without
 *      reading is_blocked
 *   E  the function runner made a token's user the function's database identity
 *      on its signature alone: from the request body, from a header spelling
 *      no door reads, or after a door had served a revoked token as no user
 *
 * Every statement on the project's database client runs as a non-superuser,
 * non-bypassing role whenever the suite's connection is a superuser (as in
 * __tests__/auth/blocked-token-under-app-role.test.ts), over a users table the
 * real pipeline provisions. Each refusal has its control: the same path with an
 * unblocked user still succeeds.
 */
import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomBytes, randomUUID } from 'crypto'
import jwt from 'jsonwebtoken'

/** The role the project's client runs as; set in beforeAll on a superuser connection. */
const mockPremise = { role: '' }
jest.mock('@/lib/data-plane/regional', () => {
  const actual = jest.requireActual('@/lib/data-plane/regional')
  // Each call is a transaction that first takes the role, as every statement
  // runs as the app role in production. Nothing else is changed.
  const asRole = (db: any) => {
    const scoped = (run: (tx: any) => Promise<unknown>) =>
      db.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${mockPremise.role}`)
        return run(tx)
      })
    return {
      $queryRaw: (...args: any[]) => scoped((tx) => tx.$queryRaw(...args)),
      $queryRawUnsafe: (...args: any[]) => scoped((tx) => tx.$queryRawUnsafe(...args)),
      $executeRaw: (...args: any[]) => scoped((tx) => tx.$executeRaw(...args)),
      $executeRawUnsafe: (...args: any[]) => scoped((tx) => tx.$executeRawUnsafe(...args)),
      // The array form is handed statements this wrapper has already run, each
      // under the role in its own transaction, so only their results remain.
      $transaction: (run: any) => (Array.isArray(run) ? Promise.all(run) : scoped(run)),
    }
  }
  return {
    ...actual,
    workspaceRawClient: async (projectId: string) => {
      const db = await actual.workspaceRawClient(projectId)
      return mockPremise.role ? asRole(db) : db
    },
  }
})

/** Every identity the function runner gave a function's database, in order. */
const mockIdentities: any[] = []
jest.mock('@/lib/services/ai-functions/rls-aware-db', () => {
  const actual = jest.requireActual('@/lib/services/ai-functions/rls-aware-db')
  return {
    ...actual,
    makeRlsAwarePrisma: (identity: any, connect: any) => {
      mockIdentities.push(identity)
      return actual.makeRlsAwarePrisma(identity, connect)
    },
  }
})

import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { workspaceRawClient } from '@/lib/data-plane/regional'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { hashApiKey, resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { v1ApiMiddleware } from '@/lib/api/v1/middleware'
import {
  ensureEmailVerifiedColumn,
  logoutEndUser,
  resetEndUserPassword,
  verifyMagicLink,
} from '@/lib/services/end-user-auth-flows'
import { executeRouteModuleFunction } from '@/lib/services/ai-functions/route-module-runner'
import { pickFnHeaders } from '@/lib/services/ai-functions/forward-headers'
import { WorkspaceOAuthService } from '@/lib/services/workspaceOAuth'

// The storage service is a singleton built from STORAGE_DRIVER when it first
// loads, so the driver is set here and the modules that reach it are imported
// in beforeAll, after this line has run.
process.env.STORAGE_DRIVER = 'local'

type Handler = (request: NextRequest, context: { params: Promise<any> }) => Promise<Response>

const DB_URL = process.env.TEST_DATABASE_URL

function assertSafeTestDatabase(): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!DB_URL) throw new Error('Refusing: TEST_DATABASE_URL is not set')
  const dbName = DB_URL.split('/').pop()?.split('?')[0] ?? ''
  if (!/test/i.test(dbName)) throw new Error(`Refusing: "${dbName}" is not a test database`)
  if (process.env.DATABASE_URL !== DB_URL) throw new Error('Refusing: DATABASE_URL is not the test database')
}

const BROWSER: Record<string, string> = {
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  origin: 'https://app.example.test',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
}

const BLOCKED = `blocked-${randomUUID().slice(0, 8)}@test.invalid`
const ALLOWED = `allowed-${randomUUID().slice(0, 8)}@test.invalid`
const FILE_BYTES = 'END-USER-OWNED-BYTES'
/** A route module that touches nothing: what is observed is the identity it was given. */
const PROBE_MODULE = `
import { NextResponse } from 'next/server'
export async function GET() {
  return NextResponse.json({ ran: true })
}
`

let ownerId = ''
let projectId = ''
let schemaName = ''
let jwtSecret = ''
let clientKey = ''
let blockedId = ''
let allowedId = ''
let dir = ''
let server: http.Server
let base = ''
let download: Handler
let acceptInvite: Handler
let getProjectIdFromAuth: (req: any) => Promise<any>
let savedOauthKey: string | undefined
let realFetch: typeof fetch
/** The profile the stubbed provider returns, set by each OAuth case. */
let providerProfile: { sub: string; email: string; name: string } | null = null

const tokenFor = (userId: string, email: string) =>
  jwt.sign({ userId, email, projectId, role: 'user', jti: randomUUID() }, jwtSecret, { algorithm: 'HS256', expiresIn: '1h' })

/** A session of the unblocked user, revoked through the real logout. */
async function revokedToken(): Promise<string> {
  const token = tokenFor(allowedId, ALLOWED)
  const out = await logoutEndUser(projectId, token)
  expect(out.status).toBe(200)
  await expect(resolveEndUserFromToken(projectId, token)).resolves.toBeNull()
  return token
}

const middleware = (headers: Record<string, string>) =>
  v1ApiMiddleware(new NextRequest(`https://backenly.test/api/v1/${projectId}/storage/files`, { headers }), { projectId })

beforeAll(async () => {
  assertSafeTestDatabase()
  ;({ GET: download } = (await import('@/app/api/storage/files/[fileId]/download/route')) as unknown as { GET: Handler })
  ;({ POST: acceptInvite } = (await import('@/app/api/v1/[projectId]/orgs/accept-invite/route')) as unknown as {
    POST: Handler
  })
  const { default: app } = await import('@/server/app')
  ;({ getProjectIdFromAuth } = await import('@/server/routes/dynamic'))

  ownerId = (
    await prisma.user.create({
      data: { email: `token-paths-${randomUUID()}@test.invalid`, name: 'Token Paths' },
      select: { id: true },
    })
  ).id
  jwtSecret = randomBytes(32).toString('hex')
  projectId = (
    await prisma.project.create({
      data: { name: `token-paths-${randomUUID().slice(0, 8)}`, userId: ownerId, jwtSecret },
      select: { id: true },
    })
  ).id
  schemaName = `workspace_${projectId}`

  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  await ensureAuthUsersTable(projectId, { email: BLOCKED })
  await ensureEmailVerifiedColumn(projectId, schemaName)
  const [rls] = await prisma.$queryRawUnsafe<Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>>(
    `SELECT c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = 'users'`,
    schemaName,
  )
  expect(rls).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true })

  const insert = async (email: string, blocked: boolean) =>
    (
      await executeWithUserContext<{ id: string }>(
        projectId,
        '',
        true,
        `INSERT INTO "${schemaName}"."users" (email, password, is_blocked) VALUES ($1, 'x', $2) RETURNING id::text AS id`,
        [email, blocked],
      )
    )[0].id
  blockedId = await insert(BLOCKED, true)
  allowedId = await insert(ALLOWED, false)

  clientKey = `proj_live_${randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'token-paths', keyPrefix: clientKey.slice(0, 16), keyHash: hashApiKey(clientKey),
      permissions: ['read', 'write'], capabilities: [], userId: ownerId, projectId,
      keyType: 'public', scope: 'runtime', serviceRole: false, rateLimit: 1000,
    },
  })

  // The single-use link tables, as the flows that mail the links create them.
  for (const table of ['_magic_links', '_password_resets']) {
    await prisma.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS "${schemaName}"."${table}" (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
         expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
    )
  }
  // The teams tables accept-invite reads and writes. They carry no policy here:
  // what C asserts is the users read, which the platform secures itself.
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schemaName}"."organization_invitations" (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id UUID NOT NULL, email TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'member', token TEXT NOT NULL UNIQUE, invited_by_user_id UUID,
       expires_at TIMESTAMP, accepted_at TIMESTAMP)`,
  )
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schemaName}"."organization_members" (
       id UUID PRIMARY KEY, organization_id UUID NOT NULL, user_id UUID NOT NULL,
       role TEXT NOT NULL DEFAULT 'member', joined_at TIMESTAMP)`,
  )

  dir = mkdtempSync(join(tmpdir(), 'token-paths-'))

  // The OAuth client secret is stored encrypted, and there is no default key.
  savedOauthKey = process.env.OAUTH_ENCRYPTION_KEY
  process.env.OAUTH_ENCRYPTION_KEY = savedOauthKey || randomBytes(32).toString('hex')
  await WorkspaceOAuthService.upsertConfig(projectId, {
    provider: 'google',
    clientId: 'token-paths-client',
    clientSecret: 'token-paths-secret',
  } as Parameters<typeof WorkspaceOAuthService.upsertConfig>[1])

  // The provider is the one thing stubbed: its token and profile endpoints.
  realFetch = globalThis.fetch
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'provider-access', token_type: 'Bearer' }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.startsWith('https://www.googleapis.com/oauth2/v3/userinfo')) {
      return new Response(JSON.stringify(providerProfile), { headers: { 'content-type': 'application/json' } })
    }
    return realFetch(input, init)
  })

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const [who] = await prisma.$queryRawUnsafe<Array<{ rolsuper: boolean; user: string }>>(
    `SELECT rolsuper, current_user AS "user" FROM pg_roles WHERE rolname = current_user`,
  )
  if (who.rolsuper) {
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backenly_rls_premise') THEN
          CREATE ROLE backenly_rls_premise NOSUPERUSER NOBYPASSRLS;
        END IF;
      END $$`)
    await prisma.$executeRawUnsafe(`GRANT "${who.user}" TO backenly_rls_premise`)
    mockPremise.role = 'backenly_rls_premise'
  }
}, 180_000)

afterAll(async () => {
  mockPremise.role = ''
  jest.restoreAllMocks()
  if (server?.listening) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  if (schemaName) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`).catch(() => {})
  await prisma.storageFile.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.storageBucket.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.workspaceOAuthConfig.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.apiKey.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.permissionPolicy.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
  if (dir) rmSync(dir, { recursive: true, force: true })
  if (savedOauthKey === undefined) delete process.env.OAUTH_ENCRYPTION_KEY
  else process.env.OAUTH_ENCRYPTION_KEY = savedOauthKey
}, 120_000)

describe('the premise', () => {
  it('a claimless read of the blocked row, on the project client every path uses, matches nothing', async () => {
    const db = await workspaceRawClient(projectId)
    const rows = await db.$queryRawUnsafe<unknown[]>(
      `SELECT is_blocked FROM "${schemaName}"."users" WHERE id::text = $1`,
      blockedId,
    )
    expect(rows).toHaveLength(0)
  })
})

describe('A: Next v1 routes read a user token in Authorization as the runtime does', () => {
  it("refuses a blocked user's token sent in Authorization 403", async () => {
    const { response } = await middleware({ ...BROWSER, 'x-api-key': clientKey, authorization: `Bearer ${tokenFor(blockedId, BLOCKED)}` })
    expect(response?.status).toBe(403)
    expect((await response!.json()).error.message).toMatch(/blocked/i)
  }, 60_000)

  it('refuses a revoked token sent in Authorization 401', async () => {
    const { response } = await middleware({ ...BROWSER, 'x-api-key': clientKey, authorization: `Bearer ${await revokedToken()}` })
    expect(response?.status).toBe(401)
    expect((await response!.json()).error.message).toMatch(/revoked/i)
  }, 60_000)

  it("admits an unblocked user's token sent in Authorization as that end user", async () => {
    const { response, context } = await middleware({
      ...BROWSER, 'x-api-key': clientKey, authorization: `Bearer ${tokenFor(allowedId, ALLOWED)}`,
    })
    expect(response).toBeUndefined()
    expect(context.endUserId).toBe(allowedId)
  }, 60_000)

  it('takes X-User-Token over Authorization when both are sent', async () => {
    const { response, context } = await middleware({
      ...BROWSER,
      'x-api-key': clientKey,
      'x-user-token': tokenFor(allowedId, ALLOWED),
      authorization: `Bearer ${tokenFor(blockedId, BLOCKED)}`,
    })
    expect(response).toBeUndefined()
    expect(context.endUserId).toBe(allowedId)
  }, 60_000)

  it('still reads a token in Authorization as the key when no key is sent elsewhere, and refuses it', async () => {
    const { response } = await middleware({ ...BROWSER, authorization: `Bearer ${tokenFor(allowedId, ALLOWED)}` })
    expect(response?.status).toBe(401)
    expect((await response!.json()).error.message).toBe('Invalid API key')
  }, 60_000)
})

describe('B: the storage download resolves its Bearer token through the shared check', () => {
  let bucketId = ''
  const fileOwnedBy = async (uploadedBy: string) => {
    if (!bucketId) {
      bucketId = (
        await prisma.storageBucket.create({
          data: { name: `owned-${randomBytes(4).toString('hex')}`, projectId, isPublic: false, accessPolicy: 'owner_only' },
          select: { id: true },
        })
      ).id
    }
    const path = join(dir, `${randomBytes(5).toString('hex')}-owned.txt`)
    writeFileSync(path, FILE_BYTES)
    return (
      await prisma.storageFile.create({
        data: {
          bucketId, projectId, name: 'owned.txt', path, isPublic: false, uploadedBy,
          size: BigInt(FILE_BYTES.length), mimeType: 'text/plain',
        },
        select: { id: true },
      })
    ).id
  }
  const get = async (fileId: string, token: string) => {
    const res = await download(
      new NextRequest(`https://backenly.test/api/storage/files/${fileId}/download`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      { params: Promise.resolve({ fileId }) },
    )
    const text = await res.text()
    return { status: res.status, text }
  }

  it("refuses a blocked user's token 403 on the file that user uploaded, and serves nothing", async () => {
    const out = await get(await fileOwnedBy(blockedId), tokenFor(blockedId, BLOCKED))
    expect(out.status).toBe(403)
    expect(JSON.parse(out.text).code).toBe('END_USER_BLOCKED')
    expect(out.text).not.toContain(FILE_BYTES)
  }, 60_000)

  it('does not take a revoked token as a reader', async () => {
    const out = await get(await fileOwnedBy(allowedId), await revokedToken())
    expect(out.status).toBe(401)
    expect(out.text).not.toContain(FILE_BYTES)
  }, 60_000)

  it("serves an unblocked user's own file to their token", async () => {
    const out = await get(await fileOwnedBy(allowedId), tokenFor(allowedId, ALLOWED))
    expect(out.status).toBe(200)
    expect(out.text).toBe(FILE_BYTES)
  }, 60_000)
})

describe('C: accept-invite resolves its token through the shared check and reads the email as the service role', () => {
  const invite = async (email: string) => {
    const token = randomBytes(16).toString('hex')
    const organizationId = randomUUID()
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schemaName}"."organization_invitations" (organization_id, email, role, token, expires_at)
       VALUES ($1::uuid, $2, 'member', $3, NOW() + INTERVAL '1 day')`,
      organizationId, email, token,
    )
    return { token, organizationId }
  }
  const accept = async (userToken: string, inviteToken: string) => {
    const res = await acceptInvite(
      new NextRequest(`https://backenly.test/api/v1/${projectId}/orgs/accept-invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-user-token': userToken },
        body: JSON.stringify({ token: inviteToken }),
      }),
      { params: Promise.resolve({ projectId }) },
    )
    return { status: res.status, body: await res.json() }
  }

  it("refuses a blocked user's token 403", async () => {
    const { token } = await invite(BLOCKED)
    const out = await accept(tokenFor(blockedId, BLOCKED), token)
    expect(out.status).toBe(403)
    expect(out.body.code).toBe('END_USER_BLOCKED')
  }, 60_000)

  it('refuses a revoked token 401, as an invalid one', async () => {
    const { token } = await invite(ALLOWED)
    const out = await accept(await revokedToken(), token)
    expect(out.status).toBe(401)
    expect(out.body.code).toBe('INVALID_TOKEN')
  }, 60_000)

  it("finds an unblocked user's email under the role and joins them to the organization", async () => {
    const { token, organizationId } = await invite(ALLOWED)
    const out = await accept(tokenFor(allowedId, ALLOWED), token)
    expect(out.body.code).not.toBe('NO_USER_RECORD')
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, organizationId })
    const members = await prisma.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM "${schemaName}"."organization_members" WHERE organization_id = $1::uuid AND user_id = $2::uuid`,
      organizationId, allowedId,
    )
    expect(members).toHaveLength(1)
  }, 60_000)
})

describe('D: the sign-ins that issue a token to an existing user refuse a blocked one', () => {
  describe('OAuth callback', () => {
    const callback = async (email: string) => {
      providerProfile = { sub: `google-${randomUUID()}`, email, name: 'OAuth User' }
      const { signState } = await import('@/server/routes/oauth')
      const state = signState({ projectId, nonce: randomUUID(), iat: Date.now() }, jwtSecret)
      const res = await realFetch(
        `${base}/api/v1/${projectId}/auth/google/callback?code=provider-code&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      )
      return { status: res.status, body: await res.json().catch(() => ({})) }
    }
    const linked = async (userId: string) =>
      (
        await prisma.$queryRawUnsafe<Array<{ oauth_id: string | null }>>(
          `SELECT oauth_id FROM "${schemaName}"."users" WHERE id = $1::uuid`,
          userId,
        )
      )[0]?.oauth_id ?? null

    it('refuses a blocked user 403 before linking the account or issuing a token', async () => {
      const out = await callback(BLOCKED)
      expect(out.status).toBe(403)
      expect(out.body).toMatchObject({ error: 'This account has been suspended.', code: 'FORBIDDEN' })
      expect(out.body.token).toBeUndefined()
      expect(await linked(blockedId)).toBeNull()
    }, 60_000)

    it('signs an unblocked user in with a token that resolves to them', async () => {
      const out = await callback(ALLOWED)
      expect(out.status).toBe(200)
      expect(out.body.user?.id).toBe(allowedId)
      await expect(resolveEndUserFromToken(projectId, out.body.token)).resolves.toMatchObject({ userId: allowedId })
      expect(await linked(allowedId)).not.toBeNull()
    }, 60_000)
  })

  describe('magic link', () => {
    const link = async (email: string) => {
      const token = randomBytes(16).toString('hex')
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${schemaName}"."_magic_links" (email, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
        email, token,
      )
      return token
    }

    it('refuses a blocked user 403 without a token', async () => {
      const out = await verifyMagicLink(projectId, await link(BLOCKED))
      expect(out.status).toBe(403)
      expect(out.body).toEqual({ error: { code: 'FORBIDDEN', message: 'This account has been suspended.' } })
    }, 60_000)

    it('signs an unblocked user in with a token that resolves to them', async () => {
      const out = await verifyMagicLink(projectId, await link(ALLOWED))
      expect(out.status).toBe(200)
      await expect(resolveEndUserFromToken(projectId, out.body.data.token)).resolves.toMatchObject({ userId: allowedId })
    }, 60_000)
  })

  describe('password reset', () => {
    const resetLink = async (email: string) => {
      const token = randomBytes(16).toString('hex')
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${schemaName}"."_password_resets" (email, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        email, token,
      )
      return token
    }
    const passwordOf = async (userId: string) =>
      (
        await prisma.$queryRawUnsafe<Array<{ password: string }>>(
          `SELECT password FROM "${schemaName}"."users" WHERE id = $1::uuid`,
          userId,
        )
      )[0].password
    const usedAt = async (token: string) =>
      (
        await prisma.$queryRawUnsafe<Array<{ used_at: Date | null }>>(
          `SELECT used_at FROM "${schemaName}"."_password_resets" WHERE token = $1`,
          token,
        )
      )[0].used_at

    it('refuses a blocked user 403, leaving the password and the link as they were', async () => {
      const before = await passwordOf(blockedId)
      const token = await resetLink(BLOCKED)
      const out = await resetEndUserPassword(projectId, token, 'a-new-password-1')
      expect(out.status).toBe(403)
      expect(out.body).toEqual({ error: { code: 'FORBIDDEN', message: 'This account has been suspended.' } })
      expect(await passwordOf(blockedId)).toBe(before)
      expect(await usedAt(token)).toBeNull()
    }, 60_000)

    it('resets an unblocked user and signs them in with a token that resolves to them', async () => {
      const before = await passwordOf(allowedId)
      const token = await resetLink(ALLOWED)
      const out = await resetEndUserPassword(projectId, token, 'a-new-password-1')
      expect(out.status).toBe(200)
      await expect(resolveEndUserFromToken(projectId, out.body.data.token)).resolves.toMatchObject({ userId: allowedId })
      expect(await passwordOf(allowedId)).not.toBe(before)
      expect(await usedAt(token)).not.toBeNull()
    }, 60_000)
  })
})

describe("E: the function runner resolves a token's user through the shared check", () => {
  const anonymous = { userId: null, isServiceRole: false }
  /** Run the probe module as /fn would, and return the identity its database was given. */
  const identityFor = async (opts: { headers?: Record<string, string>; data?: Record<string, unknown> }) => {
    mockIdentities.length = 0
    await executeRouteModuleFunction(PROBE_MODULE, projectId, { type: 'manual', data: opts.data ?? {} }, 'GET /fn/probe', {
      headers: opts.headers,
    })
    expect(mockIdentities).toHaveLength(1)
    return mockIdentities[0]
  }

  it('a revoked X-User-Token that the runtime door serves as no user runs the function as no user', async () => {
    const token = await revokedToken()
    // The /fn request as the runtime authenticates it (server/routes/dynamic.ts):
    // the door does not refuse a revoked token, it serves the request with no user...
    const req = {
      params: { projectId },
      query: {},
      method: 'GET',
      originalUrl: `/api/v1/${projectId}/fn/probe`,
      url: `/api/v1/${projectId}/fn/probe`,
      headers: { 'x-api-key': clientKey, 'x-user-token': token },
    } as any
    const auth = await getProjectIdFromAuth(req)
    expect(auth).toMatchObject({ success: true, projectId })
    expect(auth.endUserId).toBeUndefined()
    // ...and hands the function the headers it forwards, token included.
    expect(await identityFor({ headers: pickFnHeaders((name) => req.headers[name]) })).toMatchObject(anonymous)
  }, 60_000)

  it("gives a blocked user's token from the request body no identity", async () => {
    expect(await identityFor({ data: { token: tokenFor(blockedId, BLOCKED) } })).toMatchObject(anonymous)
  }, 60_000)

  it("gives a blocked user's token in a header spelling the doors do not read no identity", async () => {
    expect(await identityFor({ headers: { authorization: `bearer ${tokenFor(blockedId, BLOCKED)}` } })).toMatchObject(anonymous)
  }, 60_000)

  it("gives an unblocked user's token from the request body that user's identity", async () => {
    expect(await identityFor({ data: { token: tokenFor(allowedId, ALLOWED) } })).toMatchObject({
      userId: allowedId,
      isServiceRole: false,
    })
  }, 60_000)

  it("reads a token without a project claim, which only the project's own code signs, as before", async () => {
    const sub = randomUUID()
    const own = jwt.sign({ sub }, jwtSecret, { algorithm: 'HS256' })
    expect(await identityFor({ headers: { 'x-user-token': `Bearer ${own}` } })).toMatchObject({ userId: sub, isServiceRole: false })
  }, 60_000)
})
