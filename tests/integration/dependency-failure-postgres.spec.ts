/**
 * WHAT THE APPLICATION SAYS WHILE POSTGRESQL IS UNREACHABLE
 * ========================================================
 *
 * Restart qualification proved a pool recovers. This is the other question: an
 * application that is ALREADY RUNNING, with an established pool, loses its
 * database mid-flight. What does it tell its callers, and what does it do with
 * the work that was in progress.
 *
 * The transport is cut through a proxy, so nothing about PostgreSQL's own state
 * changes and the same process keeps running throughout. That is deliberate:
 * the claim under test is that recovery needs no restart and no reconfiguration.
 * See tests/helpers/severable-proxy.ts.
 *
 * ── The defect this found ───────────────────────────────────────────────────
 *
 * Every authorization wrapper in lib/auth/route-protection.ts ended with a
 * catch-all returning 401 or 403. So while the database was down, an operator
 * holding a perfectly valid session was told their credentials had been
 * rejected — and the obvious response, signing out and back in, destroys the
 * session and cannot succeed, because sign-in reads the same database. The
 * dashboard showed "signed out" during a database outage, and whoever was
 * debugging started on the one subsystem that was fine.
 *
 * Same family as storage answering 404 while its volume was missing: a definite
 * claim about the world, made by code whose only evidence is that something
 * threw. lib/errors/dependency-unavailable.ts now separates the two, and the
 * codes it recognises were MEASURED here rather than guessed — Prisma 5.7 on a
 * severed transport raises P1017 from a model query and P1001 from a raw one.
 *
 * ── The four paths the brief named ──────────────────────────────────────────
 *
 *   end-user auth    POST /v1/{project}/auth/signin   (the real v1 surface)
 *   a dashboard read GET  /api/notifications
 *   a write path     POST /v1/{project}/auth/signup
 *   an authorization wrapper, which is what /db/* and every dashboard route
 *   pass through before they reach any data
 *
 * `/db/*` itself is served by the runtime (server/routes/postgrest-handler.ts)
 * against a real PostgREST, which does not exist in this job. It is NOT
 * simulated here; it belongs to the self-host CI job, where the data plane is
 * real. Pretending otherwise would be the kind of evidence this programme keeps
 * deleting.
 *
 * ── Every failure is paired with a success ──────────────────────────────────
 *
 * Each path is exercised while healthy first, THROUGH THE SAME PROXY, so a
 * refusal cannot pass because the fixture never worked.
 */

import crypto from 'crypto'
import { PrismaClient } from '@prisma/client'

import { severableProxy, throughProxy, type Severable } from '../helpers/severable-proxy'

const REAL_URL = process.env.TEST_DATABASE_URL!

// A client on the REAL address, never through the proxy. It seeds the fixture
// and inspects the database afterwards, so the verification of "this write was
// not silently committed later" cannot itself be blocked by the outage.
const direct = new PrismaClient({ datasources: { db: { url: REAL_URL } } })

let proxy: Severable

// Loaded inside beforeAll, AFTER DATABASE_URL is repointed: `lib/db/postgres`
// builds its PrismaClient at import time, and a static import would be hoisted
// above the assignment, leaving the product talking to the real address where
// nothing can be severed.
let signin: any
let signup: any
let notifications: any

const OPERATOR_PASSWORD = 'operator-not-used-directly'
const END_USER_PASSWORD = 'CorrectHorse!9'

let ownerId: string
let projectId: string
let schema: string
let sessionToken: string

let ipCounter = 0

/**
 * The transport envelope the handlers read. jest.setup.js replaces
 * `global.Request` with a constructor that assigns `url`, which NextRequest
 * declares getter-only, so a NextRequest cannot be built here. The handlers'
 * own logic, the database and bcrypt all run for real; only the envelope is
 * constructed, and the envelope is not what is being asserted.
 *
 * Sign-in is IP-limited, so every call gets an address of its own — otherwise
 * one case throttles the next and an assertion about the database quietly
 * becomes an assertion about the rate limiter.
 */
function req(opts: { body?: any; bearer?: string; url?: string } = {}): any {
  ipCounter += 1
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': `198.51.100.${ipCounter % 250}`,
  }
  if (opts.bearer) headers['authorization'] = `Bearer ${opts.bearer}`
  return {
    method: 'POST',
    url: opts.url ?? 'http://localhost:3000/api/test',
    nextUrl: { pathname: '/api/test', searchParams: new URLSearchParams() },
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    cookies: { get: () => undefined, getAll: () => [] },
    json: async () => opts.body ?? {},
  }
}

const params = { params: Promise.resolve({ projectId: '' }) }

