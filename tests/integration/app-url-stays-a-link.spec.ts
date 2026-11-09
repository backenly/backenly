/**
 * AN APP URL IS ONLY EVER A LINK
 * ==============================
 *
 * A project's App URL is written into the pages Backenly hosts for the app's
 * users (email verification, magic links) and into its auth emails. It was
 * accepted if it parsed as any URL, javascript: and data: included, and the
 * hosted pages did not escape quotes, so a project could put script on the
 * platform's own origin.
 *
 * Pinned here against the real save path, the real Express runtime and a real
 * workspace. Only the SMTP transport is a stand-in, one that keeps what it is
 * given:
 *
 *  1. Saving refuses anything but an http(s) address with a plain hostname.
 *  2. A value stored before that check is never written into a page or an
 *     email.
 *  3. A real App URL still gets its "Back to" link and its reset link.
 */

import '@/tests/helpers/real-web-standard'
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import app from '@/server/app'
import { prisma } from '@/lib/db'
import { hashPassword } from '@/lib/auth/password'
import { getAuthEmailContext } from '@/lib/services/end-user-auth-email'
import { getAuthEmailPolicy, saveAuthEmailPolicy } from '@/lib/services/auth-email-policy'
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
const EMAIL = `user-${crypto.randomBytes(4).toString('hex')}@example.test`

/** Script in a link's scheme, and script after a quote in the host, which URL parsing keeps as typed. */
const SCRIPTED = [
  'javascript:console.log(document.domain)',
  'https://example.com"autofocus=""onfocus="console.log(document.domain)',
]
const REFUSED = [...SCRIPTED, 'data:text/html,<script>console.log(1)</script>', 'ftp://files.example.com/app', 'not a url']

let server: http.Server
let baseUrl = ''
let ownerId: string
let projectId: string
let schema: string

async function storeAppUrl(appUrl: string | null) {
  // Written directly, as a row saved before saving checked the value would be.
  await prisma.projectAuthConfig.upsert({ where: { projectId }, create: { projectId, appUrl }, update: { appUrl } })
}

async function hostedVerifyPage(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/${projectId}/auth/verify-email?token=not-a-real-token`)
  expect(res.status).toBe(400)
  return res.text()
}

async function resetEmail(): Promise<string> {
  const before = mailbox().length
  await expect(issueEndUserPasswordReset(projectId, EMAIL)).resolves.toEqual({ found: true, emailSent: true })
  return mailbox()[before].html
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
  process.env.NEXT_PUBLIC_APP_URL = baseUrl

  ownerId = (
    await prisma.user.create({ data: { email: `owner-${crypto.randomUUID()}@example.test`, name: 'app url fixture' }, select: { id: true } })
  ).id
  projectId = (
    await prisma.project.create({
      data: { name: 'Corner Shop', userId: ownerId, jwtSecret: crypto.randomBytes(32).toString('hex') },
      select: { id: true },
    })
  ).id
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
    `INSERT INTO "${schema}"."users" (email, password) VALUES ($1, $2)`,
    EMAIL,
    await hashPassword('Old-password-1'),
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

describe('saving an App URL', () => {
  it.each(REFUSED)('refuses %s and keeps what was there', async (appUrl) => {
    const result = await saveAuthEmailPolicy(projectId, { appUrl })
    expect(result).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' })
    expect((await getAuthEmailPolicy(projectId))?.appUrl ?? null).toBeNull()
  })

  it('accepts an https address', async () => {
    const result = await saveAuthEmailPolicy(projectId, { appUrl: 'https://shop.example.test/account' })
    expect(result).toMatchObject({ ok: true, policy: { appUrl: 'https://shop.example.test/account' } })
    await saveAuthEmailPolicy(projectId, { appUrl: '' })
  })
})

describe('an App URL stored before saving checked it', () => {
  it.each(SCRIPTED)('never reaches a hosted page or an email: %s', async (appUrl) => {
    await storeAppUrl(appUrl)

    expect((await getAuthEmailContext(projectId)).appUrl).toBeNull()
    expect((await getAuthEmailPolicy(projectId))?.effectiveAppUrl ?? null).toBeNull()

    const page = await hostedVerifyPage()
    expect(page).not.toContain('Back to')
    expect(page).not.toMatch(/javascript:|onfocus|autofocus/i)

    const email = await resetEmail()
    expect(email).not.toMatch(/javascript:|onfocus|autofocus/i)
  })
})

describe('a real App URL', () => {
  it('still gets its link back and its reset link', async () => {
    await storeAppUrl('https://shop.example.test/account/')

    const page = await hostedVerifyPage()
    expect(page).toContain('<a href="https://shop.example.test/account"')
    expect(page).toContain('Back to Corner Shop')

    const email = await resetEmail()
    expect(email).toMatch(/href="https:\/\/shop\.example\.test\/account\?backenly_reset_token=[0-9a-f]{64}"/)
  })
})
