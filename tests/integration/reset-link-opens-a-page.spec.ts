/**
 * A PASSWORD RESET EMAIL OPENS A PAGE THAT RESETS THE PASSWORD
 * ===========================================================
 *
 * Publishing a project stores its API base in project.publicUrl
 * (lib/deployment/go-live.ts). The auth emails read that as the app's address
 * whenever the developer had set no App URL, so every reset email of a
 * published project linked to /api/v1/<project>?backenly_reset_token=…, which
 * answers the API's JSON descriptor. Nobody could reset a password.
 *
 * Pinned here against a real workspace and the real Express runtime. Only the
 * SMTP transport is a stand-in, one that keeps what it is given:
 *
 *  1. With no App URL, the email links to the reset page Backenly hosts, and
 *     neither the email context nor the settings call the API base an app.
 *  2. Opening that link shows a form and leaves the link usable.
 *  3. A mismatched or short password is refused on the page, changing nothing.
 *  4. The form changes the password once; the link cannot be used again.
 *  5. A link that is not valid, or has expired, says so.
 *  6. With an App URL, the email still links to the app.
 */

import '@/tests/helpers/real-web-standard'
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import app from '@/server/app'
import { prisma } from '@/lib/db'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { getAuthEmailContext } from '@/lib/services/end-user-auth-email'
import { getAuthEmailPolicy } from '@/lib/services/auth-email-policy'
import { issueEndUserPasswordReset } from '@/lib/services/end-user-auth-flows'

jest.mock('nodemailer', () => {
  const sent: Array<{ to: string; subject: string; html: string }> = []
  const createTransport = () => ({
    sendMail: async (message: { to: string; subject: string; html: string }) => {
      sent.push(message)
      return { messageId: `captured-${sent.length}` }
    },
  })
  return { __esModule: true, default: { createTransport }, createTransport, __sent: sent }
})

const mailbox = (): Array<{ to: string; subject: string; html: string }> => jest.requireMock('nodemailer').__sent

const ENV_KEYS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'NEXT_PUBLIC_APP_URL'] as const
const saved: Record<string, string | undefined> = {}

const EMAIL = `shopper-${crypto.randomBytes(4).toString('hex')}@example.test`
const OLD_PASSWORD = 'Old-password-1'
const NEW_PASSWORD = 'New-password-22'

let server: http.Server
let baseUrl = ''
let ownerId: string
let projectId: string
let schema: string

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const tokenOf = (link: string) => new URL(link).searchParams.get('token') ?? ''

async function storedHash(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ password: string }>>(
    `SELECT password FROM "${schema}"."users" WHERE email = $1`,
    EMAIL,
  )
  return rows[0].password
}

async function unusedResets(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "${schema}"."_password_resets" WHERE email = $1 AND used_at IS NULL`,
    EMAIL,
  )
  return rows[0].n
}

/** Ask for a reset the way forgot-password and the operator's tool do, and return the emailed link. */
async function requestReset(): Promise<string> {
  const before = mailbox().length
  await expect(issueEndUserPasswordReset(projectId, EMAIL)).resolves.toEqual({ found: true, emailSent: true })
  const mail = mailbox()[before]
  expect(mail?.to).toBe(EMAIL)
  const href = /href="([^"]+)"/.exec(mail.html)?.[1]
  expect(href).toBeTruthy()
  return href!
}

/** Submit the hosted form as a browser does. */
async function submit(fields: Record<string, string>): Promise<{ status: number; html: string }> {
  const res = await fetch(`${baseUrl}/api/v1/${projectId}/auth/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  return { status: res.status, html: await res.text() }
}

beforeAll(async () => {
  if (process.env.NODE_ENV !== 'test') throw new Error('Refusing: NODE_ENV is not test')
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.SMTP_HOST = 'smtp.example.test'
  process.env.SMTP_USER = 'mailer'
  process.env.SMTP_PASS = 'not-a-real-password'
  delete process.env.SMTP_FROM

  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  // Hosted auth links are built on this origin, so the test can follow them.
  process.env.NEXT_PUBLIC_APP_URL = baseUrl

  ownerId = (
    await prisma.user.create({ data: { email: `owner-${crypto.randomUUID()}@example.test`, name: 'reset link fixture' }, select: { id: true } })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'Corner Shop', userId: ownerId, jwtSecret: crypto.randomBytes(32).toString('hex') },
      select: { id: true },
    })
  ).id
  // What publishing stores (lib/deployment/go-live.ts): the API base, as publicUrl.
  await prisma.project.update({
    where: { id: projectId },
    data: { publicUrl: `${baseUrl}/api/v1/${projectId}`, projectStatus: 'LIVE', isDeployed: true, publicEnabled: true },
  })

  schema = `workspace_${projectId}`
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
  await prisma.$executeRawUnsafe(
    `CREATE TABLE "${schema}"."users" (
       id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       email      text UNIQUE NOT NULL,
       password   text NOT NULL,
       name       text,
       role       text DEFAULT 'user',
       is_blocked boolean NOT NULL DEFAULT false,
       created_at timestamptz NOT NULL DEFAULT now(),
       updated_at timestamptz NOT NULL DEFAULT now()
     )`,
  )
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${schema}"."users" (email, password, name) VALUES ($1, $2, 'Shopper')`,
    EMAIL,
    await hashPassword(OLD_PASSWORD),
  )
}, 60_000)

