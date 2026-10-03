/**
 * SIGNUP AND PASSWORD RESET BY EMAILED CODE, END TO END
 * =====================================================
 * The defects this replaces were all "the page said it worked":
 *
 *   - forgot-password answered "we sent a reset link" when nothing was sent:
 *     to an account with no password (every Google/GitHub signup), past a
 *     per-email limit, for an address stored in different letter case, and
 *     when the provider rejected the message ("550 The backenly.com domain is
 *     not verified" in production, for days);
 *   - signup created the account and a session before anything proved the
 *     address belonged to the person typing it.
 *
 * So every delivery assertion here is made on the bytes a real SMTP server
 * received after a real STARTTLS handshake, the codes are read out of that
 * mail, and the accounts are read back from Postgres. The routes, bcrypt, the
 * rate limiter and the code store all run for real; only the request envelope
 * is constructed (a NextRequest cannot be built under jest.setup.js, see
 * tests/integration/signin-enumeration.spec.ts).
 *
 * Not covered here: a self-hosted FIRST account, which needs an empty users
 * table this shared database cannot offer. Its rule is pinned in
 * tests/unit/signup-verification-policy.spec.ts, and the route path by CI's
 * self-host job, which claims a fresh install through the signup page.
 */
import { randomUUID } from 'crypto'
import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { createSession } from '@/lib/auth/session'
import { reset as resetRateLimit } from '@/lib/security/auth-rate-limit'
import { SmtpSink, trustCertificate } from '../../tests/helpers/smtp-sink'

import { POST as register } from '@/app/api/auth/register/route'
import { POST as verifySignup } from '@/app/api/auth/register/verify/route'
import { POST as resendSignup } from '@/app/api/auth/register/resend/route'
import { POST as forgotPassword } from '@/app/api/auth/forgot-password/route'
import { POST as resetPassword } from '@/app/api/auth/reset-password/route'
import { POST as login } from '@/app/api/auth/login/route'

const PASSWORD = 'Correct-Horse-Battery-9'
const NEW_PASSWORD = 'Brand-New-Staple-42!'

const ENV_KEYS = [
  'BACKENLY_EDITION',
  'BACKENLY_ALLOW_PUBLIC_SIGNUP',
  'BACKENLY_SETUP_TOKEN',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'TURNSTILE_SECRET_KEY',
] as const
const ORIGINAL_ENV: Record<string, string | undefined> = {}

let sink: SmtpSink
let untrust: (() => void) | null = null
const emails: string[] = []

function address(prefix = 'otp'): string {
  const a = `${prefix}-${randomUUID()}@example.test`
  emails.push(a)
  return a
}

function useMail(): void {
  process.env.SMTP_HOST = '127.0.0.1'
  process.env.SMTP_PORT = String(sink.port)
  process.env.SMTP_USER = 'sink-user'
  process.env.SMTP_PASS = 'sink-password-not-real'
  process.env.SMTP_FROM = 'Backenly <auth@example.test>'
}

function noMail(): void {
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']) delete process.env[k]
}

let ipCounter = 0
function request(body: Record<string, unknown>): NextRequest {
  ipCounter += 1
  const headers = new Map<string, string>([
    ['content-type', 'application/json'],
    ['x-forwarded-for', `198.51.100.${ipCounter % 250}`],
  ])
  return {
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    cookies: { get: () => undefined },
    json: async () => body,
  } as unknown as NextRequest
}

async function call(handler: (r: NextRequest) => Promise<Response>, body: Record<string, unknown>) {
  const res = await handler(request(body))
  return { status: res.status, body: await res.json(), res }
}

/** Case-insensitive: nodemailer lowercases the domain part of a recipient. */
function mailTo(email: string) {
  const wanted = email.toLowerCase()
  return sink.received.filter(m => m.rcptTo.some(r => r.toLowerCase() === wanted))
}

/** Reset mail is sent detached from the request, so it lands after the answer. */
async function waitForMail(email: string, count = 1) {
  await waitFor(async () => (mailTo(email).length >= count ? true : null))
  return mailTo(email)
}

function codeIn(raw: string): string {
  const m = raw.match(/(\d{6}) is your Backenly (?:verification|password reset) code/)
  if (!m) throw new Error('no code in the mail that arrived')
  return m[1]
}

/**
 * Poll until something the background send wrote turns up.
 *
 * Reset mail is dispatched detached from the request, precisely so the
 * response cannot be timed by it, so its records land after the answer.
 */
