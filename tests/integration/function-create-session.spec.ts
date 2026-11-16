/**
 * A FUNCTION SIGNS A USER IN WITHOUT EVER HOLDING THE SIGNING SECRET
 * ==================================================================
 *
 * Functions no longer get the project's signing secret (route-module-runner.ts
 * withholds JWT_SECRET), so a function that proves who a user is its own way,
 * phone verification by an SMS code for one, had nothing left to sign them in
 * with: code that signed with process.env.JWT_SECRET is refused.
 *
 * createSession(userId) from '@/lib/auth/session', and ctx.auth.createSession
 * in a sandbox body, ask the platform for the session, as Appwrite's server
 * users.createSession does and Supabase's service-role admin API does: Backenly
 * signs exactly the token password sign-in issues (lib/auth/end-user-session.ts).
 *
 * Through the real sign-up and sign-in routes, the real function runner, and a
 * provisioned project whose signing secret is stored encrypted, against a real
 * database; only PostgREST's schema registry and the Cloud entitlement lookup
 * are stubbed, as in end-user-session-tokens.spec.ts.
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

import '@/tests/helpers/real-web-standard'

import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'

import { prisma } from '@/lib/db/prisma'
import { createProvisionedProject } from '@/lib/projects/provision'
import { resolveEndUserFromToken } from '@/server/lib/end-user-identity'
import { executeRouteModuleFunction } from '@/lib/services/ai-functions/route-module-runner'
import { executeAiFunction } from '@/lib/services/ai-functions/executor'
import { POST as signup } from '@/app/api/v1/[projectId]/auth/signup/route'
import { POST as signin } from '@/app/api/v1/[projectId]/auth/signin/route'

jest.setTimeout(120_000)

let ownerId: string
const schemas: string[] = []
let ip = 0

/** A provisioned project, the way Cloud makes one: its signing secret stored encrypted. */
async function project(name: string): Promise<string> {
  const p = await createProvisionedProject({ name, userId: ownerId })
  schemas.push(p.postgresSchema)
  return p.id
}

