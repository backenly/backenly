/**
 * END-USER AUTH ON A PREVIEW BRANCH
 * =================================
 *
 * An app pointed at a preview signs its test users up with the preview key.
 * Those users must exist on the branch only, their tokens must work on the
 * branch only, and none of production's side effects may run for them. Before
 * this, a key-bearing sign-up was refused (Phase 0) and a keyless one, which is
 * what the SDK sent, created a real production user.
 *
 * Driven through the real Next auth routes (the Cloud door) and the real
 * Express runtime (the self-host door), with a branch made by the real engine,
 * against a real database:
 *
 *   sign-up, sign-in, refresh and logout with a preview key run on the
 *   branch's `users`, and production's is untouched;
 *   a branch token is signed so that production cannot verify it, and the data
 *   plane names a token from the other environment instead of serving it;
 *   functions, webhooks, the active-user count and email verification are
 *   skipped on a branch and listed in the response;
 *   a key for an inactive branch or another project is refused, never served
 *   from production.
 *
 * Stubbed: PostgREST's schema registry (an external service's configuration),
 * the Cloud entitlement lookup, and the three production side effects, which
 * are replaced by recorders so the test can see whether they ran. Every schema,
 * table, policy, key and row is real.
 */

jest.mock('@cloud/entitlements', () => {
  const actual = jest.requireActual('@cloud/entitlements')
  const { selfHostedEntitlements } = jest.requireActual('@/lib/entitlements/self-hosted')
  return { ...actual, cloudEntitlements: async () => ({ ...selfHostedEntitlements(), planName: 'BUILDER' }) }
})
jest.mock('@/lib/postgrest/registration', () => {
  const actual = jest.requireActual('@/lib/postgrest/registration')
  return {
    ...actual,
    registerSchemaByName: async (schema: string) => ({ registered: true, schema }),
    ensureSchemaRegistered: async (projectId: string) => ({ registered: true, schema: `workspace_${projectId}` }),
    unregisterSchema: async () => {},
  }
})
jest.mock('@/lib/services/ai-functions/executor', () => ({
  ...jest.requireActual('@/lib/services/ai-functions/executor'),
  fireAiFunctionsOnSignup: jest.fn(async () => {}),
}))
jest.mock('@/lib/services/end-user-auth-events', () => ({
  ...jest.requireActual('@/lib/services/end-user-auth-events'),
  emitEndUserCreated: jest.fn(async () => {}),
}))
jest.mock('@/lib/quota/kernel', () => ({
  ...jest.requireActual('@/lib/quota/kernel'),
  trackEndUserActive: jest.fn(async () => {}),
  canAcceptNewEndUser: jest.fn(async () => ({ allowed: true })),
  noteEndUserActivity: jest.fn(),
}))

import '@/tests/helpers/real-web-standard'

import http from 'http'
import type { AddressInfo } from 'net'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'