async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 10_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = await read()
    if (found) return found
    if (Date.now() > deadline) throw new Error('nothing was recorded within the timeout')
    await new Promise(r => setTimeout(r, 100))
  }
}

/** Both the one-a-minute and five-an-hour send budgets, so a test can resend. */
async function clearSendThrottle(purpose: 'signup' | 'password_reset', email: string) {
  await resetRateLimit(`email-code:${purpose}:cooldown:${email}`)
  await resetRateLimit(`email-code:${purpose}:hour:${email}`)
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  if (!/test/i.test(process.env.TEST_DATABASE_URL?.split('/').pop() ?? '')) throw new Error('Refusing: not a test database')
  for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k]

  sink = new SmtpSink()
  await sink.start()
  untrust = trustCertificate(sink.certificate)
}, 120_000)

beforeEach(() => {
  process.env.BACKENLY_EDITION = 'cloud'
  delete process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP
  delete process.env.BACKENLY_SETUP_TOKEN
  delete process.env.TURNSTILE_SECRET_KEY
  sink.rejectWith = null
  sink.delayMs = 0
  useMail()
})

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL_ENV[k]
  }
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } })
  const ids = users.map(u => u.id)
  if (ids.length) {
    await prisma.session.deleteMany({ where: { userId: { in: ids } } })
    await prisma.auditLog.deleteMany({ where: { userId: { in: ids } } })
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {})
  }
  await prisma.securityEvent.deleteMany({ where: { userEmail: { in: emails } } }).catch(() => {})
  await prisma.authEmailCode.deleteMany({ where: { email: { in: emails } } })
  untrust?.()
  // Guarded so a sink that never started reports the real setup failure rather
  // than a second one from tearing down nothing.
  await sink?.stop().catch(() => {})
})