async function endUserSignin(email: string, password: string) {
  const res = await signin(req({ body: { email, password } }), {
    params: Promise.resolve({ projectId }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function endUserSignup(email: string, password: string) {
  const res = await signup(req({ body: { email, password, name: 'Dependency Suite' } }), {
    params: Promise.resolve({ projectId }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function dashboardQuery() {
  return notifications(
    req({ bearer: sessionToken, url: 'http://localhost:3000/api/notifications?limit=10' }),
  )
}

/** Rows currently in the project's end-user table, read on the REAL connection. */
async function endUserEmails(): Promise<string[]> {
  const rows = (await direct.$queryRawUnsafe(
    `SELECT email FROM "${schema}"."users" ORDER BY email`,
  )) as Array<{ email: string }>
  return rows.map(r => r.email)
}

beforeAll(async () => {
  const target = new URL(REAL_URL)
  proxy = await severableProxy(target.hostname, Number(target.port || 5432))

  // Everything the product imports from here on talks to the proxy.
  const proxied = throughProxy(REAL_URL, proxy.port)
  process.env.DATABASE_URL = proxied
  process.env.DIRECT_URL = proxied

  ;({ POST: signin } = await import('@/app/api/v1/[projectId]/auth/signin/route'))
  ;({ POST: signup } = await import('@/app/api/v1/[projectId]/auth/signup/route'))
  ;({ GET: notifications } = await import('@/app/api/notifications/route'))

  // ── Fixture, on the real connection ───────────────────────────────────────
  const owner = await direct.user.create({
    data: {
      email: `dep-pg-${crypto.randomBytes(6).toString('hex')}@example.test`,
      password: OPERATOR_PASSWORD,
      name: 'Dependency Failure Suite',
    },
    select: { id: true },
  })
  ownerId = owner.id

  const project = await direct.project.create({
    data: {
      name: 'dependency-failure',
      userId: ownerId,
      // The signin route refuses outright below 32 characters.
      jwtSecret: crypto.randomBytes(32).toString('hex'),
    },
    select: { id: true },
  })
  projectId = project.id
  schema = `workspace_${projectId}`

  await direct.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await direct.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS "${schema}"."users" (
       id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       email      text UNIQUE NOT NULL,
       password   text NOT NULL,
       name       text,
       role       text DEFAULT 'user',
       is_blocked boolean NOT NULL DEFAULT false,
       created_at timestamptz NOT NULL DEFAULT now()
     )`,
  )

  const { hashPassword } = await import('@/lib/auth/password')
  await direct.$executeRawUnsafe(
    `INSERT INTO "${schema}"."users" (email, password, name) VALUES ('known@example.test', $1, 'Known')`,
    await hashPassword(END_USER_PASSWORD),
  )

  // A real platform session: verifySession requires a Session ROW keyed by the
  // exact token, so a hand-signed JWT alone would 401 for reasons unrelated to
  // anything under test.
  const jwt = (await import('jsonwebtoken')).default
  sessionToken = jwt.sign(
    { userId: ownerId, email: 'dep-pg@example.test', role: 'user' },
    process.env.JWT_SECRET!,
    { expiresIn: '30m' },
  )
  await direct.session.create({
    data: { userId: ownerId, token: sessionToken, expiresAt: new Date(Date.now() + 30 * 60_000) },
  })
  await direct.platformNotification.create({
    data: { userId: ownerId, type: 'system', title: 'fixture', body: 'a row that must be read' },
  })
}, 300_000)

afterAll(async () => {
  await proxy?.restore().catch(() => {})
  await direct.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await direct.platformNotification.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await direct.session.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await direct.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await direct.user.delete({ where: { id: ownerId } }).catch(() => {})
  await direct.$disconnect().catch(() => {})
  await proxy?.close().catch(() => {})
}, 300_000)

// ─────────────────────────────────────────────────────────────────────────────

describe('every path works through the proxy first', () => {
  it('end-user auth signs a known user in', async () => {
    const res = await endUserSignin('known@example.test', END_USER_PASSWORD)
    expect(res.status).toBe(200)
    expect(res.body?.data?.token).toBeTruthy()
  }, 120_000)

  it('a dashboard read returns the row that exists', async () => {
    const res = await dashboardQuery()
    expect(res.status).toBe(200)
    const body = await res.json()
    // Not merely 200. An empty list with a 200 is the failure mode the outage
    // assertion below exists to rule out, so the control has to show that this
    // query genuinely returns something.
    expect(body.notifications.length).toBeGreaterThan(0)
  }, 120_000)

  it('a write path creates an end user', async () => {
    const res = await endUserSignup('control@example.test', END_USER_PASSWORD)
    expect(res.status).toBe(201)
    expect(await endUserEmails()).toContain('control@example.test')
  }, 120_000)
})

describe('while the database transport is cut', () => {
  beforeAll(async () => {
    await proxy.sever()
    // verifySession caches a valid session for 15 seconds, so a request made
    // immediately after the cut would be served from memory and would prove
    // nothing about the database being gone. Waiting is not a workaround for
    // flakiness; it is what makes the assertion address the database at all.
    await new Promise(r => setTimeout(r, 16_000))
  }, 120_000)

  it('end-user auth fails, and does not fabricate a credential verdict', async () => {
    const res = await endUserSignin('known@example.test', END_USER_PASSWORD)

    expect(res.status).not.toBe(200)
    // 401 would say the password is wrong. 404 would say the project does not
    // exist. Both are statements this code is in no position to make, and both
    // send an operator looking in the wrong place.
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(404)
    expect(res.status).toBeGreaterThanOrEqual(500)

    // And the failure must not describe the infrastructure to an unauthenticated
    // caller: this surface is reachable by anyone.
    const text = JSON.stringify(res.body ?? {})
    expect(text).not.toMatch(/postgres(ql)?:\/\//)
    expect(text).not.toMatch(/127\.0\.0\.1|localhost/)
  }, 120_000)

  it('a dashboard read fails rather than reporting an empty result', async () => {
    // The silent-empty-success class. A 200 with `notifications: []` would
    // render as "you have no notifications" during an outage, which is a
    // definite and false statement about the user's data.
    let status: number | null = null
    let body: any = null
    try {
      const res = await dashboardQuery()
      status = res.status
      body = await res.json().catch(() => null)
    } catch {
      // Throwing is an acceptable honest failure: Next renders it as a 500.
      status = null
    }

    if (status !== null) {
      expect(status).not.toBe(200)
      expect(body?.notifications).toBeUndefined()
    }
  }, 120_000)

  it('a write path does not report success', async () => {
    const res = await endUserSignup('written-during-outage@example.test', END_USER_PASSWORD)
    // Signup succeeds with 201, so "not 200" would pass even if it succeeded.
    expect(res.status >= 200 && res.status < 300).toBe(false)
  }, 120_000)

  it('an authorization wrapper reports an OUTAGE, not a rejected credential', async () => {
    // The defect. `withApiKey` is the one wrapper in this family that resolves
    // identity from the request rather than through next/headers, so it is the
    // one that can be invoked here; all four share `notAnAuthDecision`.
    const { withApiKey } = await import('@/lib/auth/route-protection')
    const { NextResponse } = await import('next/server')

    const handler = withApiKey(async () => NextResponse.json({ reached: true }))
    const res = await handler(req({ bearer: undefined }) as any)

    // A key IS present, so this is not the "no key supplied" branch.
    const withKey = req()
    ;(withKey.headers as any).get = (k: string) =>
      k.toLowerCase() === 'x-api-key' ? 'bkn_not_a_real_key' : null
    const res2 = await handler(withKey as any)

    expect(res.status).toBe(401) // genuinely no key: still a credential verdict
    expect(res2.status).toBe(503) // key present, database gone: an outage
    expect(res2.status).not.toBe(401)
  }, 120_000)
})

describe('once the database comes back', () => {
  beforeAll(async () => {
    await proxy.restore()
    // The pool re-establishes on its own; give it the chance to, without
    // restarting anything.
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      try {
        await direct.$queryRawUnsafe('SELECT 1')
        const res = await endUserSignin('known@example.test', END_USER_PASSWORD)
        if (res.status === 200) return
      } catch {
        /* keep waiting */
      }
      await new Promise(r => setTimeout(r, 500))
    }
  }, 180_000)

  it('the write attempted during the outage was NOT committed later', async () => {
    // The specific trap: a queued or retried write landing after recovery would
    // mean the failure the caller was told about did not actually happen. None
    // of these paths is a queue, so the row must simply not exist.
    const emails = await endUserEmails()
    expect(emails).not.toContain('written-during-outage@example.test')
    // Paired with the control row, so this cannot pass against a table that was
    // wiped or a query that returns nothing.
    expect(emails).toContain('control@example.test')
  }, 120_000)

  it('end-user auth works again, in the same process', async () => {
    const res = await endUserSignin('known@example.test', END_USER_PASSWORD)
    expect(res.status).toBe(200)
    expect(res.body?.data?.token).toBeTruthy()
  }, 120_000)

  it('the dashboard read works again', async () => {
    const res = await dashboardQuery()
    expect(res.status).toBe(200)
    expect((await res.json()).notifications.length).toBeGreaterThan(0)
  }, 120_000)

  it('the write path works again, and the row is really there', async () => {
    const res = await endUserSignup('after-recovery@example.test', END_USER_PASSWORD)
    expect(res.status).toBe(201)
    expect(await endUserEmails()).toContain('after-recovery@example.test')
  }, 120_000)
})