async function call(route: typeof signup, projectId: string, action: string, body: unknown) {
  ip++
  const res = await route(
    new NextRequest(`https://backenly.test/api/v1/${projectId}/auth/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.89.0.${ip}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId }) },
  )
  return { status: res.status, body: (await res.json()) as any }
}

async function signUp(projectId: string, email: string): Promise<string> {
  const res = await call(signup, projectId, 'signup', { email, password: 'Correct-Horse-9' })
  expect(res.status).toBe(201)
  return String(res.body.data.user.id)
}

/** An http function that signs in whichever user its body names, as phone verification does once the code matches. */
const verifyModule = `
  import { NextResponse } from 'next/server'
  import { createSession } from '@/lib/auth/session'

  export async function POST(request) {
    const { userId } = await request.json()
    try {
      const { token, user } = await createSession(userId)
      return NextResponse.json({ token, user })
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 })
    }
  }
`

function runVerify(projectId: string, userId: unknown) {
  return executeRouteModuleFunction(verifyModule, projectId, { type: 'http', data: { userId } }, 'POST /fn/verify-phone', {})
}

const claimsOf = (token: string) => jwt.decode(token) as Record<string, any>

let projectId: string
let otherProjectId: string
let userId: string
let suspendedId: string
let otherUserId: string

const originalEdition = process.env.BACKENLY_EDITION

beforeAll(async () => {
  // Cloud: the edition that provisions projects, and the one the Next routes serve.
  process.env.BACKENLY_EDITION = 'cloud'
  ownerId = (await prisma.user.create({
    data: { email: `fn-session-${crypto.randomBytes(6).toString('hex')}@example.test` },
  })).id
  projectId = await project('fn-session')
  otherProjectId = await project('fn-session-other')

  userId = await signUp(projectId, 'phone-user@example.test')
  suspendedId = await signUp(projectId, 'suspended@example.test')
  await prisma.$executeRawUnsafe(`UPDATE "workspace_${projectId}"."users" SET is_blocked = true WHERE id::text = $1`, suspendedId)
  otherUserId = await signUp(otherProjectId, 'someone-elsewhere@example.test')
}, 180_000)

afterAll(async () => {
  for (const s of schemas) await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {})
  if (ownerId) {
    await prisma.aiFunction.deleteMany({ where: { project: { userId: ownerId } } }).catch(() => {})
    await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
    await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
  }
  if (originalEdition === undefined) delete process.env.BACKENLY_EDITION
  else process.env.BACKENLY_EDITION = originalEdition
}, 120_000)

describe('createSession from an http function', () => {
  it('returns a session the project accepts as that user, and the run’s logs say whom it signed in', async () => {
    const { returnValue, logs } = await runVerify(projectId, userId)
    expect(returnValue.status).toBe(200)
    // Sign-up names a user after their address when no name is given.
    expect(returnValue.body.user).toEqual({ id: userId, email: 'phone-user@example.test', name: 'phone-user', role: 'user' })
    expect(await resolveEndUserFromToken(projectId, returnValue.body.token)).toMatchObject({ userId })
    expect(logs).toContain(`Backenly: createSession signed in end user ${userId}.`)
  })

  it('issues exactly the token password sign-in issues: the same claims and the same lifetime', async () => {
    const signedIn = await call(signin, projectId, 'signin', { email: 'phone-user@example.test', password: 'Correct-Horse-9' })
    expect(signedIn.status).toBe(200)
    const fromSignin = claimsOf(signedIn.body.data.token)
    const created = (await runVerify(projectId, userId)).returnValue.body
    const fromFunction = claimsOf(created.token)

    expect(created.user).toEqual(signedIn.body.data.user)
    expect(Object.keys(fromFunction).sort()).toEqual(Object.keys(fromSignin).sort())
    expect(fromFunction).toMatchObject({ userId: fromSignin.userId, email: fromSignin.email, projectId, role: fromSignin.role })
    expect(fromFunction.exp - fromFunction.iat).toBe(fromSignin.exp - fromSignin.iat)
    expect(fromFunction.exp - fromFunction.iat).toBe(7 * 24 * 60 * 60)
    expect(fromFunction.jti).not.toBe(fromSignin.jti)
  })

  it.each([
    ['an id that is no user of the project', () => crypto.randomUUID(), /No user with that id/],
    ['a suspended user', () => suspendedId, /suspended/],
    ['a user of another project', () => otherUserId, /No user with that id/],
    ['no id at all', () => undefined, /needs the user's id/],
    ['an object instead of an id', () => ({ id: 'x' }), /needs the user's id/],
    ['an empty id', () => '   ', /needs the user's id/],
  ])('refuses %s', async (_label, id, reason) => {
    const { returnValue, logs } = await runVerify(projectId, id())
    expect(returnValue.status).toBe(400)
    expect(returnValue.body.error).toMatch(reason)
    expect(returnValue.body.token).toBeUndefined()
    expect(logs.join('\n')).not.toMatch(/createSession signed in/)
  })

  it('never gives the function the signing secret on the way', async () => {
    const { returnValue } = await executeRouteModuleFunction(`
      import { NextResponse } from 'next/server'
      import * as session from '@/lib/auth/session'
      export async function GET() {
        return NextResponse.json({ names: Object.keys(session).filter((k) => k !== 'default'), env: { ...process.env } })
      }
    `, projectId, { type: 'http', data: {} }, 'GET /fn/inspect', {})
    expect(returnValue.body.names).toEqual(['createSession'])
    const stored = await prisma.project.findUnique({ where: { id: projectId }, select: { jwtSecret: true } })
    const { resolveJwtSecret } = await import('@/lib/services/jwtSecretManager')
    const seen = JSON.stringify(returnValue.body)
    expect(seen).not.toContain(stored!.jwtSecret!)
    expect(seen).not.toContain(resolveJwtSecret(stored!.jwtSecret!))
  })
})

describe('a users table with an integer key and none of the optional columns', () => {
  // Older projects made their own users table; sign-in serves them, so createSession does.
  const SECRET = crypto.randomBytes(32).toString('hex')
  let legacyId: string

  beforeAll(async () => {
    legacyId = (await prisma.project.create({ data: { name: 'fn-session-legacy', userId: ownerId, jwtSecret: SECRET }, select: { id: true } })).id
    const s = `workspace_${legacyId}`
    schemas.push(s)
    await prisma.$executeRawUnsafe(`CREATE SCHEMA "${s}"`)
    await prisma.$executeRawUnsafe(`CREATE TABLE "${s}"."users" (id serial PRIMARY KEY, email text NOT NULL, password text NOT NULL)`)
    await prisma.$executeRawUnsafe(`INSERT INTO "${s}"."users" (email, password) VALUES ('legacy@example.test', 'not-a-hash')`)
  }, 60_000)

  it('signs in the user a function names by number, with the claims sign-in gives that user', async () => {
    const { returnValue } = await runVerify(legacyId, 1)
    expect(returnValue.status).toBe(200)
    expect(returnValue.body.user).toEqual({ id: 1, email: 'legacy@example.test', name: null, role: 'user' })
    expect(jwt.verify(returnValue.body.token, SECRET)).toMatchObject({ userId: 1, email: 'legacy@example.test', projectId: legacyId, role: 'user' })
  })
})

describe('ctx.auth.createSession from a sandbox function', () => {
  async function sandbox(code: string, data: Record<string, unknown>) {
    const fn = await prisma.aiFunction.create({
      data: { projectId, name: `session-${crypto.randomBytes(4).toString('hex')}`, description: 'session', generatedCode: code, triggerType: 'manual', status: 'active' },
    })
    return executeAiFunction(fn.id, projectId, { type: 'manual', data }, { selfHeal: false })
  }

  it('returns the same session for an existing user', async () => {
    const result = await sandbox(`return await ctx.auth.createSession(event.data.userId)`, { userId })
    expect(result.success).toBe(true)
    expect(result.returnValue.user).toMatchObject({ id: userId, email: 'phone-user@example.test' })
    expect(await resolveEndUserFromToken(projectId, result.returnValue.token)).toMatchObject({ userId })
    expect(result.logs).toContain(`Backenly: createSession signed in end user ${userId}.`)
  })

  it('fails the run for a user it may not sign in, with the reason', async () => {
    const result = await sandbox(`return await ctx.auth.createSession(event.data.userId)`, { userId: otherUserId })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No user with that id/)
  })
})