describe('signup proves the address before the account exists', () => {
  it('mails a code and creates nothing until it is entered', async () => {
    const email = address()
    const r = await call(register, { email, password: PASSWORD })

    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ status: 'verification_required', email })
    expect(r.body.token).toBeUndefined()
    expect(await prisma.user.count({ where: { email } })).toBe(0)

    const mail = mailTo(email)
    expect(mail).toHaveLength(1)
    expect(codeIn(mail[0].raw)).toMatch(/^\d{6}$/)
  })

  it('creates a verified account from the right code, which then signs in with no code', async () => {
    const email = address()
    await call(register, { email, password: PASSWORD, name: 'Code Person' })
    const code = codeIn(mailTo(email)[0].raw)

    const wrong = await call(verifySignup, { email, code: code === '000000' ? '111111' : '000000' })
    expect(wrong.status).toBe(400)
    expect(wrong.body.code).toBe('CODE_REJECTED')
    expect(await prisma.user.count({ where: { email } })).toBe(0)

    const ok = await call(verifySignup, { email, code })
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('created')
    expect(ok.body.token).toBeTruthy()
    expect((ok.res as unknown as { cookies: { get: (n: string) => { value: string } | undefined } }).cookies.get('auth-token')?.value).toBeTruthy()

    const user = await prisma.user.findUniqueOrThrow({ where: { email } })
    expect(user.emailVerified).toBe(true)
    expect(user.trustLevel).toBe('trusted')
    expect(user.name).toBe('Code Person')
    expect(await verifyPassword(PASSWORD, user.password!)).toBe(true)

    // The whole point of verifying once: sign-in asks for nothing more.
    const signin = await call(login, { email, password: PASSWORD })
    expect(signin.status).toBe(200)
    expect(signin.body.token).toBeTruthy()

    // And the code is spent.
    const replay = await call(verifySignup, { email, code })
    expect(replay.status).toBe(400)
  })

  it('answers an address that already has an account exactly like a new one, and tells its owner instead', async () => {
    const existing = address('exists')
    await prisma.user.create({ data: { email: existing, password: await hashPassword(PASSWORD), name: 'Existing' } })
    const fresh = address()

    const a = await call(register, { email: existing, password: PASSWORD })
    const b = await call(register, { email: fresh, password: PASSWORD })

    expect(a.status).toBe(b.status)
    expect(Object.keys(a.body).sort()).toEqual(Object.keys(b.body).sort())
    expect(a.body.status).toBe('verification_required')

    // The owner hears about it; nobody receives a code for an existing account.
    const note = mailTo(existing)
    expect(note).toHaveLength(1)
    expect(note[0].raw).toMatch(/already have a Backenly account/i)
    expect(await prisma.authEmailCode.count({ where: { email: existing } })).toBe(0)
    expect(await prisma.user.count({ where: { email: existing } })).toBe(1)
  })

  it('resends a fresh code that replaces the old one, without changing the pending account', async () => {
    const email = address()
    await call(register, { email, password: PASSWORD })
    const first = codeIn(mailTo(email)[0].raw)

    const tooSoon = await call(resendSignup, { email })
    expect(tooSoon.status).toBe(429)

    await clearSendThrottle('signup', email)
    const again = await call(resendSignup, { email })
    expect(again.status).toBe(200)
    const second = codeIn(mailTo(email)[1].raw)

    if (first !== second) {
      expect((await call(verifySignup, { email, code: first })).status).toBe(400)
    }
    expect((await call(verifySignup, { email, code: second })).status).toBe(200)
    const user = await prisma.user.findUniqueOrThrow({ where: { email } })
    expect(await verifyPassword(PASSWORD, user.password!)).toBe(true)
  })

  it('refuses on Cloud with no mail transport, rather than creating an unverified account', async () => {
    noMail()
    const email = address()
    const r = await call(register, { email, password: PASSWORD })

    expect(r.status).toBe(503)
    expect(r.body.code).toBe('EMAIL_DELIVERY_UNAVAILABLE')
    expect(await prisma.user.count({ where: { email } })).toBe(0)
    expect(await prisma.authEmailCode.count({ where: { email } })).toBe(0)
  })

  it('refuses a later self-hosted signup when the server has no mail', async () => {
    process.env.BACKENLY_EDITION = 'single-tenant'
    process.env.BACKENLY_ALLOW_PUBLIC_SIGNUP = 'true'
    // Precondition built, not assumed: this deployment already has an account.
    await prisma.user.create({ data: { email: address('operator'), name: 'Operator' } })
    noMail()

    const email = address()
    const r = await call(register, { email, password: PASSWORD })
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('EMAIL_DELIVERY_UNAVAILABLE')
    expect(r.body.selfHosted).toBe(true)
    expect(r.body.error).toMatch(/auth:reset-password/)
    expect(await prisma.user.count({ where: { email } })).toBe(0)

    // The control: with mail, the same signup gets a code.
    useMail()
    const withMail = await call(register, { email, password: PASSWORD })
    expect(withMail.status).toBe(200)
    expect(withMail.body.status).toBe('verification_required')
  })

  it('says so when the provider refuses the sending domain, instead of claiming a code was sent', async () => {
    // The production failure, reproduced: rejected at DATA with a 550.
    sink.rejectWith = '550 The example.test domain is not verified.'
    const email = address()
    const r = await call(register, { email, password: PASSWORD })
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('EMAIL_DELIVERY_UNAVAILABLE')
  })
})

