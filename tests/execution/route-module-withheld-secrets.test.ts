/**
 * A route function never holds the project's signing secret or admin key.
 *
 * process.env used to carry JWT_SECRET (the secret every end-user session is
 * signed with) and ADMIN_API_KEY / AI_EXECUTION_TOKEN (the project's admin
 * key). Function code is free-form, so any function could read them and hand
 * them out, and with the signing secret anyone could sign in as any user. The
 * function's verifyToken also fell back to the platform's verifier, so a
 * Backenly session token passed as one of the project's users.
 *
 * Now the names hold a value that matches nothing, the helpers that need the
 * material use it inside the runner (isAdminRequest, verifyToken, and
 * jsonwebtoken.verify with process.env.JWT_SECRET), and deploy-time validation
 * refuses code that reads the names.
 *
 * No database: auth material is injected through the runner's test hook.
 */

import * as jsonwebtoken from 'jsonwebtoken'
import {
  executeRouteModuleFunction,
  validateRouteModule,
  WITHHELD_READ_REFUSED,
} from '@/lib/services/ai-functions/route-module-runner'
import { generateToken } from '@/lib/auth/jwt'
import { generateDomainEndpoints } from '@/lib/ai/build-runtime/domain-business-logic'

const jwt: typeof jsonwebtoken = (jsonwebtoken as any).default ?? jsonwebtoken
const PROJECT_ID = '11111111-2222-4333-8444-555555555555'
const SECRET = 'project-signing-secret-for-this-test-only-0123456789'
const ADMIN = `bk_admin_${'a'.repeat(64)}`

function run(code: string, headers: Record<string, string> = {}, auth = { jwtSecret: SECRET, adminKey: ADMIN }) {
  return executeRouteModuleFunction(code, PROJECT_ID, { type: 'manual', data: {} }, 'GET /fn/t', { authMaterial: auth, headers })
}

describe('process.env holds neither the signing secret nor the admin key', () => {
  it('a function that returns its whole environment gets neither', async () => {
    const { returnValue } = await run(`
      import { NextResponse } from 'next/server'
      export async function GET() { return NextResponse.json({ env: { ...process.env } }) }
    `)
    const seen = JSON.stringify(returnValue.body)
    expect(seen).not.toContain(SECRET)
    expect(seen).not.toContain(ADMIN)
  })

  // Each of these is a gate someone could have written against the variable.
  // Removed outright, the first two would let every caller in.
  it.each([
    ["(request.headers.get('x-admin-key') ?? '') === (process.env.ADMIN_API_KEY ?? '')"],
    ["request.headers.get('x-admin-key') == process.env.ADMIN_API_KEY"],
    ["request.headers.get('x-admin-key') === process.env.AI_EXECUTION_TOKEN"],
  ])('a gate written `%s` admits nobody, not even the real key', async (gate) => {
    const code = `
      import { NextResponse } from 'next/server'
      export async function GET(request) {
        if (!(${gate})) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
        return NextResponse.json({ ok: true })
      }
    `
    expect((await run(code)).returnValue.status).toBe(403)
    expect((await run(code, { 'x-admin-key': ADMIN })).returnValue.status).toBe(403)
  })
})

describe('isAdminRequest from @/lib/auth/jwt', () => {
  const code = `
    import { NextResponse } from 'next/server'
    import { isAdminRequest } from '@/lib/auth/jwt'
    export async function GET(request) {
      return NextResponse.json({ admin: isAdminRequest(request) })
    }
  `
  const admin = async (headers: Record<string, string>, auth?: { jwtSecret: string | null; adminKey: string | null }) =>
    (await run(code, headers, auth)).returnValue.body.admin

  it('admits the project’s admin key, in x-admin-key or as a bearer token', async () => {
    expect(await admin({ 'x-admin-key': ADMIN })).toBe(true)
    expect(await admin({ authorization: `Bearer ${ADMIN}` })).toBe(true)
  })

  it.each([[{}], [{ 'x-admin-key': 'wrong' }], [{ 'x-admin-key': `${ADMIN}x` }], [{ authorization: 'Bearer ' }]])(
    'refuses %j',
    async (headers) => {
      expect(await admin(headers as Record<string, string>)).toBe(false)
    },
  )

  it('refuses everyone in a project that has no admin key', async () => {
    expect(await admin({ 'x-admin-key': ADMIN }, { jwtSecret: SECRET, adminKey: null })).toBe(false)
  })
})

