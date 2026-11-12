/**
 * An owner's test run gives the function no admin credential.
 *
 * The dashboard's Test, functions { action: "invoke" } and the generator's
 * smoke test run a function for someone who may change the project, and its
 * admin and signed-in paths should answer them. The runner used to do that by
 * putting the project's admin key in x-admin-key and a ten-minute token with
 * role "admin", signed with the project's secret, in x-user-token. Function
 * code reads request.headers, so any function could keep both when its owner
 * clicked Test.
 *
 * Now the runner itself holds the fact that the run is an owner's test, and its
 * helpers ask it: isAdminRequest answers true, and verifyToken reads the
 * placeholder the request carries as the test user. Nothing the function can
 * read opens anything: the placeholder is nobody in any other run, and in this
 * one once it has ended.
 *
 * No database: auth material is injected through the runner's test hook.
 */

import * as jsonwebtoken from 'jsonwebtoken'
import { executeRouteModuleFunction, OWNER_TEST_TOKEN } from '@/lib/services/ai-functions/route-module-runner'
import { TEST_RUN_USER_ID } from '@/lib/services/ai-functions/project-fn-auth'
import { generateDomainEndpoints } from '@/lib/ai/build-runtime/domain-business-logic'

const jwt: typeof jsonwebtoken = (jsonwebtoken as any).default ?? jsonwebtoken
const PROJECT_ID = '22222222-3333-4444-8555-666666666666'
const SECRET = 'owner-test-run-signing-secret-for-this-test-only-012345'
const ADMIN = `bk_admin_${'b'.repeat(64)}`
const AUTH = { jwtSecret: SECRET, adminKey: ADMIN }

const ownerTest = (code: string, data: Record<string, unknown> = {}) =>
  executeRouteModuleFunction(code, PROJECT_ID, { type: 'manual', data }, 'POST /fn/t', { testRun: true, authMaterial: AUTH })

const publicCall = (code: string, headers: Record<string, string> = {}) =>
  executeRouteModuleFunction(code, PROJECT_ID, { type: 'http', data: {} }, 'POST /fn/t', { headers, authMaterial: AUTH })

/** Every string in a value, however deeply it is nested. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...strings(v)])
  return []
}

/** Whether the project would take `value` as a session: it verifies with the project's signing secret. */
function aSessionOfTheProject(value: string): boolean {
  try {
    jwt.verify(value.replace(/^Bearer\s+/i, ''), SECRET)
    return true
  } catch {
    return false
  }
}

describe("an owner's test run", () => {
  /** Everything the function can read about its request and environment. */
  const whatTheFunctionSees = async () => {
    const { returnValue } = await ownerTest(`
      import { NextResponse } from 'next/server'
      export async function POST(request, context) {
        const headers = {}
        request.headers.forEach((value, name) => { headers[name] = value })
        return NextResponse.json({ headers, url: request.url, body: await request.json(), params: context.params, env: { ...process.env } })
      }
    `)
    const seen = strings(returnValue.body)
    expect(seen).toContain('x-user-token')
    return seen
  }

  it('gives the function neither the admin key nor the signing secret', async () => {
    expect((await whatTheFunctionSees()).filter((s) => s.includes(ADMIN) || s.includes(SECRET))).toEqual([])
  })

  it('gives the function no token the project takes as a session', async () => {
    expect((await whatTheFunctionSees()).filter(aSessionOfTheProject)).toEqual([])
  })

  it("lets Backenly's admin endpoints answer it", async () => {
    const list = generateDomainEndpoints('users', PROJECT_ID, ['users', 'jobs', 'credits', 'orders', 'products', 'sellers'])
      .find((e) => e.name === 'admin-users-list')!
    // Past the gate the handler reaches the database, which this suite does not
    // have: anything but 403 is the gate letting the owner's test through.
    const out = await ownerTest(list.code).catch((err: Error) => ({ returnValue: { status: 0, body: err.message } }))
    expect(out.returnValue.status).not.toBe(403)
  })

  it('is an admin request, where a public call without the key is not', async () => {
    const code = `
      import { NextResponse } from 'next/server'
      import { isAdminRequest } from '@/lib/auth/jwt'
      export async function POST(request) { return NextResponse.json({ admin: isAdminRequest(request) }) }
    `
    expect((await ownerTest(code)).returnValue.body).toEqual({ admin: true })
    expect((await publicCall(code)).returnValue.body).toEqual({ admin: false })
  })

  it('is signed in as the test user to every token check the function can make', async () => {
    const { returnValue } = await ownerTest(`
      import { NextResponse } from 'next/server'
      import { verifyToken } from '@/lib/auth/jwt'
      import jwt from 'jsonwebtoken'
      export async function POST(request) {
        const token = (request.headers.get('x-user-token') || '').replace(/^Bearer /i, '')
        const bearer = (request.headers.get('authorization') || '').replace(/^Bearer /i, '')
        return NextResponse.json({
          verifyToken: verifyToken(token),
          verify: jwt.verify(bearer, process.env.JWT_SECRET),
          verifyWithCallback: jwt.verify(token, process.env.JWT_SECRET, (err, payload) => (err ? null : payload)),
          decode: jwt.decode(token),
        })
      }
    `)
    const testUser = { userId: TEST_RUN_USER_ID, role: 'admin', projectId: PROJECT_ID, exp: expect.any(Number) }
    expect(returnValue.body).toMatchObject({ verifyToken: testUser, verify: testUser, verifyWithCallback: testUser, decode: testUser })
    expect(returnValue.body.verifyToken.exp * 1000).toBeGreaterThan(Date.now())
  })

  it('keeps a token the owner put in the test event as that user', async () => {
    const token = jwt.sign({ userId: 'shopper', projectId: PROJECT_ID }, SECRET, { algorithm: 'HS256' })
    const { returnValue } = await ownerTest(
      `
      import { NextResponse } from 'next/server'
      import { verifyToken } from '@/lib/auth/jwt'
      export async function POST(request) {
        const payload = verifyToken((request.headers.get('x-user-token') || '').replace(/^Bearer /i, ''))
        return NextResponse.json({ userId: payload && payload.userId })
      }
    `,
      { token },
    )
    expect(returnValue.body).toEqual({ userId: 'shopper' })
  })
})

describe("the placeholder an owner's test run carries", () => {
  const code = `
    import { NextResponse } from 'next/server'
    import { verifyToken, isAdminRequest } from '@/lib/auth/jwt'
    export async function POST(request) {
      const token = (request.headers.get('x-user-token') || '').replace(/^Bearer /i, '')
      const now = () => ({ user: verifyToken(token), admin: isAdminRequest(request) })
      return NextResponse.json({ ...now(), later: now })
    }
  `

  it('is nobody when a caller sends it', async () => {
    const { returnValue } = await publicCall(code, { 'x-user-token': `Bearer ${OWNER_TEST_TOKEN}` })
    expect(returnValue.body).toMatchObject({ user: null, admin: false })
  })

  it('is nobody, and the run no admin, once the test has ended', async () => {
    const { returnValue } = await ownerTest(code)
    expect(returnValue.body).toMatchObject({ user: { userId: TEST_RUN_USER_ID }, admin: true })
    expect(returnValue.body.later()).toEqual({ user: null, admin: false })
  })
})