describe('password reset by code', () => {
  async function account(opts: { email?: string; password?: string | null } = {}) {
    const email = opts.email ?? address('reset')
    if (!emails.includes(email)) emails.push(email)
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Reset Person',
        password: opts.password === null ? null : await hashPassword(opts.password ?? PASSWORD),
        provider: opts.password === null ? 'google' : 'email',
      },
    })
    return user
  }

  it('mails a code that replaces the password and ends every session', async () => {
    const user = await account()
    await createSession(user.id, user.email)
    expect(await prisma.session.count({ where: { userId: user.id } })).toBeGreaterThan(0)

    const r = await call(forgotPassword, { email: user.email })
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('code_sent')
    const code = codeIn((await waitForMail(user.email))[0].raw)

    const weak = await call(resetPassword, { email: user.email, code, password: 'short' })
    expect(weak.status).toBe(400)

    const done = await call(resetPassword, { email: user.email, code, password: NEW_PASSWORD })
    expect(done.status).toBe(200)

    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0)
    expect((await call(login, { email: user.email, password: NEW_PASSWORD })).status).toBe(200)
    expect((await call(login, { email: user.email, password: PASSWORD })).status).toBe(401)

    // Spent.
    expect((await call(resetPassword, { email: user.email, code, password: PASSWORD + 'x' })).status).toBe(400)
  })

  it('answers an unknown address exactly like a known one, and mails nobody', async () => {
    const known = await account()
    const unknown = address('nobody')

    const a = await call(forgotPassword, { email: known.email })
    const b = await call(forgotPassword, { email: unknown })
    expect(a.status).toBe(b.status)
    expect(a.body).toEqual(b.body)
    expect(await waitForMail(known.email)).toHaveLength(1)
    expect(mailTo(unknown)).toHaveLength(0)
  })

  it('lets an account created with Google set a password', async () => {
    // These accounts have no password, and the old route silently sent nothing.
    const user = await account({ password: null })
    expect((await call(forgotPassword, { email: user.email })).status).toBe(200)
    const code = codeIn((await waitForMail(user.email))[0].raw)

    expect((await call(resetPassword, { email: user.email, code, password: NEW_PASSWORD })).status).toBe(200)
    expect((await call(login, { email: user.email, password: NEW_PASSWORD })).status).toBe(200)
  })

  it('finds an account stored with different letter case', async () => {
    const stored = `Mixed.Case-${randomUUID()}@Example.test`
    emails.push(stored)
    await account({ email: stored })

    const r = await call(forgotPassword, { email: stored.toLowerCase() })
    expect(r.status).toBe(200)
    expect(await waitForMail(stored)).toHaveLength(1)
  })

  it('says email is unavailable, before any lookup, when there is no transport', async () => {
    const known = await account()
    noMail()
    const a = await call(forgotPassword, { email: known.email })
    const b = await call(forgotPassword, { email: address('nobody') })
    expect(a.status).toBe(503)
    expect(a.body).toEqual(b.body)
    expect(a.body.code).toBe('EMAIL_DELIVERY_UNAVAILABLE')
  })

  it('answers a failed send exactly like an unknown address, and records the failure internally', async () => {
    // The enumeration this closes: surfacing the provider's refusal told a
    // stranger that the address they asked about has an account, because an
    // address with no account never sends anything and so never fails.
    // Operators still learn about it, from the audit trail and the Security
    // tab rather than from the response.
    const user = await account()
    sink.rejectWith = '550 The example.test domain is not verified.'

    const failed = await call(forgotPassword, { email: user.email })
    const unknown = await call(forgotPassword, { email: address('nobody') })

    expect(failed.status).toBe(200)
    expect(failed.status).toBe(unknown.status)
    expect(failed.body).toEqual(unknown.body)

    const audit = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { userId: user.id, action: 'Password reset requested' } }),
    )
    expect(audit!.details).toMatch(/could not be sent/)

    const event = await waitFor(() =>
      prisma.securityEvent.findFirst({ where: { kind: 'email_delivery_failed', userEmail: user.email } }),
    )
    expect(event!.severity).toBe('high')
  })

  it('does not wait for the provider, so a slow send cannot time the answer', async () => {
    // Latency is the other half of the oracle: awaiting the send made a
    // request for a real address cost a whole SMTP round trip while an
    // unknown one returned at once.
    const user = await account()
    sink.delayMs = 3000

    const startKnown = Date.now()
    const known = await call(forgotPassword, { email: user.email })
    const knownMs = Date.now() - startKnown

    const startUnknown = Date.now()
    const unknown = await call(forgotPassword, { email: address('nobody') })
    const unknownMs = Date.now() - startUnknown

    expect(known.body).toEqual(unknown.body)
    // Comfortably inside the 3s the provider is holding the message for.
    expect(knownMs).toBeLessThan(1500)
    expect(Math.abs(knownMs - unknownMs)).toBeLessThan(1000)
  })

  it('issues a code for an address with no account, so even the database work matches', async () => {
    const unknown = address('nobody')
    expect((await call(forgotPassword, { email: unknown })).status).toBe(200)
    expect(await prisma.authEmailCode.count({ where: { purpose: 'password_reset', email: unknown } })).toBe(1)
    // It is never mailed anywhere, and cannot reset anything.
    expect(mailTo(unknown)).toHaveLength(0)
  })

  it('throttles honestly, and identically for an address with no account', async () => {
    const known = await account()
    const unknown = address('nobody')
    await call(forgotPassword, { email: known.email })
    await call(forgotPassword, { email: unknown })

    const a = await call(forgotPassword, { email: known.email })
    const b = await call(forgotPassword, { email: unknown })
    expect(a.status).toBe(429)
    expect(b.status).toBe(429)
    expect(a.body).toEqual(b.body)
  })
})