describe('verifyToken from @/lib/auth/jwt', () => {
  const code = `
    import { NextResponse } from 'next/server'
    import { verifyToken } from '@/lib/auth/jwt'
    export async function GET(request) {
      const payload = verifyToken((request.headers.get('x-user-token') || '').replace(/^Bearer /i, ''))
      return NextResponse.json({ userId: payload ? payload.userId : null })
    }
  `
  const userOf = async (token: string) => (await run(code, { 'x-user-token': `Bearer ${token}` })).returnValue.body.userId

  it('accepts a token this project signed', async () => {
    expect(await userOf(jwt.sign({ userId: 'shopper', projectId: PROJECT_ID }, SECRET, { algorithm: 'HS256' }))).toBe('shopper')
  })

  it('refuses a Backenly session token, which the platform signs for people using the console', async () => {
    expect(await userOf(generateToken({ userId: 'console-person', email: 'person@example.test' }))).toBeNull()
  })
})

describe('jsonwebtoken with process.env.JWT_SECRET', () => {
  it('refuses to sign a session with it', async () => {
    const { returnValue } = await run(`
      import { NextResponse } from 'next/server'
      import jwt from 'jsonwebtoken'
      export async function GET() {
        try {
          return NextResponse.json({ token: jwt.sign({ userId: 'anyone' }, process.env.JWT_SECRET) })
        } catch (err) {
          return NextResponse.json({ error: err.message }, { status: 500 })
        }
      }
    `)
    expect(returnValue.status).toBe(500)
    expect(returnValue.body.error).toMatch(/cannot sign the project's end-user sessions/)
  })

  it('verifies a caller’s token with it, against the project’s secret the function never holds', async () => {
    const token = jwt.sign({ userId: 'shopper', projectId: PROJECT_ID }, SECRET, { algorithm: 'HS256' })
    const { returnValue } = await run(
      `
      import { NextResponse } from 'next/server'
      import jwt from 'jsonwebtoken'
      export async function GET(request) {
        const payload = jwt.verify(request.headers.get('x-user-token').replace(/^Bearer /i, ''), process.env.JWT_SECRET)
        return NextResponse.json({ userId: payload.userId })
      }
    `,
      { 'x-user-token': `Bearer ${token}` },
    )
    expect(returnValue.body).toEqual({ userId: 'shopper' })
  })
})

describe('deploy-time validation', () => {
  const handlerWith = (line: string) => `
    import { NextResponse } from 'next/server'
    export async function GET() {
      ${line}
      return NextResponse.json({ ok: true })
    }
  `

  it.each([
    ['const s = process.env.JWT_SECRET'],
    ["const k = process.env['ADMIN_API_KEY']"],
    ['const t = process.env?.AI_EXECUTION_TOKEN'],
    ['const { JWT_SECRET } = process.env'],
  ])('refuses code that reads one of them: %s', async (line) => {
    expect(await validateRouteModule(handlerWith(line))).toEqual({ valid: false, methods: [], error: WITHHELD_READ_REFUSED })
  })

  it('names the helpers in the refusal', () => {
    expect(WITHHELD_READ_REFUSED).toMatch(/isAdminRequest\(request\)/)
    expect(WITHHELD_READ_REFUSED).toMatch(/verifyToken\(token\)/)
    expect(WITHHELD_READ_REFUSED).toMatch(/asService/)
  })

  it('accepts code that only names them in a comment, or reads the project’s own variables', async () => {
    expect(await validateRouteModule(handlerWith('// never read process.env.JWT_SECRET\n      const plan = process.env.PLAN_NAME'))).toMatchObject({ valid: true })
  })
})

describe('Backenly’s own admin endpoints', () => {
  const admins = generateDomainEndpoints('users', PROJECT_ID, ['users', 'jobs', 'credits', 'orders', 'products', 'sellers'])
    .filter((e) => e.name.startsWith('admin-'))

  it('are generated, and none mints sessions', () => {
    expect(admins.length).toBeGreaterThan(3)
    expect(admins.map((e) => e.name)).not.toContain('admin-impersonate')
  })

  it('read none of the withheld variables and pass validation', async () => {
    for (const e of admins) {
      expect({ name: e.name, check: await validateRouteModule(e.code, e.method) }).toMatchObject({ name: e.name, check: { valid: true } })
    }
  })

  it('answer 403 without the project’s admin key, and let it through', async () => {
    const list = admins.find((e) => e.name === 'admin-users-list')!
    expect((await run(list.code)).returnValue.status).toBe(403)
    // Past the gate the handler reaches the database, which this suite does not
    // have: anything but 403 is the gate letting the key through.
    const withKey = await run(list.code, { 'x-admin-key': ADMIN }).catch((err: Error) => ({ returnValue: { status: 0, body: err.message } }))
    expect(withKey.returnValue.status).not.toBe(403)
  })
})
