/**
 * MAGIC LINKS AND VERIFICATION EMAIL ARE SENT BY THE WEB SERVICE
 * =============================================================
 *
 * On AWS, Next is the ingress and forwards every /api/v1/{projectId}/ path it
 * does not serve to the runtime (app/api/v1/[projectId]/[...unmatched]). Next
 * served no magic-link or resend-verification route, so both went to the
 * runtime, which is given no email settings: a project on Backenly's own email
 * had the link logged ("SMTP unconfigured", with the user's address) and never
 * sent. Both are now Next routes, sent with the deployment's SMTP the web
 * service holds, and limited per requester and per target address as
 * forgot-password is.
 *
 * Real SMTP (tests/helpers/smtp-sink.ts, with a real STARTTLS upgrade), the real
 * Next route handlers and a real database.
 */
import '@/tests/helpers/real-web-standard'

import { randomBytes, randomUUID } from 'crypto'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db/prisma'
import { reset as resetRateLimit } from '@/lib/security/auth-rate-limit'
import { ensureAuthUsersTable } from '@/lib/services/end-user-auth-table'
import { ensureEmailVerifiedColumn } from '@/lib/services/end-user-auth-flows'
import { SmtpSink, trustCertificate } from '../helpers/smtp-sink'
import { POST as magicLink } from '@/app/api/v1/[projectId]/auth/magic-link/route'
import { POST as resendVerification } from '@/app/api/v1/[projectId]/auth/resend-verification/route'

jest.setTimeout(120_000)

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'] as const
const ORIGINAL: Record<string, string | undefined> = {}
let sink: SmtpSink
let untrust: (() => void) | null = null
let ownerId = ''
let projectId = ''
const schema = () => `workspace_${projectId}`
let ip = 0

function post(handler: typeof magicLink, path: string, body: unknown, from?: string) {
  ip++
  return handler(
    new NextRequest(`https://backenly.test/api/v1/${projectId}/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': from ?? `203.0.113.${ip % 250}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ projectId }) },
  )
}

const mailTo = (email: string) => sink.received.filter((m) => m.rcptTo.some((r) => r.toLowerCase() === email.toLowerCase()))

async function waitForMail(email: string, count = 1): Promise<void> {
  for (let i = 0; i < 100 && mailTo(email).length < count; i++) await new Promise((r) => setTimeout(r, 100))
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  for (const k of SMTP_KEYS) ORIGINAL[k] = process.env[k]
  sink = new SmtpSink()
  await sink.start()
  untrust = trustCertificate(sink.certificate)
  // The deployment's email, as the web service holds it on Cloud.
  process.env.SMTP_HOST = '127.0.0.1'
  process.env.SMTP_PORT = String(sink.port)
  process.env.SMTP_USER = 'sink-user'
  process.env.SMTP_PASS = 'sink-password-not-real'
  process.env.SMTP_FROM = 'Backenly <auth@example.test>'

  ownerId = (await prisma.user.create({ data: { email: `owner-${randomUUID()}@example.test`, name: 'owner' } })).id
  projectId = (await prisma.project.create({
    data: { name: `auth-email-on-web-${randomUUID().slice(0, 8)}`, userId: ownerId, jwtSecret: randomBytes(32).toString('hex') },
  })).id
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema()}"`)
  await ensureAuthUsersTable(projectId, { email: 'owner@example.test' })
  await ensureEmailVerifiedColumn(projectId, schema())
}, 120_000)

beforeEach(() => resetRateLimit())

afterAll(async () => {
  for (const k of SMTP_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k]
    else process.env[k] = ORIGINAL[k]
  }
  untrust?.()
  await sink?.stop().catch(() => {})
  if (projectId) {
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema()}" CASCADE`).catch(() => {})
    await prisma.project.deleteMany({ where: { id: projectId } }).catch(() => {})
  }
  if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => {})
}, 120_000)

describe('POST /auth/magic-link (web)', () => {
  it('sends the sign-in link through the deployment email', async () => {
    const email = `magic-${randomUUID()}@example.test`
    const res = await post(magicLink, 'magic-link', { email })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { message: 'If that email is valid, a sign-in link has been sent.' } })
    await waitForMail(email)
    const [mail] = mailTo(email)
    expect(mail).toBeDefined()
    // Quoted-printable may wrap the link (`=` at a line end) and spell `=` as `=3D`.
    const body = mail.raw.replace(/=\r?\n/g, '').replace(/=3D/gi, '=')
    expect(body).toMatch(new RegExp(`/api/v1/${projectId}/auth/magic\\?token=[0-9a-f]{64}`))
    // One live link for the address, the one in the mail.
    const links = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM "${schema()}"."_magic_links" WHERE email = $1 AND used_at IS NULL`, email,
    )
    expect(links[0].n).toBe(1)
  })

  it('stops mailing one address from many sources, with the same answer', async () => {
    const email = `target-${randomUUID()}@example.test`
    const answers: number[] = []
    for (let i = 0; i < 7; i++) {
      const res = await post(magicLink, 'magic-link', { email }, `198.51.100.${10 + i}`)
      answers.push(res.status)
      expect(await res.json()).toEqual({ data: { message: 'If that email is valid, a sign-in link has been sent.' } })
    }
    expect(answers.every((s) => s === 200)).toBe(true)
    await waitForMail(email, 5)
    await new Promise((r) => setTimeout(r, 500))
    expect(mailTo(email).length).toBe(5)
  })

  it('limits one requester per project', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i++) statuses.push((await post(magicLink, 'magic-link', { email: `many-${i}-${randomUUID()}@example.test` }, '192.0.2.77')).status)
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200])
    expect(statuses[5]).toBe(429)
  })

  it('refuses a body that is not JSON', async () => {
    const res = await magicLink(
      new NextRequest(`https://backenly.test/api/v1/${projectId}/auth/magic-link`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.200' }, body: 'not json',
      }),
      { params: Promise.resolve({ projectId }) },
    )
    expect(res.status).toBe(400)
  })
})

describe('POST /auth/resend-verification (web)', () => {
  it('sends an unverified user their verification link through the deployment email', async () => {
    const email = `unverified-${randomUUID()}@example.test`
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${schema()}"."users" (email, password, email_verified) VALUES ($1, 'not-a-real-hash', false)`, email,
    )
    const res = await post(resendVerification, 'resend-verification', { email })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { message: 'If an account with that email exists, a verification link has been sent.' } })
    await waitForMail(email)
    expect(mailTo(email)).toHaveLength(1)
  })

  it('answers the same, and mails nobody, for an address with no account', async () => {
    const email = `nobody-${randomUUID()}@example.test`
    const res = await post(resendVerification, 'resend-verification', { email })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { message: 'If an account with that email exists, a verification link has been sent.' } })
    await new Promise((r) => setTimeout(r, 1000))
    expect(mailTo(email)).toHaveLength(0)
  })
})