afterAll(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
  await prisma.projectAuthConfig.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.auditLog.deleteMany({ where: { projectId } }).catch(() => {})
  await prisma.project.deleteMany({ where: { userId: ownerId } }).catch(() => {})
  await prisma.user.delete({ where: { id: ownerId } }).catch(() => {})
}, 60_000)

describe('a published project with no App URL', () => {
  let link = ''
  let token = ''

  it('emails a link to the reset page Backenly hosts, not to the API', async () => {
    link = await requestReset()
    token = tokenOf(link)

    expect(link).not.toContain(`/api/v1/${projectId}?`)
    expect(link).toMatch(new RegExp(`^${escapeRe(baseUrl)}/api/v1/${projectId}/auth/reset\\?token=[0-9a-f]{64}$`))
    // Nothing calls the API base the app's address.
    expect((await getAuthEmailContext(projectId)).appUrl).toBeNull()
    expect((await getAuthEmailPolicy(projectId))?.effectiveAppUrl).toBeNull()
  })

  it('opens a form for that account and leaves the link usable', async () => {
    const res = await fetch(link)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'")

    const html = await res.text()
    expect(html).toContain('Corner Shop')
    expect(html).toContain(EMAIL)
    expect(html).toContain(`<form method="post" action="/api/v1/${projectId}/auth/reset">`)
    expect(html).toContain(`<input type="hidden" name="token" value="${token}">`)
    expect(html).not.toMatch(/<script/i)

    expect(await unusedResets()).toBe(1)
    expect(await verifyPassword(OLD_PASSWORD, await storedHash())).toBe(true)
  })

  it('refuses a mismatched or short password on the page and changes nothing', async () => {
    const mismatched = await submit({ token, password: NEW_PASSWORD, confirm: `${NEW_PASSWORD}x` })
    expect(mismatched.status).toBe(400)
    expect(mismatched.html).toContain('The two passwords don’t match.')
    expect(mismatched.html).toContain(`value="${token}"`)

    const short = await submit({ token, password: 'short', confirm: 'short' })
    expect(short.status).toBe(400)
    expect(short.html).toContain('Use at least 8 characters.')

    expect(await unusedResets()).toBe(1)
    expect(await verifyPassword(OLD_PASSWORD, await storedHash())).toBe(true)
  })

  it('changes the password once, and the link cannot be used again', async () => {
    const done = await submit({ token, password: NEW_PASSWORD, confirm: NEW_PASSWORD })
    expect(done.status).toBe(200)
    expect(done.html).toContain('Password changed')
    expect(done.html).toContain('You can now sign in to Corner Shop with your new password.')
    expect(done.html).not.toContain(token)

    const hash = await storedHash()
    expect(await verifyPassword(NEW_PASSWORD, hash)).toBe(true)
    expect(await verifyPassword(OLD_PASSWORD, hash)).toBe(false)
    expect(await unusedResets()).toBe(0)

    const reopened = await fetch(link)
    expect(reopened.status).toBe(400)
    expect(await reopened.text()).toContain('Link already used')

    const replayed = await submit({ token, password: 'Another-password-3', confirm: 'Another-password-3' })
    expect(replayed.status).toBe(400)
    expect(replayed.html).toContain('Link already used')
    expect(await verifyPassword(NEW_PASSWORD, await storedHash())).toBe(true)
  })

  it('says plainly when a link is not valid or has expired', async () => {
    const unknown = await fetch(`${baseUrl}/api/v1/${projectId}/auth/reset?token=${'0'.repeat(64)}`)
    expect(unknown.status).toBe(400)
    expect(await unknown.text()).toContain('Link not valid')

    const missing = await fetch(`${baseUrl}/api/v1/${projectId}/auth/reset`)
    expect(missing.status).toBe(400)
    expect(await missing.text()).toContain('Link not valid')

    const stale = await requestReset()
    await prisma.$executeRawUnsafe(
      `UPDATE "${schema}"."_password_resets" SET expires_at = now() - interval '1 minute' WHERE token = $1`,
      tokenOf(stale),
    )
    const expired = await fetch(stale)
    expect(expired.status).toBe(400)
    expect(await expired.text()).toContain('Link expired')
  })
})

describe('a project with an App URL', () => {
  it('still sends the reset link to the app', async () => {
    await prisma.projectAuthConfig.upsert({
      where: { projectId },
      create: { projectId, appUrl: 'https://shop.example.test/account' },
      update: { appUrl: 'https://shop.example.test/account' },
    })
    const link = await requestReset()
    expect(link).toMatch(/^https:\/\/shop\.example\.test\/account\?backenly_reset_token=[0-9a-f]{64}$/)
    expect((await getAuthEmailPolicy(projectId))?.effectiveAppUrl).toBe('https://shop.example.test/account')
  })
})