import app from '@/server/app'
import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { dispatchTool } from '@/lib/ai/brain/tools'
import { createBranch } from '@/lib/branches/engine'
import { mintPreviewKey } from '@/lib/branches/preview'
import { clearBranchKeyCache } from '@/lib/branches/key-scope'
import { flushRecordedRequests } from '@/lib/traffic/request-recorder'
import { SKIPPED_ON_BRANCH_SIGNUP } from '@/lib/branches/auth-environment'
import { resolveJwtSecret } from '@/lib/services/jwtSecretManager'
import { executeWithUserContext } from '@/lib/services/workspace-rls'
import { ensureEmailVerifiedColumn } from '@/lib/services/end-user-auth-flows'
import { hashApiKey, resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { getProjectIdFromAuth } from '@/server/routes/dynamic'
import { POST as signupRoute } from '@/app/api/v1/[projectId]/auth/signup/route'
import { POST as signinRoute } from '@/app/api/v1/[projectId]/auth/signin/route'
import { POST as refreshRoute } from '@/app/api/v1/[projectId]/auth/refresh-token/route'
import { POST as logoutRoute } from '@/app/api/v1/[projectId]/auth/logout/route'
import { fireAiFunctionsOnSignup } from '@/lib/services/ai-functions/executor'
import { emitEndUserCreated } from '@/lib/services/end-user-auth-events'
import { trackEndUserActive, canAcceptNewEndUser } from '@/lib/quota/kernel'

const ROUTES = {
  signup: signupRoute,
  signin: signinRoute,
  'refresh-token': refreshRoute,
  logout: logoutRoute,
} as const

let server: http.Server
let base: string
let ownerId: string
let otherOwnerId: string
let projectId: string
let mainSchema: string
let qa: { id: string; schemaName: string }
let fresh: { id: string; schemaName: string }
let previewKey: string
let freshKey: string
let mainKey: string
let productionToken: string

const PASSWORD = 'Correct-Horse-9'
let ip = 0

/** One call to a Next auth route, from its own address so rate limits never interfere. */
async function auth(action: keyof typeof ROUTES, body: unknown, key?: string) {
  ip++
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': `10.77.${Math.floor(ip / 250)}.${ip % 250}`,
  }
  if (key) headers['x-api-key'] = key
  const res = await ROUTES[action](
    new NextRequest(`https://backenly.test/api/v1/${projectId}/auth/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId }) },
  )
  return { status: res.status, env: res.headers.get('x-backenly-environment'), body: (await res.json()) as any }
}

/** The users in a schema, read as the service role: `users` is FORCE ROW LEVEL SECURITY. */
async function emails(schema: string): Promise<string[]> {
  const exists = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = 'users'`
  if (exists[0].n === 0) return []
  const rows = await executeWithUserContext<{ email: string }>('', true, `SELECT email FROM "${schema}"."users" ORDER BY email`)
  return rows.map((r) => r.email)
}

/** What the data plane resolves for a request, through the same function /db and /api/v2 use. */
function dataPlane(headers: Record<string, string>) {
  return getProjectIdFromAuth({
    headers,
    method: 'GET',
    originalUrl: `/api/v1/${projectId}/db/notes`,
    url: `/api/v1/${projectId}/db/notes`,
  } as any)
}

async function makeKey(owner: string, project: string, branchId: string | null): Promise<string> {
  const raw = `proj_live_${crypto.randomBytes(24).toString('hex')}`
  await prisma.apiKey.create({
    data: {
      name: 'branch-auth', keyPrefix: raw.slice(0, 16), permissions: ['read', 'write'], capabilities: [],
      userId: owner, projectId: project, keyType: 'public', keyHash: hashApiKey(raw), branchId,
    },
  })
  return raw
}

const originalEdition = process.env.BACKENLY_EDITION
const originalEngineMode = process.env.ENGINE_MODE

beforeAll(async () => {
  process.env.BACKENLY_EDITION = 'cloud'
  process.env.ENGINE_MODE = 'runtime'

  ownerId = (await prisma.user.create({
    data: { email: `branch-auth-${crypto.randomBytes(6).toString('hex')}@example.test`, password: 'not-a-real-hash', name: 'owner' },
  })).id
  const project = await createProvisionedProject({ name: 'branch-auth', userId: ownerId })
  projectId = project.id
  mainSchema = project.postgresSchema

  // Cut before production has any users table, to show a branch provisions
  // its own without creating one on production.
  const f = await createBranch(projectId, ownerId, 'fresh')
  if (!f.ok) throw new Error(`createBranch fresh failed: ${(f as any).error}`)
  fresh = (f as any).branch

  // Production: a table with an owner column, and one real end user.
  const made = await dispatchTool('create_table', {
    tableName: 'notes',
    columns: [{ name: 'body', type: 'text' }, { name: 'user_id', type: 'uuid' }],
  }, { projectId, userId: ownerId, createdThisTurn: new Set<string>() })
  if (!made.ok) throw new Error(`setup create_table failed: ${made.summary}`)
  const prod = await auth('signup', { email: 'real-user@example.test', password: PASSWORD })
  if (prod.status !== 201) throw new Error(`production signup failed: ${JSON.stringify(prod.body)}`)
  productionToken = prod.body.data.token

  const b = await createBranch(projectId, ownerId, 'qa')
  if (!b.ok) throw new Error(`createBranch qa failed: ${(b as any).error}`)
  qa = (b as any).branch

  const minted = await mintPreviewKey(projectId, qa.id)
  const mintedFresh = await mintPreviewKey(projectId, fresh.id)
  if (!minted.ok || !mintedFresh.ok) throw new Error('mintPreviewKey failed')
  previewKey = (minted as any).minted.key
  freshKey = (mintedFresh as any).minted.key
  mainKey = await makeKey(ownerId, projectId, null)
  clearBranchKeyCache()
  jest.clearAllMocks()

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 240_000)

afterAll(async () => {
  // The routes record each request; write those rows before their project goes.
  await flushRecordedRequests()
  const branches = await prisma.workspaceBranch.findMany({ where: { projectId }, select: { schemaName: true } }).catch(() => [])
  for (const b of branches) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${b.schemaName}" CASCADE`).catch(() => {})
  if (mainSchema) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${mainSchema}" CASCADE`).catch(() => {})
  for (const id of [ownerId, otherOwnerId].filter(Boolean)) {
    await prisma.project.deleteMany({ where: { userId: id } }).catch(() => {})
    await prisma.user.delete({ where: { id } }).catch(() => {})
  }
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
  if (originalEngineMode === undefined) delete process.env.ENGINE_MODE
  else process.env.ENGINE_MODE = originalEngineMode
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
}, 240_000)

describe('sign-up with a preview key', () => {
  let res: Awaited<ReturnType<typeof auth>>

  beforeAll(async () => {
    jest.clearAllMocks()
    res = await auth('signup', { email: 'tester@example.test', password: PASSWORD }, previewKey)
    // The production side effects are fired without being awaited.
    await new Promise((r) => setTimeout(r, 200))
  }, 60_000)

  it('creates the user on the branch and leaves production untouched', async () => {
    expect(res.status).toBe(201)
    expect(res.env).toBe('branch:qa')
    expect(await emails(qa.schemaName)).toEqual(['tester@example.test'])
    expect(await emails(mainSchema)).toEqual(['real-user@example.test'])
  })

  it('runs none of production\'s side effects, and says which', () => {
    expect(res.body.data.skippedOnBranch).toEqual([...SKIPPED_ON_BRANCH_SIGNUP])
    expect(fireAiFunctionsOnSignup).not.toHaveBeenCalled()
    expect(emitEndUserCreated).not.toHaveBeenCalled()
    expect(trackEndUserActive).not.toHaveBeenCalled()
    expect(canAcceptNewEndUser).not.toHaveBeenCalled()
  })

  it('issues a token only the branch accepts', async () => {
    const token = res.body.data.token as string
    expect((jwt.decode(token) as any).br).toBe(qa.id)
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { jwtSecret: true } })
    expect(() => jwt.verify(token, resolveJwtSecret(project!.jwtSecret!))).toThrow(/signature/)
    const scope = { id: qa.id, name: 'qa', schemaName: qa.schemaName }
    expect(await resolveEndUserFromToken(projectId, token, scope)).toMatchObject({ userId: res.body.data.user.id })
    expect(await resolveEndUserFromToken(projectId, token)).toBeNull()
  })
})

describe('a production sign-up (the control)', () => {
  it('still runs every side effect and lists nothing as skipped', async () => {
    jest.clearAllMocks()
    const res = await auth('signup', { email: 'second-real@example.test', password: PASSWORD })
    await new Promise((r) => setTimeout(r, 200))
    expect(res.status).toBe(201)
    expect(res.env).toBe('main')
    expect(res.body.data.skippedOnBranch).toBeUndefined()
    expect(emitEndUserCreated).toHaveBeenCalledTimes(1)
    expect(fireAiFunctionsOnSignup).toHaveBeenCalledTimes(1)
    expect(trackEndUserActive).toHaveBeenCalledTimes(1)
    expect(await emails(qa.schemaName)).not.toContain('second-real@example.test')
  }, 60_000)
})

describe('sign-in', () => {
  it('signs a branch user in with the preview key', async () => {
    const res = await auth('signin', { email: 'tester@example.test', password: PASSWORD }, previewKey)
    expect(res.status).toBe(200)
    expect(res.env).toBe('branch:qa')
    expect((jwt.decode(res.body.data.token) as any).br).toBe(qa.id)
  }, 60_000)

  it('does not find a branch user on production', async () => {
    const res = await auth('signin', { email: 'tester@example.test', password: PASSWORD })
    expect(res.status).toBe(401)
    expect(res.env).toBe('main')
  }, 60_000)

  it('does not find a production user on the branch', async () => {
    const res = await auth('signin', { email: 'real-user@example.test', password: PASSWORD }, previewKey)
    expect(res.status).toBe(401)
    expect(res.env).toBe('branch:qa')
  }, 60_000)

  it('does not ask a branch user to verify an email the branch cannot send', async () => {
    // A branch whose users table records verification, as one cloned from a
    // production that requires it would: new rows start unverified.
    await ensureEmailVerifiedColumn(qa.schemaName)
    await prisma.projectAuthConfig.upsert({
      where: { projectId },
      create: { projectId, requireEmailVerification: true },
      update: { requireEmailVerification: true },
    })
    try {
      const up = await auth('signup', { email: 'unverified@example.test', password: PASSWORD }, previewKey)
      expect(up.status).toBe(201)
      const row = await executeWithUserContext<{ email_verified: boolean }>(
        '', true, `SELECT email_verified FROM "${qa.schemaName}"."users" WHERE email = $1`, ['unverified@example.test'],
      )
      expect(row[0].email_verified).toBe(false)
      const res = await auth('signin', { email: 'unverified@example.test', password: PASSWORD }, previewKey)
      expect(res.status).toBe(200)
      // Production still enforces it.
      const prodUp = await auth('signup', { email: 'needs-verify@example.test', password: PASSWORD })
      expect(prodUp.status).toBe(201)
      const prodIn = await auth('signin', { email: 'needs-verify@example.test', password: PASSWORD })
      expect(prodIn.status).toBe(403)
      expect(prodIn.body.error.details?.reason ?? prodIn.body.error.reason).toBe('EMAIL_NOT_VERIFIED')
    } finally {
      await prisma.projectAuthConfig.update({ where: { projectId }, data: { requireEmailVerification: false } })
    }
  }, 60_000)
})

describe('the data plane', () => {
  let branchToken: string
  let branchUserId: string

  beforeAll(async () => {
    const res = await auth('signin', { email: 'tester@example.test', password: PASSWORD }, previewKey)
    branchToken = res.body.data.token
    branchUserId = String(res.body.data.user.id)
  }, 60_000)

  it('acts as the branch user on the branch', async () => {
    const r = await dataPlane({ 'x-api-key': previewKey, 'x-user-token': branchToken })
    expect(r).toMatchObject({ success: true, endUserId: branchUserId, branchSchema: qa.schemaName, branchName: 'qa' })
  }, 60_000)

  it('names a production token sent with the preview key, instead of serving it', async () => {
    const r = await dataPlane({ 'x-api-key': previewKey, 'x-user-token': productionToken })
    expect(r).toMatchObject({ success: false, code: 'PRODUCTION_TOKEN_ON_BRANCH' })
  }, 60_000)

  it('names a branch token sent to production, with a main key or alone', async () => {
    expect(await dataPlane({ 'x-api-key': mainKey, 'x-user-token': branchToken }))
      .toMatchObject({ success: false, code: 'BRANCH_TOKEN_ON_MAIN' })
    expect(await dataPlane({ authorization: `Bearer ${branchToken}` }))
      .toMatchObject({ success: false, code: 'BRANCH_TOKEN_ON_MAIN' })
  }, 60_000)

  it('names a token from another branch', async () => {
    const r = await dataPlane({ 'x-api-key': freshKey, 'x-user-token': branchToken })
    expect(r).toMatchObject({ success: false, code: 'BRANCH_TOKEN_MISMATCH' })
  }, 60_000)

  it('keeps serving production tokens on production exactly as before', async () => {
    const r = await dataPlane({ 'x-api-key': mainKey, 'x-user-token': productionToken })
    expect(r).toMatchObject({ success: true })
    expect(r.endUserId).toBeTruthy()
    expect(r.branchSchema).toBeUndefined()
  }, 60_000)
})

describe('refresh and logout', () => {
  let token: string

  beforeAll(async () => {
    const res = await auth('signin', { email: 'tester@example.test', password: PASSWORD }, previewKey)
    token = res.body.data.token
  }, 60_000)

  it('refreshes a branch session on the branch, and keeps it a branch session', async () => {
    const res = await auth('refresh-token', { token }, previewKey)
    expect(res.status).toBe(200)
    expect(res.env).toBe('branch:qa')
    expect((jwt.decode(res.body.data.token) as any).br).toBe(qa.id)
  }, 60_000)

  it('will not turn a branch session into a production one', async () => {
    const res = await auth('refresh-token', { token })
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('BRANCH_TOKEN_ON_MAIN')
  }, 60_000)

  it('revokes on the branch, where the data plane checks it', async () => {
    const res = await auth('logout', { token }, previewKey)
    expect(res.status).toBe(200)
    const jti = (jwt.decode(token) as any).jti
    const revoked = await prisma.$queryRawUnsafe<Array<{ jti: string }>>(
      `SELECT jti FROM "${qa.schemaName}"."_token_blacklist" WHERE jti = $1`, jti,
    )
    expect(revoked).toHaveLength(1)
    const scope = { id: qa.id, name: 'qa', schemaName: qa.schemaName }
    expect(await resolveEndUserFromToken(projectId, token, scope)).toBeNull()
    const onMain = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = ${mainSchema} AND table_name = '_token_blacklist'`
    expect(onMain[0].n).toBe(0)
  }, 60_000)
})

describe('a branch with no users table yet', () => {
  it('gets its own, with row security, and production gains nothing', async () => {
    expect(await emails(fresh.schemaName)).toEqual([])
    const policiesBefore = await prisma.permissionPolicy.count({ where: { projectId, tableName: 'users' } })
    const res = await auth('signup', { email: 'fresh@example.test', password: PASSWORD }, freshKey)
    expect(res.status).toBe(201)
    expect(res.env).toBe('branch:fresh')
    expect(await emails(fresh.schemaName)).toEqual(['fresh@example.test'])
    const pols = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = ${fresh.schemaName} AND tablename = 'users'`
    expect(pols[0].n).toBeGreaterThan(0)
    expect(await prisma.permissionPolicy.count({ where: { projectId, tableName: 'users' } })).toBe(policiesBefore)
    expect(await emails(mainSchema)).not.toContain('fresh@example.test')
  }, 60_000)
})

describe('a key that must not fall back to production', () => {
  it('is refused on sign-up when its branch is no longer active', async () => {
    const closed = await prisma.workspaceBranch.create({
      data: { projectId, name: 'closed', schemaName: `${mainSchema}_br_closed`, status: 'discarded', createdBy: ownerId },
    })
    const key = await makeKey(ownerId, projectId, closed.id)
    const before = await emails(mainSchema)
    const res = await auth('signup', { email: 'closed@example.test', password: PASSWORD }, key)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('BRANCH_INACTIVE')
    expect(await emails(mainSchema)).toEqual(before)
  }, 60_000)

  it('is refused when it belongs to another project\'s branch', async () => {
    otherOwnerId = (await prisma.user.create({
      data: { email: `branch-auth-other-${crypto.randomBytes(6).toString('hex')}@example.test` },
    })).id
    const other = await prisma.project.create({ data: { name: 'branch-auth-other', userId: otherOwnerId } })
    const otherBranch = await prisma.workspaceBranch.create({
      data: { projectId: other.id, name: 'theirs', schemaName: `workspace_${other.id}_br_theirs`, status: 'active', createdBy: otherOwnerId },
    })
    const key = await makeKey(otherOwnerId, other.id, otherBranch.id)
    const res = await auth('signup', { email: 'stray@example.test', password: PASSWORD }, key)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('API_KEY_PROJECT_MISMATCH')
    expect(await emails(mainSchema)).not.toContain('stray@example.test')
  }, 60_000)
})

describe('the Express runtime (the self-host door)', () => {
  it('signs up on the branch the same way', async () => {
    const res = await fetch(`${base}/api/v1/${projectId}/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': previewKey, 'x-forwarded-for': '10.78.0.1' },
      body: JSON.stringify({ email: 'runtime@example.test', password: PASSWORD }),
    })
    const body = (await res.json()) as any
    expect(res.status).toBe(201)
    expect(res.headers.get('x-backenly-environment')).toBe('branch:qa')
    expect(body.data.skippedOnBranch).toEqual([...SKIPPED_ON_BRANCH_SIGNUP])
    expect((jwt.decode(body.data.token) as any).br).toBe(qa.id)
    expect(await emails(qa.schemaName)).toContain('runtime@example.test')
    expect(await emails(mainSchema)).not.toContain('runtime@example.test')
  }, 60_000)

  it('still refuses the emailed flows to a branch key', async () => {
    const res = await fetch(`${base}/api/v1/${projectId}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': previewKey },
      body: JSON.stringify({ email: 'tester@example.test' }),
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).code).toBe('BRANCH_SURFACE_UNAVAILABLE')
  }, 60_000)
})
